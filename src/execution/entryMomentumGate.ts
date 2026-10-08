import type { SwapQuoteResult } from '../blockchain/dexAggregator.js';
import { sentinelQuotePool, sentinelQuoteImpactAllowed } from './sentinelJupiterPreflight.js';

export interface EntryMomentumGateConfig {
  samples: number;
  intervalMs: number;
  minRisePct: number;
  maxRisePct: number;
  maxPullbackPct: number;
}

export interface EntryMomentumSample {
  timestamp: number;
  priceUsd?: number;
  priceSolPerAtomicToken?: number;
  requestId?: string;
  priceImpactPct?: number;
  poolAddress?: string;
}

export interface EntryMomentumResult {
  pass: boolean;
  risePct: number;
  maxPullbackPct: number;
  risingSteps: number;
  staleSource: boolean;
  reason: string;
  samples: EntryMomentumSample[];
}

export const DEFAULT_ENTRY_MOMENTUM_CONFIG: EntryMomentumGateConfig = {
  samples: 4,
  intervalMs: 1500,
  minRisePct: 0.40,
  maxRisePct: 4.00,
  maxPullbackPct: 0.30
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function evaluateEntryMomentum(
  samples: EntryMomentumSample[],
  config: EntryMomentumGateConfig,
  source: 'DEXSCREENER_PRICE' | 'JUPITER_EXECUTABLE' = 'DEXSCREENER_PRICE'
): EntryMomentumResult {
  const prices = samples.map(sample => sample.priceSolPerAtomicToken ?? sample.priceUsd ?? NaN);
  if (samples.length < (source === 'JUPITER_EXECUTABLE' ? 2 : 3) || prices.some(price => !Number.isFinite(price) || price <= 0)) {
    return {
      pass: false,
      risePct: 0,
      maxPullbackPct: 0,
      risingSteps: 0,
      staleSource: false,
      reason: 'Amostras de preço insuficientes ou inválidas.',
      samples
    };
  }

  const uniquePrices = new Set(prices.map(price => price.toPrecision(15)));
  if (uniquePrices.size === 1) {
    return {
      pass: false,
      risePct: 0,
      maxPullbackPct: 0,
      risingSteps: 0,
      staleSource: source === 'DEXSCREENER_PRICE',
      reason: source === 'DEXSCREENER_PRICE'
        ? 'Momentum pré-voo indeterminado ou fonte estagnada (STALE_SOURCE): fonte sem atualização.'
        : 'NO_POSITIVE_MOMENTUM: cotações novas sem avanço positivo; igualdade não comprova cache.',
      samples
    };
  }

  const first = prices[0];
  const last = prices[prices.length - 1];
  const risePct = ((last / first) - 1) * 100;

  let maxPullbackPct = 0;
  let risingSteps = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = prices[i - 1];
    const current = prices[i];
    if (current > previous) risingSteps++;
    if (current < previous) {
      maxPullbackPct = Math.max(maxPullbackPct, ((previous - current) / previous) * 100);
    }
  }

  const requiredRisingSteps = Math.ceil((samples.length - 1) * 0.67);
  let reason = 'Momentum de alta confirmado pela fonte de micropreço.';
  let pass = true;

  if (!Number.isFinite(config.minRisePct) || risePct <= 0 || risePct < config.minRisePct) {
    pass = false;
    reason = `Alta insuficiente: ${risePct.toFixed(3)}% < ${config.minRisePct}%.`;
  } else if (risePct > config.maxRisePct) {
    pass = false;
    reason = `Alta rápida demais: ${risePct.toFixed(3)}% > ${config.maxRisePct}%.`;
  } else if (risingSteps < requiredRisingSteps) {

    pass = false;
    reason = `Sequência sem continuidade: ${risingSteps}/${samples.length - 1} passos de alta.`;
  } else if (maxPullbackPct > config.maxPullbackPct) {
    pass = false;
    reason = `Pullback excessivo durante observação: ${maxPullbackPct.toFixed(3)}%.`;
  }

  return { pass, risePct, maxPullbackPct, risingSteps, staleSource: false, reason, samples };
}

export async function observeEntryMomentum(
  getPriceUsd: () => Promise<number | null>,
  config: EntryMomentumGateConfig = DEFAULT_ENTRY_MOMENTUM_CONFIG
): Promise<EntryMomentumResult> {
  const samples: EntryMomentumSample[] = [];

  for (let i = 0; i < config.samples; i++) {
    const priceUsd = await getPriceUsd();
    if (!priceUsd || !Number.isFinite(priceUsd) || priceUsd <= 0) {
      return evaluateEntryMomentum(samples, config);
    }
    samples.push({ timestamp: Date.now(), priceUsd });

    if (i < config.samples - 1) {
      await sleep(config.intervalMs);
    }
  }

  return evaluateEntryMomentum(samples, config);
}

/** Measures executable purchase cost; it does not infer buyer counts or swap order flow. */
export async function observeJupiterEntryMomentum(
  getFreshQuote: () => Promise<SwapQuoteResult>, mint: string, auditedPool: string | undefined,
  config: EntryMomentumGateConfig = {...DEFAULT_ENTRY_MOMENTUM_CONFIG, samples:2, intervalMs:1000}
): Promise<EntryMomentumResult> {
  const samples: EntryMomentumSample[] = [];
  const reject = (reason: string) => ({...evaluateEntryMomentum(samples, config, 'JUPITER_EXECUTABLE'), pass:false, staleSource:false, reason});
  if (!auditedPool) return reject('NO_AUDITED_POOL');
  let initialInput: number | undefined, initialRoute: string | undefined;
  for (let i=0;i<Math.max(2,config.samples);i++) {
    let quote: SwapQuoteResult;
    try { quote = await getFreshQuote(); } catch { return reject('NO_JUPITER_ROUTE'); }
    if (!Number.isSafeInteger(quote.inAmount) || quote.inAmount<=0 || !Number.isSafeInteger(quote.outAmount) || quote.outAmount<=0 || quote.outputMint!==mint) return reject('INVALID_JUPITER_AMOUNT');
    if (!sentinelQuoteImpactAllowed(quote)) return reject('PRICE_IMPACT_EXCEEDED_OR_UNKNOWN');
    const pool=sentinelQuotePool(quote,mint);
    if (pool!==auditedPool) return reject('AUDITED_POOL_MISMATCH');
    if (!Number.isFinite(quote.observedAtMs) || Date.now()-quote.observedAtMs!>5000 || quote.observedAtMs!>Date.now()+1000) return reject('QUOTE_FRESHNESS_UNCONFIRMED');
    const route=JSON.stringify({input:quote.inputMint,router:quote.router,feeBps:quote.feeBps,feeMint:quote.feeMint,
      legs:quote.rawQuote.routePlan.map((r:any)=>({pool:r.swapInfo?.ammKey,input:r.swapInfo?.inputMint,output:r.swapInfo?.outputMint,percent:r.percent,bps:r.bps}))});
    if (initialInput!==undefined && (quote.inAmount!==initialInput || route!==initialRoute)) return reject('INCOMPARABLE_JUPITER_QUOTES');
    initialInput=quote.inAmount;initialRoute=route;
    samples.push({timestamp:quote.observedAtMs!,priceSolPerAtomicToken:quote.inAmount/1e9/quote.outAmount,requestId:quote.requestId,priceImpactPct:quote.priceImpactPct,poolAddress:pool!});
    if(i<Math.max(2,config.samples)-1) await sleep(config.intervalMs);
  }
  return evaluateEntryMomentum(samples,config,'JUPITER_EXECUTABLE');
}
