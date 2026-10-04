# NEXUS LATENCY BUDGET & EXECUTION PIPELINE TIMING
> **Document Version:** 2.0.0  
> **Status:** AUDITED & CONSOLIDATED  
> **Date:** 2026-10-04  
> **Baseline Commit:** `9879a43` (Hardening Commit 4)  
> **Classification:** FORMAL SPECIFICATION — NEXUS QUANT SOLANA  

---

## 1. Executive Summary

This document defines the latency budget, pipeline decomposition, and measurement taxonomy across the entire Nexus Quant Solana execution cycle. 

A primary failure mode of automated trading systems is conflating different sources of latency—for example, blaming Jupiter execution slippage when the delay occurred in internal queue concurrency or in polling interval lag. Nexus V2.0 isolates every step of the pipeline with explicit clock domains and measurement statuses.

---

## 2. End-to-End Pipeline Decomposition

The complete trading cycle consists of 9 sequential stages:

```
┌──────────────┐     ┌───────────┐     ┌───────────────┐     ┌─────────────┐
│ 1. ON-CHAIN  │     │ 2. OBS &  │     │  3. JUPITER   │     │  4. JUPITER │
│    EVENT     │ ──> │ DECISION  │ ──> │  QUEUE WAIT   │ ──> │    QUOTE    │
└──────────────┘     └───────────┘     └───────────────┘     └─────────────┘
                                                                    │
┌──────────────┐     ┌───────────┐     ┌───────────────┐     ┌──────▼──────┐
│  8. CONFIRM  │     │7. JUPITER │     │  6. SOLANA    │     │  5. JUPITER │
│  & RECONCILE │ <── │  EXECUTE  │ <── │ SIGN & SIMUL  │ <── │    ORDER    │
└──────────────┘     └───────────┘     └───────────────┘     └─────────────┘
```

---

## 3. Pipeline Stages & Measurement Status

To ensure absolute audit clarity, every stage is classified into one of three statuses:
- **`MEASURED NOW`**: Active live instrumentation in codebase using monotonic clocks.
- **`NOT YET MEASURED`**: Live production capability does not yet exist (scheduled for V2.1+).
- **`COARSE HISTORICAL ONLY`**: Estimated retrospectively from historical logs (~1s Solana blockTime uncertainty).

| Stage | Operation / Boundary | Clock Domain | Instrumentation Status | Metric Name | Target Budget (V2.1+) |
|---|---|---|---|---|---|
| **1. Ingestion** | On-chain swap landed → Nexus receives event | Solana BlockTime vs Wall Clock | **COARSE HISTORICAL ONLY** (Replay)<br>**NOT YET MEASURED** (Live) | `approxEventToObservationMs`<br>(bounds: ±1000ms) | < 250 ms (via WS/gRPC in V2.4) |
| **2. Decision** | Evaluation of exit criteria / Laya System 1 | Process Monotonic / Wall Clock | **MEASURED NOW** | `observationGapMs`<br>`layaTriagemMs` | < 50 ms |
| **3. Queue Wait** | `JupiterTrafficCoordinator` permit acquisition | Process Monotonic | **MEASURED NOW** | `JUPITER_QUEUE_WAIT_MS` | < 50 ms |
| **4. Quote HTTP** | Round-trip HTTP to Jupiter `/quote` endpoint | Process Monotonic | **MEASURED NOW** | `JUPITER_QUOTE_HTTP_MS` | < 150 ms |
| **5. Order HTTP** | Round-trip HTTP to Jupiter `/swap` endpoint | Process Monotonic | **MEASURED NOW** | `JUPITER_ORDER_HTTP_MS` | < 200 ms |
| **6a. Sign** | Local transaction signing with Ed25519 keypair | Process Monotonic | **MEASURED NOW** | `LOCAL_SIGN_MS` | < 5 ms |
| **6b. Simulate** | Pre-flight transaction simulation on Solana RPC | Process Monotonic | **MEASURED NOW** | `SOLANA_SIMULATION_MS` | < 120 ms |
| **7. Execute HTTP** | Round-trip HTTP dispatching transaction | Process Monotonic | **MEASURED NOW** | `JUPITER_EXECUTE_HTTP_MS` | < 300 ms |
| **8. Reconcile** | Polling confirmation & wallet balance update | Process Monotonic & Wall Clock | **MEASURED NOW** (RPC methods)<br>**NOT YET MEASURED** (FillLedger) | `SOLANA_RPC` duration<br>`decisionToExecutionMs` | < 1,500 ms |

---

## 4. Detailed Stage Analysis

### Stage 1: On-Chain Event to Ingestion
- **Live Status:** `NOT YET MEASURED`. In V2.0, quotes are polled on fixed intervals (~500ms to 2000ms). There is no live event stream measuring sub-millisecond network propagation between validator block inclusion and HTTP poll arrival.
- **Historical Replay Status:** `COARSE HISTORICAL ONLY`. Derived from the validator `blockTime` of the crash transaction and the wall clock timestamp of the first bad observation.
- **Uncertainty Rule:** Because `blockTime` has integer second resolution (1000ms), `approxEventToObservationMs` carries an inherent uncertainty interval of up to 1000ms. It is strictly forbidden to claim sub-second speed advantages (e.g. "WebSocket is 300ms faster") against this coarse baseline.

### Stage 2: Decision & Observation Gaps
- Evaluates `observationGapMs` across consecutive polling intervals.
- Identifies anomalies where local CPU starvation or event-loop blockage delayed consecutive quotes.

### Stage 3: Jupiter Traffic Coordinator Queue Wait
- Isolates concurrency queue delays from network delays.
- A sudden increase in `JUPITER_QUEUE_WAIT_MS` indicates thread contention or rate-limiting throttling rather than Jupiter API slowness.

### Stages 4 & 5: Jupiter Quote and Order HTTP
- Measures actual network transit and remote serialization duration.
- Differentiates quote cache hits (`quoteSource: 'CACHE'`) where network transit is 0 ms from actual outbound HTTP requests (`quoteSource: 'NETWORK'`).

### Stage 6: Local Sign and Simulation
- `LOCAL_SIGN_MS` isolates pure CPU computation of Ed25519 signature. Must never exceed 10ms.
- `SOLANA_SIMULATION_MS` isolates RPC simulation latency. Detects pre-flight simulation rejection codes (e.g. Custom 6001) before incurring network execution fees.

### Stage 7: Execute HTTP
- Measures the time to submit the signed transaction to the RPC node or Jupiter execution service.

### Stage 8: Confirmation & Balance Reconciliation
- Measures the time until on-chain status reaches confirmed commitment.
- Live RPC methods (`getParsedTransaction`, `getBalance`) are fully instrumented (`SOLANA_RPC`).
- Full persistent balance ledger is scheduled for V2.1 (`FillLedger`).

---

## 5. Controlled Local Benchmark (Mock Pipeline)

During automated test execution (`test/telemetry/jupiterInstrumentation.test.ts`), a controlled mock benchmark validates that telemetry overhead is negligible:

```
--- BENCHMARK LOCAL CONTROLADO (MOCK) ---
jupiter_queue_wait       15.57 ms
jupiter_quote            15.70 ms
local_sign               15.88 ms
solana_simulation        15.54 ms
jupiter_execute          31.47 ms
-----------------------------------------
Total Mock Duration:     94.16 ms
```

> [!WARNING]
> **Strict Segregation Rule:** Controlled local benchmarks use deterministic software timers/mocks in a local test runner. They demonstrate zero telemetry overhead and correct pipeline sequencing. They **MUST NEVER** be cited or compared alongside live production latencies as if they were real network measurements.

---

## 6. Target Latency Budget for V2.1+

| Pipeline Stage | Warning Threshold | Critical Alarm Threshold | Corrective Action |
|---|---|---|---|
| Queue Wait | > 50 ms | > 150 ms | Increase coordinator concurrency permit |
| Quote HTTP | > 150 ms | > 400 ms | Route to fallback RPC / provider |
| Order HTTP | > 200 ms | > 500 ms | Abort and re-evaluate liquidity depth |
| Local Sign | > 5 ms | > 20 ms | CPU profile event-loop blocking |
| Simulation | > 120 ms | > 350 ms | Fallback to priority RPC endpoint |
| Execute HTTP | > 300 ms | > 800 ms | Dispatch via dual-path RPC fallback |
| Total Execution Window | > 800 ms | > 2,000 ms | Mark transaction for emergency reconciliation |
