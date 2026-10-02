import test from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import { handleAdminAuthRoutes } from './adminAuthRoutes.js';

function makeRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): any {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  const req = Readable.from(chunks) as any;
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost', ...headers };
  return req;
}

function makeResponse() {
  let statusCode = 0;
  let body = '';
  const headers = new Map<string, unknown>();
  const res = {
    setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
    writeHead: (code: number, extra?: Record<string, unknown>) => {
      statusCode = code;
      for (const [key, value] of Object.entries(extra || {})) headers.set(key.toLowerCase(), value);
    },
    end: (data?: string) => { body = data || ''; }
  } as any;
  return { res, headers, get statusCode() { return statusCode; }, get body() { return body; } };
}

test('login cria sessão HttpOnly/SameSite e não devolve JWT ao JavaScript', async () => {
  const req = makeRequest('/api/auth/login', 'POST', {
    email: 'admin@example.com',
    password: 'senha-segura'
  });
  const out = makeResponse();
  const auth = {
    login: async () => ({
      token: 'jwt-super-secreto',
      user: { userId: 'admin-1', email: 'admin@example.com', role: 'ADMIN', name: 'Admin' }
    })
  } as any;

  const handled = await handleAdminAuthRoutes(req, out.res, auth);
  assert.strictEqual(handled, true);
  assert.strictEqual(out.statusCode, 200);

  const cookie = String(out.headers.get('set-cookie') || '');
  assert.match(cookie, /nexusSolanaAdminSession=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=28800/);

  const payload = JSON.parse(out.body);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.session, 'cookie');
  assert.strictEqual(payload.token, undefined);
  assert.doesNotMatch(out.body, /jwt-super-secreto/);
});

test('/api/auth/me aceita a sessão pelo cookie', async () => {
  const req = makeRequest('/api/auth/me', 'GET', undefined, {
    cookie: 'nexusSolanaAdminSession=jwt-cookie-valido'
  });
  const out = makeResponse();
  const auth = {
    verifyAdminToken: (token: string) =>
      token === 'jwt-cookie-valido'
        ? { userId: 'admin-1', email: 'admin@example.com', role: 'ADMIN', name: 'Admin' }
        : null
  } as any;

  await handleAdminAuthRoutes(req, out.res, auth);
  assert.strictEqual(out.statusCode, 200);
  assert.strictEqual(JSON.parse(out.body).user.role, 'ADMIN');
});

test('logout expira o cookie de sessão no servidor', async () => {
  const req = makeRequest('/api/auth/logout', 'POST');
  const out = makeResponse();

  await handleAdminAuthRoutes(req, out.res, {} as any);
  assert.strictEqual(out.statusCode, 200);
  const cookie = String(out.headers.get('set-cookie') || '');
  assert.match(cookie, /nexusSolanaAdminSession=;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=0/);
});
