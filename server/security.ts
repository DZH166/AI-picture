import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const EMPLOYEE_LIFETIME = 24 * 60 * 60 * 1000;
const ADMIN_LIFETIME = 8 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Scope = 'employee' | 'admin';

interface SessionPayload {
  scope: Scope;
  sub: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/** Server-only signed sessions. Cookie transport and authentication live in HTTP handlers. */
export class SessionManager {
  private readonly secret: Buffer;

  constructor(masterKey: Buffer) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length < 32) {
      throw new Error('服务端会话密钥无效。');
    }
    this.secret = Buffer.from(masterKey);
  }

  private signature(scope: Scope, body: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(`AI-picture/session/v1/${scope}\0${body}`)
      .digest();
  }

  private issue(scope: Scope, sub: string): string {
    const now = Date.now();
    const payload: SessionPayload = {
      scope,
      sub,
      issuedAt: now,
      expiresAt: now + (scope === 'admin' ? ADMIN_LIFETIME : EMPLOYEE_LIFETIME),
      nonce: randomUUID(),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `v1.${body}.${this.signature(scope, body).toString('base64url')}`;
  }

  private verify(token: string | undefined, scope: Scope): SessionPayload | null {
    if (!token || token.length > 2048) return null;
    const parts = token.split('.');
    if (
      parts.length !== 3 ||
      parts[0] !== 'v1' ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[2])
    ) {
      return null;
    }
    try {
      const signature = Buffer.from(parts[2], 'base64url');
      const expected = this.signature(scope, parts[1]);
      if (
        signature.length !== expected.length ||
        !timingSafeEqual(signature, expected) ||
        signature.toString('base64url') !== parts[2]
      ) {
        return null;
      }
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      ) as Partial<SessionPayload>;
      const now = Date.now();
      const lifetime = scope === 'admin' ? ADMIN_LIFETIME : EMPLOYEE_LIFETIME;
      if (
        payload.scope !== scope ||
        typeof payload.sub !== 'string' ||
        (scope === 'employee' ? !UUID.test(payload.sub) : payload.sub !== 'administrator') ||
        typeof payload.nonce !== 'string' ||
        !UUID.test(payload.nonce) ||
        !Number.isSafeInteger(payload.issuedAt) ||
        !Number.isSafeInteger(payload.expiresAt) ||
        payload.issuedAt! > now ||
        payload.expiresAt! <= now ||
        payload.expiresAt! - payload.issuedAt! !== lifetime
      ) {
        return null;
      }
      return payload as SessionPayload;
    } catch {
      return null;
    }
  }

  employee(token?: string): { ownerId: string; token: string; fresh: boolean } {
    const existing = this.verify(token, 'employee');
    if (existing && token) return { ownerId: existing.sub, token, fresh: false };
    const ownerId = randomUUID();
    return { ownerId, token: this.issue('employee', ownerId), fresh: true };
  }

  adminToken(): string {
    return this.issue('admin', 'administrator');
  }

  isAdmin(token?: string): boolean {
    return this.verify(token, 'admin') !== null;
  }
}
