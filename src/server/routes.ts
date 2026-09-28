import type { IncomingMessage, ServerResponse } from 'node:http';
import { DashboardState, renderDashboardHtml } from '../dashboard/dashboardRenderer.js';

export type ExitReason = 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL';

export interface RouteContext {
  latestState: DashboardState;
  executeExitOrder?: (mint: string, reason: ExitReason | string, pnlPct: number, exitSolValue: number, options?: { exitTokenAmount?: number; shouldCloseAta?: boolean }) => Promise<any>;
  liquidateHolding?: (payload: { mint: string; symbol: string; amount: number; decimals: number }) => Promise<any>;
  getAllOpenPositions?: () => any[];
  sweepRent?: () => Promise<any>;
  panicToken?: (mint: string) => Promise<{ success: boolean; txid?: string; message?: string; error?: string }>;
  panicAll?: () => Promise<{ success: boolean; liquidationsCount: number; message?: string; error?: string }>;
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

  // Middlewares: Cabeçalhos CORS Irrestritos Universais
  if (typeof res.setHeader === 'function') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
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
      entryPriceUsd: p.entryPriceUsd,
      currentPriceUsd: p.currentPriceUsd,
      pnlPercent: Number((p.pnlPct * 100).toFixed(2)),
      stopLossPercent: Number((p.stopLossPct * 100).toFixed(2)),
      trailingStopActive: Boolean(p.trailingActive),
      timeOpenSeconds: Math.floor((Date.now() - (p.entryTimestamp || Date.now())) / 1000)
    }));

    const formattedLogs = (s.scannerLogs || []).map(l => 
      typeof l === 'string' ? l : `[${l.timestamp}] ${l.message}`
    );

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
      incubator: {
        waiting: s.incubator?.waiting ?? 0,
        mature: s.incubator?.mature ?? 0,
        technicalDiscards: s.incubator?.technicalDiscards ?? 0,
        aylaEligible: s.incubator?.aylaEligible ?? 0
      },
      positions: formattedPositions,
      recentLogs: formattedLogs,

      // Campos legados mantidos para retrocompatibilidade
      agent: s.agent,
      balanceSol: s.balanceSol,
      vitalityState: s.vitalityState,
      dryRun: s.dryRun,
      macroRegime: s.macroRegime,
      circuitBreakerActive: s.circuitBreakerActive,
      activeRpcUrl: s.activeRpcUrl,
      totalRealizedPnlSol: s.totalRealizedPnlSol,
      quarantineCount: s.quarantineCount,
      lastUpdated: s.lastUpdated,
      scannerLogs: s.scannerLogs,
      closedTrades: s.closedTrades,
      walletHoldings: s.walletHoldings
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

  if ((isPanicMint || isPositionExit) && method === 'POST') {
    const segments = pathname.split('/');
    const mint = decodeURIComponent(isPanicMint ? segments[3] || '' : segments[3] || '');
    if (!mint || mint === 'undefined') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Mint inválido fornecido.' }));
      return true;
    }

    if (ctx.panicToken) {
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
        txSignature: result?.txSignature || 'SIMULATED_PANIC',
        txid: result?.txSignature || 'SIMULATED_PANIC',
        message: 'Moeda liquidada e aluguel de ~0.00204 SOL recuperado.'
      }));
      return true;
    }

    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Executor de pânico indisponível' }));
    return true;
  }

  // 5. PÂNICO GERAL: POST /api/panic/all (ou POST /api/positions/liquidate-all)
  if ((pathname === '/api/panic/all' || pathname === '/api/positions/liquidate-all') && method === 'POST') {
    if (ctx.panicAll) {
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

      ctx.latestState.circuitBreakerActive = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        liquidationsCount: results.length,
        message: `${results.length} posições liquidadas a mercado.`,
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

  // 8. Dashboard Web Terminal Visual
  if ((pathname === '/' || pathname === '/dashboard') && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml(ctx.latestState));
    return true;
  }

  return false;
}
