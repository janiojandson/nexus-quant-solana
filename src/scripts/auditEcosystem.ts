// ==============================================================================
// src/scripts/auditEcosystem.ts — Diagnóstico de Ecossistema & Equalização de Risco
// ==============================================================================
// Executa 3 auditorias sem abrir ordens:
// 1. Auditoria Laya (POST /v1/systemone via protocolo Jev Wire)
// 2. Auditoria Sentinel Handoff (PostgreSQL tabela sentinel_handoff)
// 3. Auditoria de Carteira & Equalização de Risco (Helius RPC + 0.025 SOL)
// ==============================================================================

import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import pg from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';
import { BUY_AMOUNT_SOL, BUY_AMOUNT_LAMPORTS } from '../config/env.js';

const OFFICIAL_PHANTOM_WALLET =
  process.env.AGENT_SOLANA_PUBLIC_KEY || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';

const LAYA_URL =
  process.env.SOLANA_LAYA_NATIVE_URL || 'http://nexus-decisor-laya.railway.internal:8001';

const DB_URL =
  process.env.DATABASE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  'postgresql://postgres:RqTVXNATEwQOMryilqbZZOUttNTQuJmk@zephyr.proxy.rlwy.net:25561/railway';

const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  'https://mainnet.helius-rpc.com/?api-key=b84d44ce-1e66-49f9-8b5e-0193cf14b1ae';

async function runAudit(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('       🔬 NEXUS QUANT SOLANA — AUDITORIA DE ECOSSISTEMA & RISCO            ');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  // ───────────────────────────────────────────────────────────────────────────
  // 1. AUDITORIA DA LAYA (POST /v1/systemone - Jev Wire Protocol)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('📡 [1/3] AUDITORIA DO DECISOR LAYA (JEV WIRE PROTOCOL)');
  console.log(`   Endpoint Alvo: ${LAYA_URL}/v1/systemone`);

  const jevWirePayload = {
    state: {
      body: 'Auditoria de diagnóstico de ecossistema, latência e vitalidade.',
      domain: 'solana_memecoin',
      contractVersion: 'solana-laya-entry/v1',
      stage: 'ECOSYSTEM_AUDIT_PING',
      hardSafetyGatesRemainAuthoritative: true,
      facts: {
        mint: 'So11111111111111111111111111111111111111112',
        liquidityUsd: 50000,
        holdersCount: 500,
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        rugCheckScore: 90
      }
    },
    questions: {
      action: {
        type: 'choice',
        instructions: 'Qual ação tática de Sistema 1 é adequada agora?',
        criteria: {
          BUY: 'Contexto favorável e seguro (score >= 75)',
          WAIT: 'Aguardar próximo ciclo',
          ABSTAIN: 'Confiança insuficiente',
          REJECT: 'Risco detectado',
          VETO: 'Anomalia grave'
        }
      },
      score: {
        type: 'score',
        instructions: 'Pontuação de qualidade e segurança de 0 a 100',
        min: 0,
        max: 100
      }
    },
    lang: 'pt',
    min_confidence: 0.85
  };

  const layaToken =
    process.env.SOLANA_LAYA_AUTH_TOKEN || process.env.SOLANA_LAYA_API_KEY;

  const tStart = Date.now();
  try {
    const layaRes = await axios.post(
      `${LAYA_URL.replace(/\/$/, '')}/v1/systemone`,
      jevWirePayload,
      {
        timeout: 4000,
        headers: layaToken ? { Authorization: `Bearer ${layaToken}` } : undefined
      }
    );
    const latencyMs = Date.now() - tStart;
    const isStatusOk = layaRes.status === 200;
    const isLatencyOk = latencyMs < 50;

    console.log(`   Status HTTP:     ${layaRes.status} ${isStatusOk ? '200 OK ✅' : '❌'}`);
    console.log(`   Latência Medida: ${latencyMs}ms ${isLatencyOk ? '⚡ (< 50ms - MALHA INTERNA OK)' : '⚠️ (Acima de 50ms)'}`);
    console.log(`   Payload Retorno:`, JSON.stringify(layaRes.data).slice(0, 150) + '...');
    console.log(`   Veredito Laya:   ✅ OPERACIONAL E RESPONDENDO`);
  } catch (err: any) {
    const latencyMs = Date.now() - tStart;
    console.log(`   Status:          FALHA NA CONEXÃO DIRETA`);
    console.log(`   Erro:            ${err?.message || err}`);
    if (String(err?.message || '').includes('ENOTFOUND')) {
      console.log(`   ℹ️ Observação:   Host '.railway.internal' acessível exclusivamente de dentro do container Railway.`);
      console.log(`                    Em deploy de produção (Railway VPC), a rota resolve e atinge < 50ms.`);
    }
  }

  console.log('\n───────────────────────────────────────────────────────────────────────────\n');

  // ───────────────────────────────────────────────────────────────────────────
  // 2. AUDITORIA DO SENTINEL HANDOFF (POSTGRESQL)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('🗄️ [2/3] AUDITORIA DO SENTINEL HANDOFF (POSTGRESQL)');
  const pool = new pg.Pool({ connectionString: DB_URL });

  try {
    // 1. Contagens
    const totalQuery = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM sentinel_handoff'
    );
    const consumedQuery = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM sentinel_handoff WHERE consumed_by_quant = TRUE'
    );
    const pendingQuery = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM sentinel_handoff WHERE consumed_by_quant = FALSE'
    );

    const totalCount = Number(totalQuery.rows[0]?.count || 0);
    const consumedCount = Number(consumedQuery.rows[0]?.count || 0);
    const pendingCount = Number(pendingQuery.rows[0]?.count || 0);

    console.log(`   Total de Tokens Registrados: ${totalCount}`);
    console.log(`   Tokens Consumidos (Quant):   ${consumedCount}`);
    console.log(`   Tokens Pendentes na Fila:    ${pendingCount}`);

    // 2. Último Registro Emitido
    const lastRowQuery = await pool.query<{
      mint: string;
      symbol: string;
      dev_wallet: string | null;
      laya_score: string | null;
      pnl_percent: string | null;
      status: string;
      consumed_by_quant: boolean;
      created_at: Date;
    }>(
      `SELECT mint, symbol, dev_wallet, laya_score, pnl_percent, status, consumed_by_quant, created_at
       FROM sentinel_handoff
       ORDER BY created_at DESC
       LIMIT 1`
    );

    if (lastRowQuery.rows.length > 0) {
      const last = lastRowQuery.rows[0];
      console.log('\n   ÚLTIMO REGISTRO EMITIDO PELO SENTINEL:');
      console.log(`   • Symbol:            ${last.symbol}`);
      console.log(`   • Mint:              ${last.mint}`);
      console.log(`   • Dev Wallet:        ${last.dev_wallet || 'N/A'}`);
      console.log(`   • Status:            ${last.status}`);
      console.log(`   • Laya Score:        ${last.laya_score ?? 'N/A'}`);
      console.log(`   • PnL%:              ${last.pnl_percent ? Number(last.pnl_percent).toFixed(2) + '%' : 'N/A'}`);
      console.log(`   • Consumido Quant:   ${last.consumed_by_quant ? 'SIM' : 'NÃO'}`);
      console.log(`   • Timestamp:         ${new Date(last.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    } else {
      console.log('   ℹ️ Nenhum token registrado ainda na tabela sentinel_handoff.');
    }
    console.log('   Veredito Banco:  ✅ BANCO CONECTADO E TABELA ACESSÍVEL');
  } catch (dbErr: any) {
    console.log(`   ❌ Erro PostgreSQL: ${dbErr?.message || dbErr}`);
  } finally {
    await pool.end().catch(() => {});
  }

  console.log('\n───────────────────────────────────────────────────────────────────────────\n');

  // ───────────────────────────────────────────────────────────────────────────
  // 3. AUDITORIA DE CARTEIRA & EQUALIZAÇÃO DE RISCO (HELIUS RPC)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('💰 [3/3] AUDITORIA DE CARTEIRA E EQUALIZAÇÃO DE RISCO');
  console.log(`   Carteira Oficial:  ${OFFICIAL_PHANTOM_WALLET}`);

  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    const balanceLamports = await connection.getBalance(new PublicKey(OFFICIAL_PHANTOM_WALLET));
    const balanceSol = balanceLamports / 1e9;

    const isFixedAmountOk = BUY_AMOUNT_SOL === 0.025 && BUY_AMOUNT_LAMPORTS === 25_000_000;
    const exposurePct = balanceSol > 0 ? (BUY_AMOUNT_SOL / balanceSol) * 100 : 0;

    console.log(`   Saldo On-Chain:    ${balanceSol.toFixed(6)} SOL (${balanceLamports.toLocaleString()} lamports)`);
    console.log(`   Stake Padronizado: ${BUY_AMOUNT_SOL} SOL (${BUY_AMOUNT_LAMPORTS} lamports) ${isFixedAmountOk ? '✅' : '❌'}`);
    console.log(`   Exposição Lote:    ${exposurePct.toFixed(2)}% do patrimônio total (Alvo: ~2%)`);

    if (isFixedAmountOk) {
      console.log('   Veredito Stake:  ✅ EQUALIZAÇÃO CONFIRMADA EM 0.025 SOL (25.000.000 lamports)');
    } else {
      console.log('   ❌ ERRO: BUY_AMOUNT_SOL difere de 0.025 SOL!');
    }
  } catch (rpcErr: any) {
    console.log(`   ❌ Erro RPC Helius: ${rpcErr?.message || rpcErr}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('                        AUDITORIA CONCLUÍDA                                ');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');
}

void runAudit();
