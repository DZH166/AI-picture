import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  ImagePlus,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RotateCcw,
  Scan,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  ACTIVE_STATUSES,
  type AssetResult,
  type Correction,
  type JobSnapshot,
  type PublicStatus,
} from '../shared/contracts';
import { api, downloadUrl } from './api';
import { preflightImage } from './lib/image-header';
import { sanitizeFilename } from './lib/export';
import { AdminPanel } from './components/AdminPanel';
import { AssetEditor } from './components/AssetEditor';
import { Modal } from './components/Modal';
import './admin.css';

export default function App() {
  const [page, setPage] = useState<'employee' | 'admin'>('employee');
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState('');
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [consent, setConsent] = useState<'start' | 'retry' | null>(null);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importLock = useRef(false);
  const actionLock = useRef(false);
  const notify = useCallback((message: string) => setNotice(message), []);
  const refreshStatus = useCallback(async () => {
    const value = await api<PublicStatus>('/api/status');
    setStatus(value);
    return value;
  }, []);
  const active = !!job && ACTIVE_STATUSES.includes(job.status);
  const jobId = job?.id;
  const statusLoaded = status !== null;
  const outputs =
    job?.assets.filter(
      (asset) =>
        asset.previewUrl &&
        asset.status !== 'failed' &&
        asset.status !== 'processing' &&
        asset.status !== 'pending',
    ) || [];
  const selectedAsset =
    selectedId && selectedId !== 'new'
      ? job?.assets.find((asset) => asset.id === selectedId)
      : undefined;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const nextStatus = await api<PublicStatus>('/api/status', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setStatus(nextStatus);
      const restored = await api<{ jobs: JobSnapshot[] }>('/api/jobs', {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setJob(restored.jobs[0] || null);
    })().catch((error) => {
      if (!controller.signal.aborted)
        notify(error instanceof Error ? error.message : '无法连接主机服务。');
    });
    return () => controller.abort();
  }, [notify]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  useEffect(
    () => () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    },
    [localPreview],
  );
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let inFlight = false;
    const timer = setInterval(
      () => {
        if (inFlight) return;
        inFlight = true;
        void api<JobSnapshot>('/api/jobs/' + jobId, { signal: controller.signal })
          .then((value) => {
            if (!controller.signal.aborted) setJob(value);
          })
          .catch((error) => {
            if (!controller.signal.aborted)
              notify(error instanceof Error ? error.message : '状态读取失败。');
          })
          .finally(() => {
            inFlight = false;
          });
      },
      active ? 1100 : 5000,
    );
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [jobId, active, notify]);
  useEffect(() => {
    if (!statusLoaded) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void api<PublicStatus>('/api/status', { signal: controller.signal })
        .then((value) => {
          if (!controller.signal.aborted) setStatus(value);
        })
        .catch(() => undefined);
    }, 10000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [statusLoaded]);

  async function importFile(nextFile: File) {
    if (active || uploading || importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setNotice('');
    try {
      const header = await preflightImage(nextFile);
      setLocalPreview(URL.createObjectURL(nextFile));
      setDimensions({ width: header.width, height: header.height });
      setFile(nextFile);
      setJob(null);
      setSelectedId(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : '请使用有效的 PNG、JPG 或 WebP。');
    } finally {
      importLock.current = false;
      setImporting(false);
    }
  }
  async function start() {
    if (actionLock.current) return;
    actionLock.current = true;
    const kind = consent;
    setConsent(null);
    setUploading(true);
    setNotice('');
    try {
      if (kind === 'retry' && job) {
        setJob(await api<JobSnapshot>('/api/jobs/' + job.id + '/retry', { method: 'POST' }));
      } else if (file) {
        const body = new FormData();
        body.append('image', file);
        setJob(
          await api<JobSnapshot>('/api/jobs', {
            method: 'POST',
            body,
            headers: { 'X-Image-Consent': 'confirmed' },
          }),
        );
        setFile(null);
        setLocalPreview('');
        setDimensions(null);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法开始处理。');
    } finally {
      actionLock.current = false;
      setUploading(false);
    }
  }
  async function cancel() {
    if (!job) return;
    try {
      setJob(await api<JobSnapshot>('/api/jobs/' + job.id + '/cancel', { method: 'POST' }));
    } catch (error) {
      notify(error instanceof Error ? error.message : '取消请求未完成。');
    }
  }
  async function remove(asset: AssetResult) {
    if (!job) return;
    try {
      setJob(
        await api<JobSnapshot>('/api/jobs/' + job.id + '/assets/' + asset.id, { method: 'DELETE' }),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : '移除失败。');
    }
  }
  async function applyCorrection(correction: Correction, assetId?: string) {
    if (!job) return;
    const path = '/api/jobs/' + job.id + '/assets' + (assetId ? '/' + assetId : '');
    setJob(await api<JobSnapshot>(path, { method: assetId ? 'PATCH' : 'POST', body: correction }));
  }
  async function downloadOne(asset: AssetResult) {
    if (!job || !asset.previewUrl) return;
    setJob(
      await api<JobSnapshot>('/api/jobs/' + job.id + '/assets/' + asset.id + '/approve', {
        method: 'POST',
      }),
    );
    downloadUrl(asset.previewUrl, sanitizeFilename(asset.label) + '.png');
  }
  async function downloadAll() {
    if (!job || exporting) return;
    setExporting(true);
    try {
      setJob(await api<JobSnapshot>('/api/jobs/' + job.id + '/approve', { method: 'POST' }));
      downloadUrl('/api/jobs/' + job.id + '/zip');
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出未完成。');
    } finally {
      setExporting(false);
    }
  }
  const imageUrl = localPreview || job?.originalUrl;
  const imageName = file?.name || job?.filename;
  const imageDimensions = dimensions || (job ? { width: job.width, height: job.height } : null);
  const canRetry = job && ['failed', 'cancelled', 'partial', 'budget_paused'].includes(job.status);

  return (
    <div className="application">
      <header className="site-header">
        <a
          href="#"
          className="brand"
          onClick={(event) => {
            event.preventDefault();
            setPage('employee');
          }}
        >
          <span className="brand-icon">
            <Scan size={20} />
          </span>
          <strong>AI-picture</strong>
          <span className="brand-subtitle">素材处理</span>
        </a>
        <nav aria-label="功能区">
          <button
            className={page === 'employee' ? 'active' : ''}
            aria-current={page === 'employee' ? 'page' : undefined}
            onClick={() => setPage('employee')}
          >
            员工区
          </button>
          <button
            className={page === 'admin' ? 'active' : ''}
            aria-current={page === 'admin' ? 'page' : undefined}
            onClick={() => {
              setPage('admin');
              void refreshStatus().catch(() => undefined);
            }}
          >
            <LockKeyhole size={13} />
            管理员
          </button>
        </nav>
      </header>
      <main className={'content ' + (page === 'admin' ? 'admin-content' : '')}>
        {page === 'admin' ? (
          <AdminPanel
            status={status}
            onChanged={() => {
              void refreshStatus().catch(() => undefined);
            }}
            onNotice={notify}
          />
        ) : (
          <>
            <div className="page-title">
              <h1>去水印，提取完整素材。</h1>
              <p>上传一张拼图，把里面的每个完整设计整理成独立 PNG。</p>
            </div>
            {status && !status.available && (
              <div className="notice config-notice">
                <span>
                  {status.configured
                    ? '模型服务当前已停用，请联系管理员。'
                    : '管理员尚未配置 DeepSeek 和图像服务，配置后即可开始。'}
                </span>
                {status.adminLocal && (
                  <button className="text-button" onClick={() => setPage('admin')}>
                    前往管理员区
                  </button>
                )}
              </div>
            )}
            <section
              className={'upload-panel panel ' + (dragging ? 'dragging' : '')}
              onDragOver={(event) => {
                event.preventDefault();
                if (!active && !uploading) setDragging(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const files = Array.from(event.dataTransfer.files);
                if (files.length !== 1) {
                  notify('每次请选择一张拼图。');
                  return;
                }
                void importFile(files[0]);
              }}
            >
              {imageUrl ? (
                <>
                  <div className="source-topline">
                    <div>
                      <strong>{imageName}</strong>
                      <span>
                        {imageDimensions?.width} × {imageDimensions?.height} · 原图分辨率保留
                      </span>
                    </div>
                    <button
                      className="button secondary small"
                      disabled={active || uploading || importing}
                      onClick={() => fileInput.current?.click()}
                    >
                      <Upload size={14} />
                      更换图片
                    </button>
                  </div>
                  <div className="original-preview">
                    <img src={imageUrl} alt="待处理的原始拼图" />
                  </div>
                </>
              ) : (
                <button
                  className="drop-area"
                  disabled={importing || uploading}
                  onClick={() => fileInput.current?.click()}
                >
                  <span className="upload-icon">
                    {importing ? (
                      <LoaderCircle className="spin" size={25} />
                    ) : (
                      <ImagePlus size={25} />
                    )}
                  </span>
                  <strong>
                    {dragging
                      ? '松开以导入图片'
                      : importing
                        ? '正在检查图片…'
                        : '点击上传，或将图片拖到这里'}
                  </strong>
                  <span>PNG、JPG、WebP · 单张不超过 25 MB</span>
                </button>
              )}
              <div className="upload-bottom">
                <span>
                  <Check size={14} />
                  人物、文字、装饰按完整设计提取
                </span>
                {active ? (
                  <button className="button secondary" onClick={() => void cancel()}>
                    <Square size={13} />
                    停止处理
                  </button>
                ) : (
                  <button
                    className="button primary main-action"
                    disabled={!file || !status?.available || importing || uploading}
                    onClick={() => setConsent('start')}
                  >
                    {uploading ? <LoaderCircle size={16} className="spin" /> : <Scan size={16} />}
                    {uploading ? '正在上传…' : '去水印并提取素材'}
                  </button>
                )}
              </div>
            </section>
            {job && (
              <div
                className={
                  'job-status ' +
                  (job.status === 'failed' || job.status === 'budget_paused' ? 'attention' : '')
                }
                role="status"
              >
                <div className="job-stage">
                  {active && <LoaderCircle size={16} className="spin" />}
                  <strong>{job.stage}</strong>
                  {job.error && <p>{job.error}</p>}
                </div>
                <div className="job-meta">
                  <span>
                    费用预留 ¥{job.spentCny.toFixed(2)} / ¥{job.budgetCny.toFixed(2)}
                  </span>
                  {canRetry && (
                    <button
                      className="text-button"
                      disabled={!status?.available || uploading || job.spentCny >= job.budgetCny}
                      onClick={() => setConsent('retry')}
                    >
                      <RotateCcw size={13} />
                      继续处理
                    </button>
                  )}
                </div>
              </div>
            )}
            {job && (job.assets.length > 0 || !active) && (
              <section className="results-section">
                <div className="results-heading">
                  <div>
                    <h2>
                      提取结果 <span>{outputs.length}</span>
                    </h2>
                    <p>点击素材查看原图位置；检查水印、文字和边缘后再下载。</p>
                  </div>
                  <div className="result-actions">
                    <button
                      className="button secondary small"
                      disabled={active || !status?.available}
                      onClick={() => setSelectedId('new')}
                    >
                      <Plus size={14} />
                      补充素材
                    </button>
                    <button
                      className="button primary"
                      disabled={!outputs.length || active || exporting}
                      onClick={() => void downloadAll()}
                    >
                      <ArrowDownToLine size={16} />
                      {exporting ? '正在生成…' : '确认并下载全部'}
                    </button>
                  </div>
                </div>
                {!job.assets.length ? (
                  <div className="results-empty">
                    {job.status === 'failed'
                      ? '没有生成可用结果，请检查失败原因后重试。'
                      : '尚无提取结果。不会用整图裁剪或测试图片代替真实输出。'}
                  </div>
                ) : (
                  <div className="results-grid">
                    {job.assets.map((asset) => (
                      <article
                        className={
                          'result-card ' + (asset.status === 'failed' ? 'failed-card' : '')
                        }
                        key={asset.id}
                      >
                        <button
                          className="result-image checkerboard"
                          disabled={active}
                          onClick={() => setSelectedId(asset.id)}
                          aria-label={'查看素材 ' + asset.label}
                        >
                          {asset.previewUrl ? (
                            <img src={asset.previewUrl} alt={asset.label} />
                          ) : (
                            <div className="result-placeholder">
                              {asset.status === 'processing' ? (
                                <LoaderCircle className="spin" size={22} />
                              ) : (
                                <ImagePlus size={22} />
                              )}
                              <span>{asset.status === 'failed' ? '需要重试' : '等待生成'}</span>
                            </div>
                          )}
                          <span className={'asset-state ' + asset.status}>
                            {asset.status === 'ready'
                              ? '已确认'
                              : asset.status === 'review'
                                ? '待检查'
                                : asset.status === 'failed'
                                  ? '失败'
                                  : asset.status === 'processing'
                                    ? '处理中'
                                    : '待处理'}
                          </span>
                        </button>
                        <div className="result-caption">
                          <div>
                            <strong title={asset.label}>{asset.label}</strong>
                            <span>
                              {asset.width
                                ? asset.width + ' × ' + asset.height + ' · PNG'
                                : asset.error || '尚未生成 PNG'}
                            </span>
                          </div>
                          <button
                            className="icon-button"
                            disabled={active}
                            aria-label={'移除素材 ' + asset.label}
                            onClick={() => void remove(asset)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                {job.warnings.length > 0 && (
                  <details className="processing-notes">
                    <summary>处理说明与待复核提醒</summary>
                    {job.warnings.map((warning, index) => (
                      <p key={index}>{warning}</p>
                    ))}
                  </details>
                )}
              </section>
            )}
            <p className="privacy-note">
              本次处理会调用 DeepSeek 与 fal。原图和结果在主机保留 24
              小时；水印遮住的细节需要检查修复效果。
            </p>
          </>
        )}
      </main>
      <footer className="site-footer">
        <span>仅处理自有或已获授权的素材</span>
        <span>AI-picture · 0.2</span>
      </footer>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept=".png,.jpg,.jpeg,.webp"
        aria-label="选择一张拼图"
        onChange={(event) => {
          if (event.target.files?.[0]) void importFile(event.target.files[0]);
          event.target.value = '';
        }}
      />
      {notice && (
        <div className="toast" role="alert">
          <span>{notice}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {consent && (
        <Modal
          title={consent === 'retry' ? '继续处理这张图片' : '确认本次图片处理'}
          onClose={() => setConsent(null)}
        >
          <p className="modal-copy">
            本图及为处理它生成的裁剪图，将发送给 DeepSeek 和
            fal，用于识别、分割和局部水印修复。外部服务可能产生 API 费用。
          </p>
          <p className="modal-copy">
            {job && consent === 'retry'
              ? '本任务预算为 ' + job.budgetCny + ' 元。'
              : '每图预算由管理员统一设置，默认 10 元。'}
            局部重试也计入同一任务；达到费用预留上限时暂停。水印覆盖的细节不保证等于原始干净像素。
          </p>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setConsent(null)}>
              取消
            </button>
            <button className="button primary" onClick={() => void start()}>
              确认并开始
            </button>
          </div>
        </Modal>
      )}
      {selectedId && job && (selectedId === 'new' || selectedAsset) && (
        <AssetEditor
          key={selectedId}
          job={job}
          asset={selectedAsset}
          onClose={() => setSelectedId(null)}
          onApply={applyCorrection}
          onDownload={downloadOne}
        />
      )}
    </div>
  );
}
