import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACTIVE_STATUSES } from '../shared/contracts';
import type {
  ConfigUpdate,
  FailureRecord,
  PublicConfig,
  RuntimeConfig,
  StoredAsset,
  StoredJob,
} from '../shared/contracts';

const CACHE_LIFETIME = 24 * 60 * 60 * 1000;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_PROPERTIES = /^(?:deepseekKey|falKey|apiKey|api_key|authorization|password|secret)$/i;
type SecretName = 'deepseek' | 'fal';
interface JobRow {
  id: string;
  owner_id: string;
  created_at: number;
  expires_at: number;
  spent_cents: number;
  budget_cents: number;
  data: string;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly budgetCny: number,
    readonly spentCny: number,
    readonly requestedCny: number,
  ) {
    super('本任务预算不足，请联系管理员提高任务预算后重试。');
    this.name = 'BudgetExceededError';
  }
}

function cents(value: number, roundUp = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error('预算或费用必须是 0 至 1000000 元之间的有效金额。');
  }
  return roundUp ? Math.ceil(value * 100 - 1e-9) : Math.round(value * 100);
}

function protect(path: string, directory = false): void {
  if (process.platform === 'win32') {
    const account = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${userInfo().username}`
      : userInfo().username;
    try {
      execFileSync(
        'icacls.exe',
        [path, '/inheritance:r', '/grant:r', `${account}:${directory ? '(OI)(CI)F' : 'F'}`],
        { stdio: 'ignore', windowsHide: true },
      );
    } catch {
      throw new Error('无法限制服务端数据目录的访问权限，请检查目录权限。');
    }
  } else {
    chmodSync(path, directory ? 0o700 : 0o600);
  }
}

function normalizeKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    /[\r\n]/.test(value) ||
    value.includes('\0')
  ) {
    throw new Error('API Key 格式无效。');
  }
  return value.trim();
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function masked(key: string): string {
  return key ? `••••${key.length > 4 ? key.slice(-4) : ''}` : '';
}

/** Local server storage; never import this module into the client bundle. */
export class Store {
  readonly dataDir: string;
  private readonly database: DatabaseSync;
  private readonly masterKey: Buffer;
  private readonly jobsDir: string;
  private readonly knownSecrets = new Set<string>();
  private closed = false;

  constructor(dataDir: string) {
    mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(resolve(dataDir));
    protect(this.dataDir, true);
    this.jobsDir = join(this.dataDir, 'jobs');
    if (existsSync(this.jobsDir) && lstatSync(this.jobsDir).isSymbolicLink()) {
      throw new Error('任务缓存目录不能是符号链接。');
    }
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    const masterPath = join(this.dataDir, 'master.key');
    const databasePath = join(this.dataDir, 'state.sqlite');
    if (!existsSync(masterPath)) {
      if (existsSync(databasePath)) {
        throw new Error('服务端主密钥文件缺失，请恢复原数据目录。');
      }
      try {
        writeFileSync(masterPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    }
    if (lstatSync(masterPath).isSymbolicLink()) {
      throw new Error('服务端主密钥文件不能是符号链接。');
    }
    this.masterKey = readFileSync(masterPath);
    if (this.masterKey.length !== 32) throw new Error('服务端主密钥文件无效。');
    protect(masterPath);
    this.database = new DatabaseSync(databasePath);
    protect(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS config (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, encrypted TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        spent_cents INTEGER NOT NULL DEFAULT 0,
        budget_cents INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires_at);
      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        filename TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL
      );
      INSERT OR IGNORE INTO config(name, value) VALUES ('deepseekEnabled', 'true');
      INSERT OR IGNORE INTO config(name, value) VALUES ('falEnabled', 'true');
      INSERT OR IGNORE INTO config(name, value) VALUES ('budgetCents', '1000');
    `);
    this.initializeEnvironment('deepseek', process.env.DEEPSEEK_API_KEY);
    this.initializeEnvironment('fal', process.env.FAL_KEY);
    this.recoverInterrupted();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private encrypt(name: SecretName, value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    cipher.setAAD(Buffer.from(`AI-picture/key/v1/${name}`));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v1',
      nonce.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  private secret(name: SecretName): string {
    const row = this.database.prepare('SELECT encrypted FROM secrets WHERE name = ?').get(name) as
      { encrypted: string } | undefined;
    if (!row) return '';
    try {
      const [version, nonce, tag, encrypted, extra] = row.encrypted.split('.');
      if (version !== 'v1' || extra !== undefined) throw new Error();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.masterKey,
        Buffer.from(nonce, 'base64url'),
      );
      decipher.setAAD(Buffer.from(`AI-picture/key/v1/${name}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const key = Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      if (key) this.knownSecrets.add(key);
      return key;
    } catch {
      throw new Error('无法解密服务端凭据，请检查原数据目录和主密钥文件。');
    }
  }

  private initializeEnvironment(name: SecretName, value: string | undefined): void {
    if (!value) return;
    const key = normalizeKey(value);
    if (!key) return;
    // An encrypted empty value is a deliberate deletion, not an invitation to reimport.
    this.database
      .prepare('INSERT OR IGNORE INTO secrets(name, encrypted) VALUES (?, ?)')
      .run(name, this.encrypt(name, key));
  }

  private config(name: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM config WHERE name = ?').get(name) as
      { value: string } | undefined;
    return row?.value;
  }

  private writeConfig(name: string, value: string): void {
    this.database
      .prepare(
        'INSERT INTO config(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
      )
      .run(name, value);
  }

  getRuntimeConfig(): RuntimeConfig {
    return {
      deepseekKey: this.secret('deepseek'),
      falKey: this.secret('fal'),
      deepseekEnabled: this.config('deepseekEnabled') === 'true',
      falEnabled: this.config('falEnabled') === 'true',
      budgetCny: Number(this.config('budgetCents') ?? '1000') / 100,
    };
  }

  getPublicConfig(): PublicConfig {
    const config = this.getRuntimeConfig();
    return {
      deepseek: {
        configured: Boolean(config.deepseekKey),
        enabled: config.deepseekEnabled,
        masked: masked(config.deepseekKey),
      },
      fal: {
        configured: Boolean(config.falKey),
        enabled: config.falEnabled,
        masked: masked(config.falKey),
      },
      budgetCny: config.budgetCny,
    };
  }

  updateConfig(update: ConfigUpdate): PublicConfig {
    const keys: Array<[SecretName, string]> = [];
    if (update.deepseekKey !== undefined) keys.push(['deepseek', normalizeKey(update.deepseekKey)]);
    if (update.falKey !== undefined) keys.push(['fal', normalizeKey(update.falKey)]);
    for (const enabled of [update.deepseekEnabled, update.falEnabled]) {
      if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('启用状态无效。');
    }
    const budget = update.budgetCny === undefined ? undefined : cents(update.budgetCny);
    this.getRuntimeConfig();
    this.transaction(() => {
      for (const [name, key] of keys) {
        this.database
          .prepare(
            'INSERT INTO secrets(name,encrypted) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET encrypted=excluded.encrypted',
          )
          .run(name, this.encrypt(name, key));
        if (key) this.knownSecrets.add(key);
      }
      if (update.deepseekEnabled !== undefined) {
        this.writeConfig('deepseekEnabled', String(update.deepseekEnabled));
      }
      if (update.falEnabled !== undefined)
        this.writeConfig('falEnabled', String(update.falEnabled));
      if (budget !== undefined) this.writeConfig('budgetCents', String(budget));
    });
    return this.getPublicConfig();
  }

  /** Derived signing key, available only to server modules, never a response field. */
  getSessionSecret(): Buffer {
    return createHmac('sha256', this.masterKey).update('AI-picture/session-secret/v1').digest();
  }

  hasAdmin(): boolean {
    return this.config('adminPassword') !== undefined;
  }

  setAdminPassword(password: string): void {
    if (
      typeof password !== 'string' ||
      [...password].length < 10 ||
      password.length > 1024 ||
      !password.trim()
    ) {
      throw new Error('管理员密码至少需要 10 个字符，且不能仅为空格。');
    }
    if (this.hasAdmin()) throw new Error('管理员密码已设置，不能再次初始化。');
    const salt = randomBytes(32);
    const hash = scryptSync(password, salt, 64);
    this.transaction(() => {
      if (this.hasAdmin()) throw new Error('管理员密码已设置，不能再次初始化。');
      this.writeConfig(
        'adminPassword',
        JSON.stringify({
          version: 1,
          salt: salt.toString('base64url'),
          hash: hash.toString('base64url'),
        }),
      );
    });
  }

  verifyAdminPassword(password: string): boolean {
    if (typeof password !== 'string' || password.length > 1024) return false;
    const saved = this.config('adminPassword');
    if (!saved) return false;
    try {
      const record = JSON.parse(saved) as { version: number; salt: string; hash: string };
      const salt = Buffer.from(record.salt, 'base64url');
      const expected = Buffer.from(record.hash, 'base64url');
      if (record.version !== 1 || salt.length !== 32 || expected.length !== 64) return false;
      const actual = scryptSync(password, salt, expected.length);
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private redact(value: string): string {
    let result = value;
    for (const secret of this.knownSecrets) result = result.split(secret).join('[已隐藏]');
    return result;
  }

  private serialize(job: StoredJob): string {
    this.getRuntimeConfig();
    // Keep only contract fields; callers cannot accidentally persist provider settings.
    const assets = job.assets.map((asset): StoredAsset => ({
      id: asset.id,
      label: asset.label,
      bounds: asset.bounds,
      kind: asset.kind,
      status: asset.status,
      width: asset.width,
      height: asset.height,
      previewUrl: asset.previewUrl,
      maskUrl: asset.maskUrl,
      warnings: asset.warnings,
      error: asset.error,
      candidate: asset.candidate,
      pngPath: asset.pngPath,
      alphaPath: asset.alphaPath,
      watermarkPath: asset.watermarkPath,
      correction: asset.correction,
    }));
    const data: StoredJob = {
      id: job.id,
      ownerId: job.ownerId,
      sourcePath: job.sourcePath,
      filename: job.filename,
      width: job.width,
      height: job.height,
      originalUrl: job.originalUrl,
      status: job.status,
      stage: job.stage,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      spentCny: job.spentCny,
      budgetCny: job.budgetCny,
      assets,
      warnings: job.warnings,
      error: job.error,
      analysis: job.analysis,
    };
    return JSON.stringify(data, (key: string, value: unknown): unknown => {
      if (SECRET_PROPERTIES.test(key)) return undefined;
      return typeof value === 'string' ? this.redact(value) : value;
    });
  }

  private row(id: string, includeExpired = false): JobRow | undefined {
    return this.database
      .prepare(`SELECT * FROM jobs WHERE id = ?${includeExpired ? '' : ' AND expires_at > ?'}`)
      .get(...(includeExpired ? [id] : [id, Date.now()])) as unknown as JobRow | undefined;
  }

  private fromRow(row: JobRow): StoredJob {
    const data = JSON.parse(row.data) as StoredJob;
    return {
      ...data,
      id: row.id,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      spentCny: row.spent_cents / 100,
      budgetCny: row.budget_cents / 100,
    };
  }

  private persist(job: StoredJob): void {
    this.database
      .prepare('UPDATE jobs SET updated_at = ?, data = ? WHERE id = ?')
      .run(Date.now(), this.serialize(job), job.id);
  }

  createJob(
    ownerId: string,
    meta: { filename: string; width: number; height: number; sourcePath: string },
  ): StoredJob {
    if (!ownerId || ownerId.length > 256) throw new Error('员工会话无效。');
    if (
      !Number.isSafeInteger(meta.width) ||
      !Number.isSafeInteger(meta.height) ||
      meta.width < 1 ||
      meta.height < 1
    ) {
      throw new Error('图片尺寸无效。');
    }
    const now = Date.now();
    const job: StoredJob = {
      id: randomUUID(),
      ownerId,
      filename: meta.filename,
      width: meta.width,
      height: meta.height,
      sourcePath: meta.sourcePath,
      originalUrl: '',
      status: 'queued',
      stage: '等待处理',
      createdAt: now,
      expiresAt: now + CACHE_LIFETIME,
      spentCny: 0,
      budgetCny: this.getRuntimeConfig().budgetCny,
      assets: [],
      warnings: [],
    };
    this.assertJobsDirectory();
    mkdirSync(join(this.jobsDir, job.id), { mode: 0o700 });
    this.database
      .prepare(
        'INSERT INTO jobs(id,owner_id,created_at,expires_at,updated_at,spent_cents,budget_cents,data) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(job.id, ownerId, now, job.expiresAt, now, 0, cents(job.budgetCny), this.serialize(job));
    return this.getJob(job.id)!;
  }

  getJob(id: string): StoredJob | null {
    const row = this.row(id);
    return row ? this.fromRow(row) : null;
  }

  saveJob(job: StoredJob): void {
    this.transaction(() => {
      const row = this.row(job.id);
      if (!row) throw new Error('任务不存在或已过期。');
      const previous = this.fromRow(row);
      const current: StoredJob = {
        ...job,
        ownerId: row.owner_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        spentCny: row.spent_cents / 100,
        budgetCny: row.budget_cents / 100,
      };
      this.persist(current);
      const message = current.error || current.assets.find((asset) => asset.error)?.error;
      const previousMessage = previous.error || previous.assets.find((asset) => asset.error)?.error;
      if (
        message &&
        ['failed', 'partial', 'budget_paused'].includes(current.status) &&
        (message !== previousMessage || current.status !== previous.status)
      ) {
        this.database
          .prepare('INSERT INTO failures(job_id,at,filename,stage,message) VALUES (?,?,?,?,?)')
          .run(
            job.id,
            Date.now(),
            this.redact(job.filename),
            this.redact(job.stage),
            this.redact(message).slice(0, 2000),
          );
      }
    });
  }

  listJobs(ownerId: string): StoredJob[] {
    const rows = this.database
      .prepare(
        'SELECT * FROM jobs WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(ownerId, Date.now()) as unknown as JobRow[];
    return rows.map((row) => this.fromRow(row));
  }

  listBudgetPaused(): StoredJob[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM jobs WHERE expires_at > ? AND json_extract(data, '$.status') = 'budget_paused' ORDER BY updated_at DESC, rowid DESC",
      )
      .all(Date.now()) as unknown as JobRow[];
    return rows.map((row) => this.fromRow(row));
  }

  private recoverInterrupted(): void {
    const rows = this.database
      .prepare('SELECT * FROM jobs WHERE expires_at > ?')
      .all(Date.now()) as unknown as JobRow[];
    for (const row of rows) {
      const job = this.fromRow(row);
      if (!ACTIVE_STATUSES.includes(job.status)) continue;
      job.status = 'failed';
      job.stage = '服务重启，任务中断';
      job.error = '服务已重启，任务处理被中断；已保留结果和预留费用，请手动重试。';
      for (const asset of job.assets) {
        if (asset.status === 'processing' || asset.status === 'pending') {
          asset.status = 'failed';
          asset.error = '服务重启导致本素材处理被中断，请手动重试。';
        }
      }
      this.saveJob(job);
    }
  }

  reserve(jobId: string, amountCny: number, label: string): void {
    const amount = cents(amountCny, true);
    this.transaction(() => {
      const row = this.row(jobId);
      if (!row) throw new Error('任务不存在或已过期。');
      if (row.spent_cents + amount > row.budget_cents) {
        throw new BudgetExceededError(row.budget_cents / 100, row.spent_cents / 100, amount / 100);
      }
      const spent = row.spent_cents + amount;
      this.database.prepare('UPDATE jobs SET spent_cents = ? WHERE id = ?').run(spent, jobId);
      this.persist({ ...this.fromRow(row), spentCny: spent / 100 });
      this.database
        .prepare('INSERT INTO reservations(job_id,at,amount_cents,label) VALUES (?,?,?,?)')
        .run(jobId, Date.now(), amount, this.redact(label).slice(0, 300));
    });
  }

  setJobBudget(id: string, budget: number): StoredJob {
    const amount = cents(budget);
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) throw new Error('任务不存在或已过期。');
      if (amount < row.spent_cents) throw new Error('任务总预算不能低于已经预留的费用。');
      this.database.prepare('UPDATE jobs SET budget_cents = ? WHERE id = ?').run(amount, id);
      const job = { ...this.fromRow(row), budgetCny: amount / 100 };
      this.persist(job);
      return job;
    });
  }

  recentFailures(): FailureRecord[] {
    return this.database
      .prepare(
        'SELECT failures.at,filename,stage,message FROM failures JOIN jobs ON jobs.id = failures.job_id WHERE jobs.expires_at > ? ORDER BY failures.id DESC LIMIT 20',
      )
      .all(Date.now()) as unknown as FailureRecord[];
  }

  private assertJobsDirectory(): void {
    if (
      !existsSync(this.jobsDir) ||
      lstatSync(this.jobsDir).isSymbolicLink() ||
      !inside(this.dataDir, realpathSync(this.jobsDir))
    ) {
      throw new Error('任务缓存目录不安全，已停止文件操作。');
    }
  }

  cleanupExpired(): void {
    this.assertJobsDirectory();
    const rows = this.database
      .prepare('SELECT id FROM jobs WHERE expires_at <= ?')
      .all(Date.now()) as unknown as Array<{ id: string }>;
    for (const { id } of rows) {
      if (!JOB_ID.test(id)) throw new Error('任务缓存路径无效，已停止清理。');
      const target = resolve(this.jobsDir, id);
      if (!inside(this.jobsDir, target)) throw new Error('任务缓存路径越界，已停止清理。');
      const targetStat = lstatSync(target, { throwIfNoEntry: false });
      if (targetStat) {
        if (targetStat.isSymbolicLink()) {
          // Unlink the link itself, never traverse a junction into another directory.
          unlinkSync(target);
        } else {
          if (!inside(realpathSync(this.jobsDir), realpathSync(target))) {
            throw new Error('任务缓存路径越界，已停止清理。');
          }
          rmSync(target, { recursive: true, force: true });
        }
      }
      this.database
        .prepare('DELETE FROM jobs WHERE id = ? AND expires_at <= ?')
        .run(id, Date.now());
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
    this.masterKey.fill(0);
    this.knownSecrets.clear();
  }
}
