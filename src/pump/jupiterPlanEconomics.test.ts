import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePlanBreakEven, type JupiterPlanConfig } from './jupiterPlanEconomics.js';

const plans: JupiterPlanConfig[] = [
  { name: 'Free', monthlyUsd: 0, generalRps: 1, executeRps: 50 },
  { name: 'Developer', monthlyUsd: 25, generalRps: 10, executeRps: 100 },
  { name: 'Launch', monthlyUsd: 100, generalRps: 50, executeRps: 100 },
  { name: 'Pro', monthlyUsd: 500, generalRps: 150, executeRps: 100 }
];

test('Developer $25 is justified only when measured monthly profit gain exceeds fixed cost', () => {
  const summaries = evaluatePlanBreakEven([
    { planName: 'Free', netProfitSol: 0.20 },
    { planName: 'Developer', netProfitSol: 0.40 }
  ], plans, 200);

  const free = summaries.find(x => x.name === 'Free')!;
  const developer = summaries.find(x => x.name === 'Developer')!;

  assert.equal(developer.monthlyCostSol, 0.125);
  assert.ok(developer.netAfterPlanCostSol > free.netAfterPlanCostSol);
  assert.equal(developer.breakEvenVsFree, true);
  assert.equal(developer.economicallyPreferred, true);
});

test('Free remains preferred when paid incremental profit is below monthly fee', () => {
  const summaries = evaluatePlanBreakEven([
    { planName: 'Free', netProfitSol: 0.20 },
    { planName: 'Developer', netProfitSol: 0.30 }
  ], plans, 200);

  assert.equal(summaries.find(x => x.name === 'Free')!.economicallyPreferred, true);
  assert.equal(summaries.find(x => x.name === 'Developer')!.breakEvenVsFree, false);
});

test('higher plans only win after their extra monthly cost is covered by high-volume outcomes', () => {
  const moderate = evaluatePlanBreakEven([
    { planName: 'Free', netProfitSol: 0.20 },
    { planName: 'Launch', netProfitSol: 0.80 },
    { planName: 'Pro', netProfitSol: 2.60 }
  ], plans, 200);
  assert.equal(moderate.find(x => x.name === 'Launch')!.economicallyPreferred, true);

  const highVolume = evaluatePlanBreakEven([
    { planName: 'Free', netProfitSol: 0.20 },
    { planName: 'Launch', netProfitSol: 0.80 },
    { planName: 'Pro', netProfitSol: 3.50 }
  ], plans, 200);
  assert.equal(highVolume.find(x => x.name === 'Pro')!.economicallyPreferred, true);
});
