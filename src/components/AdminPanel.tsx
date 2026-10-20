import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import type {
  ConfigUpdate,
  FailureRecord,
  PublicConfig,
  PublicStatus,
} from '../../shared/contracts';
import { api } from '../api';
import { Modal } from './Modal';
import '../admin.css';

type Provider = 'deepseek' | 'fal';
type Session = { setupRequired: boolean; authenticated: boolean };
type PausedJob = { id: string; filename: string; spentCny: number; budgetCny: number };
type Activity = { failures: FailureRecord[]; paused: PausedJob[] };
type Confirmation = { kind: 'fal-test' } | { kind: 'delete'; provider: Provider };
type Request = { controller: AbortController };

const providers: { id: Provider; name: string; description: string }[] = [
  { id: 'deepseek', name: 'DeepSeek', description: '识别拼图里的完整设计和水印位置' },
  { id: 'fal', name: 'fal', description: '提取真实轮廓，修复水印覆盖的区域' },
];
const money = (value: number) => `¥${value.toFixed(2)}`;
const providerName = (provider: Provider) => (provider === 'deepseek' ? 'DeepSeek' : 'fal');

export function AdminPanel({
  status,
  onChanged,
  onNotice,
}: {
  status: PublicStatus | null;
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [password, setPassword] = useState('');
  const [confirmationPassword, setConfirmationPassword] = useState('');
  const [keys, setKeys] = useState<Record<Provider, string>>({ deepseek: '', fal: '' });
  const [budget, setBudget] = useState('10');
  const [jobBudgets, setJobBudgets] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState<Record<string, number>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const request = useRef<Request | null>(null);
  const local = status?.adminLocal;

  function acceptConfig(next: PublicConfig) {
    setConfig(next);
    setBudget(String(next.budgetCny));
  }

  function acceptActivity(next: Activity) {
    setActivity(next);
    setJobBudgets((previous) =>
      Object.fromEntries(
        next.paused.map((job) => [
          job.id,
          previous[job.id] ?? String(Math.min(1000, Math.ceil((job.budgetCny + 10) * 100) / 100)),
        ]),
      ),
    );
  }

  useEffect(() => {
    if (!local) return;
    const operation = { controller: new AbortController() };
    request.current = operation;
    const signal = operation.controller.signal;
    setBusy('loading');
    setError('');
    void (async () => {
      try {
        const next = await api<Session>('/api/admin/session', { signal });
        if (signal.aborted) return;
        setSession(next);
        if (next.authenticated) {
          const [nextConfig, nextActivity] = await Promise.all([
            api<PublicConfig>('/api/admin/config', { signal }),
            api<Activity>('/api/admin/failures', { signal }),
          ]);
          if (signal.aborted) return;
          acceptConfig(nextConfig);
          acceptActivity(nextActivity);
        }
      } catch (reason) {
        if (!signal.aborted)
          setError(reason instanceof Error ? reason.message : '无法读取管理员设置，请重试。');
      } finally {
        if (request.current === operation && !signal.aborted) {
          request.current = null;
          setBusy('');
        }
      }
    })();
    return () => {
      request.current?.controller.abort();
      request.current = null;
    };
  }, [local, reload]);

  async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const operation = { controller: new AbortController() };
    request.current = operation;
    setBusy(label);
    setError('');
    try {
      await action(operation.controller.signal);
    } catch (reason) {
      if (!operation.controller.signal.aborted) {
        const message = reason instanceof Error ? reason.message : '操作未完成，请重试。';
        setError(message);
        if (message.includes('请先登录')) {
          setSession({ authenticated: false, setupRequired: false });
          setConfig(null);
          setActivity(null);
          setKeys({ deepseek: '', fal: '' });
        }
      }
    } finally {
      if (request.current === operation && !operation.controller.signal.aborted) {
        request.current = null;
        setBusy('');
      }
    }
  }

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (!session || request.current) return;
    if (session.setupRequired && password !== confirmationPassword) {
      setError('两次输入的密码不一致。');
      return;
    }
    const submittedPassword = password;
    const settingUp = session.setupRequired;
    setPassword('');
    setConfirmationPassword('');
    await run('auth', async (signal) => {
      await api('/api/admin/' + (settingUp ? 'setup' : 'login'), {
        method: 'POST',
        body: { password: submittedPassword },
        signal,
      });
      if (signal.aborted) return;
      setSession({ authenticated: true, setupRequired: false });
      onChanged();
      const [nextConfig, nextActivity] = await Promise.all([
        api<PublicConfig>('/api/admin/config', { signal }),
        api<Activity>('/api/admin/failures', { signal }),
      ]);
      if (signal.aborted) return;
      acceptConfig(nextConfig);
      acceptActivity(nextActivity);
      onNotice(settingUp ? '管理员密码已设置。请添加服务 Key。' : '已登录管理员。');
    });
  }

  async function updateConfig(
    update: ConfigUpdate,
    label: string,
    message: string,
    clearKey?: Provider,
  ) {
    await run(label, async (signal) => {
      const next = await api<PublicConfig>('/api/admin/config', {
        method: 'PATCH',
        body: update,
        signal,
      });
      if (signal.aborted) return;
      acceptConfig(next);
      if (clearKey) setKeys((previous) => ({ ...previous, [clearKey]: '' }));
      onChanged();
      onNotice(message);
    });
  }

  async function test(provider: Provider) {
    await run(`test-${provider}`, async (signal) => {
      const result = await api<{ message: string }>('/api/admin/test', {
        method: 'POST',
        body: { provider, ...(provider === 'fal' ? { consent: true } : {}) },
        signal,
      });
      if (!signal.aborted) onNotice(result.message);
    });
  }

  async function logout() {
    await run('logout', async (signal) => {
      await api('/api/admin/logout', { method: 'POST', body: {}, signal });
      if (signal.aborted) return;
      setSession({ authenticated: false, setupRequired: false });
      setConfig(null);
      setActivity(null);
      setKeys({ deepseek: '', fal: '' });
      setPassword('');
      setConfirmationPassword('');
      setApproved({});
      setConfirmation(null);
      onNotice('已退出管理员登录。');
    });
  }

  async function approveBudget(event: FormEvent, job: PausedJob) {
    event.preventDefault();
    const total = Number(jobBudgets[job.id]);
    if (!Number.isFinite(total) || total <= job.budgetCny || total < job.spentCny || total > 1000) {
      setError('新总预算必须高于当前预算，且不超过 1000 元。');
      return;
    }
    await run(`budget-${job.id}`, async (signal) => {
      const result = await api<{ id: string; budgetCny: number; spentCny: number }>(
        `/api/admin/jobs/${encodeURIComponent(job.id)}/budget`,
        { method: 'POST', body: { budgetCny: total }, signal },
      );
      if (signal.aborted) return;
      setApproved((previous) => ({ ...previous, [job.id]: result.budgetCny }));
      setActivity(
        (previous) =>
          previous && {
            ...previous,
            paused: previous.paused.map((item) =>
              item.id === job.id ? { ...item, budgetCny: result.budgetCny } : item,
            ),
          },
      );
      setJobBudgets((previous) => ({
        ...previous,
        [job.id]: String(Math.min(1000, Math.ceil((result.budgetCny + 10) * 100) / 100)),
      }));
      onChanged();
      onNotice(`已批准总预算 ${money(result.budgetCny)}。请员工重试，继续处理这张图片。`);
    });
  }

  if (!status)
    return (
      <div className="admin-panel panel">
        <p className="text-muted">正在读取服务状态…</p>
      </div>
    );
  if (!local)
    return (
      <section className="admin-panel panel">
        <h2>管理员设置</h2>
        <p className="text-muted">
          请在运行服务的主机上，通过 localhost 打开本页面管理密码和服务 Key。
        </p>
      </section>
    );

  return (
    <section className="admin-panel" aria-busy={Boolean(busy)}>
      <header className="admin-heading">
        <div>
          <h2>
            <ShieldCheck size={22} aria-hidden="true" />
            管理员设置
          </h2>
          <p className="text-muted">仅限服务主机本机访问。员工无需填写 Key。</p>
        </div>
        {session?.authenticated && (
          <button className="admin-button" disabled={Boolean(busy)} onClick={() => void logout()}>
            <LogOut size={16} aria-hidden="true" />
            {busy === 'logout' ? '正在退出…' : '退出登录'}
          </button>
        )}
      </header>

      {error && (
        <p className="error admin-error" role="alert">
          {error}
        </p>
      )}
      {!session && (
        <div className="admin-auth panel">
          <p className="text-muted">
            {busy ? '正在检查管理员登录状态…' : '暂时无法读取管理员设置。'}
          </p>
          {!busy && (
            <button className="admin-button" onClick={() => setReload((value) => value + 1)}>
              重新读取
            </button>
          )}
        </div>
      )}

      {session && !session.authenticated && (
        <form className="admin-auth panel" onSubmit={(event) => void authenticate(event)}>
          <h3>{session.setupRequired ? '首次设置管理员密码' : '登录管理员'}</h3>
          <p className="text-muted">
            {session.setupRequired
              ? '由管理员设置至少 10 个字符的密码，用于保护服务 Key。'
              : '输入这台主机的管理员密码。'}
          </p>
          <label className="admin-field">
            <span>管理员密码</span>
            <input
              type="password"
              autoComplete={session.setupRequired ? 'new-password' : 'current-password'}
              required
              minLength={10}
              maxLength={200}
              value={password}
              disabled={Boolean(busy)}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 10 个字符"
            />
          </label>
          {session.setupRequired && (
            <label className="admin-field">
              <span>再次输入密码</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={200}
                value={confirmationPassword}
                disabled={Boolean(busy)}
                onChange={(event) => setConfirmationPassword(event.target.value)}
                placeholder="确认管理员密码"
              />
            </label>
          )}
          <button className="admin-button admin-primary" disabled={Boolean(busy)} type="submit">
            {busy === 'auth' ? '正在验证…' : session.setupRequired ? '设置密码并进入' : '登录'}
          </button>
        </form>
      )}

      {session?.authenticated && !config && (
        <div className="admin-auth panel">
          <p className="text-muted">
            {busy ? '正在读取服务配置…' : '服务配置未加载，请重新读取。'}
          </p>
          {!busy && (
            <button className="admin-button" onClick={() => setReload((value) => value + 1)}>
              重新读取
            </button>
          )}
        </div>
      )}

      {session?.authenticated && config && (
        <>
          <div className="admin-services">
            {providers.map((provider) => {
              const saved = config[provider.id];
              const key = keys[provider.id].trim();
              return (
                <section className="admin-service panel" key={provider.id}>
                  <div className="admin-service-heading">
                    <div className="admin-service-name">
                      <KeyRound size={19} aria-hidden="true" />
                      <h3>{provider.name}</h3>
                    </div>
                    <span
                      className={`admin-state ${saved.configured && saved.enabled ? 'admin-state-on' : ''}`}
                    >
                      {saved.configured ? (saved.enabled ? '已启用' : '已停用') : '未配置'}
                    </span>
                  </div>
                  <p className="text-muted">{provider.description}</p>
                  <p className="admin-key-summary">
                    {saved.configured ? (
                      <>
                        已保存 <code>{saved.masked}</code>
                      </>
                    ) : (
                      '尚未添加 Key'
                    )}
                  </p>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (key.length < 8) {
                        setError('Key 至少需要 8 个字符。');
                        return;
                      }
                      void updateConfig(
                        provider.id === 'deepseek'
                          ? { deepseekKey: key, deepseekEnabled: true }
                          : { falKey: key, falEnabled: true },
                        `save-${provider.id}`,
                        `${provider.name} Key 已保存并启用。`,
                        provider.id,
                      );
                    }}
                  >
                    <label className="admin-field">
                      <span>{saved.configured ? '替换 Key' : '添加 Key'}</span>
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        autoCapitalize="none"
                        minLength={8}
                        maxLength={500}
                        required
                        value={keys[provider.id]}
                        disabled={Boolean(busy)}
                        onChange={(event) =>
                          setKeys((previous) => ({
                            ...previous,
                            [provider.id]: event.target.value,
                          }))
                        }
                        placeholder={saved.configured ? '粘贴新的 Key' : '粘贴服务 Key'}
                      />
                    </label>
                    <button
                      className="admin-button admin-primary"
                      disabled={Boolean(busy) || key.length < 8}
                      type="submit"
                    >
                      {busy === `save-${provider.id}` ? '正在保存…' : '保存并启用'}
                    </button>
                  </form>
                  <div className="admin-key-actions">
                    <button
                      className="admin-button"
                      disabled={Boolean(busy) || !saved.configured || Boolean(key)}
                      onClick={() =>
                        provider.id === 'fal'
                          ? setConfirmation({ kind: 'fal-test' })
                          : void test('deepseek')
                      }
                    >
                      {busy === `test-${provider.id}` ? '正在测试…' : '测试连接'}
                    </button>
                    <button
                      className="admin-button"
                      disabled={Boolean(busy) || !saved.configured}
                      onClick={() =>
                        void updateConfig(
                          provider.id === 'deepseek'
                            ? { deepseekEnabled: !saved.enabled }
                            : { falEnabled: !saved.enabled },
                          `toggle-${provider.id}`,
                          `${provider.name} 已${saved.enabled ? '停用' : '启用'}。`,
                        )
                      }
                    >
                      {saved.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      className="admin-button admin-danger"
                      disabled={Boolean(busy) || !saved.configured}
                      onClick={() => setConfirmation({ kind: 'delete', provider: provider.id })}
                    >
                      删除 Key
                    </button>
                  </div>
                  <p className="admin-hint text-muted">
                    {key
                      ? '请先保存新 Key，再测试连接。'
                      : provider.id === 'deepseek'
                        ? '测试仅读取模型列表，不上传图片。'
                        : '测试会使用内置合成小图，确认后可能产生一次费用。'}
                  </p>
                </section>
              );
            })}
          </div>

          <details className="admin-advanced panel">
            <summary>
              高级设置 <span className="text-muted">预算与近期失败</span>
            </summary>
            <div className="admin-advanced-body">
              <form
                className="admin-budget-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = Number(budget);
                  if (!Number.isFinite(value) || value < 1 || value > 1000) {
                    setError('每图预算应在 1–1000 元之间。');
                    return;
                  }
                  void updateConfig(
                    { budgetCny: value },
                    'default-budget',
                    '新图片的默认预算已更新。',
                  );
                }}
              >
                <label className="admin-field">
                  <span>每张新图片的预算上限（元）</span>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    step="0.01"
                    required
                    value={budget}
                    disabled={Boolean(busy)}
                    onChange={(event) => setBudget(event.target.value)}
                  />
                </label>
                <button className="admin-button" type="submit" disabled={Boolean(busy)}>
                  {busy === 'default-budget' ? '正在保存…' : '保存预算'}
                </button>
                <p className="admin-hint text-muted">
                  默认 10 元。费用预留达到上限时暂停；预留金额与服务商实际账单可能不同。
                </p>
              </form>
              <div className="admin-activity-heading">
                <h3>待审批与近期失败</h3>
                <button
                  className="admin-button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run('activity', async (signal) => {
                      const next = await api<Activity>('/api/admin/failures', { signal });
                      if (!signal.aborted) acceptActivity(next);
                    })
                  }
                >
                  {busy === 'activity' ? '正在刷新…' : '刷新'}
                </button>
              </div>
              {activity?.paused.map((job) => (
                <form
                  className="admin-paused"
                  key={job.id}
                  onSubmit={(event) => void approveBudget(event, job)}
                >
                  <div className="admin-job-description">
                    <strong>{job.filename}</strong>
                    <p className="text-muted">
                      已预留 {money(job.spentCny)} · 当前总预算 {money(job.budgetCny)}
                    </p>
                    {approved[job.id] !== undefined && (
                      <p className="admin-approved" role="status">
                        已审批，请员工重试继续。
                      </p>
                    )}
                  </div>
                  <label className="admin-field">
                    <span>新总预算（元）</span>
                    <input
                      type="number"
                      min={Math.min(1000, job.budgetCny + 0.01)}
                      max={1000}
                      step="0.01"
                      required
                      value={jobBudgets[job.id] ?? ''}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        setJobBudgets((previous) => ({ ...previous, [job.id]: event.target.value }))
                      }
                    />
                  </label>
                  <button
                    className="admin-button"
                    type="submit"
                    disabled={Boolean(busy) || job.budgetCny >= 1000}
                  >
                    {busy === `budget-${job.id}` ? '正在审批…' : '批准预算'}
                  </button>
                </form>
              ))}
              {activity && activity.paused.length === 0 && (
                <p className="admin-hint text-muted">没有等待预算审批的图片。</p>
              )}
              {activity && activity.failures.length > 0 ? (
                <ul className="admin-failures">
                  {activity.failures.slice(0, 8).map((failure, index) => (
                    <li key={`${failure.at}-${index}`}>
                      <div>
                        <strong>{failure.filename}</strong>
                        <time dateTime={new Date(failure.at).toISOString()}>
                          {new Date(failure.at).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </div>
                      <p>
                        {failure.stage} · {failure.message}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-hint text-muted">暂无近期失败记录。</p>
              )}
            </div>
          </details>
        </>
      )}

      {confirmation && (
        <Modal
          title={
            confirmation.kind === 'fal-test'
              ? '确认测试 fal 连接'
              : `删除 ${providerName(confirmation.provider)} Key`
          }
          onClose={() => setConfirmation(null)}
        >
          <div className="admin-confirm">
            {confirmation.kind === 'fal-test' ? (
              <>
                <p>将向 fal 上传一张内置合成小图，进行一次真实分割请求，以验证 Key。</p>
                <p>这次测试可能产生费用。不会上传任何员工图片。</p>
                <p>提交后离开页面不保证停止服务方处理，费用以服务方账单为准。</p>
              </>
            ) : (
              <p>删除后此服务将停用，需要重新添加 Key 才能继续处理新图片。</p>
            )}
            <div className="admin-confirm-actions">
              <button className="admin-button" onClick={() => setConfirmation(null)}>
                取消
              </button>
              <button
                className={`admin-button ${confirmation.kind === 'fal-test' ? 'admin-primary' : 'admin-danger'}`}
                disabled={Boolean(busy)}
                onClick={() => {
                  const action = confirmation;
                  setConfirmation(null);
                  if (action.kind === 'fal-test') void test('fal');
                  else
                    void updateConfig(
                      action.provider === 'deepseek'
                        ? { deepseekKey: '', deepseekEnabled: false }
                        : { falKey: '', falEnabled: false },
                      `delete-${action.provider}`,
                      `${providerName(action.provider)} Key 已删除。`,
                      action.provider,
                    );
                }}
              >
                {confirmation.kind === 'fal-test' ? '确认测试，可能计费' : '确认删除'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
