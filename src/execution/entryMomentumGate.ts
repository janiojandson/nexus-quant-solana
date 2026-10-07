export interface EntryMomentumGateConfig {
  samples: number;
  intervalMs: number;
  minRisePct: number;
  maxRisePct: number;
  maxPullbackPct: number;
}

export interface EntryMomentumSample {
  timestamp: number;
  priceUsd: number;
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
  config: EntryMomentumGateConfig
): EntryMomentumResult {
  if (samples.length < 3 || samples.some(sample => !Number.isFinite(sample.priceUsd) || sample.priceUsd <= 0)) {
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

  const uniquePrices = new Set(samples.map(sample => sample.priceUsd.toPrecision(15)));
  if (uniquePrices.size === 1) {
    return {
      pass: false,
      risePct: 0,
      maxPullbackPct: 0,
      risingSteps: 0,
      staleSource: true,
      reason: 'Momentum pré-voo indeterminado ou fonte estagnada (STALE_SOURCE): fonte sem atualização.',
      samples
    };
  }

  const first = samples[0].priceUsd;
  const last = samples[samples.length - 1].priceUsd;
  const risePct = ((last / first) - 1) * 100;

  let maxPullbackPct = 0;
  let risingSteps = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1].priceUsd;
    const current = samples[i].priceUsd;
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
