import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { DashboardState, renderDashboardHtml } from '../dashboard/dashboardRenderer.js';
import type { DecisionLogger } from '../database/decisionJournal.js';
import { handleJournalRoutes } from './journalRoutes.js';

export type ExitReason = 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL';

export interface RouteContext {
  latestState: DashboardState;
  drawdownState?: { tier: string; dailyPnlSol: number; dailyTradeCount: number; pausedUntil: number | null; lastResetDate: string };
  executeExitOrder?: (mint: string, reason: ExitReason | string, pnlPct: number, exitSolValue: number, options?: { exitTokenAmount?: number; shouldCloseAta?: boolean }) => Promise<any>;
  liquidateHolding?: (payload: { mint: string; symbol: string; amount: number; decimals: number }) => Promise<any>;
  getAllOpenPositions?: () => any[];
  sweepRent?: () => Promise<any>;
  panicToken?: (mint: string) => Promise<{ success: boolean; txid?: string; message?: string; error?: string }>;
  panicAll?: () => Promise<{ success: boolean; liquidationsCount: number; message?: string; error?: string }>;
  runCalibration?: () => Promise<any>;
  getSnapshots?: (limit: number) => Promise<any[]>;
  pgPool?: Pool | null;
  journal?: DecisionLogger | null;
  adminToken?: string;
  allowedCorsOrigins?: string[];
  enableLegacyPanicApi?: boolean;
}

function isProtectedMutation(pathname: string, method: string): boolean {
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
    return false;
  }

  return (
    pathname.startsWith('/api/panic/') ||
    pathname.startsWith('/api/positions/') ||
    pathname === '/api/wallet/liquidate-holding' ||
    pathname === '/api/wallet/sweep-rent' ||
    pathname === '/api/calibration/run'
  );
}

function secureTokenEquals(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer);
}

function authorizeMutation(req: IncomingMessage, res: ServerResponse, adminToken?: string): boolean {
  const expectedToken = (adminToken || '').trim();
  if (!expectedToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Admin API authentication is not configured.' }));
    return false;
  }

  const rawHeader = req.headers.authorization;
  const authHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const prefix = 'Bearer ';
  const receivedToken = authHeader?.startsWith(prefix) ? authHeader.slice(prefix.length).trim() : '';

  if (!receivedToken || !secureTokenEquals(receivedToken, expectedToken)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer'
    });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized.' }));
    return false;
  }

  return true;
}

function applyCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  allowedCorsOrigins: string[]
): void {
  if (typeof res.setHeader !== 'function') return;

  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  const allowed = new Set(
    allowedCorsOrigins
      .map(value => value.trim())
      .filter(value => value.length > 0 && value !== '*')
  );

  if (origin && allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/**
 * Roteador HTTP Modular para o Nexus Quant Solana
 * Desacopla o servidor de rotas, healthchecks, API REST e painel web institucional.
 */
export async function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext
): Promise<boolean> {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method || 'GET';

  const allowedCorsOrigins = ctx.allowedCorsOrigins ??
    (process.env.NEXUS_CORS_ORIGINS || '').split(',');
  applyCorsHeaders(req, res, allowedCorsOrigins);

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (isProtectedMutation(pathname, method)) {
    const adminToken = ctx.adminToken ?? process.env.NEXUS_ADMIN_TOKEN;
    if (!authorizeMutation(req, res, adminToken)) {
      return true;
    }
  }

  // 0. Rotas Especializadas do Decision Journal, Auditoria do Ledger & Calibração
  if (
    pathname.startsWith('/api/journal') ||
    pathname === '/api/decisions/audit' ||
    pathname === '/api/audit'
  ) {
    const handledJournal = await handleJournalRoutes(req, res, ctx.pgPool ?? null, ctx.journal ?? null);
    if (handledJournal) return true;
  }

  // 1. Healthcheck padrão para monitoramento (Railway, K8s, UptimeRobot)
  if (pathname === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ONLINE',
      agent: ctx.latestState.agent,
      wallet: ctx.latestState.wallet,
      balanceSol: ctx.latestState.balanceSol,
      positionsCount: ctx.latestState.positions?.length || 0,
      timestamp: new Date().toISOString()
    }));
    return true;
  }

  // 2. Rota de Estado Global da Máquina Quant (Estrutura Completa & Padronizada)
  if (pathname === '/api/status' && method === 'GET') {
    const s = ctx.latestState;
    const formattedPositions = (s.positions || []).map(p => ({
      mint: p.mint,
      symbol: p.symbol,
      tokenAmount: p.tokenAmount,
      entryPriceUsd: p.entryPriceUsd,
      currentPriceUsd: p.currentPriceUsd,
      pnlPercent: Number((p.pnlPct * 100).toFixed(2)),
      stopLossPct: Number((p.stopLossPct * 100).toFixed(2)),
      takeProfitPct: Number(((p.takeProfitPct || 0) * 100).toFixed(2)),
      // Estado real de proteção (antes vinha sempre false do backend)
      trailingStopActive: Boolean(p.trailingActive),
      stopStatusText: p.stopStatusText,
      trailingStopSolValue: p.trailingStopSolValue,
      peakSolValue: p.peakSolValue,
      solscanUrl: p.solscanUrl,
      dexScreenerUrl: p.dexScreenerUrl,
      timeOpenSeconds: Math.floor((Date.now() - (p.entryTimestamp || Date.now())) / 1000)
    }));

    const formattedLogs = (s.scannerLogs || []).map(l =>
      typeof l === 'string' ? l : `[${l.timestamp}] ${l.message}`
    );

    // Histórico de trades encerrados, com assinatura da TX de saída para
    // auditoria on-chain. Este dado já era populado em closedTrades mas não
    // tinha superfície visual no painel.
    const formattedClosedTrades = (s.closedTrades || []).map(t => ({
      mint: t.mint,
      symbol: t.symbol,
      tokenAmount: t.tokenAmount,
      entryPriceUsd: t.entryPriceUsd,
      exitPriceUsd: t.exitPriceUsd,
      realizedPnlSol: Number((t.pnlSolEst || 0).toFixed(6)),
      pnlPct: Number((t.pnlPct * 100).toFixed(2)),
      entryTimestamp: t.entryTimestamp,
      exitReason: t.exitReason,
      txSignature: t.txSignature || null,
      txUrl: t.txSignature ? `https://solscan.io/tx/${t.txSignature}` : null,
      closedAt: t.exitTimestamp,
      dexScreenerUrl: t.dexScreenerUrl,
      solscanUrl: t.solscanUrl
    }));

    // Auditorias recentes: probes, aprovações e falhas de swap.
    const formattedAudits = (s.recentAudits || []).map(a => ({
      mint: a.mint,
      symbol: a.symbol,
      isSafe: a.isSafe,
      score: a.score,
      reason: a.reason || null,
      swapFailReason: a.swapFailReason || null,
      timestamp: a.timestamp
    }));

    const responsePayload = {
      // Formato exigido para clientes avançados / ordem de execução
      wallet: {
        address: s.wallet,
        balanceSol: s.balanceSol
      },
      sentinel: {
        status: s.macroRegime || 'NORMAL',
        circuitBreaker: s.circuitBreakerActive ? 'ENGAGED' : 'DISENGAGED'
      },
      drawdown: ctx.drawdownState || { tier: 'ACTIVE', dailyPnlSol: 0, dailyTradeCount: 0, pausedUntil: null, lastResetDate: '' },
      incubator: {
        waiting: s.incubator?.waiting ?? 0,
        mature: s.incubator?.mature ?? 0,
        technicalDiscards: s.incubator?.technicalDiscards ?? 0,
        aylaEligible: s.incubator?.aylaEligible ?? 0
      },
      positions: formattedPositions,
      recentLogs: formattedLogs,
      closedTrades: formattedClosedTrades,
      recentAudits: formattedAudits,
      walletHoldings: s.walletHoldings || [],
      totalRealizedPnlSol: s.totalRealizedPnlSol,
      totalNetworkFeesSolEst: s.totalNetworkFeesSolEst,

      // Campos legados mantidos para retrocompatibilidade
      agent: s.agent,
      balanceSol: s.balanceSol,
      vitalityState: s.vitalityState,
      dryRun: s.dryRun,
      macroRegime: s.macroRegime,
      circuitBreakerActive: s.circuitBreakerActive,
      activeRpcUrl: s.activeRpcUrl,
      quarantineCount: s.quarantineCount,
      lastUpdated: s.lastUpdated,
      scannerLogs: s.scannerLogs
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responsePayload, null, 2));
    return true;
  }

  // 3. Rota de Holdings (Tokens custodiados na carteira Phantom)
  if (pathname === '/api/holdings' && method === 'GET') {
    const sanitizedHoldings = (ctx.latestState.walletHoldings || []).filter(h => 
      h && h.mint && h.symbol && h.symbol !== 'undefined' && h.symbol.trim() !== ''
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sanitizedHoldings, null, 2));
    return true;
  }

  // 4. PÂNICO INDIVIDUAL: POST /api/panic/:mint (ou POST /api/positions/:mint/exit)
  const isPanicMint = pathname.startsWith('/api/panic/') && pathname !== '/api/panic/all';
  const isPositionExit = pathname.startsWith('/api/positions/') && pathname.endsWith('/exit');
  const legacyPanicEnabled = ctx.enableLegacyPanicApi ??
    (process.env.NEXUS_ENABLE_LEGACY_PANIC_API === 'true');

  if (isPanicMint && method === 'POST' && !legacyPanicEnabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Legacy panic API disabled. Use the authenticated /api/positions/:mint/exit path.'
    }));
    return true;
  }

  if ((isPanicMint || isPositionExit) && method === 'POST') {
    const segments = pathname.split('/');
    const mint = decodeURIComponent(isPanicMint ? segments[3] || '' : segments[3] || '');
    if (!mint || mint === 'undefined') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Mint inválido fornecido.' }));
      return true;
    }

    if (isPanicMint && ctx.panicToken) {
      try {
        const result = await ctx.panicToken(mint);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err?.message || 'Falha ao executar pânico para a moeda' }));
      }
      return true;
    }

    if (ctx.executeExitOrder) {
      const result = await ctx.executeExitOrder(mint, 'MANUAL', 0, 0, { shouldCloseAta: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...result,
        success: result?.success !== false,
        txSignature: result?.txSignature || null,
        txid: result?.txSignature || null,
        message: result?.success === false
          ? 'Saída manual não confirmada; posição preservada.'
          : 'Saída manual processada pelo executor de posições.'
      }));
      return true;
    }

    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Executor de pânico indisponível' }));
    return true;
  }

  // 5. PÂNICO GERAL: legado /api/panic/all e caminho seguro /api/positions/liquidate-all
  const isLegacyPanicAll = pathname === '/api/panic/all';
  const isPositionLiquidateAll = pathname === '/api/positions/liquidate-all';

  if (isLegacyPanicAll && method === 'POST' && !legacyPanicEnabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Legacy panic API disabled. Use the authenticated /api/positions/liquidate-all path.'
    }));
    return true;
  }

  if ((isLegacyPanicAll || isPositionLiquidateAll) && method === 'POST') {
    if (isLegacyPanicAll && ctx.panicAll) {
      try {
        const result = await ctx.panicAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [], ...result }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err?.message || 'Falha no pânico geral' }));
      }
      return true;
    }

    if (ctx.getAllOpenPositions && ctx.executeExitOrder) {
      const positions = ctx.getAllOpenPositions();
      const results = [];
      for (const pos of positions) {
        const exitResult = await ctx.executeExitOrder(pos.mint, 'MANUAL', 0, 0, { shouldCloseAta: true });
        results.push({ mint: pos.mint, symbol: pos.symbol, ...exitResult });
      }

      if (ctx.sweepRent) {
        await ctx.sweepRent().catch(() => {});
      }

      const failures = results.filter((result: any) =>
        result?.success === false || result?.status === 'FAILED'
      );
      const liquidationsCount = results.length - failures.length;

      ctx.latestState.circuitBreakerActive = true;
      res.writeHead(failures.length === 0 ? 200 : 207, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: failures.length === 0,
        liquidationsCount,
        failureCount: failures.length,
        message: `${liquidationsCount} posições liquidadas; ${failures.length} falha(s).`,
        results
      }));
      return true;
    }

    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Funções de pânico geral indisponíveis' }));
    return true;
  }

  // 6. Rota de Liquidação Direta de Qualquer Token On-Chain (avulso)
  if (pathname === '/api/wallet/liquidate-holding' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.mint || payload.mint === 'undefined' || !payload.symbol || payload.symbol === 'undefined' || Number(payload.amount || 0) <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Mint e amount válidos são obrigatórios (símbolo não pode ser undefined).' }));
          return;
        }

        if (ctx.liquidateHolding) {
          const resExit = await ctx.liquidateHolding(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(resExit));
        } else {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'liquidateHolding não implementado no contexto' }));
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err?.message || 'Falha interna ao processar requisição' }));
      }
    });
    return true;
  }

  // 7. Rota de Varredura de Rent (Fechamento de ATAs vazias e devolução de SOL)
  if (pathname === '/api/wallet/sweep-rent' && method === 'POST') {
    if (ctx.sweepRent) {
      try {
        const result = await ctx.sweepRent();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err?.message || 'Falha ao executar varredura de rent' }));
      }
    } else {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'sweepRent não configurado no contexto' }));
    }
    return true;
  }

  // 8. Rota de Calibração Manual (POST /api/calibration/run)
  if (pathname === '/api/calibration/run' && method === 'POST') {
    if (ctx.runCalibration) {
      try {
        const report = await ctx.runCalibration();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: 'READ_ONLY',
          summary: {
            totalTrades: report.totalTrades,
            totalDecisions: report.totalDecisions,
            overallWinRate: report.overallWinRate,
            overallEV: report.overallEV,
            gateCount: report.gateMetrics?.length || 0,
            warningCount: report.warnings?.length || 0,
          },
          gates: report.gateMetrics || [],
          latency: report.latencyMetrics || [],
          warnings: report.warnings || [],
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err?.message || 'Falha ao executar calibração' }));
      }
    } else {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'runCalibration não configurado no contexto' }));
    }
    return true;
  }

  // 9. Rota de Consulta de Snapshots (GET /api/calibration/snapshots)
  if (pathname === '/api/calibration/snapshots' && method === 'GET') {
    const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '50', 10), 200);
    if (ctx.getSnapshots) {
      try {
        const rows = await ctx.getSnapshots(limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ snapshots: rows }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'Falha ao consultar snapshots' }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ snapshots: [] }));
    }
    return true;
  }

  // 10. Dashboard Web Terminal Visual
  if ((pathname === '/' || pathname === '/dashboard') && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml(ctx.latestState));
    return true;
  }

  return false;
}
