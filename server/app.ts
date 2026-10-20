import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import sharp from 'sharp';
import { zip, type Zippable } from 'fflate';
import { Store, BudgetExceededError } from './store';
import { SessionManager } from './security';
import { processJob } from './processor';
import { DeepSeekService, FalService } from './providers/index';
import {
  ACTIVE_STATUSES,
  type Bounds,
  type ConfigUpdate,
  type Correction,
  type JobSnapshot,
  type StoredJob,
} from '../shared/contracts';
import {
  parseImageHeader,
  validateImportDimensions,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_PIXELS,
} from '../src/lib/image-header';
import { sanitizeFilename } from '../src/lib/export';

interface BuildOptions {
  dataDir: string;
  serveStatic?: boolean;
  process?: typeof processJob;
}

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function isLoopback(ip: string) {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('::ffff:127.') ||
    /^127\.\d+\.\d+\.\d+$/.test(ip)
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, '请求内容无效。');
  return value as Record<string, unknown>;
}

export function publicJob(job: StoredJob): JobSnapshot {
  return {
    id: job.id,
    filename: job.filename,
    width: job.width,
    height: job.height,
    originalUrl: '/api/jobs/' + job.id + '/source',
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    spentCny: job.spentCny,
    budgetCny: job.budgetCny,
    warnings: job.warnings,
    error: job.error,
    assets: job.assets
      .filter((asset) => asset.status !== 'deleted')
      .map((asset) => ({
        id: asset.id,
        label: asset.label,
        bounds: asset.bounds,
        kind: asset.kind,
        status: asset.status,
        width: asset.width,
        height: asset.height,
        warnings: asset.warnings,
        error: asset.error,
        previewUrl: asset.pngPath
          ? '/api/jobs/' +
            job.id +
            '/assets/' +
            asset.id +
            '/png?v=' +
            encodeURIComponent(asset.pngPath.split(/[\\/]/).pop() || '') +
            '-' +
            String(job.spentCny)
          : undefined,
        maskUrl: asset.watermarkPath
          ? '/api/jobs/' + job.id + '/assets/' + asset.id + '/mask?v=' + String(job.spentCny)
          : undefined,
      })),
  };
}

function validateBounds(value: unknown, job: StoredJob): Bounds {
  const box = record(value);
  const { x, y, width, height } = box;
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item)))
    throw new HttpError(400, '范围必须使用有效的原图像素坐标。');
  const result = {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number),
  };
  if (
    result.x < 0 ||
    result.y < 0 ||
    result.width < 2 ||
    result.height < 2 ||
    result.x + result.width > job.width ||
    result.y + result.height > job.height
  )
    throw new HttpError(400, '素材范围超出原图。');
  return result;
}

function correctionInput(value: unknown, job: StoredJob): Correction {
  const data = record(value);
  const result: Correction = {};
  if (data.bounds !== undefined) result.bounds = validateBounds(data.bounds, job);
  if (data.label !== undefined) {
    if (typeof data.label !== 'string' || !data.label.trim() || data.label.length > 100)
      throw new HttpError(400, '素材名称需要 1–100 个字符。');
    result.label = data.label.trim();
  }
  if (data.kind !== undefined) {
    if (data.kind !== 'rectangle' && data.kind !== 'cutout')
      throw new HttpError(400, '素材类型无效。');
    result.kind = data.kind;
  }
  if (data.mergeIds !== undefined) {
    if (
      !Array.isArray(data.mergeIds) ||
      data.mergeIds.length > 100 ||
      data.mergeIds.some(
        (id) =>
          typeof id !== 'string' ||
          !job.assets.some((asset) => asset.id === id && asset.status !== 'deleted'),
      )
    )
      throw new HttpError(400, '合并对象无效。');
    result.mergeIds = [...new Set(data.mergeIds as string[])];
  }
  if (data.strokes !== undefined) {
    if (!Array.isArray(data.strokes) || data.strokes.length > 200)
      throw new HttpError(400, '画笔操作过多，请分次提交。');
    let pointCount = 0;
    result.strokes = data.strokes.map((value) => {
      const stroke = record(value);
      if (
        (stroke.mode !== 'add' && stroke.mode !== 'erase') ||
        typeof stroke.radius !== 'number' ||
        stroke.radius < 0.5 ||
        stroke.radius > 200 ||
        !Array.isArray(stroke.points) ||
        !stroke.points.length
      )
        throw new HttpError(400, '画笔数据无效。');
      pointCount += stroke.points.length;
      if (pointCount > 20000) throw new HttpError(400, '画笔操作过多，请分次提交。');
      return {
        mode: stroke.mode,
        radius: stroke.radius,
        points: stroke.points.map((value) => {
          const point = record(value);
          if (
            typeof point.x !== 'number' ||
            typeof point.y !== 'number' ||
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y) ||
            point.x < 0 ||
            point.y < 0 ||
            point.x > job.width ||
            point.y > job.height
          )
            throw new HttpError(400, '画笔位置超出原图。');
          return { x: point.x, y: point.y };
        }),
      };
    });
  }
  return result;
}

export async function buildApp(options: BuildOptions) {
  const store = new Store(resolve(options.dataDir));
  const sessions = new SessionManager(store.getSessionSecret());
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024, trustProxy: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_IMPORT_BYTES, files: 1, parts: 3 } });
  const contexts = new WeakMap<FastifyRequest, { ownerId: string; local: boolean }>();
  const uploadingOwners = new Set<string>();
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const pending: Array<{ jobId: string; assetId?: string }> = [];
  let active: { jobId: string; controller: AbortController } | null = null;
  let draining: Promise<void> | null = null;
  let closed = false;
  const run = options.process || processJob;

  const errorMessage = (error: unknown) => {
    let message = error instanceof Error ? error.message.slice(0, 600) : '处理失败，请重试。';
    const config = store.getRuntimeConfig();
    for (const key of [config.deepseekKey, config.falKey])
      if (key) message = message.split(key).join('[已隐藏]');
    return message;
  };

  async function drain() {
    while (pending.length && !closed) {
      const operation = pending.shift()!;
      const job = store.getJob(operation.jobId);
      if (!job) continue;
      const controller = new AbortController();
      active = { jobId: job.id, controller };
      try {
        const config = store.getRuntimeConfig();
        if (!config.deepseekKey || !config.falKey || !config.deepseekEnabled || !config.falEnabled)
          throw new Error('模型服务尚未配置或已停用，请联系管理员。');
        await run(
          {
            job,
            config,
            signal: controller.signal,
            save: (value) => store.saveJob(value),
            reserve: (amount, label) => {
              if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
              store.reserve(job.id, amount, label);
              job.spentCny = store.getJob(job.id)?.spentCny || job.spentCny;
            },
          },
          operation.assetId,
        );
        if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
        if (ACTIVE_STATUSES.includes(job.status)) {
          job.status = job.assets.some((asset) => asset.status === 'failed') ? 'partial' : 'review';
          job.stage = '处理结束，请检查结果';
          store.saveJob(job);
        }
      } catch (error) {
        job.status = controller.signal.aborted
          ? 'cancelled'
          : error instanceof BudgetExceededError ||
              (error instanceof Error && error.name === 'BudgetExceededError')
            ? 'budget_paused'
            : 'failed';
        job.stage =
          job.status === 'cancelled'
            ? '已停止，保留已完成结果'
            : job.status === 'budget_paused'
              ? '费用预留达到上限，等待管理员审批'
              : '处理未完成';
        job.error = controller.signal.aborted ? undefined : errorMessage(error);
        for (const asset of job.assets)
          if (asset.status === 'processing') {
            asset.status = 'failed';
            asset.error = job.error || '处理已取消，可局部重试。';
          }
        store.saveJob(job);
      } finally {
        active = null;
      }
    }
  }

  function enqueue(jobId: string, assetId?: string) {
    if (active?.jobId === jobId || pending.some((item) => item.jobId === jobId))
      throw new HttpError(409, '该任务正在处理或排队，请稍候。');
    pending.push({ jobId, assetId });
    if (!draining) {
      draining = drain().finally(() => {
        draining = null;
        if (pending.length && !closed) enqueueDrain();
      });
    }
  }
  function enqueueDrain() {
    if (!draining)
      draining = drain().finally(() => {
        draining = null;
        if (pending.length && !closed) enqueueDrain();
      });
  }
  function ownJob(request: FastifyRequest, id: string) {
    const job = store.getJob(id);
    if (!job || job.ownerId !== contexts.get(request)?.ownerId)
      throw new HttpError(404, '任务不存在或已过期。');
    return job;
  }
  function requireIdle(job: StoredJob) {
    if (active?.jobId === job.id || pending.some((item) => item.jobId === job.id))
      throw new HttpError(409, '请先停止当前处理，再修改结果。');
  }
  function requireAdmin(request: FastifyRequest) {
    if (!contexts.get(request)?.local)
      throw new HttpError(403, '管理员设置仅允许在服务主机本机打开。');
    if (!sessions.isAdmin(request.cookies.ap_admin)) throw new HttpError(401, '请先登录管理员。');
  }
  function requireReady() {
    const config = store.getRuntimeConfig();
    if (
      !store.hasAdmin() ||
      !config.deepseekKey ||
      !config.falKey ||
      !config.deepseekEnabled ||
      !config.falEnabled
    )
      throw new HttpError(409, '请管理员先配置并开启 DeepSeek 和 fal 服务。');
  }
  async function sendImage(reply: FastifyReply, path: string | undefined) {
    if (!path) throw new HttpError(404, '该图片尚未生成。');
    const inside = relative(store.dataDir, path);
    if (inside.startsWith('..') || resolve(path) === resolve(store.dataDir))
      throw new HttpError(404, '图片不可用。');
    try {
      await access(path);
    } catch {
      throw new HttpError(404, '图片已过期或不可用。');
    }
    reply.type('image/png');
    return reply.send(createReadStream(path));
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const identity = sessions.employee(request.cookies.ap_employee);
    if (identity.fresh)
      reply.setCookie('ap_employee', identity.token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 86400,
      });
    const local =
      isLoopback(request.ip) &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(request.hostname);
    contexts.set(request, { ownerId: identity.ownerId, local });
    if (request.url.startsWith('/api/admin/') && !local)
      throw new HttpError(403, '管理员设置仅允许在服务主机本机打开。');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers['x-ai-picture'] !== '1')
        throw new HttpError(403, '缺少请求校验，请从本应用操作。');
      const origin = request.headers.origin;
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          throw new HttpError(403, '请求来源无效。');
        }
        if (host !== request.headers.host) throw new HttpError(403, '不允许跨站操作。');
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : error &&
            typeof error === 'object' &&
            'statusCode' in error &&
            typeof error.statusCode === 'number' &&
            error.statusCode >= 400 &&
            error.statusCode < 500
          ? error.statusCode
          : 500;
    reply
      .code(statusCode)
      .send({
        error:
          error instanceof HttpError
            ? error.message
            : statusCode === 413
              ? '单张图片不能超过 25 MB。'
              : statusCode < 500
                ? '请求数据无效，请检查后重试。'
                : '服务暂时无法完成请求，请重试或联系管理员。',
      });
  });

  app.get('/api/status', async (request) => {
    const config = store.getPublicConfig();
    const configured = config.deepseek.configured && config.fal.configured;
    return {
      configured,
      available: configured && config.deepseek.enabled && config.fal.enabled && store.hasAdmin(),
      adminSetupRequired: !store.hasAdmin(),
      adminLocal: contexts.get(request)!.local,
      message: configured
        ? '图像将由 DeepSeek 和 fal 协同处理，结果需要检查。'
        : '管理员尚未配置完整的模型服务。',
    };
  });
  app.get('/api/jobs', async (request) => ({
    jobs: store.listJobs(contexts.get(request)!.ownerId).map(publicJob),
  }));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request) =>
    publicJob(ownJob(request, request.params.id)),
  );
  app.get<{ Params: { id: string } }>('/api/jobs/:id/source', async (request, reply) =>
    sendImage(reply, ownJob(request, request.params.id).sourcePath),
  );

  app.post('/api/jobs', async (request, reply) => {
    requireReady();
    if (request.headers['x-image-consent'] !== 'confirmed')
      throw new HttpError(400, '请先确认本图及裁剪图的外发处理。');
    const ownerId = contexts.get(request)!.ownerId;
    if (
      uploadingOwners.has(ownerId) ||
      store.listJobs(ownerId).some((job) => ACTIVE_STATUSES.includes(job.status))
    ) {
      throw new HttpError(409, '当前浏览器已有正在上传或处理的图片。');
    }
    // Reserve this employee before the first asynchronous read/decode. Otherwise
    // concurrent uploads can both pass the active-task check and start paid work.
    uploadingOwners.add(ownerId);
    try {
      const file = await request.file();
      if (!file) throw new HttpError(400, '请选择一张 PNG、JPG 或 WebP 图片。');
      const buffer = await file.toBuffer();
      let normalized: { data: Buffer; info: sharp.OutputInfo };
      try {
        validateImportDimensions(parseImageHeader(buffer));
        normalized = await sharp(buffer, { limitInputPixels: MAX_IMPORT_PIXELS })
          .rotate()
          .ensureAlpha()
          .png()
          .toBuffer({ resolveWithObject: true });
      } catch {
        throw new HttpError(
          400,
          '图片损坏、不受支持或超过 4000 万像素，请重新导出 PNG、JPG、WebP。',
        );
      }
      const job = store.createJob(ownerId, {
        filename: sanitizeFilename(file.filename),
        width: normalized.info.width,
        height: normalized.info.height,
        sourcePath: '',
      });
      job.sourcePath = join(store.dataDir, 'jobs', job.id, 'source.png');
      try {
        await writeFile(job.sourcePath, normalized.data);
        store.saveJob(job);
        enqueue(job.id);
        return reply.code(202).send(publicJob(store.getJob(job.id)!));
      } catch (error) {
        job.status = 'failed';
        job.stage = '保存原图失败';
        job.error = '原图未保存，请重新上传。';
        store.saveJob(job);
        throw error;
      }
    } finally {
      uploadingOwners.delete(ownerId);
    }
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request) => {
    const job = ownJob(request, request.params.id);
    if (active?.jobId === job.id) {
      active.controller.abort();
      job.stage = '正在停止，已提交调用仍可能计费';
      store.saveJob(job);
    } else {
      for (let index = pending.length - 1; index >= 0; index--)
        if (pending[index].jobId === job.id) pending.splice(index, 1);
      if (ACTIVE_STATUSES.includes(job.status)) {
        job.status = 'cancelled';
        job.stage = '已取消排队';
        store.saveJob(job);
      }
    }
    return publicJob(store.getJob(job.id)!);
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request) => {
    requireReady();
    const job = ownJob(request, request.params.id);
    requireIdle(job);
    if (job.spentCny >= job.budgetCny)
      throw new HttpError(409, '费用预留已达上限，请管理员审批后再重试。');
    job.status = 'queued';
    job.stage = '等待继续处理';
    job.error = undefined;
    store.saveJob(job);
    enqueue(job.id);
    return publicJob(store.getJob(job.id)!);
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/assets', async (request) => {
    requireReady();
    const job = ownJob(request, request.params.id);
    requireIdle(job);
    const correction = correctionInput(request.body, job);
    if (!correction.bounds) throw new HttpError(400, '请在原图上框选需要补充的完整素材。');
    const id = randomUUID();
    const candidate = {
      id,
      label: correction.label || '补充素材',
      bounds: correction.bounds,
      kind: correction.kind || ('cutout' as const),
      prompt:
        'the complete graphic design in the indicated box, including its text and decorations',
    };
    job.assets.push({
      id,
      label: candidate.label,
      bounds: candidate.bounds,
      kind: candidate.kind,
      status: 'pending',
      warnings: [],
      candidate,
      correction,
    });
    job.status = 'queued';
    job.stage = '补充素材已排队';
    job.error = undefined;
    store.saveJob(job);
    enqueue(job.id, id);
    return publicJob(store.getJob(job.id)!);
  });

  app.patch<{ Params: { id: string; assetId: string } }>(
    '/api/jobs/:id/assets/:assetId',
    async (request) => {
      requireReady();
      const job = ownJob(request, request.params.id);
      requireIdle(job);
      const asset = job.assets.find(
        (item) => item.id === request.params.assetId && item.status !== 'deleted',
      );
      if (!asset) throw new HttpError(404, '素材不存在。');
      const correction = correctionInput(request.body, job);
      const previous = asset.correction || {};
      const combinedStrokes = [...(previous.strokes || []), ...(correction.strokes || [])];
      if (
        combinedStrokes.length > 200 ||
        combinedStrokes.reduce((sum, stroke) => sum + stroke.points.length, 0) > 20000
      )
        throw new HttpError(400, '累计画笔操作过多，请先完成当前修正。');
      asset.correction = { ...previous, ...correction, strokes: combinedStrokes };
      asset.status = 'pending';
      asset.error = undefined;
      job.status = 'queued';
      job.stage = '局部修正已排队';
      job.error = undefined;
      store.saveJob(job);
      enqueue(job.id, asset.id);
      return publicJob(store.getJob(job.id)!);
    },
  );

  app.delete<{ Params: { id: string; assetId: string } }>(
    '/api/jobs/:id/assets/:assetId',
    async (request) => {
      const job = ownJob(request, request.params.id);
      requireIdle(job);
      const asset = job.assets.find((item) => item.id === request.params.assetId);
      if (!asset) throw new HttpError(404, '素材不存在。');
      asset.status = 'deleted';
      store.saveJob(job);
      return publicJob(store.getJob(job.id)!);
    },
  );
  app.post<{ Params: { id: string; assetId: string } }>(
    '/api/jobs/:id/assets/:assetId/approve',
    async (request) => {
      const job = ownJob(request, request.params.id);
      requireIdle(job);
      const asset = job.assets.find(
        (item) => item.id === request.params.assetId && item.status !== 'deleted',
      );
      if (!asset) throw new HttpError(404, '素材不存在。');
      if (asset.status !== 'review' && asset.status !== 'ready') {
        throw new HttpError(409, '该素材尚未成功处理，请完成处理或重试后再确认。');
      }
      if (!asset.pngPath) throw new HttpError(400, '没有可确认的 PNG。');
      asset.status = 'ready';
      asset.error = undefined;
      store.saveJob(job);
      return publicJob(store.getJob(job.id)!);
    },
  );
  app.post<{ Params: { id: string } }>('/api/jobs/:id/approve', async (request) => {
    const job = ownJob(request, request.params.id);
    requireIdle(job);
    const visible = job.assets.filter((asset) => asset.status !== 'deleted');
    if (
      !visible.some(
        (asset) => asset.pngPath && (asset.status === 'review' || asset.status === 'ready'),
      )
    ) {
      throw new HttpError(400, '没有可确认的 PNG。');
    }
    for (const asset of visible)
      if (asset.pngPath && asset.status === 'review') {
        asset.status = 'ready';
        asset.error = undefined;
      }
    // Confirming finished results must not dismiss a task-level interruption or
    // remove a budget pause from the administrator's approval queue.
    if (job.status === 'review' || job.status === 'partial' || job.status === 'completed') {
      job.status = visible.every((asset) => asset.status === 'ready' && asset.pngPath)
        ? 'completed'
        : 'partial';
      job.stage = job.status === 'completed' ? '结果已确认' : '已确认可用素材，其余待处理';
    }
    store.saveJob(job);
    return publicJob(store.getJob(job.id)!);
  });

  app.get<{ Params: { id: string; assetId: string } }>(
    '/api/jobs/:id/assets/:assetId/png',
    async (request, reply) => {
      const job = ownJob(request, request.params.id);
      const asset = job.assets.find(
        (item) => item.id === request.params.assetId && item.status !== 'deleted',
      );
      if (!asset) throw new HttpError(404, '素材不存在。');
      return sendImage(reply, asset.pngPath);
    },
  );
  app.get<{ Params: { id: string; assetId: string } }>(
    '/api/jobs/:id/assets/:assetId/mask',
    async (request, reply) => {
      const job = ownJob(request, request.params.id);
      const asset = job.assets.find(
        (item) => item.id === request.params.assetId && item.status !== 'deleted',
      );
      if (!asset) throw new HttpError(404, '素材不存在。');
      return sendImage(reply, asset.watermarkPath);
    },
  );
  app.get<{ Params: { id: string } }>('/api/jobs/:id/zip', async (request, reply) => {
    const job = ownJob(request, request.params.id);
    const assets = job.assets.filter((asset) => asset.status === 'ready' && asset.pngPath);
    if (!assets.length) throw new HttpError(400, '请先检查并确认要导出的结果。');
    const archive: Zippable = Object.create(null) as Zippable;
    const used = new Set<string>();
    for (let index = 0; index < assets.length; index++) {
      const asset = assets[index];
      const base = sanitizeFilename(asset.label);
      let name = base + '.png';
      let suffix = 2;
      while (used.has(name.toLowerCase())) name = base + '_' + suffix++ + '.png';
      used.add(name.toLowerCase());
      archive[name] = new Uint8Array(await readFile(asset.pngPath!));
    }
    const data = await new Promise<Uint8Array>((resolveZip, reject) =>
      zip(archive, { level: 0 }, (error, result) => (error ? reject(error) : resolveZip(result))),
    );
    reply
      .type('application/zip')
      .header(
        'Content-Disposition',
        "attachment; filename*=UTF-8''" +
          encodeURIComponent(sanitizeFilename(job.filename.replace(/\.[^.]+$/, '')) + '_素材.zip'),
      );
    return reply.send(Buffer.from(data));
  });

  app.get('/api/admin/session', async (request) => ({
    setupRequired: !store.hasAdmin(),
    authenticated: sessions.isAdmin(request.cookies.ap_admin),
  }));
  app.post('/api/admin/setup', async (request, reply) => {
    if (store.hasAdmin()) throw new HttpError(409, '管理员已创建，请登录。');
    const { password } = record(request.body);
    if (typeof password !== 'string' || password.length < 10 || password.length > 200)
      throw new HttpError(400, '管理员密码需要 10–200 个字符。');
    store.setAdminPassword(password);
    reply.setCookie('ap_admin', sessions.adminToken(), {
      httpOnly: true,
      sameSite: 'strict',
      path: '/api/admin',
      maxAge: 8 * 3600,
    });
    return { authenticated: true };
  });
  app.post('/api/admin/login', async (request, reply) => {
    const { password } = record(request.body);
    const previous = loginAttempts.get(request.ip);
    if (previous && previous.count >= 5 && previous.until > Date.now())
      throw new HttpError(429, '尝试次数较多，请五分钟后再试。');
    if (
      typeof password !== 'string' ||
      password.length > 200 ||
      !store.verifyAdminPassword(password)
    ) {
      loginAttempts.set(request.ip, {
        count: previous && previous.until > Date.now() ? previous.count + 1 : 1,
        until: Date.now() + 300000,
      });
      throw new HttpError(401, '管理员密码不正确。');
    }
    loginAttempts.delete(request.ip);
    reply.setCookie('ap_admin', sessions.adminToken(), {
      httpOnly: true,
      sameSite: 'strict',
      path: '/api/admin',
      maxAge: 8 * 3600,
    });
    return { authenticated: true };
  });
  app.post('/api/admin/logout', async (_request, reply) => {
    reply.clearCookie('ap_admin', { path: '/api/admin' });
    return { authenticated: false };
  });
  app.get('/api/admin/config', async (request) => {
    requireAdmin(request);
    return store.getPublicConfig();
  });
  app.patch('/api/admin/config', async (request) => {
    requireAdmin(request);
    const data = record(request.body);
    const update: ConfigUpdate = {};
    for (const key of ['deepseekKey', 'falKey'] as const)
      if (data[key] !== undefined) {
        if (
          typeof data[key] !== 'string' ||
          (data[key].length !== 0 && data[key].length < 8) ||
          data[key].length > 500 ||
          /[\r\n]/.test(data[key])
        )
          throw new HttpError(400, 'Key 格式不正确。');
        update[key] = data[key].trim();
      }
    for (const key of ['deepseekEnabled', 'falEnabled'] as const)
      if (data[key] !== undefined) {
        if (typeof data[key] !== 'boolean') throw new HttpError(400, '服务状态无效。');
        update[key] = data[key];
      }
    if (data.budgetCny !== undefined) {
      if (
        typeof data.budgetCny !== 'number' ||
        !Number.isFinite(data.budgetCny) ||
        data.budgetCny < 1 ||
        data.budgetCny > 1000
      )
        throw new HttpError(400, '默认预算应在 1–1000 元之间。');
      update.budgetCny = data.budgetCny;
    }
    return store.updateConfig(update);
  });
  app.post('/api/admin/test', async (request) => {
    requireAdmin(request);
    const { provider, consent } = record(request.body);
    const config = store.getRuntimeConfig();
    let reserved = 0;
    const reserve = (amount: number) => {
      reserved += amount;
      if (reserved > 1) throw new HttpError(400, '连接测试费用预留超出上限。');
    };
    if (provider === 'deepseek') {
      if (!config.deepseekKey) throw new HttpError(400, '请先保存 DeepSeek Key。');
      try {
        return await new DeepSeekService(config.deepseekKey, reserve).testConnection();
      } catch (error) {
        throw new HttpError(502, errorMessage(error));
      }
    }
    if (provider === 'fal') {
      if (consent !== true)
        throw new HttpError(400, '请确认调用内置示例测试，可能产生一次分割费用。');
      if (!config.falKey) throw new HttpError(400, '请先保存 fal Key。');
      try {
        return await new FalService(config.falKey, reserve).testConnection();
      } catch (error) {
        throw new HttpError(502, errorMessage(error));
      }
    }
    throw new HttpError(400, '未知的模型服务。');
  });
  app.get('/api/admin/failures', async (request) => {
    requireAdmin(request);
    return {
      failures: store.recentFailures(),
      paused: store
        .listBudgetPaused()
        .map((job) => ({
          id: job.id,
          filename: job.filename,
          spentCny: job.spentCny,
          budgetCny: job.budgetCny,
        })),
    };
  });
  app.post<{ Params: { id: string } }>('/api/admin/jobs/:id/budget', async (request) => {
    requireAdmin(request);
    const { budgetCny } = record(request.body);
    if (
      typeof budgetCny !== 'number' ||
      !Number.isFinite(budgetCny) ||
      budgetCny < 1 ||
      budgetCny > 1000
    )
      throw new HttpError(400, '任务预算应在 1–1000 元之间。');
    const job = store.getJob(request.params.id);
    if (!job || budgetCny < job.spentCny)
      throw new HttpError(400, '任务不存在，或新预算低于已预留费用。');
    const updated = store.setJobBudget(job.id, budgetCny);
    return { id: updated.id, budgetCny: updated.budgetCny, spentCny: updated.spentCny };
  });

  const cleanup = setInterval(() => store.cleanupExpired(), 15 * 60 * 1000);
  cleanup.unref();
  store.cleanupExpired();
  app.addHook('onClose', async () => {
    closed = true;
    pending.length = 0;
    clearInterval(cleanup);
    active?.controller.abort();
    await draining;
    store.close();
  });
  if (options.serveStatic) {
    const dist = resolve('dist');
    await app.register(staticFiles, { root: dist, index: ['index.html'] });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在。' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
