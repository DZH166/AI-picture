import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import type { ProcessContext, processJob } from './processor';
import type { JobSnapshot, StoredAsset } from '../shared/contracts';
import { MAX_IMPORT_BYTES } from '../src/lib/image-header';

type App = Awaited<ReturnType<typeof buildApp>>;
type Process = typeof processJob;
const applications: App[] = [];
const directories: string[] = [];
const TEST_PASSWORD = 'temporary-test-password-123';
const TEST_DEEPSEEK_KEY = 'test-only-http-deepseek-key-1234';
const TEST_FAL_KEY = 'test-only-http-fal-key-5678';
const CLIENT_A = '192.168.20.11';
const CLIENT_B = '192.168.20.12';
const boundary = 'ai-picture-test-boundary';

function cookies(response: { cookies: Array<{ name: string; value: string }> }): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function headers(cookie = '', additions: Record<string, string> = {}): Record<string, string> {
  return {
    host: 'localhost',
    origin: 'http://localhost',
    'x-ai-picture': '1',
    ...(cookie ? { cookie } : {}),
    ...additions,
  };
}

const finish: Process = async ({ job, save }) => {
  job.status = 'review';
  job.stage = '模拟处理完成';
  save(job);
};

async function application(process: Process = finish): Promise<App> {
  const dataDir = mkdtempSync(join(tmpdir(), 'AI-picture-http-test-'));
  directories.push(dataDir);
  const app = await buildApp({ dataDir, process });
  applications.push(app);
  return app;
}

async function initialize(app: App): Promise<string> {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/admin/setup',
    remoteAddress: '127.0.0.1',
    headers: headers(),
    payload: { password: TEST_PASSWORD },
  });
  expect(setup.statusCode).toBe(200);
  const admin = cookies(setup);
  const configured = await app.inject({
    method: 'PATCH',
    url: '/api/admin/config',
    remoteAddress: '127.0.0.1',
    headers: headers(admin),
    payload: { deepseekKey: TEST_DEEPSEEK_KEY, falKey: TEST_FAL_KEY },
  });
  expect(configured.statusCode).toBe(200);
  return admin;
}

async function employee(app: App, ip = CLIENT_A): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { host: 'localhost' },
    remoteAddress: ip,
  });
  expect(response.statusCode).toBe(200);
  return cookies(response);
}

async function png(width = 48, height = 40): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 220, g: 50, b: 100, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}

function multipart(image: Buffer, filename = 'original.png'): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function upload(
  app: App,
  cookie: string,
  image: Buffer,
  options: { ip?: string; consent?: boolean; filename?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/jobs',
    remoteAddress: options.ip || CLIENT_A,
    headers: headers(cookie, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...(options.consent === false ? {} : { 'x-image-consent': 'confirmed' }),
    }),
    payload: multipart(image, options.filename),
  });
}

async function snapshot(app: App, cookie: string, id: string): Promise<JobSnapshot> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/jobs/${id}`,
    headers: headers(cookie),
    remoteAddress: CLIENT_A,
  });
  expect(response.statusCode).toBe(200);
  return response.json<JobSnapshot>();
}

async function untilJob(
  app: App,
  cookie: string,
  id: string,
  condition: (job: JobSnapshot) => boolean,
): Promise<JobSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await snapshot(app, cookie, id);
    if (condition(current)) return current;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('Mock processing did not reach the expected state.');
}

async function mutate(
  app: App,
  cookie: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  ip = CLIENT_A,
) {
  return app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: headers(cookie),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function addAsset(
  ctx: ProcessContext,
  id: string,
  status: StoredAsset['status'],
  label = '人物',
): Promise<StoredAsset> {
  const bounds = { x: 1, y: 1, width: 16, height: 16 };
  const path = join(dirname(ctx.job.sourcePath), `${id}.png`);
  await writeFile(path, await png(16, 16));
  const asset: StoredAsset = {
    id,
    label,
    bounds,
    kind: 'cutout',
    status,
    width: 16,
    height: 16,
    warnings: [],
    pngPath: path,
    watermarkPath: path,
    candidate: { id, label, bounds, kind: 'cutout', prompt: 'mock character' },
  };
  ctx.job.assets.push(asset);
  return asset;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const stop = () => reject(new DOMException('mock cancelled', 'AbortError'));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('FAL_KEY', '');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('External requests are forbidden in HTTP tests.')),
  );
});

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    const path = resolve(directory);
    const fromTemporaryRoot = relative(resolve(tmpdir()), path);
    if (
      !basename(path).startsWith('AI-picture-http-test-') ||
      fromTemporaryRoot === '..' ||
      fromTemporaryRoot.startsWith(`..${sep}`)
    ) {
      throw new Error('Refusing to remove an unexpected HTTP test directory.');
    }
    rmSync(path, { recursive: true, force: true });
  }
});

describe('administrator HTTP boundary', () => {
  it('allows setup and login only on the local service host, including with a valid admin cookie', async () => {
    const app = await application();
    const remote = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      headers: headers(),
      remoteAddress: CLIENT_A,
      payload: { password: TEST_PASSWORD },
    });
    expect(remote.statusCode).toBe(403);
    const admin = await initialize(app);
    const remoteConfig = await app.inject({
      method: 'GET',
      url: '/api/admin/config',
      headers: headers(admin),
      remoteAddress: CLIENT_A,
    });
    expect(remoteConfig.statusCode).toBe(403);
    const remoteLogin = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      headers: headers(admin, { 'x-forwarded-for': '127.0.0.1' }),
      remoteAddress: CLIENT_B,
      payload: { password: TEST_PASSWORD },
    });
    expect(remoteLogin.statusCode).toBe(403);
    const rebind = await app.inject({
      method: 'GET',
      url: '/api/admin/config',
      headers: headers(admin, { host: 'evil.example' }),
      remoteAddress: '127.0.0.1',
    });
    expect(rebind.statusCode).toBe(403);
    const mappedLocal = await app.inject({
      method: 'GET',
      url: '/api/admin/session',
      headers: headers(admin),
      remoteAddress: '::ffff:127.0.0.1',
    });
    expect(mappedLocal.statusCode).toBe(200);
    expect(mappedLocal.json().authenticated).toBe(true);
  });

  it('requires valid setup/passwords, does not reinitialize, and marks cookies HttpOnly and SameSite', async () => {
    const app = await application();
    expect(
      (await mutate(app, '', 'POST', '/api/admin/setup', { password: 'short' }, '127.0.0.1'))
        .statusCode,
    ).toBe(400);
    const setup = await mutate(
      app,
      '',
      'POST',
      '/api/admin/setup',
      { password: TEST_PASSWORD },
      '127.0.0.1',
    );
    expect(setup.statusCode).toBe(200);
    expect(String(setup.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(setup.headers['set-cookie'])).toContain('SameSite=Strict');
    expect(
      (await mutate(app, '', 'POST', '/api/admin/setup', { password: TEST_PASSWORD }, '127.0.0.1'))
        .statusCode,
    ).toBe(409);
    expect(
      (await mutate(app, '', 'POST', '/api/admin/login', { password: 'wrong' }, '127.0.0.1'))
        .statusCode,
    ).toBe(401);
    const login = await mutate(
      app,
      '',
      'POST',
      '/api/admin/login',
      { password: TEST_PASSWORD },
      '127.0.0.1',
    );
    expect(login.statusCode).toBe(200);
    const session = await app.inject({
      url: '/api/admin/session',
      headers: headers(cookies(login)),
      remoteAddress: '127.0.0.1',
    });
    expect(session.json().authenticated).toBe(true);
  });

  it('requires the CSRF header and rejects cross-site or malformed Origins before mutation', async () => {
    const app = await application();
    for (const requestHeaders of [
      { host: 'localhost', origin: 'http://localhost' },
      headers('', { origin: 'https://evil.example' }),
      headers('', { origin: 'null' }),
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/setup',
        headers: requestHeaders,
        remoteAddress: '127.0.0.1',
        payload: { password: TEST_PASSWORD },
      });
      expect(response.statusCode).toBe(403);
    }
    const status = await app.inject({ url: '/api/status' });
    expect(status.json().adminSetupRequired).toBe(true);
    await initialize(app);
  });

  it('rate-limits repeated incorrect administrator passwords without exposing credentials', async () => {
    const app = await application();
    await initialize(app);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const denied = await mutate(
        app,
        '',
        'POST',
        '/api/admin/login',
        { password: 'incorrect-temporary-password' },
        '127.0.0.1',
      );
      expect(denied.statusCode).toBe(401);
      expect(denied.body).not.toContain(TEST_PASSWORD);
      expect(denied.body).not.toContain(TEST_DEEPSEEK_KEY);
    }
    const throttled = await mutate(
      app,
      '',
      'POST',
      '/api/admin/login',
      { password: TEST_PASSWORD },
      '127.0.0.1',
    );
    expect(throttled.statusCode).toBe(429);
  });

  it('returns only masks for configured keys and denies an employee admin access', async () => {
    const app = await application();
    const admin = await initialize(app);
    const configuration = await app.inject({
      url: '/api/admin/config',
      headers: headers(admin),
      remoteAddress: '127.0.0.1',
    });
    expect(configuration.statusCode).toBe(200);
    expect(configuration.json().deepseek.masked).toBe('••••1234');
    expect(configuration.json().fal.masked).toBe('••••5678');
    expect(configuration.body).not.toContain(TEST_DEEPSEEK_KEY);
    expect(configuration.body).not.toContain(TEST_FAL_KEY);
    const worker = await employee(app);
    const status = await app.inject({
      url: '/api/status',
      headers: headers(worker),
      remoteAddress: CLIENT_A,
    });
    expect(status.body).not.toMatch(/deepseekKey|falKey|masked/);
    const localEmployee = await app.inject({
      url: '/api/admin/config',
      headers: headers(worker),
      remoteAddress: '127.0.0.1',
    });
    expect(localEmployee.statusCode).toBe(401);
    const updated = await mutate(
      app,
      admin,
      'PATCH',
      '/api/admin/config',
      { deepseekKey: 'replacement-test-key-9876', falEnabled: false },
      '127.0.0.1',
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain('replacement-test-key-9876');
    expect(updated.json().deepseek.masked).toBe('••••9876');
    expect(updated.json().fal.enabled).toBe(false);
  });
});

describe('upload and employee ownership', () => {
  it('accepts only one of two concurrent uploads from the same employee and starts paid work once', async () => {
    const process = vi.fn<Process>(async (ctx) => {
      await ctx.reserve(1, 'one accepted task');
      ctx.job.status = 'analyzing';
      ctx.save(ctx.job);
      await waitForAbort(ctx.signal);
    });
    const app = await application(process);
    await initialize(app);
    const worker = await employee(app);
    const image = await png(900, 900);
    const responses = await Promise.all([upload(app, worker, image), upload(app, worker, image)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    const accepted = responses.find((response) => response.statusCode === 202)!;
    const id = accepted.json<JobSnapshot>().id;
    const current = await untilJob(app, worker, id, (job) => job.status === 'analyzing');
    expect(current.spentCny).toBe(1);
    const list = await app.inject({
      url: '/api/jobs',
      headers: headers(worker),
      remoteAddress: CLIENT_A,
    });
    expect(list.json().jobs).toHaveLength(1);
    expect(process).toHaveBeenCalledOnce();
    expect((await mutate(app, worker, 'POST', `/api/jobs/${id}/cancel`)).statusCode).toBe(200);
    await untilJob(app, worker, id, (job) => job.status === 'cancelled');
  });

  it('releases the upload lock after a failed decode and after a successful upload', async () => {
    const process = vi.fn<Process>(finish);
    const app = await application(process);
    await initialize(app);
    const worker = await employee(app);
    expect((await upload(app, worker, Buffer.from('invalid image'))).statusCode).toBe(400);
    const first = await upload(app, worker, await png());
    expect(first.statusCode).toBe(202);
    await untilJob(app, worker, first.json<JobSnapshot>().id, (job) => job.status === 'review');
    const second = await upload(app, worker, await png());
    expect(second.statusCode).toBe(202);
    await untilJob(app, worker, second.json<JobSnapshot>().id, (job) => job.status === 'review');
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('requires configured services and explicit consent, and rejects unsupported or oversized input', async () => {
    const process = vi.fn<Process>(finish);
    const app = await application(process);
    const worker = await employee(app);
    const image = await png();
    expect((await upload(app, worker, image)).statusCode).toBe(409);
    await initialize(app);
    expect((await upload(app, worker, image, { consent: false })).statusCode).toBe(400);
    expect(
      (await upload(app, worker, Buffer.from('<svg>not a supported image</svg>'))).statusCode,
    ).toBe(400);
    expect((await upload(app, worker, await png(7, 8))).statusCode).toBe(400);
    const oversizedDimensions = Buffer.from(image);
    oversizedDimensions.writeUInt32BE(50000, 16);
    oversizedDimensions.writeUInt32BE(50000, 20);
    expect((await upload(app, worker, oversizedDimensions)).statusCode).toBe(400);
    expect((await upload(app, worker, Buffer.alloc(MAX_IMPORT_BYTES + 1))).statusCode).toBe(413);
    expect(process).not.toHaveBeenCalled();
  });

  it('keeps original resolution above 1600 pixels and stores source data under the actual job ID', async () => {
    const process = vi.fn<Process>(async (ctx) => {
      expect(basename(dirname(ctx.job.sourcePath))).toBe(ctx.job.id);
      const metadata = await sharp(await readFile(ctx.job.sourcePath)).metadata();
      expect(metadata.width).toBe(1800);
      expect(metadata.height).toBe(20);
      await finish(ctx);
    });
    const app = await application(process);
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png(1800, 20));
    expect(response.statusCode).toBe(202);
    const created = response.json<JobSnapshot>();
    expect(created.width).toBe(1800);
    expect(created.height).toBe(20);
    const done = await untilJob(
      app,
      worker,
      created.id,
      (job) => job.status === 'review' || job.status === 'failed',
    );
    expect(done.status).toBe('review');
    const source = await app.inject({
      url: done.originalUrl,
      headers: headers(worker),
      remoteAddress: CLIENT_A,
    });
    expect(source.statusCode).toBe(200);
    expect((await sharp(source.rawPayload).metadata()).width).toBe(1800);
    expect(process).toHaveBeenCalledOnce();
  });

  it('isolates list, job, original, PNG, mask and ZIP access across employee cookies', async () => {
    const app = await application(async (ctx) => {
      await addAsset(ctx, 'ready-asset', 'ready');
      await finish(ctx);
    });
    await initialize(app);
    const first = await employee(app, CLIENT_A);
    const second = await employee(app, CLIENT_B);
    expect(first).not.toBe(second);
    const response = await upload(app, first, await png());
    const id = response.json<JobSnapshot>().id;
    await untilJob(app, first, id, (job) => job.status === 'review');
    const ownList = await app.inject({
      url: '/api/jobs',
      headers: headers(first),
      remoteAddress: CLIENT_A,
    });
    expect(ownList.json().jobs).toHaveLength(1);
    const otherList = await app.inject({
      url: '/api/jobs',
      headers: headers(second),
      remoteAddress: CLIENT_B,
    });
    expect(otherList.json().jobs).toEqual([]);
    for (const path of [
      `/api/jobs/${id}`,
      `/api/jobs/${id}/source`,
      `/api/jobs/${id}/assets/ready-asset/png`,
      `/api/jobs/${id}/assets/ready-asset/mask`,
      `/api/jobs/${id}/zip`,
    ]) {
      const denied = await app.inject({
        url: path,
        headers: headers(second),
        remoteAddress: CLIENT_B,
      });
      expect(denied.statusCode).toBe(404);
      const permitted = await app.inject({
        url: path,
        headers: headers(first),
        remoteAddress: CLIENT_A,
      });
      expect(permitted.statusCode).toBe(200);
      expect(permitted.body).not.toContain(TEST_DEEPSEEK_KEY);
    }
    expect(
      (await mutate(app, second, 'POST', `/api/jobs/${id}/cancel`, undefined, CLIENT_B)).statusCode,
    ).toBe(404);
    const publicData = await snapshot(app, first, id);
    expect(JSON.stringify(publicData)).not.toMatch(
      /sourcePath|pngPath|ownerId|apiKey|falKey|deepseekKey/,
    );
  });
});

describe('task execution and export', () => {
  it('queues across employees, rejects a second active task in one browser, and cancels pending work', async () => {
    const calls: string[] = [];
    const process: Process = async (ctx) => {
      calls.push(ctx.job.id);
      await addAsset(ctx, 'retained', 'ready');
      ctx.job.status = 'repairing';
      ctx.save(ctx.job);
      await ctx.reserve(2, 'mock active work');
      await waitForAbort(ctx.signal);
    };
    const app = await application(process);
    await initialize(app);
    const first = await employee(app, CLIENT_A);
    const second = await employee(app, CLIENT_B);
    const a = await upload(app, first, await png());
    const idA = a.json<JobSnapshot>().id;
    await untilJob(app, first, idA, (job) => job.status === 'repairing');
    expect((await upload(app, first, await png())).statusCode).toBe(409);
    const b = await upload(app, second, await png(), { ip: CLIENT_B });
    expect(b.statusCode).toBe(202);
    const idB = b.json<JobSnapshot>().id;
    expect((await snapshot(app, second, idB)).status).toBe('queued');
    expect(calls).toEqual([idA]);
    expect(
      (await mutate(app, second, 'POST', `/api/jobs/${idB}/cancel`, undefined, CLIENT_B))
        .statusCode,
    ).toBe(200);
    expect((await snapshot(app, second, idB)).status).toBe('cancelled');
    expect((await mutate(app, first, 'POST', `/api/jobs/${idA}/cancel`)).statusCode).toBe(200);
    const stopped = await untilJob(app, first, idA, (job) => job.status === 'cancelled');
    expect(stopped.assets[0].status).toBe('ready');
    expect(stopped.spentCny).toBe(2);
    expect(calls).toEqual([idA]);
  });

  it('retains completed assets and accumulated cost when a failed task is retried', async () => {
    let attempts = 0;
    const app = await application(async (ctx) => {
      attempts += 1;
      await ctx.reserve(attempts === 1 ? 2 : 3, 'mock paid attempt');
      if (attempts === 1) {
        await addAsset(ctx, 'kept-from-first-attempt', 'ready');
        ctx.save(ctx.job);
        throw new Error(`simulated provider failure ${TEST_FAL_KEY}`);
      }
      expect(ctx.job.assets[0].id).toBe('kept-from-first-attempt');
      await addAsset(ctx, 'second-attempt', 'review');
      await finish(ctx);
    });
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    const failed = await untilJob(app, worker, id, (job) => job.status === 'failed');
    expect(failed.spentCny).toBe(2);
    expect(failed.assets).toHaveLength(1);
    expect(failed.error).not.toContain(TEST_FAL_KEY);
    expect((await mutate(app, worker, 'POST', `/api/jobs/${id}/retry`)).statusCode).toBe(200);
    const retried = await untilJob(app, worker, id, (job) => job.status === 'review');
    expect(retried.spentCny).toBe(5);
    expect(retried.assets.map((asset) => asset.id)).toEqual([
      'kept-from-first-attempt',
      'second-attempt',
    ]);
    expect(attempts).toBe(2);
  });

  it('exports only approved PNGs in a flat ZIP, with duplicate names disambiguated and original bytes retained', async () => {
    const app = await application(async (ctx) => {
      await addAsset(ctx, 'ready-one', 'ready', '同名');
      await addAsset(ctx, 'ready-two', 'ready', '同名');
      await addAsset(ctx, 'review', 'review');
      await addAsset(ctx, 'failed', 'failed');
      await addAsset(ctx, 'deleted', 'deleted');
      await finish(ctx);
    });
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    await untilJob(app, worker, id, (job) => job.status === 'review');
    const zip = await app.inject({
      url: `/api/jobs/${id}/zip`,
      headers: headers(worker),
      remoteAddress: CLIENT_A,
    });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    const files = unzipSync(zip.rawPayload);
    expect(Object.keys(files)).toEqual(['同名.png', '同名_2.png']);
    expect(files['同名.png']).toEqual(new Uint8Array(await png(16, 16)));
    expect(Object.keys(files).every((path) => !path.includes('/') && path.endsWith('.png'))).toBe(
      true,
    );
    const deleted = await app.inject({
      url: `/api/jobs/${id}/assets/deleted/png`,
      headers: headers(worker),
      remoteAddress: CLIENT_A,
    });
    expect(deleted.statusCode).toBe(404);
  });

  it('requires result approval before exporting a review-only job', async () => {
    const app = await application(async (ctx) => {
      await addAsset(ctx, 'review-only', 'review');
      await finish(ctx);
    });
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    await untilJob(app, worker, id, (job) => job.status === 'review');
    expect(
      (await app.inject({ url: `/api/jobs/${id}/zip`, headers: headers(worker) })).statusCode,
    ).toBe(400);
    const approved = await mutate(
      app,
      worker,
      'POST',
      `/api/jobs/${id}/assets/review-only/approve`,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json<JobSnapshot>().assets[0].status).toBe('ready');
    expect(
      (await app.inject({ url: `/api/jobs/${id}/zip`, headers: headers(worker) })).statusCode,
    ).toBe(200);
  });
});

describe('correction and budget HTTP boundaries', () => {
  it('rejects invalid bounds, brush strokes, merge IDs and labels before scheduling paid work', async () => {
    const process = vi.fn<Process>(async (ctx) => {
      await addAsset(ctx, 'editable', 'review');
      await finish(ctx);
    });
    const app = await application(process);
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    await untilJob(app, worker, id, (job) => job.status === 'review');
    const invalidCorrections = [
      { bounds: { x: -1, y: 0, width: 10, height: 10 } },
      { bounds: { x: 40, y: 0, width: 10, height: 10 } },
      { bounds: { x: 0, y: 0, width: 1, height: 10 } },
      { bounds: { x: '0', y: 0, width: 10, height: 10 } },
      { kind: 'unknown' },
      { label: '   ' },
      { mergeIds: ['other-job-asset'] },
      { strokes: [{ mode: 'paint', radius: 2, points: [{ x: 1, y: 1 }] }] },
      { strokes: [{ mode: 'add', radius: 0, points: [{ x: 1, y: 1 }] }] },
      { strokes: [{ mode: 'add', radius: 201, points: [{ x: 1, y: 1 }] }] },
      { strokes: [{ mode: 'erase', radius: 2, points: [] }] },
      { strokes: [{ mode: 'erase', radius: 2, points: [{ x: 49, y: 1 }] }] },
      {
        strokes: Array.from({ length: 201 }, () => ({
          mode: 'add',
          radius: 2,
          points: [{ x: 1, y: 1 }],
        })),
      },
      {
        strokes: [
          { mode: 'add', radius: 2, points: Array.from({ length: 20001 }, () => ({ x: 1, y: 1 })) },
        ],
      },
    ];
    for (const correction of invalidCorrections) {
      expect(
        (await mutate(app, worker, 'PATCH', `/api/jobs/${id}/assets/editable`, correction))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (await mutate(app, worker, 'POST', `/api/jobs/${id}/assets`, { label: 'missing bounds' }))
        .statusCode,
    ).toBe(400);
    expect(process).toHaveBeenCalledOnce();
    expect((await snapshot(app, worker, id)).assets[0].status).toBe('review');
  });

  it('passes validated original-pixel corrections to a single-asset retry and checks cumulative brush limits', async () => {
    const calls: Array<string | undefined> = [];
    const app = await application(async (ctx, assetId) => {
      calls.push(assetId);
      if (!assetId) {
        const editable = await addAsset(ctx, 'editable', 'review');
        editable.correction = {
          strokes: Array.from({ length: 199 }, () => ({
            mode: 'add',
            radius: 2,
            points: [{ x: 1, y: 1 }],
          })),
        };
      } else {
        const current = ctx.job.assets.find((asset) => asset.id === assetId)!;
        expect(current.correction!.bounds).toEqual({ x: 2, y: 3, width: 20, height: 25 });
        expect(current.correction!.strokes).toHaveLength(200);
        current.status = 'review';
      }
      await finish(ctx);
    });
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    await untilJob(app, worker, id, (job) => job.status === 'review');
    const stroke = { mode: 'erase', radius: 3, points: [{ x: 2, y: 3 }] };
    expect(
      (
        await mutate(app, worker, 'PATCH', `/api/jobs/${id}/assets/editable`, {
          strokes: [stroke, stroke],
        })
      ).statusCode,
    ).toBe(400);
    const corrected = await mutate(app, worker, 'PATCH', `/api/jobs/${id}/assets/editable`, {
      bounds: { x: 2, y: 3, width: 20, height: 25 },
      label: '修正人物',
      strokes: [stroke],
    });
    expect(corrected.statusCode).toBe(200);
    const done = await untilJob(
      app,
      worker,
      id,
      (job) => job.status === 'review' || job.status === 'failed',
    );
    expect(done.status).toBe('review');
    expect(calls).toEqual([undefined, 'editable']);
  });

  it('allows only local authenticated administrators to approve a larger total budget and requires manual retry', async () => {
    let attempts = 0;
    const app = await application(async (ctx) => {
      attempts += 1;
      if (attempts === 1) {
        await ctx.reserve(10, 'initial work');
        await ctx.reserve(1, 'would exceed budget');
      } else {
        await ctx.reserve(1, 'retry work');
        await finish(ctx);
      }
    });
    const admin = await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    const paused = await untilJob(app, worker, id, (job) => job.status === 'budget_paused');
    expect(paused.spentCny).toBe(10);
    expect((await mutate(app, worker, 'POST', `/api/jobs/${id}/retry`)).statusCode).toBe(409);
    expect(
      (await mutate(app, worker, 'POST', `/api/admin/jobs/${id}/budget`, { budgetCny: 15 }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(
          app,
          worker,
          'POST',
          `/api/admin/jobs/${id}/budget`,
          { budgetCny: 15 },
          '127.0.0.1',
        )
      ).statusCode,
    ).toBe(401);
    const failures = await app.inject({
      url: '/api/admin/failures',
      headers: headers(admin),
      remoteAddress: '127.0.0.1',
    });
    expect(failures.json().paused[0].id).toBe(id);
    expect(
      (
        await mutate(
          app,
          admin,
          'POST',
          `/api/admin/jobs/${id}/budget`,
          { budgetCny: 9 },
          '127.0.0.1',
        )
      ).statusCode,
    ).toBe(400);
    const approved = await mutate(
      app,
      admin,
      'POST',
      `/api/admin/jobs/${id}/budget`,
      { budgetCny: 15 },
      '127.0.0.1',
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ id, budgetCny: 15, spentCny: 10 });
    expect((await snapshot(app, worker, id)).status).toBe('budget_paused');
    expect(attempts).toBe(1);
    expect((await mutate(app, worker, 'POST', `/api/jobs/${id}/retry`)).statusCode).toBe(200);
    const done = await untilJob(app, worker, id, (job) => job.status === 'review');
    expect(done.spentCny).toBe(11);
    expect(done.budgetCny).toBe(15);
  });
});

describe('approval preserves unresolved work', () => {
  it.each(['pending', 'processing', 'failed'] as const)(
    'does not approve a %s asset just because an old PNG exists',
    async (status) => {
      const app = await application(async (ctx) => {
        const current = await addAsset(ctx, 'old-png', status);
        current.error = '该素材的最近一次处理未成功。';
        await finish(ctx);
      });
      await initialize(app);
      const worker = await employee(app);
      const response = await upload(app, worker, await png());
      const id = response.json<JobSnapshot>().id;
      await untilJob(app, worker, id, (job) => job.status === 'review');
      const approved = await mutate(app, worker, 'POST', `/api/jobs/${id}/assets/old-png/approve`);
      expect(approved.statusCode).toBe(409);
      const unchanged = await snapshot(app, worker, id);
      expect(unchanged.assets[0].status).toBe(status);
      expect(unchanged.assets[0].error).toBe('该素材的最近一次处理未成功。');
      expect((await mutate(app, worker, 'POST', `/api/jobs/${id}/approve`)).statusCode).toBe(400);
      expect(
        (await app.inject({ url: `/api/jobs/${id}/zip`, headers: headers(worker) })).statusCode,
      ).toBe(400);
    },
  );

  it.each(['budget_paused', 'cancelled', 'failed'] as const)(
    'approves available results without erasing the %s task state or its explanation',
    async (status) => {
      const app = await application(async (ctx) => {
        await addAsset(ctx, 'available', 'review');
        const broken = await addAsset(ctx, 'unfinished', 'failed');
        broken.error = '未完成素材需要重试。';
        await ctx.reserve(2, 'work before interruption');
        ctx.job.status = status;
        ctx.job.stage = '仍有工作需要后续处理';
        ctx.job.error = '保留这条中断或预算说明。';
        ctx.save(ctx.job);
      });
      const admin = await initialize(app);
      const worker = await employee(app);
      const response = await upload(app, worker, await png());
      const id = response.json<JobSnapshot>().id;
      const before = await untilJob(app, worker, id, (job) => job.status === status);
      const approved = await mutate(app, worker, 'POST', `/api/jobs/${id}/approve`);
      expect(approved.statusCode).toBe(200);
      const after = approved.json<JobSnapshot>();
      expect(after.status).toBe(status);
      expect(after.stage).toBe(before.stage);
      expect(after.error).toBe(before.error);
      expect(after.spentCny).toBe(2);
      expect(after.assets.map((asset) => asset.status)).toEqual(['ready', 'failed']);
      const repeated = await mutate(app, worker, 'POST', `/api/jobs/${id}/approve`);
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json<JobSnapshot>().status).toBe(status);
      const singleReady = await mutate(
        app,
        worker,
        'POST',
        `/api/jobs/${id}/assets/available/approve`,
      );
      expect(singleReady.statusCode).toBe(200);
      expect(singleReady.json<JobSnapshot>().status).toBe(status);
      const report = await app.inject({
        url: '/api/admin/failures',
        headers: headers(admin),
        remoteAddress: '127.0.0.1',
      });
      if (status === 'budget_paused') {
        expect(report.json().paused.some((job: { id: string }) => job.id === id)).toBe(true);
      }
      const exported = await app.inject({ url: `/api/jobs/${id}/zip`, headers: headers(worker) });
      expect(exported.statusCode).toBe(200);
      expect(Object.keys(unzipSync(exported.rawPayload))).toHaveLength(1);
    },
  );

  it('does not call an ordinary task complete while processing or missing-image assets remain', async () => {
    const app = await application(async (ctx) => {
      await addAsset(ctx, 'available', 'review');
      await addAsset(ctx, 'unfinished', 'processing');
      const missing = await addAsset(ctx, 'missing-image', 'review');
      missing.pngPath = undefined;
      await finish(ctx);
    });
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    await untilJob(app, worker, id, (job) => job.status === 'review');
    const approved = await mutate(app, worker, 'POST', `/api/jobs/${id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json<JobSnapshot>().status).toBe('partial');
    expect(approved.json<JobSnapshot>().assets.map((asset) => asset.status)).toEqual([
      'ready',
      'processing',
      'review',
    ]);
  });

  it('does not create a successful completion for a job without any result images', async () => {
    const app = await application();
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    await untilJob(app, worker, id, (job) => job.status === 'review');
    expect((await mutate(app, worker, 'POST', `/api/jobs/${id}/approve`)).statusCode).toBe(400);
    expect((await snapshot(app, worker, id)).status).toBe('review');
  });

  it('completes a normal task after its available results are approved, ignoring deleted assets', async () => {
    const app = await application(async (ctx) => {
      await addAsset(ctx, 'available', 'review');
      await addAsset(ctx, 'removed', 'deleted');
      await finish(ctx);
    });
    await initialize(app);
    const worker = await employee(app);
    const response = await upload(app, worker, await png());
    const id = response.json<JobSnapshot>().id;
    await untilJob(app, worker, id, (job) => job.status === 'review');
    const approved = await mutate(app, worker, 'POST', `/api/jobs/${id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json<JobSnapshot>().status).toBe('completed');
    expect(approved.json<JobSnapshot>().assets).toHaveLength(1);
    expect(approved.json<JobSnapshot>().assets[0].status).toBe('ready');
  });
});
