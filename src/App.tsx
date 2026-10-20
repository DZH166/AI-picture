import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  FileImage,
  FileSpreadsheet,
  FolderDown,
  FolderOpen,
  ImagePlus,
  Images,
  Info,
  LayoutDashboard,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  RotateCcw,
  ScanLine,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  UploadCloud,
  WandSparkles,
  X,
  ZoomIn,
} from 'lucide-react';
import { Modal } from './components/Modal';
import { Settings } from './components/Settings';
import { DEFAULT_SETTINGS } from './providers/deepseek';
import {
  cutoutToPng,
  loadSampleFile,
  readRaster,
  segmentInWorker,
  validateImage,
} from './lib/images';
import {
  canSaveToDirectory,
  createCsvReport,
  createZip,
  downloadBlob,
  sanitizeFilename,
  saveToDirectory,
} from './lib/export';
import {
  formatBytes,
  loadSettings,
  persistSettings,
  revokeJob,
  type Job,
  type Material,
  type Page,
  type ProcessingMode,
} from './model';
import type { ExportItem, ExportMode, ReportRow } from './types';

const PAGE_LABELS: Record<Page, string> = {
  workspace: '人物提取',
  results: '素材结果',
  settings: '模型与设置',
};
const STATUS_LABELS = {
  queued: '待处理',
  processing: '提取中',
  complete: '已完成',
  failed: '处理失败',
};

function App() {
  const [page, setPage] = useState<Page>('workspace');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [mode, setMode] = useState<ProcessingMode>('local');
  const [exportMode, setExportMode] = useState<ExportMode>('grouped');
  const [settings, setSettings] = useState(() => loadSettings(DEFAULT_SETTINGS));
  const [tolerance, setTolerance] = useState(28);
  const [minAreaPercent, setMinAreaPercent] = useState(0.15);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [help, setHelp] = useState(false);
  const [preview, setPreview] = useState<{ job: Job; material?: Material } | null>(null);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [batch, setBatch] = useState({ done: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const jobsRef = useRef(jobs);
  const busyRef = useRef(false);
  const importRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  jobsRef.current = jobs;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      jobsRef.current.forEach(revokeJob);
    },
    [],
  );

  const notify = (message: string, error = false) => setToast({ message, error });
  const count = jobs.reduce((sum, job) => sum + job.materials.length, 0);
  const completedCount = jobs.filter((job) => job.status === 'complete').length;
  const pendingCount = jobs.filter(
    (job) => job.status === 'queued' || job.status === 'failed',
  ).length;
  const failedCount = jobs.filter((job) => job.status === 'failed').length;
  const updateJob = (id: string, patch: Partial<Job>) =>
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));

  async function addFiles(files: File[]) {
    if (busyRef.current || importRef.current) return;
    importRef.current = true;
    setImporting(true);
    const errors: string[] = [];
    const additions: Job[] = [];
    const room = Math.max(0, 30 - jobsRef.current.length);
    if (files.length > room) errors.push('每批最多导入 30 张图片，超出部分未导入。');
    for (const file of files.slice(0, room)) {
      try {
        const dimensions = await validateImage(file);
        additions.push({
          id: crypto.randomUUID(),
          file,
          url: URL.createObjectURL(file),
          ...dimensions,
          status: 'queued',
          stage: '等待开始',
          materials: [],
          warnings: [],
          durationMs: 0,
        });
      } catch (error) {
        errors.push(`${file.name}：${error instanceof Error ? error.message : '图片读取失败。'}`);
      }
    }
    setJobs((current) => [...current, ...additions]);
    setImporting(false);
    importRef.current = false;
    if (errors.length) notify(errors.slice(0, 3).join('\n'), true);
    else if (additions.length) notify(`已导入 ${additions.length} 张图片，准备好就开始提取吧。`);
  }

  async function addSample() {
    try {
      await addFiles([await loadSampleFile()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : '示例读取失败。', true);
    }
  }

  function removeJob(id: string) {
    if (busyRef.current) return;
    const job = jobsRef.current.find((item) => item.id === id);
    if (job) revokeJob(job);
    setJobs((current) => current.filter((item) => item.id !== id));
  }

  function clearJobs() {
    if (busyRef.current) return;
    jobsRef.current.forEach(revokeJob);
    setJobs([]);
    setBatch({ done: 0, total: 0 });
  }

  async function startBatch(onlyId?: string) {
    if (busyRef.current || importRef.current) return;
    const targets = jobsRef.current.filter(
      (job) =>
        (job.status === 'queued' || job.status === 'failed') && (!onlyId || job.id === onlyId),
    );
    if (!targets.length) {
      notify('先导入图片，或添加新的待处理任务。');
      return;
    }
    if (mode === 'ai') {
      const error =
        '尚未配置真实水印修复与人物实例分割模型。可先使用“本地试提取”，或前往设置测试视觉分析接口。';
      setJobs((current) =>
        current.map((job) =>
          targets.some((target) => target.id === job.id)
            ? { ...job, status: 'failed', stage: '模型未配置', error }
            : job,
        ),
      );
      notify(error, true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setBatch({ done: 0, total: targets.length });
    let successes = 0;
    let failures = 0;
    let done = 0;
    for (const job of targets) {
      if (controller.signal.aborted) break;
      const start = performance.now();
      const materials: Material[] = [];
      updateJob(job.id, { status: 'processing', stage: '读取图片像素', error: undefined });
      try {
        const image = await readRaster(job.file);
        if (controller.signal.aborted) throw new DOMException('已停止处理', 'AbortError');
        const processedSize = `${image.width} × ${image.height}`;
        const resized = image.width !== job.width || image.height !== job.height;
        const minArea = Math.max(
          12,
          Math.round((image.width * image.height * minAreaPercent) / 100),
        );
        updateJob(job.id, { stage: '分析背景并提取独立区域' });
        const result = await segmentInWorker(image, { tolerance, minArea }, controller.signal);
        if (!result.cutouts.length)
          throw new Error(
            '没有检测到符合条件的独立图形。请调整背景容差或最小面积，或更换纯色背景图片。',
          );
        updateJob(job.id, { stage: `正在生成 ${result.cutouts.length} 张透明 PNG` });
        const base = sanitizeFilename(job.file.name.replace(/\.[^.]+$/, ''));
        for (let index = 0; index < result.cutouts.length; index++) {
          if (controller.signal.aborted) throw new DOMException('已停止处理', 'AbortError');
          const cutout = result.cutouts[index];
          const blob = await cutoutToPng(cutout);
          materials.push({
            id: crypto.randomUUID(),
            name: `${base}_${String(index + 1).padStart(3, '0')}.png`,
            blob,
            url: URL.createObjectURL(blob),
            width: cutout.width,
            height: cutout.height,
          });
        }
        if (controller.signal.aborted) throw new DOMException('已停止处理', 'AbortError');
        updateJob(job.id, {
          status: 'complete',
          stage: '本地提取完成 · 需检查',
          materials,
          durationMs: performance.now() - start,
          processedSize,
          warnings: [
            '本地试提取未执行水印定位或修复，请检查输出。',
            ...result.warnings,
            ...(resized ? [`为控制内存，处理尺寸缩放为 ${processedSize}；输出基于此尺寸。`] : []),
          ],
        });
        successes++;
      } catch (error) {
        materials.forEach((material) => URL.revokeObjectURL(material.url));
        if (controller.signal.aborted) {
          updateJob(job.id, { status: 'queued', stage: '已停止，可重新开始', error: undefined });
          break;
        }
        failures++;
        updateJob(job.id, {
          status: 'failed',
          stage: '提取失败',
          error: error instanceof Error ? error.message : '处理失败，请重试。',
          durationMs: performance.now() - start,
        });
      }
      done++;
      setBatch({ done, total: targets.length });
    }
    busyRef.current = false;
    setBusy(false);
    abortRef.current = null;
    if (controller.signal.aborted) notify('已停止处理，完成的素材已保留。');
    else
      notify(
        `本批处理完成：${successes} 张成功${failures ? `，${failures} 张失败，可单独重试` : '。可在“素材结果”中检查并导出'}`,
        failures > 0,
      );
  }

  function removeMaterial(jobId: string, materialId: string) {
    setJobs((current) =>
      current.map((job) => {
        if (job.id !== jobId) return job;
        const material = job.materials.find((item) => item.id === materialId);
        if (material) URL.revokeObjectURL(material.url);
        return { ...job, materials: job.materials.filter((item) => item.id !== materialId) };
      }),
    );
  }

  function queueAgain(job: Job) {
    if (busyRef.current) return;
    job.materials.forEach((material) => URL.revokeObjectURL(material.url));
    updateJob(job.id, {
      status: 'queued',
      stage: '已重新加入队列，可调整参数后开始',
      materials: [],
      warnings: [],
      error: undefined,
      durationMs: 0,
    });
    setPage('workspace');
    notify('原图已重新加入队列。调整参数后，点击“开始本地提取”。');
  }

  function exportData(): { items: ExportItem[]; rows: ReportRow[] } {
    return {
      items: jobs.flatMap((job) =>
        job.materials.map((material) => ({
          sourceId: job.id,
          sourceName: job.file.name,
          name: material.name,
          blob: material.blob,
        })),
      ),
      rows: jobs.map((job) => ({
        sourceName: job.file.name,
        status: STATUS_LABELS[job.status],
        count: job.materials.length,
        durationMs: job.durationMs,
        note: [job.error, ...job.warnings].filter(Boolean).join('；'),
      })),
    };
  }

  async function exportResults(toDirectory = false) {
    if (!count) {
      notify('还没有可导出的素材。');
      return;
    }
    setExporting(true);
    try {
      const { items, rows } = exportData();
      if (toDirectory) {
        await saveToDirectory(items, exportMode, rows);
        notify(`已保存 ${items.length} 张 PNG 和处理报告到所选文件夹。`);
      } else {
        const blob = await createZip(items, exportMode, rows);
        downloadBlob(blob, `素材工厂_${new Date().toISOString().slice(0, 10)}.zip`);
        notify(`已生成 ${items.length} 张 PNG 的 ZIP，下载已开始。`);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        notify('已取消选择文件夹。');
      else
        notify(error instanceof Error ? error.message : '导出失败，请重试或使用 ZIP 下载。', true);
    } finally {
      setExporting(false);
    }
  }

  const currentPreviewJob = preview ? jobs.find((job) => job.id === preview.job.id) : undefined;
  const importDisabled = busy || importing;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage('workspace');
          }}
        >
          <span className="brand-symbol">
            <Sparkles size={23} fill="currentColor" />
          </span>
          <span>
            素材工厂<small>AI MATERIAL STUDIO</small>
          </span>
        </a>
        <div className="workspace-name">
          <span className="workspace-avatar">工</span>
          <div>
            我的工作空间<small>内部素材工作室</small>
          </div>
          <MoreHorizontal size={17} />
        </div>
        <div className="nav-section-label">工作空间</div>
        <nav aria-label="主要导航">
          <button
            className={`nav-item ${page === 'workspace' ? 'active' : ''}`}
            aria-current={page === 'workspace' ? 'page' : undefined}
            onClick={() => setPage('workspace')}
          >
            <LayoutDashboard size={19} />
            <span>人物提取</span>
            <ChevronRight size={16} />
          </button>
          <button
            className={`nav-item ${page === 'results' ? 'active' : ''}`}
            aria-current={page === 'results' ? 'page' : undefined}
            onClick={() => setPage('results')}
          >
            <Images size={19} />
            <span>素材结果</span>
            {count > 0 && <span className="nav-count">{count}</span>}
          </button>
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => setPage('settings')}
          >
            <Settings2 size={19} />
            <span>模型与设置</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <div>
              <span className="online-dot" />
              <strong>本地工作模式</strong>
            </div>
            <p>
              导入与试提取在浏览器完成。
              <br />
              你的素材，留在你的电脑。
            </p>
            <span>
              LOCAL FIRST <ShieldCheck size={14} />
            </span>
          </div>
          <button className="nav-item help-link" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            <span>使用指南</span>
            <ArrowUpRightIcon />
          </button>
          <div className="sidebar-version">
            <span className="version-dot" />
            MVP 0.1<span>为创意，少一点重复</span>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{PAGE_LABELS[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <Monitor size={13} />
              本地运行
            </span>
            <span className="top-divider" />
            <button className="icon-button" aria-label="打开使用指南" onClick={() => setHelp(true)}>
              <CircleHelp size={19} />
            </button>
            <span className="profile-avatar">创</span>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === 'workspace'
                  ? 'YOUR LITTLE MATERIAL FACTORY'
                  : page === 'results'
                    ? 'READY FOR YOUR NEXT CREATION'
                    : 'MAKE IT WORK YOUR WAY'}
              </div>
              <h1>
                {page === 'workspace'
                  ? '好素材，从这里开始。'
                  : page === 'results'
                    ? '每个角色，都有自己的位置。'
                    : '连接你的创作工具。'}
              </h1>
              <p>
                {page === 'workspace'
                  ? '导入卡通拼图，提取独立人物，让素材整理变得轻松一点。'
                  : page === 'results'
                    ? '检查透明边缘，移除多余结果，再把需要的素材带走。'
                    : '管理模型接口与图片隐私，清楚了解每一步的处理能力。'}
              </p>
            </div>
            {page === 'workspace' && (
              <button
                className="button secondary sample-top"
                disabled={importDisabled}
                onClick={() => void addSample()}
              >
                <Play size={15} />
                试用示例
              </button>
            )}
            {page === 'results' && (
              <button
                className="button primary"
                disabled={!count || exporting || busy}
                onClick={() => void exportResults()}
              >
                {exporting ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <ArrowDownToLine size={17} />
                )}
                导出全部素材 <span className="button-counter">{count}</span>
              </button>
            )}
          </div>

          {page === 'settings' ? (
            <Settings
              settings={settings}
              setSettings={setSettings}
              onSave={() => {
                try {
                  persistSettings(settings);
                  notify('设置已保存。API Key 仅保留在当前页面内存中。');
                } catch {
                  notify('浏览器未允许保存设置；当前页面仍可使用。', true);
                }
              }}
            />
          ) : (
            <>
              {page === 'workspace' && (
                <>
                  <section className="workflow-strip" aria-label="处理步骤">
                    <div className="workflow-step">
                      <span className="step-icon">
                        <ImagePlus size={19} />
                      </span>
                      <div>
                        <strong>
                          01 <span>导入拼图</span>
                        </strong>
                        <p>支持多张，原图完整保留</p>
                      </div>
                    </div>
                    <ChevronRight className="step-arrow" size={17} />
                    <div className="workflow-step">
                      <span className="step-icon lavender">
                        <ScanLine size={19} />
                      </span>
                      <div>
                        <strong>
                          02 <span>提取人物</span>
                        </strong>
                        <p>{mode === 'local' ? '纯色背景本地试提取' : '修复与分割模型待接入'}</p>
                      </div>
                    </div>
                    <ChevronRight className="step-arrow" size={17} />
                    <div className="workflow-step">
                      <span className="step-icon peach">
                        <FolderDown size={19} />
                      </span>
                      <div>
                        <strong>
                          03 <span>打包带走</span>
                        </strong>
                        <p>独立透明 PNG，整理好再导出</p>
                      </div>
                    </div>
                    <span className="workflow-deco">
                      <Sparkles size={21} />
                    </span>
                  </section>
                  <div className="work-grid">
                    <div className="work-main">
                      <section
                        className={`panel import-panel ${dragOver ? 'is-dragging' : ''}`}
                        onDragOver={(event) => {
                          event.preventDefault();
                          if (!importDisabled) setDragOver(true);
                        }}
                        onDragLeave={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node))
                            setDragOver(false);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          setDragOver(false);
                          if (!importDisabled) void addFiles(Array.from(event.dataTransfer.files));
                        }}
                      >
                        <div className="panel-heading">
                          <h2>
                            导入素材 <span>从一张拼图开始</span>
                          </h2>
                          <span className="subtle-tag">PNG / JPG / WebP</span>
                        </div>
                        <div className="dropzone">
                          <div className="upload-illustration">
                            <span className="upload-sheet back" />
                            <span className="upload-sheet front">
                              <UploadCloud size={29} strokeWidth={1.5} />
                            </span>
                            <span className="mini-spark">✦</span>
                          </div>
                          <h3>{dragOver ? '松开鼠标，开始导入' : '把图片拖到这里'}</h3>
                          <p>或选择本地图片，一次处理一组素材</p>
                          <button
                            className="button primary"
                            disabled={importDisabled}
                            onClick={() => inputRef.current?.click()}
                          >
                            {importing ? (
                              <LoaderCircle className="spin" size={17} />
                            ) : (
                              <Plus size={18} />
                            )}
                            {importing ? '正在读取图片' : '选择图片'}
                          </button>
                          <small>单张最大 25 MB · 每批最多 30 张 · 图片不会自动上传</small>
                        </div>
                        <div className="sample-row">
                          <div className="sample-thumbnail">
                            <img src="/sample-sheet.svg" alt="猫、兔子和小熊组成的示例拼图" />
                          </div>
                          <div>
                            <strong>第一次来？让森林伙伴带你试试</strong>
                            <p>使用内置原创示例，体验完整的本地提取与导出。</p>
                          </div>
                          <button
                            className="text-button"
                            disabled={importDisabled}
                            onClick={() => void addSample()}
                          >
                            载入示例 <ArrowRight size={15} />
                          </button>
                        </div>
                      </section>
                      <section className="panel queue-panel">
                        <div className="panel-heading">
                          <h2>
                            处理队列 <span className="count-label">{jobs.length}</span>
                          </h2>
                          <div className="queue-tools">
                            {jobs.length > 0 && (
                              <button
                                className="text-button muted"
                                disabled={importDisabled}
                                onClick={clearJobs}
                              >
                                清空队列
                              </button>
                            )}
                            <span className="queue-dot" />
                            {busy ? '正在处理' : '准备就绪'}
                          </div>
                        </div>
                        {!jobs.length ? (
                          <div className="queue-empty">
                            <div className="empty-stack">
                              <FileImage size={24} strokeWidth={1.4} />
                            </div>
                            <strong>等待你的第一组素材</strong>
                            <p>导入后，处理状态和提取数量会显示在这里。</p>
                          </div>
                        ) : (
                          <div className="job-list">
                            {jobs.map((job) => (
                              <div
                                className={`job-row ${job.status === 'failed' ? 'job-failed' : ''}`}
                                key={job.id}
                              >
                                <button
                                  className="job-thumbnail"
                                  aria-label={`查看原图 ${job.file.name}`}
                                  onClick={() => setPreview({ job })}
                                >
                                  <img src={job.url} alt="" />
                                </button>
                                <div className="job-information">
                                  <strong title={job.file.name}>{job.file.name}</strong>
                                  <p>
                                    {job.width} × {job.height}
                                    <span>·</span>
                                    {formatBytes(job.file.size)}
                                    {job.status === 'complete' && (
                                      <>
                                        <span>·</span>
                                        {(job.durationMs / 1000).toFixed(1)} 秒
                                      </>
                                    )}
                                  </p>
                                  <small className={job.error ? 'error-text' : ''}>
                                    {job.error || job.stage}
                                  </small>
                                </div>
                                <div className="job-state">
                                  <span
                                    className={`status-pill ${job.status === 'complete' ? 'green' : job.status === 'failed' ? 'red' : job.status === 'processing' ? 'purple' : 'gray'}`}
                                  >
                                    {job.status === 'processing' && (
                                      <LoaderCircle size={12} className="spin" />
                                    )}
                                    {job.status === 'complete' && <Check size={12} />}
                                    {STATUS_LABELS[job.status]}
                                  </span>
                                  {job.status === 'complete' && (
                                    <button
                                      className="text-button"
                                      onClick={() => setPage('results')}
                                    >
                                      {job.materials.length} 个素材 <ChevronRight size={13} />
                                    </button>
                                  )}
                                </div>
                                {job.status === 'failed' ? (
                                  <button
                                    className="icon-button"
                                    aria-label={`重试 ${job.file.name}`}
                                    disabled={importDisabled}
                                    onClick={() => void startBatch(job.id)}
                                  >
                                    <RotateCcw size={16} />
                                  </button>
                                ) : (
                                  <button
                                    className="icon-button remove-job"
                                    aria-label={`移除 ${job.file.name}`}
                                    disabled={importDisabled}
                                    onClick={() => removeJob(job.id)}
                                  >
                                    <X size={17} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {batch.total > 0 && (
                          <div className="batch-progress">
                            <div>
                              <span>{busy ? '本批正在处理' : '上次处理进度'}</span>
                              <strong>
                                {batch.done} / {batch.total} 张
                              </strong>
                            </div>
                            <progress
                              max={batch.total}
                              value={batch.done}
                              aria-label="已完成处理的图片数量"
                            />
                          </div>
                        )}
                        <div className="queue-footer">
                          <span>
                            <ShieldCheck size={14} />
                            仅处理自有或已获授权的素材
                          </span>
                          {completedCount > 0 && (
                            <button className="text-button" onClick={() => setPage('results')}>
                              查看提取结果 <ArrowRight size={14} />
                            </button>
                          )}
                        </div>
                      </section>
                      <div className="workspace-footnote">
                        <Info size={14} />
                        <span>
                          第一版专注可检查的提取与导出。复杂背景、相连人物或遮挡区域，请逐张复核。
                        </span>
                      </div>
                    </div>
                    <aside className="work-rail">
                      <section className="panel controls-panel">
                        <div className="panel-heading">
                          <h2>
                            <Settings2 size={17} />
                            处理设置
                          </h2>
                          <span className="tiny-version">V0.1</span>
                        </div>
                        <div className="controls-body">
                          <label className="field-label">处理模式</label>
                          <div className="segmented" aria-label="处理模式">
                            <button
                              className={mode === 'local' ? 'selected' : ''}
                              disabled={busy}
                              onClick={() => setMode('local')}
                            >
                              <Monitor size={14} />
                              本地试提取
                            </button>
                            <button
                              className={mode === 'ai' ? 'selected' : ''}
                              disabled={busy}
                              onClick={() => setMode('ai')}
                            >
                              <Sparkles size={14} />
                              完整 AI
                            </button>
                          </div>
                          <div className={`mode-note ${mode === 'ai' ? 'mode-note-warning' : ''}`}>
                            <span className={`status-dot ${mode === 'ai' ? 'amber' : ''}`} />
                            <div>
                              <strong>
                                {mode === 'local' ? '图片留在本地' : '真实模型尚未配置'}
                              </strong>
                              <p>
                                {mode === 'local'
                                  ? '适合纯色背景、彼此分离的卡通形象。当前模式不去水印。'
                                  : '视觉分析可单独测试。水印修复和复杂人物分割仍待接入。'}
                              </p>
                              {mode === 'ai' && (
                                <button className="text-button" onClick={() => setPage('settings')}>
                                  查看模型配置 <ArrowRight size={13} />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="start-area">
                            {busy ? (
                              <button
                                className="button stop-button full-width"
                                onClick={() => abortRef.current?.abort()}
                              >
                                <Square size={14} />
                                停止处理
                              </button>
                            ) : (
                              <button
                                className="button primary full-width start-button"
                                disabled={!pendingCount || importing}
                                onClick={() => void startBatch()}
                              >
                                <WandSparkles size={18} />
                                {mode === 'local' ? '开始本地提取' : '一键提取无水印人物'}
                                <ArrowRight size={16} />
                              </button>
                            )}
                            <p className="start-hint">
                              {busy
                                ? '停止后保留已完成的素材'
                                : pendingCount
                                  ? `${pendingCount} 张图片等待处理`
                                  : '添加图片后即可开始'}
                            </p>
                          </div>
                          {mode === 'local' && (
                            <div className="local-options">
                              <div className="label-line">
                                <label htmlFor="tolerance">背景容差</label>
                                <span>{tolerance}</span>
                              </div>
                              <input
                                id="tolerance"
                                type="range"
                                min="5"
                                max="70"
                                value={tolerance}
                                disabled={busy}
                                onChange={(e) => setTolerance(Number(e.target.value))}
                              />
                              <div className="range-labels">
                                <span>保留更多边缘</span>
                                <span>去除更多背景</span>
                              </div>
                              <div className="label-line minimum-area">
                                <label htmlFor="min-area">最小区域面积</label>
                                <select
                                  id="min-area"
                                  value={minAreaPercent}
                                  disabled={busy}
                                  onChange={(e) => setMinAreaPercent(Number(e.target.value))}
                                >
                                  <option value={0.05}>0.05%</option>
                                  <option value={0.15}>0.15%</option>
                                  <option value={0.5}>0.5%</option>
                                  <option value={1}>1%</option>
                                </select>
                              </div>
                            </div>
                          )}
                          <div className="control-divider" />
                          <label className="field-label">导出整理方式</label>
                          <label
                            className={`export-option ${exportMode === 'grouped' ? 'chosen' : ''}`}
                          >
                            <input
                              type="radio"
                              name="export-mode"
                              checked={exportMode === 'grouped'}
                              onChange={() => setExportMode('grouped')}
                            />
                            <span className="radio-circle" />
                            <FolderOpen size={18} />
                            <span>
                              <strong>按原图分类</strong>
                              <small>每张原图一个文件夹</small>
                            </span>
                            <span className="recommended">推荐</span>
                          </label>
                          <label
                            className={`export-option ${exportMode === 'flat' ? 'chosen' : ''}`}
                          >
                            <input
                              type="radio"
                              name="export-mode"
                              checked={exportMode === 'flat'}
                              onChange={() => setExportMode('flat')}
                            />
                            <span className="radio-circle" />
                            <Images size={18} />
                            <span>
                              <strong>全部汇总</strong>
                              <small>所有 PNG 放在同一层</small>
                            </span>
                          </label>
                          <div className="output-detail">
                            <span>输出格式</span>
                            <strong>
                              透明 PNG <span>+ CSV 报告</span>
                            </strong>
                          </div>
                        </div>
                      </section>
                      <div className="tip-card">
                        <div className="tip-symbol">
                          <Sparkles size={19} />
                        </div>
                        <h3>
                          少一点整理，
                          <br />
                          多一点创作。
                        </h3>
                        <p>
                          每个人物单独一张 PNG，
                          <br />
                          打开文件夹，就能开始用。
                        </p>
                        <div className="tip-bottom">
                          <span>MADE FOR CREATORS</span>
                          <span>↗</span>
                        </div>
                      </div>
                    </aside>
                  </div>
                </>
              )}
              {page === 'results' && (
                <>
                  <div className="result-stats">
                    <div>
                      <span className="stat-icon lavender">
                        <Images size={20} />
                      </span>
                      <p>
                        已提取素材
                        <strong>
                          {count}
                          <small>个</small>
                        </strong>
                      </p>
                    </div>
                    <div>
                      <span className="stat-icon mint">
                        <CheckCircle2 size={20} />
                      </span>
                      <p>
                        成功处理原图
                        <strong>
                          {completedCount}
                          <small>/ {jobs.length} 张</small>
                        </strong>
                      </p>
                    </div>
                    <div>
                      <span className="stat-icon peach">
                        <FileImage size={20} />
                      </span>
                      <p>
                        输出格式
                        <strong className="stat-format">
                          PNG<small>透明背景</small>
                        </strong>
                      </p>
                    </div>
                  </div>
                  <div className="results-toolbar">
                    <div>
                      <h2>本次提取结果</h2>
                      <span className="subtle-tag">需人工复核</span>
                    </div>
                    <div>
                      <select
                        aria-label="结果导出整理方式"
                        className="compact-select"
                        value={exportMode}
                        onChange={(e) => setExportMode(e.target.value as ExportMode)}
                      >
                        <option value="grouped">按原图分类</option>
                        <option value="flat">全部汇总</option>
                      </select>
                      <button
                        className="button secondary small"
                        disabled={!jobs.length || busy}
                        onClick={() => {
                          downloadBlob(
                            new Blob([createCsvReport(exportData().rows)], {
                              type: 'text/csv;charset=utf-8',
                            }),
                            '素材处理报告.csv',
                          );
                          notify('CSV 报告下载已开始。');
                        }}
                      >
                        <FileSpreadsheet size={15} />
                        处理报告
                      </button>
                      {canSaveToDirectory() && (
                        <button
                          className="button secondary small"
                          disabled={!count || busy || exporting}
                          onClick={() => void exportResults(true)}
                        >
                          <FolderDown size={15} />
                          保存到文件夹
                        </button>
                      )}
                    </div>
                  </div>
                  {failedCount > 0 && (
                    <div className="notice notice-warning result-alert">
                      {failedCount} 张原图处理失败。已完成的素材仍可导出。
                      <button className="text-button" onClick={() => setPage('workspace')}>
                        返回队列重试 <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                  {!completedCount ? (
                    <div className="panel results-empty">
                      <span className="results-empty-icon">
                        <Images size={36} strokeWidth={1.3} />
                      </span>
                      <h2>你的素材，即将在这里集合</h2>
                      <p>先导入一张拼图并开始提取，完成后就能检查和导出。</p>
                      <button className="button primary" onClick={() => setPage('workspace')}>
                        前往人物提取 <ArrowRight size={16} />
                      </button>
                    </div>
                  ) : (
                    jobs
                      .filter((job) => job.status === 'complete')
                      .map((job) => (
                        <section className="panel result-group" key={job.id}>
                          <div className="result-group-heading">
                            <button
                              className="result-source-thumb"
                              aria-label={`查看原图 ${job.file.name}`}
                              onClick={() => setPreview({ job })}
                            >
                              <img src={job.url} alt="" />
                            </button>
                            <div>
                              <h3>{job.file.name}</h3>
                              <p>
                                {job.materials.length} 个候选素材<span>·</span>处理尺寸{' '}
                                {job.processedSize}
                                <span>·</span>
                                {(job.durationMs / 1000).toFixed(1)} 秒
                              </p>
                            </div>
                            <div className="result-group-actions">
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => queueAgain(job)}
                              >
                                重新提取 <RotateCcw size={13} />
                              </button>
                              <button className="text-button" onClick={() => setPreview({ job })}>
                                查看原图 <ZoomIn size={14} />
                              </button>
                            </div>
                          </div>
                          <div className="result-grid">
                            {job.materials.map((material, index) => (
                              <article className="material-card" key={material.id}>
                                <button
                                  className="material-image checkerboard"
                                  onClick={() => setPreview({ job, material })}
                                  aria-label={`预览 ${material.name}`}
                                >
                                  <img src={material.url} alt={`提取素材 ${index + 1}`} />
                                  <span className="material-index">
                                    {String(index + 1).padStart(2, '0')}
                                  </span>
                                  <span className="zoom-badge">
                                    <ZoomIn size={17} />
                                  </span>
                                </button>
                                <div className="material-details">
                                  <div>
                                    <strong title={material.name}>{material.name}</strong>
                                    <p>
                                      {material.width} × {material.height} <span>·</span> PNG
                                    </p>
                                  </div>
                                  <button
                                    className="icon-button"
                                    aria-label={`删除结果 ${material.name}`}
                                    onClick={() => removeMaterial(job.id, material.id)}
                                  >
                                    <Trash2 size={15} />
                                  </button>
                                </div>
                              </article>
                            ))}
                          </div>
                          {!job.materials.length && (
                            <p className="all-removed">
                              本组候选素材已全部移除。原图仍保留在队列中。
                            </p>
                          )}
                          <details className="quality-notes">
                            <summary>
                              <Info size={14} />
                              处理说明与复核提醒<span>{job.warnings.length} 条</span>
                            </summary>
                            <ul>
                              {job.warnings.map((warning, index) => (
                                <li key={index}>{warning}</li>
                              ))}
                            </ul>
                          </details>
                        </section>
                      ))
                  )}
                  <p className="results-footnote">
                    <ShieldCheck size={14} />
                    原图始终保留。导出前请确认人物数量、透明边缘和水印残留；刷新页面会清空本次图片与结果。
                  </p>
                </>
              )}
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>
            素材工厂 <span>·</span> 为每一份创意留出时间
          </span>
          <span>
            本地处理，安心创作 <ShieldCheck size={13} />
          </span>
        </footer>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        multiple
        className="visually-hidden"
        aria-label="导入图片文件"
        onChange={(event) => {
          if (event.target.files) void addFiles(Array.from(event.target.files));
          event.target.value = '';
        }}
      />
      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">
          {toast.error ? <Info size={18} /> : <CheckCircle2 size={18} />}
          <span>{toast.message}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {help && (
        <Modal title="从拼图，到独立素材" onClose={() => setHelp(false)}>
          <div className="guide-list">
            <div>
              <span>1</span>
              <p>
                <strong>导入图片</strong>选择 PNG、JPG、WebP，或载入内置示例。每批最多 30 张。
              </p>
            </div>
            <div>
              <span>2</span>
              <p>
                <strong>开始本地试提取</strong>
                适用于纯色背景、互不相连的角色。容差越大，去除的相近背景色越多。此模式不执行水印修复。
              </p>
            </div>
            <div>
              <span>3</span>
              <p>
                <strong>检查与导出</strong>在素材结果中放大检查，删除误识别区域，下载 ZIP
                或保存到文件夹。每个人物一个透明 PNG。
              </p>
            </div>
          </div>
          <div className="notice notice-warning">
            完整 AI 流程仍缺少真实修复与分割模型。DeepSeek
            视觉理解可在设置页单独测试；图片发送前需确认。
          </div>
          <p className="modal-copy">
            图片与结果仅保留在本次页面会话，刷新前请先导出。大图处理时最长边限制为 1600
            像素，并在结果中注明。仅处理自有或已获授权的素材。
          </p>
          <button className="button primary full-width" onClick={() => setHelp(false)}>
            知道了，开始创作
          </button>
        </Modal>
      )}
      {preview && currentPreviewJob && (
        <Modal
          title={preview.material ? '素材预览' : '原图预览'}
          onClose={() => setPreview(null)}
          wide
        >
          <div className={`preview-canvas ${preview.material ? 'checkerboard' : ''}`}>
            <img
              src={preview.material?.url || currentPreviewJob.url}
              alt={preview.material?.name || currentPreviewJob.file.name}
            />
          </div>
          <div className="preview-caption">
            <div>
              <strong>{preview.material?.name || currentPreviewJob.file.name}</strong>
              <p>
                {preview.material
                  ? `${preview.material.width} × ${preview.material.height} · 透明 PNG · 未执行水印修复`
                  : `${currentPreviewJob.width} × ${currentPreviewJob.height} · 原图保留`}
              </p>
            </div>
            {preview.material && (
              <button
                className="button primary"
                onClick={() => downloadBlob(preview.material!.blob, preview.material!.name)}
              >
                <ArrowDownToLine size={16} />
                下载 PNG
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M7 17 17 7M7 7h10v10" />
    </svg>
  );
}

export default App;
