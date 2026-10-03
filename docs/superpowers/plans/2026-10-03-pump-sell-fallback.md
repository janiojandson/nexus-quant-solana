# Pump Sell-Only Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Add a disabled-by-default direct Pump bonding-curve SELL fallback that protects live capital when Jupiter exit construction is unavailable or economically inferior.

**Architecture:** Implement canonical account validation and deterministic sell quoting first, then transaction construction, simulation, idempotency and reconciliation. Activation is a separate feature flag and never grants direct BUY permission.

**Tech Stack:** TypeScript, @solana/web3.js, @solana/spl-token, Pump on-chain program, existing wallet/rent/exit infrastructure.

**Spec:** `docs/superpowers/specs/2026-10-03-pump-strategy-lab-design.md`

## Global Constraints

- SELL only. No direct Pump BUY.
- Disabled by default.
- Exact atomic token amounts only.
- Canonical Pump program/PDA/account ownership validation is fail closed.
- If curve is complete, fallback refuses and hands off to post-graduation routing.
- Hard min-out/slippage/priority-fee caps.
- Uncertain submission must reconcile on-chain before retry.

## Review Focus

- Wrong bonding-curve PDA must refuse before signing.
- Completed curve must never receive a bonding-curve sell.
- Timeout after broadcast must not create a duplicate sale.
- Token-2022 vs legacy token program ownership must be validated exactly.
- Partial sale confirmation must update remaining position atomically.

---

### Task 1: Deterministic Pump sell quote math

**Files:**
- Create: `src/pump/pumpSellQuote.ts`
- Create: `src/pump/pumpSellQuote.test.ts`

- [ ] Write canonical reserve/fee examples and edge tests.
- [ ] Verify RED.
- [ ] Implement quote and min-out calculation.
- [ ] Verify PASS.
- [ ] Commit: `feat: calculate direct Pump sell quotes`.

### Task 2: Canonical account validator

**Files:**
- Create: `src/pump/pumpSellValidator.ts`
- Create: `src/pump/pumpSellValidator.test.ts`

- [ ] Test program ID, mint, curve PDA, ATA/token-program ownership, completion state and fee accounts.
- [ ] Verify RED.
- [ ] Implement fail-closed validation.
- [ ] Verify PASS.
- [ ] Commit: `feat: validate Pump sell accounts fail closed`.

### Task 3: Transaction builder and simulation

**Files:**
- Create: `src/pump/pumpSellExecutor.ts`
- Create: `src/pump/pumpSellExecutor.test.ts`

**Interfaces:**
- `buildSell(request): VersionedTransaction|Transaction`
- `simulateSell(request)`
- `executeSell(request)`

- [ ] Test exact atomic amount and hard caps.
- [ ] Test no signing on validation failure.
- [ ] Test simulation rejection prevents broadcast.
- [ ] Implement minimal builder/executor.
- [ ] Verify PASS.
- [ ] Commit: `feat: build safe Pump sell fallback`.

### Task 4: Idempotency and reconciliation

**Files:**
- Modify: `src/pump/pumpSellExecutor.ts`
- Add tests.

- [ ] Write timeout-after-broadcast test.
- [ ] Require signature/account reconciliation before retry.
- [ ] Verify duplicate sale cannot occur.
- [ ] Commit: `fix: reconcile uncertain Pump sell submissions`.

### Task 5: Integrate into exit router

**Files:**
- Create: `src/execution/exitRouter.ts`
- Create: `src/execution/exitRouter.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Jupiter remains primary unless policy/economics/availability selects Pump fallback.
- P0/P1 exit priority preserved.
- Curve-complete routes never use Pump bonding-curve sell.

- [ ] Write tests for Jupiter success, Jupiter unavailable + valid Pump fallback, and both unavailable.
- [ ] Implement router.
- [ ] Verify PASS.
- [ ] Commit: `feat: add sell-only Pump exit fallback`.

### Task 6: Operational arming and observability

**Files:**
- Modify: `.env.example`
- Modify dashboard/API.
- Add tests.

- [ ] Add `PUMP_DIRECT_SELL_FALLBACK_ENABLED=false`.
- [ ] Expose selected exit path, fallback reason, cost estimate and confirmation state.
- [ ] Verify PASS.
- [ ] Commit: `feat: expose Pump sell fallback controls`.

### Task 7: Full verification and live-safe canary

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Run no-broadcast simulation/preflight script against a known Pump curve.
- [ ] Confirm feature flag remains false after deploy until separate live arming approval.
