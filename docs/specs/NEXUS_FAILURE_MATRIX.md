# NEXUS INCIDENT TAXONOMY & FAILURE MATRIX
> **Document Version:** 2.0.0  
> **Status:** AUDITED & CONSOLIDATED  
> **Date:** 2026-10-04  
> **Baseline Commit:** `9879a43` (Hardening Commit 4)  
> **Classification:** FORMAL SPECIFICATION — NEXUS QUANT SOLANA  

---

## 1. Executive Summary

This document establishes the official taxonomy of incident classifications, diagnostic criteria, and evidentiary standards for the Nexus Quant Solana trading system.

Automated incident post-mortems frequently suffer from category confusion—such as labeling an atomic whale dump as an execution error, or labeling normal pool slippage as an accounting failure. This matrix defines strict evidentiary requirements for every failure category, permitting multi-label classification when multiple distinct failures compound in a single trade.

---

## 2. Multi-Category Classification Policy

An incident may exhibit multiple distinct failures across different phases of the lifecycle:
- A trade may experience `PRICE_GAP` followed by `EXECUTION_DELAY`.
- An incident may compound `EXECUTION_FAILURE` with `ACCOUNTING_FAILURE` (as occurred in SUPERPIG).
- Classifications must be supported by direct cryptographic or state evidence. Hypotheses regarding unobserved alternative paths remain tagged `UNKNOWN` or `NOT_DEMONSTRATED`.

---

## 3. Formal Failure Categories

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          NEXUS FAILURE TAXONOMY                             │
├─────────────────────┬───────────────────────────────────────────────────────┤
│ MARKET & LIQUIDITY  │ 1. PRICE_GAP (Discontinuous liquidity movement)       │
│ DYNAMICS            │ 2. INSUFFICIENT_DEPTH (Size exceeds pool capacity)    │
├─────────────────────┼───────────────────────────────────────────────────────┤
│ INGESTION & SENSING │ 3. DETECTION_FAILURE (Missed available market data)   │
├─────────────────────┼───────────────────────────────────────────────────────┤
│ PIPELINE & ON-CHAIN │ 4. EXECUTION_DELAY (Latency exceeded budget)          │
│ EXECUTION           │ 5. EXECUTION_FAILURE (Simulation or on-chain revert)  │
├─────────────────────┼───────────────────────────────────────────────────────┤
│ DATA & LEDGER       │ 6. ACCOUNTING_FAILURE (Database vs on-chain divergence)│
│ INTEGRITY           │ 7. UNKNOWN (Unresolvable logs or missing evidence)    │
└─────────────────────┴───────────────────────────────────────────────────────┘
```

---

### Category 1: `PRICE_GAP`
- **Definition:** An instantaneous, discontinuous drop in pool reserves or executable quote price caused by a confirmed atomic liquidity removal or massive single-transaction sell order that landed prior to the exit decision.
- **Necessary Evidence:**
  1. On-chain transaction signature of the whale swap/liquidity pull preceding the exit decision.
  2. Proof that pool SOL reserves dropped discontinuously (e.g. > 50% drop in a single slot).
  3. First deteriorated quote observed by the monitor already reflects the post-crash price.
- **What is NOT Sufficient Evidence:**
  - A gradual, multi-minute price downtrend.
  - Execution slippage between quote request and swap confirmation.
- **Related Metrics:** `poolDropPct`, `poolDropReservePreSol`, `poolDropReservePostSol`, `isPreQuoteCollapse`.
- **Historical Examples:**
  - **Tesla:** -99.77% pool crash (605.2 SOL → 1.37 SOL in slot 452790087).
  - **SSI:** -88.24% pool crash (863.8 SOL → 101.5 SOL in slot 453173809).
  - **Mr Beast:** -71.57% pool crash (302.8 SOL → 86.08 SOL in slot 453146589).

---

### Category 2: `DETECTION_FAILURE`
- **Definition:** The trading system failed to ingest, process, or react to market data that was already available and consumable through its configured data channels.
- **Necessary Evidence:**
  1. Proof that an existing data provider or feed made the updated state available at timestamp $T_1$.
  2. Proof that Nexus did not register an observation until timestamp $T_2$, where $T_2 - T_1 > \text{budget}$.
  3. Proof that internal loop starvation, unhandled promise rejections, or queue blocking caused the missed observation.
- **What is NOT Sufficient Evidence:**
  - The mere fact that a whale sold in an earlier block is **NOT** proof of detection failure. If the monitor was polling every 1 second and reacted on the very first poll after the transaction landed, the current path did not miss available data.
  - An unverified hypothesis that "an alternative WebSocket or gRPC sensor could have seen it earlier" is NOT historical evidence. Such future possibilities are classified as `alternativeSensorCouldObserveEarlier: 'UNKNOWN'`.
- **Related Metrics:** `observationGapMs`, `approxEventToObservationMs`.
- **Historical Status:**
  - **NOT_DEMONSTRATED** across Tesla, SSI, and Mr Beast. In all three cases, the monitor reacted on the very first deteriorated poll it received (`currentPathMissedAvailableData: false`).

---

### Category 3: `EXECUTION_DELAY`
- **Definition:** An excessive delay between the generation of an exit decision signal and the confirmed inclusion of the exit transaction on-chain, leading to adverse price degradation during the execution window.
- **Necessary Evidence:**
  1. Monotonic elapsed time between decision timestamp and on-chain block inclusion exceeds target budget (> 3,000 ms).
  2. Proof that market price or fill proceeds deteriorated between decision quote and execution fill.
- **What is NOT Sufficient Evidence:**
  - An exit occurring at a terrible price because the pool was ALREADY crashed before the decision was made (that is `PRICE_GAP`, not `EXECUTION_DELAY`).
- **Related Metrics:** `decisionToExecutionMs`, `JUPITER_QUEUE_WAIT_MS`.
- **Historical Examples:**
  - **SUPERPIG:** Decision generated at 02:35:10, final on-chain fill not confirmed until 02:35:49 (~39 seconds elapsed) due to 3 simulation retries and confirmation timeout.

---

### Category 4: `EXECUTION_FAILURE`
- **Definition:** A transaction submitted to the network or pre-flight engine was rejected, reverted, or dropped by block engines.
- **Necessary Evidence:**
  1. Pre-flight RPC simulation error logs (`InstructionError` with custom program code).
  2. On-chain transaction error status (`TransactionError`).
  3. Transaction expiration without on-chain signature confirmation after timeout window.
- **What is NOT Sufficient Evidence:**
  - A transaction that confirms successfully with high slippage (that is market depth/slippage, not execution failure).
- **Related Metrics:** `simulationRejectedCount`, `simulationsRejectedCustomCode`, `confirmationTimeoutOccurred`.
- **Historical Examples:**
  - **SUPERPIG:** 3 consecutive pre-flight simulations rejected with `InstructionError: [3, {"Custom": 6001}]`, followed by confirmation timeout on attempt 1.

---

### Category 5: `INSUFFICIENT_DEPTH`
- **Definition:** The position token quantity represents an excessive proportion of total available liquidity in the target AMM pool, making complete exit impossible without massive (> 30%) price impact or catastrophic slippage rejection.
- **Necessary Evidence:**
  1. Pool reserve data showing pool SOL liquidity is comparable to or smaller than position value.
  2. Jupiter quote indicating severe price impact or returning no route.
- **What is NOT Sufficient Evidence:**
  - A transaction failing due to incorrect ATA account creation or missing signatures.
- **Related Metrics:** `liquiditySol`, quote price impact bps, reserve ratios.
- **Historical Examples:**
  - **SUPERPIG:** Token pool had depleted to near-zero executable SOL, causing simulation rejections and forcing exit at -84.77% net recovery.

---

### Category 6: `ACCOUNTING_FAILURE`
- **Definition:** Discrepancy between internal system balance records (database, trade outcomes, in-memory state) and actual confirmed on-chain wallet balance changes.
- **Necessary Evidence:**
  1. Divergence between database recorded proceeds and on-chain gross proceeds exceeding tolerance (> 0.0015 SOL).
  2. Failure to account for unclosed ATAs or trapped token balances.
- **What is NOT Sufficient Evidence:**
  - Normal transaction fees or priority fees within expected parameters.
- **Related Metrics:** `accountingDivergenceSol`, `accountingDivergencePctPoints`.
- **Historical Examples:**
  - **SUPERPIG:** Database recorded exit proceeds of **0.010301 SOL** (-48.49% PnL) based on an unconfirmed quote, while actual on-chain proceeds were **0.003183856 SOL** (-84.77% PnL), creating an accounting divergence of **0.007117 SOL** (36.28 percentage points).

---

### Category 7: `UNKNOWN`
- **Definition:** Failure mode where available logs, signatures, or telemetry are insufficient to establish a definitive root cause with cryptographic certainty.
- **Necessary Evidence:** Missing transaction signatures, truncated log lines, unverified third-party error codes without program ID provenance.
- **Historical Examples:**
  - **SUPERPIG Custom 6001:** While the raw log indicates `{"Custom": 6001}`, the emitting program ID is not provably verified in legacy logs. Under V2.0 namespaced rules, this error is classified as **`UNKNOWN`** rather than assuming Jupiter slippage.

---

## 4. Summary Matrix of Audited Incidents

| Incident | Primary Classification | Secondary Classifications | Detection Failure Status | Price Gap Status | Accounting Divergence |
|---|---|---|---|---|---|
| **TESLA** | `PRICE_GAP` | None | `NOT_DEMONSTRATED` | `CONFIRMED` | 0.000000 SOL (Clean) |
| **SSI** | `PRICE_GAP` | None | `NOT_DEMONSTRATED` | `CONFIRMED` | 0.000000 SOL (Clean) |
| **MR BEAST** | `PRICE_GAP` | None | `NOT_DEMONSTRATED` | `CONFIRMED` | 0.000000 SOL (Clean) |
| **SUPERPIG** | `EXECUTION_FAILURE` | `ACCOUNTING_FAILURE`<br>`EXECUTION_DELAY`<br>`INSUFFICIENT_DEPTH` | `NOT_APPLICABLE` | `NOT_APPLICABLE` | **0.007117 SOL** (36.28 pp) |
