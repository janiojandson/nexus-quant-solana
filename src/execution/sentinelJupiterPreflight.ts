import type { SwapQuoteResult } from '../blockchain/dexAggregator.js';
export function sentinelQuotePool(quote: SwapQuoteResult, mint: string): string | null {
  const routes = quote.rawQuote?.routePlan;
  if (!Array.isArray(routes)) return null;
  const pools = [...new Set<string>(routes.filter(r => r?.swapInfo?.outputMint === mint)
    .map(r => r?.swapInfo?.ammKey).filter((p): p is string => typeof p === 'string' && p.length > 0))];
  // A split route with multiple destination pools requires multiple audits; fail closed here.
  return pools.length === 1 ? pools[0] : null;
}
export function sentinelQuoteImpactAllowed(quote: SwapQuoteResult): boolean {
  const raw = quote.rawQuote;
  const impactKnown = (raw?.priceImpact != null && Number.isFinite(Number(raw.priceImpact))) ||
    (raw?.priceImpactPct != null && Number.isFinite(Number(raw.priceImpactPct)));
  return impactKnown && Number.isFinite(quote.priceImpactPct) && Math.abs(quote.priceImpactPct) <= 2.5;
}
export async function waitForSentinelJupiterRoute(
  mint: string, quote: (signal: AbortSignal) => Promise<SwapQuoteResult | null>, now = Date.now,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), windowMs = 45_000
): Promise<{ quote: SwapQuoteResult; poolAddress: string } | null> {
  const deadline = now() + windowMs;
  let stopped = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<null>(resolve => { timer = setTimeout(() => { stopped = true; controller.abort(); resolve(null); }, windowMs); });
  const poll = async () => {
    while (!stopped && now() < deadline) {
      try {
        const route = await quote(controller.signal);
        if (stopped || now() >= deadline) return null;
        const poolAddress = route && sentinelQuotePool(route, mint);
        if (route && route.outAmount > 0 && poolAddress && sentinelQuoteImpactAllowed(route)) return { quote: route, poolAddress };
      } catch { /* Unindexed routes are retried inside the bounded preflight window. */ }
      if (!stopped && now() < deadline) await sleep(Math.min(2_000, deadline - now()));
    }
    return null;
  };
  try { return await Promise.race([poll(), expiry]); }
  finally { stopped = true; controller.abort(); clearTimeout(timer!); }
}
