# NEXUS V2.0 — ARCHITECTURAL & OBSERVABILITY SPECIFICATION
> **Document Version:** 2.0.0  
> **Status:** AUDITED & CONSOLIDATED  
> **Date:** 2026-10-04  
> **Baseline Commit:** `9879a43` (Hardening Commit 4)  
> **Classification:** FORMAL SPECIFICATION — NEXUS QUANT SOLANA  

---

## 1. Executive Summary & Core Mission

Nexus V2.0 establishes the definitive **Observability, Provenance, and Deterministic Benchmarking Foundation** for the Nexus Quant Solana trading engine. 

Prior to V2.0, execution failures, price gap collapses, and slippage anomalies could not be mathematically attributed to specific pipeline bottlenecks (queue delay vs HTTP latency vs on-chain confirmation vs RPC latency). V2.0 solves this by introducing:
1. **Multi-Domain Clocks** separating wall-clock persistence from monotonic interval measurement.
2. **Universal Redaction** preventing cryptographic keys, tokens, and binary payloads from entering logs.
3. **Bounded Telemetry Buffer** with drop-oldest retention and zero disruption to trading execution.
4. **End-to-End Pipeline Instrumentation** for Jupiter Aggregator and Solana RPC operations.
5. **Namespaced Error Classification** requiring explicit `(programId, customCode)` pairs.
6. **Deterministic Historical Incident Replay** across 4 audited real-world market crashes.

---

## 2. Strict State Boundaries: What is Implemented vs Proposed vs Not Implemented

To ensure architectural integrity and prevent forward-looking assumptions from being treated as historical facts, all system components are categorized into three disjoint statuses:

| Status | Definition | Components in this Status |
|---|---|---|
| **IMPLEMENTED** | Code exists, is unit tested, covered in CI (420 tests passing), and active in the codebase. | Monotonic/Wall Clock domains, `TelemetrySpan`, `UniversalRedaction`, `TelemetryRingBuffer`, `telemetryInternalErrorCount`, Jupiter coordinator queue wait measurement, Jupiter HTTP quote/order/execute instrumentation, local signing timing, simulation timing, Solana RPC provider alias classification & latency tracking, namespaced error classifier, 4 historical incident fixtures with `fixtures.lock.json`, zero-lookahead / zero-network replay harness. |
| **PROPOSED** | Formally specified and architecturally approved, scheduled for sequential implementation in V2.1–V2.7. | `FillLedger` persistent schema (V2.1), `ExitIntent` persistent lifecycle (V2.1), Decoupled Execution Worker (V2.2), Position Versioning & Idempotency Key (V2.3), Dedicated Helius/QuickNode streaming sensors (V2.4), Market Data Fusion (V2.5), Crash Detector Shadow (V2.6), Profit Lock Shadow (V2.7). |
| **NÃO IMPLEMENTADO** | Strictly absent from active runtime; MUST NOT be treated as available or active. | Persistent database `FillLedger`, live WebSocket / Yellowstone gRPC listener, live pre-quote crash detection, multi-source orderbook fusion, automated rollback of on-chain state, automated un-stuck ATA re-entry. |

> [!CAUTION]
> It is strictly forbidden to document or treat `ExitIntent` or `FillLedger` as if they were live in V2.0. They belong to Phase V2.1.

---

## 3. Clock Domains & Timing Semantics

Timing measurements in distributed blockchain systems fail when clock domains are conflated. Nexus V2.0 strictly segregates three clock domains:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             NEXUS CLOCK DOMAINS                             │
├──────────────────────────┬──────────────────────────┬───────────────────────┤
│ 1. SYSTEM WALL CLOCK     │ 2. MONOTONIC CLOCK       │ 3. ON-CHAIN BLOCKTIME │
├──────────────────────────┼──────────────────────────┼───────────────────────┤
│ Source: Date.now() / ISO │ Source: hrtime.bigint()  │ Source: Solana Slot   │
│ Domain: UTC Time         │ Domain: Node.js Process  │ Domain: Validators    │
│ Precision: Milliseconds  │ Precision: Nanoseconds   │ Precision: ~1 Second  │
│ Drift: NTP / Leap adjust │ Drift: 0 (Strict Monotonic) Drift: Validator skew │
│ Purpose: Audit, DB, Logs │ Purpose: Latency metrics │ Purpose: Block order  │
└──────────────────────────┴──────────────────────────┴───────────────────────┘
```

### 3.1 System Wall Clock
- **API:** `Date.now()`, `new Date().toISOString()`.
- **Usage:** Timestamps for database persistence, external log aggregation, JSON serialization, and human audit trails.
- **Constraints:** Never used for latency subtraction or interval calculation due to potential NTP adjustments, VM clock steps, and leap seconds.

### 3.2 Process Monotonic Clock
- **API:** `process.hrtime.bigint()`.
- **Helper:** `diffMonotonicMs(startNs, endNs)` returning floating-point milliseconds.
- **Usage:** All operational interval measurements: queue waiting time, HTTP request duration, local signing time, transaction simulation time, and RPC round-trips.
- **Invariance:** Guaranteed strictly monotonic; never moves backwards.

### 3.3 On-Chain Block Time & Slot Clock
- **Source:** Solana validator consensus timestamps (`blockTime` in Unix integer seconds) and ledger `slot`.
- **Precision:** **COARSE** (~1000 ms resolution).
- **Semantic Rule:** On-chain blockTime cannot be used for sub-second precision latency comparisons. Metrics derived from blockTime (such as `approxEventToObservationMs`) must include lower and upper uncertainty bounds (`±1000ms`) and be tagged `COARSE`.

---

## 4. Telemetry Architecture

### 4.1 TelemetrySpan Contract
Every instrumented operation creates an immutable or controlled-mutation `TelemetrySpan`:
```typescript
interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTimeWallMs: number;
  startMonotonicNs: bigint;
  durationMs: number;
  status: 'OK' | 'ERROR' | 'TIMEOUT';
  attributes: Record<string, string | number | boolean | null>;
  events: Array<{ name: string; timestampMs: number; data?: any }>;
}
```

### 4.2 Universal Redaction Policy
To guarantee zero secret leakage into logs or telemetry:
1. **Private Keys:** Base58 32-byte secret keys, 64-byte secret key arrays, and PEM formatted private keys are automatically matched and replaced with `[REDACTED_PRIVATE_KEY]`.
2. **API Keys & Authorization:** Tokens in headers (`Authorization: Bearer ...`, `apiKey`, `jup_api_key`) and query parameters (`?api-key=...`) are sanitized to `[REDACTED_API_KEY]`.
3. **Binary Payloads:** Base64 serialized Solana transactions (`swapTransaction`) are stripped to prevent raw payload bloat and accidental leak of unconfirmed instructions.
4. **Context-Aware Public Identifiers:** Fields named `signature`, `txSignature`, `mint`, or `wallet` preserve Base58 strings **ONLY IF** they satisfy strict cryptographic lengths (32 bytes Base58 for PublicKeys, 64 bytes Base58 for Signatures). Any unrecognized or malformed Base58 string is conservatively redacted.

### 4.3 Bounded In-Memory Ring Buffer
- **Capacity:** Default effective capacity of 5,000 spans (`globalTelemetryBuffer` initialized with `capacity = 5000`, configurable via `TelemetryBufferOptions`).
- **Overflow Policy:** `DROP_OLDEST`. When buffer reaches capacity, the oldest span is dropped, and `droppedSpansCount` is atomically incremented.
- **Safety Guarantee:** Telemetry buffer operations are enclosed in unconditional try/catch blocks. Telemetry never throws exceptions to caller code.

### 4.4 Telemetry Internal Error Counter
- A dedicated counter `telemetryInternalErrorCount` tracks any internal telemetry formatting, redaction, or buffer insertion failures.
- **Trading Safety:** Telemetry failures increment this counter and fail silently; they NEVER abort quotes, order submission, simulation, or transaction execution.

---

## 5. Jupiter & Solana RPC Instrumentation

### 5.1 Jupiter Pipeline Metrics
The execution pipeline through Jupiter Swap API V2 is decomposed into segregated spans:
1. `JUPITER_QUEUE_WAIT_MS`: Time spent queued waiting for concurrency permit in `JupiterTrafficCoordinator`.
2. `JUPITER_COORDINATOR_TOTAL_MS`: Total time in coordinator (queue wait + execution callback).
3. `JUPITER_QUOTE_HTTP_MS`: HTTP round-trip duration for quote without taker (via `GET /order` on `https://api.jup.ag/swap/v2/order` without `taker` parameter, functioning as V2 price check). Marked with `quoteSource: 'NETWORK'` or `'CACHE'`.
4. `JUPITER_ORDER_HTTP_MS`: HTTP round-trip duration for order with taker (via `GET /order` on `https://api.jup.ag/swap/v2/order` with `taker: userPublicKey` returning transaction and `requestId`).
5. `LOCAL_SIGN_MS`: Monotonic duration of local private key signature.
6. `SOLANA_SIMULATION_MS`: Monotonic duration of pre-flight RPC simulation.
7. `JUPITER_EXECUTE_HTTP_MS`: HTTP round-trip duration of execution dispatch (via `POST /execute` on `https://api.jup.ag/swap/v2/execute`).

### 5.2 Solana RPC Instrumentation & Provider Provenance
Every outbound RPC call via `SolanaWallet` is instrumented across all 7 supported wallet methods:
- **Provider Alias Classification:** Sanitizes endpoint URLs to high-level aliases:
  - `HELIUS`: `*helius*`
  - `QUICKNODE`: `*quiknode*` / `*quicknode*`
  - `SOLANA_PUBLIC`: `*solana.com*`
  - `CUSTOM_PRIVATE`: Any authenticated custom RPC URL (URL and API key stripped)
  - `UNKNOWN`: Unrecognized hostnames
- **Method Duration:** Monotonic execution duration measured per method across all 7 instrumented Solana RPC calls: `getBalance`, `getParsedTransaction`, `getSignaturesForAddress`, `getParsedTokenAccountsByOwner`, `getAccountInfo`, `getLatestBlockhash`, `sendAndConfirmTransaction`.
- **Slot Capture:** Captured strictly from RPC response context (`context.slot`). ZERO synthetic `getSlot()` requests are generated to avoid adding RPC overhead.

---

## 6. Error Classification Namespaced by Program ID

Generic error codes (such as `Custom: 6001`) have completely different meanings depending on the program that emits them. Nexus V2.0 strictly requires namespaced error resolution:

```typescript
function classifySolanaProgramError(
  programId: string | null | undefined,
  customCode: number,
  rawLog?: string
): SolanaErrorClassification
```

### Approved Program Mappings:
1. **Jupiter Swap Program (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`):**
   - `6001`: `JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED`
   - `6008`: `JUPITER_NOT_ENOUGH_ACCOUNT_KEYS`
   - `6014` (`0x177e`): `JUPITER_INCORRECT_TOKEN_PROGRAM_ID` (*NEVER slippage!*)
   - `6017`: `JUPITER_EXACT_OUT_AMOUNT_NOT_MATCHED`
   - `6024`: `JUPITER_INSUFFICIENT_FUNDS`
   - `6025`: `JUPITER_INVALID_TOKEN_ACCOUNT`
2. **Raydium AMM V4 (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`):**
   - `0x1e`: `RAYDIUM_SLIPPAGE_EXCEEDED`
3. **Pump.fun Bonding Curve (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`):**
   - `0x1771`: `PUMPFUN_SLIPPAGE_EXCEEDED`
4. **Unproven or Unknown Program ID:**
   - Any error code without a verified, proven `programId` in the on-chain log line is classified strictly as **`UNKNOWN`**.

---

## 7. Deterministic Replay Harness & Atomic Execution Rules

### 7.1 Zero-Lookahead & Zero-Network Guarantees
- The `HistoricalReplayEngine` loads immutable JSON/JSONL fixtures.
- All HTTP, HTTPS, and fetch network interfaces are mocked and blocked during replay.
- Attempting to inspect future observations or transactions beyond current replay step throws `LookaheadViolationError`.

### 7.2 Atomic Execution Constraints
For all market crash fixtures:
- `allowsPreCrashFill: false`: An atomic on-chain swap executed by another trader alters the constant product curve instantaneously. No future sensor, WebSocket, or gRPC stream can retroactively fill an exit order at the pre-crash price once the swap has landed on-chain.
- `detectionAdvantageMeasurable: true`: A faster sensor can reduce `transaction landed -> Nexus observed`, giving detection advantage.
- `retroactiveExecutionAllowed: false`: Fabricating retroactive fills prior to confirmed atomic swaps is strictly prohibited.

---

## 8. Summary of Operational Limitations in V2.0

1. **No Live WebSocket:** All live quotes in V2.0 continue to operate via HTTP polling. WebSocket ingestion is deferred to V2.2/V2.4.
2. **Coarse Event Latency:** Historical events rely on Solana validator integer second timestamps; true sub-millisecond network propagation was not captured in legacy logs.
3. **Database Ledger Deferred:** Positions currently track outcomes in memory and in legacy database schemas; formal `FillLedger` table implementation is assigned to V2.1.
