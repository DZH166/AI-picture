import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Radio,
  Save,
  ShieldCheck,
} from 'lucide-react';
import type { ProviderSettings } from '../types';
import { API_CAPABILITIES, DeepSeekProvider } from '../providers/deepseek';
import { loadSampleFile } from '../lib/images';
import { Modal } from './Modal';

interface Props {
  settings: ProviderSettings;
  setSettings: (settings: ProviderSettings) => void;
  onSave: () => void;
}

function readDataUrl(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('已取消测试', 'AbortError'));
      return;
    }
    const reader = new FileReader();
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      reader.abort();
      cleanup();
      reject(new DOMException('已取消测试', 'AbortError'));
    };
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error('测试图片读取失败。'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.readAsDataURL(file);
  });
}

export function Settings({ settings, setSettings, onSave }: Props) {
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState<'connection' | 'vision' | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const [confirmVision, setConfirmVision] = useState<ProviderSettings | null>(null);
  const activeTest = useRef<AbortController | null>(null);
  const consentSnapshot = useRef<ProviderSettings | null>(null);
  const mounted = useRef(true);
  const locked = !!testing || !!confirmVision;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeTest.current?.abort();
      activeTest.current = null;
      consentSnapshot.current = null;
    };
  }, []);

  const patch = (value: Partial<ProviderSettings>) => {
    if (activeTest.current || consentSnapshot.current) return;
    setFeedback(null);
    setSettings({ ...settings, ...value });
  };

  function beginTest(kind: 'connection' | 'vision'): AbortController | null {
    if (activeTest.current || !mounted.current) return null;
    const controller = new AbortController();
    activeTest.current = controller;
    setTesting(kind);
    setFeedback(null);
    return controller;
  }

  const isCurrent = (controller: AbortController) =>
    mounted.current && activeTest.current === controller && !controller.signal.aborted;

  function finishTest(controller: AbortController) {
    if (mounted.current && activeTest.current === controller) {
      activeTest.current = null;
      setTesting(null);
    }
  }

  function cancelTest() {
    const controller = activeTest.current;
    activeTest.current = null;
    controller?.abort();
    setTesting(null);
    setFeedback({ error: false, message: '已取消测试。' });
  }

  function closeConsent() {
    consentSnapshot.current = null;
    setConfirmVision(null);
  }

  async function testConnection() {
    if (consentSnapshot.current) return;
    const snapshot = { ...settings };
    const controller = beginTest('connection');
    if (!controller) return;
    try {
      const result = await new DeepSeekProvider(snapshot).testConnection(controller.signal);
      if (!isCurrent(controller)) return;
      setFeedback({
        error: !result.selectedModelAvailable,
        message: result.selectedModelAvailable
          ? `连接成功。当前模型 ${snapshot.modelId} 在可用模型列表中。`
          : `已连通，但模型列表中没有“${snapshot.modelId}”。接口返回的模型：${result.models.slice(0, 12).join('、') || '空列表'}。`,
      });
    } catch (error) {
      if (isCurrent(controller))
        setFeedback({
          error: true,
          message: error instanceof Error ? error.message : '连接测试失败。',
        });
    } finally {
      finishTest(controller);
    }
  }

  async function testVision(snapshot: ProviderSettings) {
    if (consentSnapshot.current !== snapshot) return;
    const controller = beginTest('vision');
    if (!controller) return;
    closeConsent();
    try {
      const image = await loadSampleFile();
      if (!isCurrent(controller)) return;
      const dataUrl = await readDataUrl(image, controller.signal);
      if (!isCurrent(controller)) return;
      const result = await new DeepSeekProvider(snapshot).testVision(dataUrl, controller.signal);
      if (!isCurrent(controller)) return;
      setFeedback({ error: false, message: result.message });
    } catch (error) {
      if (isCurrent(controller))
        setFeedback({
          error: true,
          message: error instanceof Error ? error.message : '视觉测试失败。',
        });
    } finally {
      finishTest(controller);
    }
  }

  return (
    <div className="settings-layout">
      <section className="panel settings-panel">
        <div className="panel-title">
          <div className="section-icon">
            <Radio size={19} />
          </div>
          <div>
            <h2>模型连接</h2>
            <p>配置视觉分析接口，按真实返回结果验证能力。</p>
          </div>
          <span className="subtle-tag">DeepSeek</span>
        </div>
        <div className="settings-body">
          <label className="field-label" htmlFor="base-url">
            API Base URL
          </label>
          <input
            id="base-url"
            className="input"
            disabled={locked}
            value={settings.apiBaseUrl}
            onChange={(e) => patch({ apiBaseUrl: e.target.value })}
            placeholder="https://api.deepseek.com"
            spellCheck={false}
          />
          <p className="field-hint">
            测试时会向此地址发送 API Key。使用官方地址或你信任的兼容服务。
          </p>
          <div className="label-line">
            <label className="field-label" htmlFor="model-id">
              Model ID
            </label>
            <button
              className="text-button"
              disabled={locked}
              onClick={() => patch({ modelId: API_CAPABILITIES.recommendedModelId })}
            >
              填入官方已核验 ID <ArrowUpRight size={13} />
            </button>
          </div>
          <input
            id="model-id"
            className="input"
            disabled={locked}
            value={settings.modelId}
            onChange={(e) => patch({ modelId: e.target.value })}
            spellCheck={false}
          />
          <p className="field-hint">保留项目文档中的初始值；请用“测试连接”确认模型 ID 是否可用。</p>
          <label className="field-label" htmlFor="api-key">
            API Key <span className="label-note">仅在当前页面内存中保留</span>
          </label>
          <div className="secret-input">
            <KeyRound size={17} />
            <input
              id="api-key"
              disabled={locked}
              type={showKey ? 'text' : 'password'}
              value={settings.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
              placeholder="输入你的 API Key"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className="icon-button"
              aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          <p className="field-hint">
            刷新页面后需重新输入。浏览器直连 API 时，使用者可在浏览器中查看 Key。
          </p>
          <label className="field-label" htmlFor="timeout">
            请求超时
          </label>
          <select
            id="timeout"
            className="input short-input"
            disabled={locked}
            value={settings.timeoutMs}
            onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
          >
            <option value={15000}>15 秒</option>
            <option value={30000}>30 秒</option>
            <option value={60000}>60 秒</option>
            <option value={120000}>120 秒</option>
          </select>
          <div className="settings-actions">
            <button
              className="button secondary"
              disabled={locked}
              onClick={() => void testConnection()}
            >
              {testing === 'connection' ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Radio size={16} />
              )}
              测试连接
            </button>
            <button
              className="button secondary"
              disabled={locked}
              onClick={() => {
                if (activeTest.current || consentSnapshot.current) return;
                if (!settings.allowImageUpload) {
                  setFeedback({
                    error: true,
                    message: '请先开启下方的“允许发送图片”，再进行视觉测试。',
                  });
                  return;
                }
                const snapshot = { ...settings };
                consentSnapshot.current = snapshot;
                setConfirmVision(snapshot);
              }}
            >
              {testing === 'vision' ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Eye size={16} />
              )}
              测试视觉输入
            </button>
            {testing && (
              <button className="button secondary" onClick={cancelTest}>
                取消测试
              </button>
            )}
          </div>
          {feedback && (
            <div
              className={`notice ${feedback.error ? 'notice-warning' : 'notice-success'}`}
              role="status"
            >
              {feedback.message}
            </div>
          )}
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-title">
          <div className="section-icon mint">
            <ShieldCheck size={19} />
          </div>
          <div>
            <h2>图片与隐私</h2>
            <p>图片的去向，由你决定。</p>
          </div>
        </div>
        <div className="settings-body">
          <label className="switch-row">
            <span>
              <strong>允许发送图片到配置的 API</strong>
              <small>每次发送前仍会说明图片和接收地址，并允许取消。</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              disabled={locked}
              checked={settings.allowImageUpload}
              onChange={(e) => patch({ allowImageUpload: e.target.checked })}
            />
            <span
              className={`switch ${settings.allowImageUpload ? 'on' : ''}`}
              aria-hidden="true"
            />
          </label>
          <div className="privacy-facts">
            <p>
              <Check size={16} />
              本地试提取不会上传图片
            </p>
            <p>
              <Check size={16} />
              原图与结果保存在本次浏览器会话
            </p>
            <p>
              <Check size={16} />
              设置保存不包含 API Key
            </p>
          </div>
          <button className="button primary" disabled={locked} onClick={onSave}>
            <Save size={16} />
            保存设置
          </button>
        </div>
      </section>
      <aside className="settings-aside">
        <div className="eyebrow">CAPABILITY CHECK</div>
        <h3>
          让每项能力
          <br />
          都有明确状态。
        </h3>
        <div className="capability">
          <CheckCircle2 size={17} />
          <div>
            <strong>本地像素提取</strong>
            <p>纯色背景、彼此分离的图形</p>
          </div>
          <span className="status-pill green">可用</span>
        </div>
        <div className="capability">
          <Eye size={17} />
          <div>
            <strong>DeepSeek 视觉分析</strong>
            <p>
              {API_CAPABILITIES.visionVerified ? '官方格式已核验，需 Key 实测' : '接口能力待核验'}
            </p>
          </div>
          <span className="status-pill purple">待连接</span>
        </div>
        <div className="capability">
          <LockKeyhole size={17} />
          <div>
            <strong>水印定位与修复</strong>
            <p>尚未配置真实修复模型</p>
          </div>
        </div>
        <div className="capability">
          <LockKeyhole size={17} />
          <div>
            <strong>复杂人物实例分割</strong>
            <p>尚未配置真实分割模型</p>
          </div>
        </div>
        <p className="aside-note">
          视觉分析可以理解图片内容；完整修复和精确人物分割还需要对应模型。
        </p>
        <a
          className="text-button"
          href="https://api-docs.deepseek.com/zh-cn/"
          target="_blank"
          rel="noreferrer"
        >
          查看官方 API 文档 <ArrowUpRight size={14} />
        </a>
      </aside>
      {confirmVision && (
        <Modal title="确认发送测试图片" onClose={closeConsent}>
          <p className="modal-copy">
            将发送应用内置的「森林伙伴」示例拼图到以下
            API，测试当前模型能否理解图片。此请求可能产生该服务的 API 费用。
          </p>
          <div className="endpoint">{confirmVision.apiBaseUrl}</div>
          <p className="field-hint">模型：{confirmVision.modelId}</p>
          <img className="consent-image" src="/sample-sheet.svg" alt="将发送的森林伙伴示例拼图" />
          <p className="field-hint">此操作只发送内置示例图。你导入的图片不会用于本次测试。</p>
          <div className="modal-actions">
            <button className="button secondary" onClick={closeConsent}>
              取消
            </button>
            <button
              className="button primary"
              disabled={!!testing}
              onClick={() => void testVision(confirmVision)}
            >
              发送示例图并测试
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
