import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SolanaAdminAuthService } from './adminAuthService.js';

const ADMIN_SESSION_COOKIE = 'nexusSolanaAdminSession';
const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function getCookieValue(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const [cookieName, ...rest] = part.trim().split('=');
    if (cookieName === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

function setAdminSessionCookie(res: ServerResponse, token: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}${secure}`
  );
}

function clearAdminSessionCookie(res: ServerResponse): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  );
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    size += Buffer.byteLength(text);
    if (size > 64 * 1024) throw new Error('Payload excede 64KB.');
    body += text;
  }
  if (!body.trim()) return {};
  return JSON.parse(body);
}

export function getBearerToken(req: IncomingMessage): string {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export function getAdminAuthToken(req: IncomingMessage): string {
  return getBearerToken(req) || getCookieValue(req, ADMIN_SESSION_COOKIE);
}

export async function handleAdminAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  auth: SolanaAdminAuthService
): Promise<boolean> {
  const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  const method = req.method || 'GET';

  if (pathname === '/api/auth/status' && method === 'GET') {
    try {
      const status = await auth.getStatus();
      json(res, 200, status);
    } catch (err: any) {
      json(res, 503, { configured: false, needsBootstrap: false, error: err?.message || String(err) });
    }
    return true;
  }

  if (pathname === '/api/auth/register-admin' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const bootstrapHeader = req.headers['x-admin-bootstrap'];
      const bootstrapToken = String(
        body.bootstrapToken || (Array.isArray(bootstrapHeader) ? bootstrapHeader[0] : bootstrapHeader) || ''
      );

      const user = await auth.registerFirstAdmin({
        email: String(body.email || ''),
        password: String(body.password || ''),
        name: String(body.name || ''),
        bootstrapToken
      });
      const login = await auth.login(user.email, String(body.password || ''));
      setAdminSessionCookie(res, login.token);
      json(res, 201, { success: true, user: login.user, session: 'cookie' });
    } catch (err: any) {
      const message = err?.message || String(err);
      const status = /já cadastrado/i.test(message) ? 409 : /inválid|obrigat|mínimo|mestre/i.test(message) ? 400 : 500;
      json(res, status, { success: false, error: message });
    }
    return true;
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.email || !body.password) {
        json(res, 400, { success: false, error: 'Email e senha são obrigatórios.' });
        return true;
      }
      const result = await auth.login(String(body.email), String(body.password));
      setAdminSessionCookie(res, result.token);
      json(res, 200, { success: true, user: result.user, session: 'cookie' });
    } catch (err: any) {
      const message = err?.message || String(err);
      const status = /Credenciais inválidas/i.test(message) ? 401 : 503;
      json(res, status, { success: false, error: message });
    }
    return true;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    clearAdminSessionCookie(res);
    json(res, 200, { success: true });
    return true;
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const identity = auth.verifyAdminToken(getAdminAuthToken(req));
    if (!identity) {
      json(res, 401, { success: false, error: 'Token inválido ou expirado.' });
      return true;
    }
    json(res, 200, { success: true, user: identity });
    return true;
  }

  if (pathname === '/api/auth/change-password' && method === 'POST') {
    const identity = auth.verifyAdminToken(getAdminAuthToken(req));
    if (!identity) {
      json(res, 401, { success: false, error: 'Token inválido ou expirado.' });
      return true;
    }

    try {
      const body = await readJsonBody(req);
      await auth.changePassword(
        identity.userId,
        String(body.currentPassword || ''),
        String(body.newPassword || '')
      );
      json(res, 200, { success: true, message: 'Senha alterada com sucesso.' });
    } catch (err: any) {
      json(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  return false;
}
