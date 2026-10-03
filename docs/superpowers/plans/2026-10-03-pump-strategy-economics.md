# Pump Strategy Lab Economics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Quantify which combination of Jupiter plan, Pump fees, lifecycle entry window and exit policy yields the best net economic result.

**Architecture:** Build pure economic math first, then low-priority Jupiter availability probes, lifecycle shadow trades, strategy summaries and a break-even plan selector. The selector never purchases a plan automatically; it reports whether observed monthly preserved/added profit justifies Free, Developer, Launch or Pro.

**Tech Stack:** TypeScript, PostgreSQL, Jupiter Developer API telemetry, Pump bonding-curve state.

**Spec:** `docs/superpowers/specs/2026-10-03-pump-strategy-lab-design.md`

## Global Constraints

- All results use executable or locally deterministic sell values, never mark price alone.
- Include Pump protocol/creator fee, slippage, priority/network cost and Jupiter plan fixed monthly cost.
- Current reference plan prices/RPS are configuration inputs, not hard-coded forever.
- Strategy Lab probes are P6 and yield to live exits.
- No automatic subscription purchase or live strategy promotion.

## Review Focus

- Fee schedule changes must not silently reuse stale percentages.
- A plan with lower latency but lower net profit must not be selected.
- Sparse samples must remain INSUFFICIENT_DATA.
- A positive mark price with no executable exit must not count as a win.
- Monthly plan break-even must handle zero and low trade-volume months.

---

### Task 1: Economic cost model

**Files:**
- Create: `src/pump/pumpEconomics.ts`
- Create: `src/pump/pumpEconomics.test.ts`

**Interfaces:**
- `calculateNetExitValue(input): PumpNetEconomics`
- Inputs include gross SOL value, venue fee bps, slippage bps, priority/network lamports and optional fixed-plan allocation.
- Output includes totalCostSol, netValueSol, netReturnPct.

- [ ] Write failing tests for 1.25% bonding-curve fee and round-trip accounting.
- [ ] Add PumpSwap fee-tier input tests.
- [ ] Verify RED, implement minimal math, verify PASS.
- [ ] Commit: `feat: model Pump net trading economics`.

### Task 2: Jupiter plan break-even model

**Files:**
- Create: `src/pump/jupiterPlanEconomics.ts`
- Create: `src/pump/jupiterPlanEconomics.test.ts`

**Interfaces:**
- Plans configurable as `{name, monthlyUsd, generalRps, executeRps}`.
- `evaluatePlanBreakEven(samples, plans, solUsd): PlanEconomicsSummary[]`.

- [ ] Write failing test: Developer $25 is justified only when measured monthly preserved/added profit exceeds its fixed cost.
- [ ] Write failing test: Free remains preferred when paid-plan incremental profit is below monthly fee.
- [ ] Write failing test for Launch/Pro high-volume crossover.
- [ ] Implement pure selector with no billing side effects.
- [ ] Verify PASS.
- [ ] Commit: `feat: compare Jupiter plan break-even economics`.

### Task 3: Jupiter availability and rate telemetry

**Files:**
- Create: `src/pump/pumpJupiterTiming.ts`
- Create: `src/pump/pumpJupiterTiming.test.ts`
- Modify: coordinator from Exit Sovereignty plan.

**Interfaces:**
- P6 probes only.
- Persist first attempt, first route, response latency, 429, queue wait and route economics.

- [ ] Write failing tests for first-route timing and 429 telemetry.
- [ ] Prove P6 yields to P0/P1.
- [ ] Implement minimal probe scheduler.
- [ ] Verify PASS.
- [ ] Commit: `feat: measure Pump to Jupiter route latency`.

### Task 4: Lifecycle cohort classifier

**Files:**
- Create: `src/pump/pumpCohorts.ts`
- Create: `src/pump/pumpCohorts.test.ts`

**Interfaces:**
- `classifyPumpCohort({ageMs,progressPct,graduatedAtMs,nowMs})`.

- [ ] Write tests for every cohort boundary in the spec.
- [ ] Verify RED.
- [ ] Implement deterministic classifier.
- [ ] Verify PASS.
- [ ] Commit: `feat: classify Pump lifecycle strategy cohorts`.

### Task 5: Shadow trade lifecycle

**Files:**
- Create: `src/pump/pumpShadowTrade.ts`
- Create: `src/pump/pumpShadowTrade.test.ts`

**Interfaces:**
- Create shadow entry from deterministic Pump model or Jupiter route.
- Record executable exit marks at 15s,30s,1m,2m,5m,10m/graduation.

- [ ] Write failing test rejecting mark-only profit without executable exit.
- [ ] Write failing test including all costs in net PnL.
- [ ] Implement lifecycle state.
- [ ] Verify PASS.
- [ ] Commit: `feat: record executable Pump shadow trades`.

### Task 6: Stop/trailing policy replay

**Files:**
- Create: `src/pump/exitPolicyReplay.ts`
- Create: `src/pump/exitPolicyReplay.test.ts`

**Interfaces:**
- Baseline current, adaptive trailing, tiered profit-lock and partial variants.
- Output captured net return, give-back from peak, premature exit and realized slippage.

- [ ] Write test reproducing a +370% peak followed by sharp reversal and compare captured outcomes without asserting a predetermined winner.
- [ ] Write tests for flat/choppy and straight-rising paths.
- [ ] Implement replay engine.
- [ ] Verify PASS.
- [ ] Commit: `feat: compare stop and trailing policies in shadow`.

### Task 7: Autonomous evaluator

**Files:**
- Create: `src/pump/pumpStrategyEvaluator.ts`
- Create: `src/pump/pumpStrategyEvaluator.test.ts`

**Interfaces:**
- States: INSUFFICIENT_DATA, NEGATIVE_EXPECTANCY, PROMISING_SHADOW, EXECUTION_CANDIDATE.
- Requires minimum samples, executable exits and positive net expectancy.

- [ ] Write failing tests for each state transition.
- [ ] Verify RED.
- [ ] Implement fail-closed evaluator.
- [ ] Verify PASS.
- [ ] Commit: `feat: rank Pump strategies by executable evidence`.

### Task 8: Persistence and dashboard

**Files:**
- Modify: `src/database/schemaSql.ts` or project schema source.
- Add repository methods/tests.
- Modify: `src/dashboard/dashboardRenderer.ts`
- Modify: `src/server/routes.ts`

- [ ] Add tests for append-only observation/sample/shadow records.
- [ ] Add strategy summary and plan-economics API/dashboard tests.
- [ ] Implement migrations and views.
- [ ] Verify focused tests.
- [ ] Commit: `feat: expose Pump strategy economics and evidence`.

### Task 9: Full verification

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Verify Strategy Lab calls remain P6 and cannot starve exits.
