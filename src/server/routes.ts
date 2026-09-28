import type { IncomingMessage, ServerResponse } from 'node:http';
import { DashboardState, renderDashboardHtml } from '../dashboard/dashboardRenderer.js';

export type ExitReason = 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL';

export interface RouteContext {
  latestState: DashboardState;
  executeExitOrder?: (mint: string, reason: ExitReason | string, pnlPct: number, exitSolValue: number) => Promise<any>;
  liquidateHolding?: (payload: { mint: string; symbol: string; amount: number; decimals: number }) => Promise<any>;
  getAllOpenPositions?: () => any[];
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

  // 2. Rota de Estado Global da Máquina Quant
  if (pathname === '/api/status' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(ctx.latestState, null, 2));
    return true;
  }

  // 3. Rota de Holdings (Tokens custodiados na carteira Phantom)
  if (pathname === '/api/holdings' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(ctx.latestState.walletHoldings || [], null, 2));
    return true;
  }

  // 4. Venda Manual de Posição Específica sob Gestão
  if (pathname.startsWith('/api/positions/') && pathname.endsWith('/exit') && method === 'POST') {
    const segments = pathname.split('/');
    const mint = decodeURIComponent(segments[3] || '');
    if (ctx.executeExitOrder) {
      const result = await ctx.executeExitOrder(mint, 'MANUAL', 0, 0);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Executor de saída não configurado no contexto' }));
    }
    return true;
  }

  // 5. Panic Button: Liquidar Todas as Posições em Aberto
  if (pathname === '/api/positions/liquidate-all' && method === 'POST') {
    if (!ctx.getAllOpenPositions || !ctx.executeExitOrder) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Funções de liquidação global indisponíveis' }));
      return true;
    }

    const positions = ctx.getAllOpenPositions();
    const results = [];
    for (const pos of positions) {
      const exitResult = await ctx.executeExitOrder(pos.mint, 'MANUAL', 0, 0);
      results.push({ mint: pos.mint, symbol: pos.symbol, ...exitResult });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ message: `${results.length} posições liquidadas a mercado.`, results }));
    return true;
  }

  // 6. Rota de Liquidação Direta de Qualquer Token On-Chain (mesmo avulso)
  if (pathname === '/api/wallet/liquidate-holding' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.mint || Number(payload.amount || 0) <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Mint e amount válidos são obrigatórios.' }));
          return;
        }

        if (ctx.liquidateHolding) {
          const resExit = await ctx.liquidateHolding(payload);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

  // 7. Dashboard Web Terminal Visual
  if ((pathname === '/' || pathname === '/dashboard') && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml(ctx.latestState));
    return true;
  }

  return false;
}
