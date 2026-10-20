import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredAsset, StoredJob } from '../shared/contracts';
import { BudgetExceededError, Store } from './store';

const temporaryDirectories: string[] = [];
const stores: Store[] = [];
const TEST_KEY = 'test-only-deepseek-credential-1234567890';
const TEST_FAL_KEY = 'test-only-fal-credential-0987654321';

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'AI-picture-store-test-'));
  temporaryDirectories.push(path);
  return path;
}

function open(path = directory()): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}

function job(store: Store, owner = 'employee-one'): StoredJob {
  return store.createJob(owner, {
    filename: '原图.png',
    width: 100,
    height: 80,
    sourcePath: join(store.dataDir, 'incoming.png'),
  });
}

function asset(id: string, status: StoredAsset['status']): StoredAsset {
  const bounds = { x: 1, y: 2, width: 20, height: 30 };
  return {
    id,
    label: '人物',
    bounds,
    kind: 'cutout',
    status,
    warnings: [],
    candidate: { id, label: '人物', bounds, kind: 'cutout', prompt: 'character' },
  };
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('FAL_KEY', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  for (const path of temporaryDirectories.splice(0)) {
    const resolved = resolve(path);
    const fromTemporaryRoot = relative(resolve(tmpdir()), resolved);
    if (
      !basename(resolved).startsWith('AI-picture-store-test-') ||
      fromTemporaryRoot.startsWith(`..${sep}`) ||
      fromTemporaryRoot === '..'
    ) {
      throw new Error('Refusing to remove an unexpected test directory.');
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('encrypted server configuration', () => {
  it('defaults to a 10 CNY task budget and reveals only key suffixes', () => {
    const store = open();
    expect(store.getPublicConfig()).toEqual({
      deepseek: { configured: false, enabled: true, masked: '' },
      fal: { configured: false, enabled: true, masked: '' },
      budgetCny: 10,
    });
    const publicConfig = store.updateConfig({
      deepseekKey: TEST_KEY,
      falKey: TEST_FAL_KEY,
      falEnabled: false,
      budgetCny: 12.34,
    });
    expect(publicConfig.deepseek.masked).toBe('••••7890');
    expect(publicConfig.fal.masked).toBe('••••4321');
    expect(publicConfig.fal.enabled).toBe(false);
    expect(JSON.stringify(publicConfig)).not.toContain(TEST_KEY);
    expect(store.getRuntimeConfig().deepseekKey).toBe(TEST_KEY);
    expect(store.getRuntimeConfig().budgetCny).toBe(12.34);
    store.updateConfig({ deepseekKey: 'abc' });
    expect(store.getPublicConfig().deepseek.masked).toBe('••••');
  });

  it('encrypts database contents and recovers credentials and signing secret after restart', () => {
    const store = open();
    store.updateConfig({ deepseekKey: TEST_KEY, falKey: TEST_FAL_KEY });
    const secret = store.getSessionSecret();
    const dataDir = store.dataDir;
    store.close();
    const contents = readFileSync(join(dataDir, 'state.sqlite'));
    expect(contents.includes(Buffer.from(TEST_KEY))).toBe(false);
    expect(contents.includes(Buffer.from(TEST_FAL_KEY))).toBe(false);
    expect(readFileSync(join(dataDir, 'master.key')).length).toBe(32);
    const restored = open(dataDir);
    expect(restored.getRuntimeConfig().deepseekKey).toBe(TEST_KEY);
    expect(restored.getRuntimeConfig().falKey).toBe(TEST_FAL_KEY);
    expect(restored.getSessionSecret()).toEqual(secret);
    const copy = restored.getSessionSecret();
    copy.fill(0);
    expect(restored.getSessionSecret()).toEqual(secret);
    if (process.platform !== 'win32') {
      expect(statSync(join(dataDir, 'master.key')).mode & 0o777).toBe(0o600);
    }
  });

  it('authenticates ciphertext and binds each ciphertext to its provider', () => {
    const store = open();
    store.updateConfig({ deepseekKey: TEST_KEY, falKey: TEST_FAL_KEY });
    const dataDir = store.dataDir;
    store.close();
    const raw = new DatabaseSync(join(dataDir, 'state.sqlite'));
    const deepseek = raw.prepare("SELECT encrypted FROM secrets WHERE name='deepseek'").get() as {
      encrypted: string;
    };
    raw.prepare("UPDATE secrets SET encrypted=? WHERE name='fal'").run(deepseek.encrypted);
    raw.close();
    const restored = open(dataDir);
    expect(() => restored.getRuntimeConfig()).toThrow('无法解密');
  });

  it('initializes from environment once, preserves configured values and honors deletion after restart', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', TEST_KEY);
    vi.stubEnv('FAL_KEY', TEST_FAL_KEY);
    const store = open();
    expect(store.getRuntimeConfig().deepseekKey).toBe(TEST_KEY);
    store.updateConfig({ deepseekKey: 'replacement-test-credential', falKey: '' });
    const dataDir = store.dataDir;
    store.close();
    const restored = open(dataDir);
    expect(restored.getRuntimeConfig().deepseekKey).toBe('replacement-test-credential');
    expect(restored.getRuntimeConfig().falKey).toBe('');
    expect(restored.getPublicConfig().fal.configured).toBe(false);
  });

  it('rejects invalid updates without partially changing an existing configuration', () => {
    const store = open();
    store.updateConfig({ deepseekKey: TEST_KEY });
    expect(() => store.updateConfig({ deepseekKey: TEST_FAL_KEY, budgetCny: -1 })).toThrow();
    expect(store.getRuntimeConfig().deepseekKey).toBe(TEST_KEY);
    expect(() => store.updateConfig({ falKey: 'test\r\ninjection' })).toThrow();
  });
});

describe('administrator password', () => {
  it('requires a long password, hashes it, verifies it and forbids reinitialization', () => {
    const store = open();
    expect(store.hasAdmin()).toBe(false);
    expect(store.verifyAdminPassword('incorrect')).toBe(false);
    expect(() => store.setAdminPassword('short')).toThrow('10');
    expect(() => store.setAdminPassword('          ')).toThrow();
    const password = 'local-test-admin-password';
    store.setAdminPassword(password);
    expect(store.hasAdmin()).toBe(true);
    expect(store.verifyAdminPassword(password)).toBe(true);
    expect(store.verifyAdminPassword(password + 'wrong')).toBe(false);
    expect(() => store.setAdminPassword('another-valid-password')).toThrow('已设置');
    const dataDir = store.dataDir;
    store.close();
    expect(readFileSync(join(dataDir, 'state.sqlite')).includes(Buffer.from(password))).toBe(false);
    const restored = open(dataDir);
    expect(restored.verifyAdminPassword(password)).toBe(true);
  });

  it('uses a fresh salt for equal passwords in different stores', () => {
    const first = open();
    const second = open();
    first.setAdminPassword('same-test-password');
    second.setAdminPassword('same-test-password');
    first.close();
    second.close();
    const readHash = (dataDir: string) => {
      const raw = new DatabaseSync(join(dataDir, 'state.sqlite'));
      const value = raw.prepare("SELECT value FROM config WHERE name='adminPassword'").get() as {
        value: string;
      };
      raw.close();
      return value.value;
    };
    expect(readHash(first.dataDir)).not.toBe(readHash(second.dataDir));
  });
});

describe('jobs and budget reservations', () => {
  it('snapshots a job budget and filters owners with newest-first ordering', () => {
    const store = open();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    const first = job(store);
    expect(first.status).toBe('queued');
    expect(first.assets).toEqual([]);
    expect(first.expiresAt - first.createdAt).toBe(24 * 60 * 60 * 1000);
    expect(first.budgetCny).toBe(10);
    store.updateConfig({ budgetCny: 20 });
    vi.setSystemTime(new Date('2026-10-20T00:00:01Z'));
    const second = job(store);
    job(store, 'different-owner');
    expect(store.listJobs('employee-one').map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(store.listJobs('unknown-owner')).toEqual([]);
    expect(store.getJob(first.id)!.budgetCny).toBe(10);
    expect(second.budgetCny).toBe(20);
  });

  it('atomically accumulates reservations, refuses excess and keeps failed-call reservations', () => {
    const store = open();
    const current = job(store);
    store.reserve(current.id, 6, 'analysis');
    store.reserve(current.id, 3.1, 'repair attempt');
    expect(store.getJob(current.id)!.spentCny).toBe(9.1);
    expect(() => store.reserve(current.id, 1, 'cannot fit')).toThrow(BudgetExceededError);
    expect(store.getJob(current.id)!.spentCny).toBe(9.1);
    // A processor can finish with a snapshot obtained before the reservation.
    current.status = 'failed';
    current.error = 'Provider request failed.';
    current.spentCny = 0;
    current.budgetCny = 100;
    store.saveJob(current);
    expect(store.getJob(current.id)!.spentCny).toBe(9.1);
    expect(store.getJob(current.id)!.budgetCny).toBe(10);
    store.reserve(current.id, 0.9, 'retry');
    expect(store.getJob(current.id)!.spentCny).toBe(10);
    expect(() => store.reserve(current.id, 0.01, 'another retry')).toThrow(BudgetExceededError);
    expect(() => store.reserve(current.id, -1, 'negative')).toThrow();
  });

  it('uses integer cents and rounds sub-cent reservations upward', () => {
    const store = open();
    const current = job(store);
    store.setJobBudget(current.id, 0.3);
    store.reserve(current.id, 0.1, 'one');
    store.reserve(current.id, 0.2, 'two');
    expect(store.getJob(current.id)!.spentCny).toBe(0.3);
    const tiny = job(store);
    store.reserve(tiny.id, 0.001, 'tiny paid call');
    expect(store.getJob(tiny.id)!.spentCny).toBe(0.01);
  });

  it('rolls back the whole reservation if recording it fails after the balance update', () => {
    const store = open();
    const current = job(store);
    const raw = new DatabaseSync(join(store.dataDir, 'state.sqlite'));
    raw.exec(`
      CREATE TRIGGER reject_test_reservation BEFORE INSERT ON reservations
      WHEN NEW.label = 'simulate-ledger-failure'
      BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END;
    `);
    try {
      store.reserve(current.id, 2, 'successful call');
      expect(() => store.reserve(current.id, 3, 'simulate-ledger-failure')).toThrow();
      expect(store.getJob(current.id)!.spentCny).toBe(2);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM reservations').get()!.count).toBe(1);
      store.reserve(current.id, 8, 'remaining budget');
      expect(store.getJob(current.id)!.spentCny).toBe(10);
    } finally {
      raw.close();
    }
  });

  it('enforces the same budget across two database handles', () => {
    const store = open();
    const peer = open(store.dataDir);
    const current = job(store);
    store.reserve(current.id, 6, 'first handler');
    peer.reserve(current.id, 3, 'second handler');
    expect(() => peer.reserve(current.id, 2, 'cannot overspend')).toThrow(BudgetExceededError);
    expect(store.getJob(current.id)!.spentCny).toBe(9);
    expect(peer.getJob(current.id)!.spentCny).toBe(9);
  });

  it('only changes a paused job budget when approved and never resumes it automatically', () => {
    const store = open();
    const current = job(store);
    store.reserve(current.id, 8, 'previous work');
    current.status = 'budget_paused';
    current.stage = '等待预算审批';
    store.saveJob(current);
    expect(store.listBudgetPaused().map((entry) => entry.id)).toEqual([current.id]);
    expect(() => store.setJobBudget(current.id, 7.99)).toThrow('不能低于');
    const approved = store.setJobBudget(current.id, 15);
    expect(approved.budgetCny).toBe(15);
    expect(approved.spentCny).toBe(8);
    expect(approved.status).toBe('budget_paused');
    // A later stale worker snapshot must not undo the administrator's approval.
    store.saveJob(current);
    expect(store.getJob(current.id)!.budgetCny).toBe(15);
  });

  it('does not persist keys from accidental extension fields or error messages', () => {
    const store = open();
    store.updateConfig({ deepseekKey: TEST_KEY, falKey: TEST_FAL_KEY });
    const current = job(store);
    const polluted = {
      ...current,
      status: 'failed' as const,
      error: `Error containing ${TEST_KEY}`,
      deepseekKey: TEST_KEY,
      runtimeConfig: store.getRuntimeConfig(),
      assets: [{ ...asset('one', 'failed'), error: TEST_FAL_KEY, apiKey: TEST_KEY }],
    };
    store.saveJob(polluted);
    const restored = store.getJob(current.id)!;
    const serialized = JSON.stringify(restored);
    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).not.toContain(TEST_FAL_KEY);
    expect(serialized).not.toContain('runtimeConfig');
    expect(restored.error).toContain('[已隐藏]');
    expect(store.recentFailures()[0].message).not.toContain(TEST_KEY);
  });

  it('recovers interrupted work after restart without losing results or reservations', () => {
    const store = open();
    const current = job(store);
    current.status = 'repairing';
    current.assets = [asset('ready', 'ready'), asset('working', 'processing')];
    store.reserve(current.id, 3, 'repair before crash');
    store.saveJob(current);
    const dataDir = store.dataDir;
    store.close();
    const restored = open(dataDir);
    const recovered = restored.getJob(current.id)!;
    expect(recovered.status).toBe('failed');
    expect(recovered.error).toContain('服务已重启');
    expect(recovered.spentCny).toBe(3);
    expect(recovered.assets[0].status).toBe('ready');
    expect(recovered.assets[1].status).toBe('failed');
    expect(restored.recentFailures()[0].message).toContain('手动重试');
  });

  it('preserves ownership and expiry when saving task snapshots', () => {
    const store = open();
    const current = job(store);
    store.saveJob({
      ...current,
      ownerId: 'another-owner',
      expiresAt: current.expiresAt + 1_000_000,
      createdAt: 0,
    });
    const saved = store.getJob(current.id)!;
    expect(saved.ownerId).toBe(current.ownerId);
    expect(saved.expiresAt).toBe(current.expiresAt);
    expect(saved.createdAt).toBe(current.createdAt);
  });
});

describe('24-hour cache cleanup', () => {
  it('hides expired jobs and deletes only their own cache directories and records', () => {
    const store = open();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    const expired = job(store);
    const expiredDirectory = join(store.dataDir, 'jobs', expired.id);
    writeFileSync(join(expiredDirectory, 'result.png'), 'test-cache');
    const outside = join(store.dataDir, 'incoming.png');
    writeFileSync(outside, 'original-outside-job-directory');
    vi.setSystemTime(new Date('2026-10-20T23:00:00Z'));
    const active = job(store);
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    expect(store.getJob(expired.id)).toBeNull();
    expect(store.listJobs(expired.ownerId).map((entry) => entry.id)).toEqual([active.id]);
    store.cleanupExpired();
    expect(existsSync(expiredDirectory)).toBe(false);
    expect(existsSync(join(store.dataDir, 'jobs', active.id))).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('original-outside-job-directory');
    expect(() => store.reserve(expired.id, 1, 'expired')).toThrow('已过期');
  });

  it('unlinks a job-directory junction without deleting its external destination', () => {
    const store = open();
    const external = directory();
    writeFileSync(join(external, 'keep.txt'), 'keep-external');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    const current = job(store);
    const cachePath = resolve(store.dataDir, 'jobs', current.id);
    expect(relative(resolve(store.dataDir, 'jobs'), cachePath)).toBe(current.id);
    rmSync(cachePath, { recursive: true });
    symlinkSync(external, cachePath, process.platform === 'win32' ? 'junction' : 'dir');
    vi.setSystemTime(new Date('2026-10-21T00:00:01Z'));
    store.cleanupExpired();
    expect(existsSync(cachePath)).toBe(false);
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('keep-external');
  });

  it('refuses cleanup if the jobs root has been replaced with a junction', () => {
    const store = open();
    const external = directory();
    const jobsRoot = resolve(store.dataDir, 'jobs');
    expect(readdirSync(jobsRoot)).toEqual([]);
    expect(relative(store.dataDir, jobsRoot)).toBe('jobs');
    rmSync(jobsRoot, { recursive: true });
    symlinkSync(external, jobsRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(lstatSync(jobsRoot).isSymbolicLink()).toBe(true);
    expect(() => store.cleanupExpired()).toThrow('不安全');
    expect(existsSync(external)).toBe(true);
  });

  it('refuses an unsafe existing jobs directory during startup', () => {
    const dataDir = directory();
    const external = directory();
    mkdirSync(join(external, 'keep'));
    symlinkSync(external, join(dataDir, 'jobs'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => open(dataDir)).toThrow('符号链接');
    expect(existsSync(join(external, 'keep'))).toBe(true);
  });
});
