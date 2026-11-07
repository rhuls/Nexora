import { describe, expect, it } from 'vitest';
import { AuthGuard, authStatus, loadAuthConfig } from '../src/config/auth.js';

const TOKEN = 'a-sufficiently-long-deployment-token';

const request = (headers: Record<string, string> = {}) =>
  ({ headers, url: '/api/model/rollback', method: 'POST', log: { warn: () => {} } }) as never;

function reply() {
  const sent: { status?: number; body?: unknown } = {};
  const r = {
    status(code: number) {
      sent.status = code;
      return { send: async (body: unknown) => { sent.body = body; } };
    },
  };
  return { reply: r as never, sent };
}

describe('auth configuration', () => {
  it('refuses to start in production without a token', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production' })).toThrow(/NEXORA_API_TOKEN is required/);
  });

  it('allows development without one, so the local stack runs unchanged', () => {
    expect(loadAuthConfig({ NODE_ENV: 'development' })).toEqual({ token: null, required: false });
  });

  it('rejects a token short enough to guess', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production', NEXORA_API_TOKEN: 'short' })).toThrow(/at least 16/);
  });

  it('never puts the token in the error it throws', () => {
    try {
      loadAuthConfig({ NODE_ENV: 'production', NEXORA_API_TOKEN: 'x'.repeat(8) });
      throw new Error('should have thrown');
    } catch (e) {
      expect(String(e)).not.toContain('xxxxxxxx');
    }
  });
});

describe('the guard', () => {
  const guard = new AuthGuard({ token: TOKEN, required: true });

  it('accepts the token as a bearer header', async () => {
    const { reply: r, sent } = reply();
    await guard.require(request({ authorization: `Bearer ${TOKEN}` }), r);
    expect(sent.status).toBeUndefined();
  });

  it('accepts it as x-nexora-token, for curl', async () => {
    const { reply: r, sent } = reply();
    await guard.require(request({ 'x-nexora-token': TOKEN }), r);
    expect(sent.status).toBeUndefined();
  });

  it('rejects a missing, wrong or truncated token with 401', async () => {
    const cases: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer nope-not-the-right-token' },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: TOKEN }, // no "Bearer " prefix
    ];
    for (const headers of cases) {
      const { reply: r, sent } = reply();
      await guard.require(request(headers), r);
      expect(sent.status).toBe(401);
    }
  });

  it('never echoes the token back in the rejection', async () => {
    const { reply: r, sent } = reply();
    await guard.require(request({ authorization: 'Bearer wrong-token-entirely-here' }), r);
    expect(JSON.stringify(sent.body)).not.toContain('wrong-token-entirely-here');
    expect(JSON.stringify(sent.body)).not.toContain(TOKEN);
  });

  it('answers the predicate without touching the reply', () => {
    expect(guard.authenticated(request({ authorization: `Bearer ${TOKEN}` }))).toBe(true);
    expect(guard.authenticated(request({}))).toBe(false);
    expect(guard.authenticated(request({ authorization: 'Bearer wrong-token-entirely' }))).toBe(false);
  });

  it('leaves everything open when no token is configured, and says so', () => {
    const open = new AuthGuard({ token: null, required: false });
    expect(open.enabled).toBe(false);
    expect(open.authenticated(request({}))).toBe(true);
    expect(authStatus(open)).toEqual({ guardedRoutesProtected: false });
    expect(authStatus(guard)).toEqual({ guardedRoutesProtected: true });
  });

  it('compares tokens of equal length rather than returning early on the first byte', async () => {
    // A same-length wrong token must still be refused; this is the case a naive === would pass
    // on length but a timing-unsafe compare would leak.
    const sameLength = TOKEN.slice(0, -1) + (TOKEN.endsWith('x') ? 'y' : 'x');
    expect(sameLength).toHaveLength(TOKEN.length);
    const { reply: r, sent } = reply();
    await guard.require(request({ authorization: `Bearer ${sameLength}` }), r);
    expect(sent.status).toBe(401);
  });
});
