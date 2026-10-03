export interface JupiterPlanConfig {
  name: string;
  monthlyUsd: number;
  generalRps: number;
  executeRps: number;
}

export interface JupiterPlanOutcomeSample {
  planName: string;
  netProfitSol: number;
}

export interface JupiterPlanEconomicsSummary extends JupiterPlanConfig {
  observedNetProfitSol: number;
  monthlyCostSol: number;
  netAfterPlanCostSol: number;
  incrementalVsFreeSol: number;
  breakEvenVsFree: boolean;
  economicallyPreferred: boolean;
}

export const CURRENT_JUPITER_PLANS: readonly JupiterPlanConfig[] = [
  { name: 'Free', monthlyUsd: 0, generalRps: 1, executeRps: 50 },
  { name: 'Developer', monthlyUsd: 25, generalRps: 10, executeRps: 100 },
  { name: 'Launch', monthlyUsd: 100, generalRps: 50, executeRps: 100 },
  { name: 'Pro', monthlyUsd: 500, generalRps: 150, executeRps: 100 }
] as const;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function evaluatePlanBreakEven(
  samples: JupiterPlanOutcomeSample[],
  plans: JupiterPlanConfig[],
  solUsd: number
): JupiterPlanEconomicsSummary[] {
  const safeSolUsd = Number.isFinite(solUsd) && solUsd > 0 ? solUsd : 0;
  if (safeSolUsd <= 0) {
    throw new Error('SOL/USD must be positive to evaluate monthly Jupiter plan cost.');
  }

  const totals = new Map<string, number>();
  for (const sample of samples) {
    totals.set(
      sample.planName,
      (totals.get(sample.planName) ?? 0) + finiteOrZero(sample.netProfitSol)
    );
  }

  const preliminary = plans.map(plan => {
    const observedNetProfitSol = totals.get(plan.name) ?? 0;
    const monthlyCostSol = Math.max(0, finiteOrZero(plan.monthlyUsd)) / safeSolUsd;
    return {
      ...plan,
      observedNetProfitSol,
      monthlyCostSol,
      netAfterPlanCostSol: observedNetProfitSol - monthlyCostSol
    };
  });

  const free = preliminary.find(plan => plan.name.toLowerCase() === 'free');
  const freeNet = free?.netAfterPlanCostSol ?? 0;

  let bestIndex = 0;
  for (let i = 1; i < preliminary.length; i++) {
    const candidate = preliminary[i];
    const best = preliminary[bestIndex];
    if (
      candidate.netAfterPlanCostSol > best.netAfterPlanCostSol ||
      (
        candidate.netAfterPlanCostSol === best.netAfterPlanCostSol &&
        candidate.monthlyUsd < best.monthlyUsd
      )
    ) {
      bestIndex = i;
    }
  }

  return preliminary.map((plan, index) => {
    const incrementalVsFreeSol = plan.netAfterPlanCostSol - freeNet;
    const isFree = plan.name.toLowerCase() === 'free';
    return {
      ...plan,
      incrementalVsFreeSol,
      breakEvenVsFree: isFree || incrementalVsFreeSol > 0,
      economicallyPreferred: index === bestIndex
    };
  });
}
