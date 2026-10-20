import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './security';

afterEach(() => vi.useRealTimers());

describe('server sessions', () => {
  it('issues separate employee identities and preserves a valid identity', () => {
    const sessions = new SessionManager(randomBytes(32));
    const first = sessions.employee();
    expect(first.fresh).toBe(true);
    expect(sessions.employee(first.token)).toEqual({ ...first, fresh: false });
    expect(sessions.employee().ownerId).not.toBe(first.ownerId);
  });

  it('does not accept employee cookies as administrator cookies or vice versa', () => {
    const sessions = new SessionManager(randomBytes(32));
    const employee = sessions.employee();
    const admin = sessions.adminToken();
    expect(sessions.isAdmin(employee.token)).toBe(false);
    expect(sessions.isAdmin(admin)).toBe(true);
    const replaced = sessions.employee(admin);
    expect(replaced.fresh).toBe(true);
    expect(sessions.isAdmin(replaced.token)).toBe(false);
  });

  it('rejects altered bodies, signatures and malformed tokens', () => {
    const sessions = new SessionManager(randomBytes(32));
    const token = sessions.adminToken();
    const [version, body, signature] = token.split('.');
    const altered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString()),
        expiresAt: Date.now() + 9_999_999_999,
      }),
    ).toString('base64url');
    expect(sessions.isAdmin(`${version}.${altered}.${signature}`)).toBe(false);
    expect(sessions.isAdmin(`${version}.${body}.${'A'.repeat(43)}`)).toBe(false);
    for (const invalid of [undefined, '', 'v1', 'v1..', token + '.extra', 'x'.repeat(3000)]) {
      expect(sessions.isAdmin(invalid)).toBe(false);
      expect(sessions.employee(invalid).fresh).toBe(true);
    }
  });

  it('expires administrator sessions after 8 hours and employee sessions after 24 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    const sessions = new SessionManager(randomBytes(32));
    const employee = sessions.employee();
    const admin = sessions.adminToken();
    vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
    expect(sessions.isAdmin(admin)).toBe(false);
    expect(sessions.employee(employee.token).fresh).toBe(false);
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    expect(sessions.employee(employee.token).fresh).toBe(true);
  });

  it('survives process reconstruction with the same secret and rejects another secret', () => {
    const secret = randomBytes(32);
    const sessions = new SessionManager(secret);
    const admin = sessions.adminToken();
    const employee = sessions.employee();
    const restored = new SessionManager(Buffer.from(secret));
    expect(restored.isAdmin(admin)).toBe(true);
    expect(restored.employee(employee.token).ownerId).toBe(employee.ownerId);
    const other = new SessionManager(randomBytes(32));
    expect(other.isAdmin(admin)).toBe(false);
    expect(other.employee(employee.token).fresh).toBe(true);
  });

  it('copies and validates the server signing secret', () => {
    const secret = randomBytes(32);
    const sessions = new SessionManager(secret);
    const token = sessions.adminToken();
    secret.fill(0);
    expect(sessions.isAdmin(token)).toBe(true);
    expect(() => new SessionManager(Buffer.alloc(4))).toThrow('会话密钥无效');
  });
});
