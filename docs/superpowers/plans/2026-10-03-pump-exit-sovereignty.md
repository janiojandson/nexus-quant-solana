# Pump Exit Sovereignty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Pump→Dex correlation and make live STOP/TRAILING protection independent from entry/research Jupiter traffic.

**Architecture:** Preserve the existing read-only Pump observer. Add one process-wide Jupiter priority coordinator, capacity-aware entry admission, independent exit-watermark persistence, and a degraded-exit circuit breaker. Pump shadow research remains lower priority than any live-capital exit path.

**Tech Stack:** TypeScript, Node.js test runner via tsx, @solana/web3.js, axios, PostgreSQL, Jupiter Swap V2.

**Spec:** `docs/superpowers/specs/2026-10-03-pump-strategy-lab-design.md`

## Global Constraints

- No direct Pump BUY execution in this plan.
- Existing real-trading controls remain authoritative.
- Exit priority order is P0 emergency, P1 stop/trailing/take-profit/manual, P2 exit confirmation, P3 exitability health, P4 entry order, P5 sizing/momentum, P6 Pump shadow research.
- Shadow research must never consume capacity needed by live exits.
- Free Jupiter general budget is modeled as 1 RPS; execute bucket is separate.
- No API-key/account rotation to evade provider limits.
- All new behavior must be TDD and fail closed around live capital.

## Review Focus

- Two open positions on Free Jupiter must not be admitted if protection capacity would exceed the configured general RPS.
- A P1 stop request queued behind P5/P6 work must preempt that lower-priority work.
- Jupiter outage must persist the latest high-watermark and pause new entries rather than resetting protection state.
- DexScreener 429 must not affect the production trading loop.
- A position must never be marked closed unless on-chain sale confirmation succeeds.

---

### Task 1: Finish Pump→Dex correlation

**Files:**
- Modify: `src/pump/pumpObservatory.ts`
- Modify: `src/pump/pumpObservatory.test.ts`
- Create/retain: `src/pump/pumpDexTiming.ts`
- Create/retain: `src/pump/pumpDexTiming.test.ts`

**Interfaces:**
- Consumes: existing `PumpObservation`
- Produces: `getDexCorrelationCandidates(limit,maxAgeMs)`, `applyDexCorrelation(mint,sample)`, Dex timing fields on snapshot.

- [ ] Write/retain failing test proving first-seen and first-ready timestamps are stored once and measured from Pump birth.
- [ ] Run: `npx tsx --test src/pump/pumpDexTiming.test.ts src/pump/pumpObservatory.test.ts`; expected current RED on missing `applyDexCorrelation`.
- [ ] Implement minimal correlation methods and snapshot fields without changing live execution.
- [ ] Re-run the focused tests; expected PASS.
- [ ] Commit: `feat: correlate Pump births with Dex readiness`.

### Task 2: Add one global Jupiter priority coordinator

**Files:**
- Create: `src/blockchain/jupiterTrafficCoordinator.ts`
- Create: `src/blockchain/jupiterTrafficCoordinator.test.ts`
- Modify: `src/blockchain/dexAggregator.ts`
- Modify: `src/blockchain/jupiterExecutionEngine.ts`

**Interfaces:**
- Produces: `JupiterPriority = 0|1|2|3|4|5|6`
- Produces: `schedule<T>(priority: JupiterPriority, op: () => Promise<T>): Promise<T>`
- Produces: telemetry snapshot with queued/running/completed/429/waitMs by priority.

- [ ] Write failing tests for strict priority preemption and FIFO within equal priority.
- [ ] Write failing test that execute traffic is tracked separately from general-order traffic.
- [ ] Run focused tests and verify RED.
- [ ] Implement one shared coordinator instance injected into both quote and order paths.
- [ ] Replace separate general-bucket waits with coordinator scheduling.
- [ ] Re-run focused tests; expected PASS.
- [ ] Commit: `feat: prioritize Jupiter exit traffic globally`.

### Task 3: Wire priority classes into production flows

**Files:**
- Modify: `src/index.ts`
- Modify: relevant existing execution tests.

**Interfaces:**
- Uses coordinator priorities from Task 2.
- P1 for STOP/TRAILING/TP/manual order construction.
- P2/P3 for active position quote/health.
- P4 for entry order.
- P5 for sizing/momentum.
- P6 for Pump Strategy Lab probes.

- [ ] Write failing tests or extracted pure-routing tests proving STOP gets P1 and sizing gets P5.
- [ ] Verify RED.
- [ ] Implement exact priority assignment at call sites.
- [ ] Verify focused tests PASS.
- [ ] Commit: `feat: reserve Jupiter capacity for live exits`.

### Task 4: Capacity-aware entry admission

**Files:**
- Create: `src/execution/exitCapacityPolicy.ts`
- Create: `src/execution/exitCapacityPolicy.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `evaluateExitCapacity({generalRps,monitorIntervalMs,openPositions,hasLocalExitSensor})`.
- Returns `{admit:boolean, requiredRps:number, availableRps:number, reason?:string}`.

- [ ] Write failing test: 2 Jupiter-only positions at 1.5s interval require >1 RPS and must reject another protected position under Free.
- [ ] Write failing test: Pump local exit sensor removes high-frequency Jupiter dependency and allows admission if remaining budget is sufficient.
- [ ] Verify RED.
- [ ] Implement policy with deterministic arithmetic.
- [ ] Gate new entries in `src/index.ts`; fail closed with explicit journal/dashboard reason.
- [ ] Verify tests PASS.
- [ ] Commit: `feat: gate entries on exit protection capacity`.

### Task 5: Persist exit watermarks independently of Jupiter health

**Files:**
- Modify: `src/execution/positionExitEngine.ts`
- Modify: `src/execution/positionExitEngine.test.ts`
- Modify persistence code already storing position peak.

**Interfaces:**
- Track observable peak, executable/local-sellable peak, latest Jupiter executable value, last healthy exit-route timestamp.

- [ ] Write failing restart test proving watermarks survive process rehydration.
- [ ] Write failing outage test proving a Jupiter error never lowers/reset the prior peak.
- [ ] Verify RED.
- [ ] Extend position state/persistence minimally.
- [ ] Verify PASS.
- [ ] Commit: `feat: persist sovereign exit watermarks`.

### Task 6: Add degraded-exit circuit breaker

**Files:**
- Create: `src/execution/exitPathHealth.ts`
- Create: `src/execution/exitPathHealth.test.ts`
- Modify: `src/index.ts`
- Modify: dashboard/API state.

**Interfaces:**
- Produces states `HEALTHY|DEGRADED|EMERGENCY`.
- New entries allowed only in HEALTHY.
- P6 research suspended in DEGRADED/EMERGENCY.

- [ ] Write failing tests for transition on consecutive quote failures and recovery on confirmed healthy exit route.
- [ ] Verify RED.
- [ ] Implement state machine and production gating.
- [ ] Expose status and reason in dashboard/API.
- [ ] Verify PASS.
- [ ] Commit: `feat: pause entries when exit path degrades`.

### Task 7: Full verification

- [ ] Run `npm test`; expected 0 failures.
- [ ] Run `npm run build`; expected exit 0.
- [ ] Run `git diff --check`; expected no errors.
- [ ] Review all live-capital call sites for priority and fail-closed behavior.
- [ ] Commit any test-only/documentation adjustments separately.
