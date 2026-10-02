import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';

export interface SolanaAdminIdentity {
  userId: string;
  email: string;
  role: 'ADMIN';
  name: string;
}

interface SolanaAdminRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'ADMIN';
  is_active: boolean;
}

export interface AdminAuthStatus {
  configured: boolean;
  needsBootstrap: boolean;
  bootstrapFromEnvironmentAvailable: boolean;
}

function secureEquals(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function resolveJwtSecret(): string | null {
  const explicit = process.env.SOLANA_JWT_SECRET || process.env.JWT_SECRET;
  if (explicit?.trim()) return explicit.trim();

  const legacyAdminToken = process.env.NEXUS_ADMIN_TOKEN;
  if (legacyAdminToken?.trim()) {
    return createHash('sha256')
      .update('nexus-quant-solana:jwt:v1:')
      .update(legacyAdminToken.trim())
      .digest('hex');
  }
  return null;
}

export class SolanaAdminAuthService {
  constructor(private readonly pool: Pool | null) {}

  public isDatabaseAvailable(): boolean {
    return Boolean(this.pool);
  }

  private getJwtSecret(): string {
    const secret = resolveJwtSecret();
    if (!secret) {
      throw new Error('SOLANA_JWT_SECRET/JWT_SECRET não configurado e NEXUS_ADMIN_TOKEN indisponível.');
    }
    return secret;
  }

  public async initSchema(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS solana_admin_users (
        id VARCHAR(96) PRIMARY KEY,
        email VARCHAR(320) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(160) NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'ADMIN' CHECK (role = 'ADMIN'),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_solana_admin_users_email
        ON solana_admin_users (LOWER(email));
    `);
  }

  public async bootstrapAdministratorFromEnvironment(): Promise<{ createdOrUpdated: boolean; email?: string }> {
    if (!this.pool) return { createdOrUpdated: false };
    const email = normalizeEmail(process.env.ADMIN_EMAIL || '');
    const password = process.env.ADMIN_PASSWORD || '';
    const name = String(process.env.ADMIN_NAME || 'Administrador Nexus Solana').trim();

    if (!email || !password) return { createdOrUpdated: false };
    if (password.length < 8) {
      throw new Error('ADMIN_PASSWORD deve ter no mínimo 8 caracteres.');
    }

    await this.initSchema();
    const hash = await bcrypt.hash(password, 12);
    const id = `sol-admin-${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;

    await this.pool.query(
      `INSERT INTO solana_admin_users (id, email, password_hash, name, role, is_active)
       VALUES ($1, $2, $3, $4, 'ADMIN', TRUE)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         name = EXCLUDED.name,
         role = 'ADMIN',
         is_active = TRUE,
         updated_at = NOW()`,
      [id, email, hash, name]
    );

    return { createdOrUpdated: true, email };
  }

  public async hasAdmin(): Promise<boolean> {
    if (!this.pool) return false;
    await this.initSchema();
    const result = await this.pool.query(
      `SELECT 1 FROM solana_admin_users WHERE role = 'ADMIN' AND is_active = TRUE LIMIT 1`
    );
    return (result.rowCount || 0) > 0;
  }

  public async getStatus(): Promise<AdminAuthStatus> {
    const configured = Boolean(resolveJwtSecret()) && Boolean(this.pool);
    const hasAdmin = configured ? await this.hasAdmin() : false;
    return {
      configured,
      needsBootstrap: configured && !hasAdmin,
      bootstrapFromEnvironmentAvailable: Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD)
    };
  }

  public async registerFirstAdmin(input: {
    email: string;
    password: string;
    name: string;
    bootstrapToken: string;
  }): Promise<SolanaAdminIdentity> {
    if (!this.pool) throw new Error('Postgres indisponível para cadastro administrativo.');
    await this.initSchema();

    if (await this.hasAdmin()) {
      throw new Error('Administrador já cadastrado. Use o login.');
    }

    const expectedBootstrap = String(process.env.NEXUS_ADMIN_TOKEN || '').trim();
    if (!expectedBootstrap || !input.bootstrapToken || !secureEquals(input.bootstrapToken.trim(), expectedBootstrap)) {
      throw new Error('Código mestre inválido.');
    }

    const email = normalizeEmail(input.email);
    const name = String(input.name || '').trim();
    const password = String(input.password || '');

    if (!email || !email.includes('@')) throw new Error('Email administrativo inválido.');
    if (!name) throw new Error('Nome do administrador é obrigatório.');
    if (password.length < 8) throw new Error('A senha deve ter no mínimo 8 caracteres.');

    const hash = await bcrypt.hash(password, 12);
    const id = `sol-admin-${Date.now()}-${createHash('sha256').update(email).digest('hex').slice(0, 10)}`;

    await this.pool.query(
      `INSERT INTO solana_admin_users (id, email, password_hash, name, role, is_active)
       VALUES ($1, $2, $3, $4, 'ADMIN', TRUE)`,
      [id, email, hash, name]
    );

    return { userId: id, email, role: 'ADMIN', name };
  }

  public async login(emailInput: string, password: string): Promise<{ token: string; user: SolanaAdminIdentity }> {
    if (!this.pool) throw new Error('Postgres indisponível para login.');
    await this.initSchema();

    const email = normalizeEmail(emailInput);
    const result = await this.pool.query<SolanaAdminRecord>(
      `SELECT id, email, password_hash, name, role, is_active
       FROM solana_admin_users
       WHERE LOWER(email) = LOWER($1) AND role = 'ADMIN'
       LIMIT 1`,
      [email]
    );
    const user = result.rows[0];

    if (!user || !user.is_active) throw new Error('Credenciais inválidas.');
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) throw new Error('Credenciais inválidas.');

    const identity: SolanaAdminIdentity = {
      userId: user.id,
      email: user.email,
      role: 'ADMIN',
      name: user.name
    };

    const token = jwt.sign(identity, this.getJwtSecret(), { expiresIn: '8h' });
    return { token, user: identity };
  }

  public verifyAdminToken(token: string): SolanaAdminIdentity | null {
    try {
      const payload = jwt.verify(token, this.getJwtSecret()) as SolanaAdminIdentity;
      if (payload?.role !== 'ADMIN' || !payload.userId || !payload.email) return null;
      return payload;
    } catch {
      return null;
    }
  }

  public async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    if (!this.pool) throw new Error('Postgres indisponível.');
    if (newPassword.length < 8) throw new Error('A nova senha deve ter no mínimo 8 caracteres.');

    const result = await this.pool.query<SolanaAdminRecord>(
      `SELECT id, email, password_hash, name, role, is_active
       FROM solana_admin_users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) throw new Error('Administrador não encontrado.');

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) throw new Error('Senha atual incorreta.');

    const hash = await bcrypt.hash(newPassword, 12);
    await this.pool.query(
      `UPDATE solana_admin_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, userId]
    );
  }
}
