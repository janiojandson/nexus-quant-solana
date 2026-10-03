# Pump Strategy Lab — Design

**Date:** 2026-10-03
**Project:** nexus-quant-solana
**Status:** design for review
**Safety stage:** shadow/read-only first; no Pump trade execution in this design stage

## 1. Intent

Extend the existing Pump.fun Observatory into an autonomous evidence engine that can answer from production telemetry rather than intuition:

1. How much timing advantage Nexus gets from observing Pump on-chain at creation.
2. When DexScreener, GeckoTerminal and Jupiter become usable after token birth.
3. Whether slot/minute 0, early-curve, near-graduation or post-graduation entries have positive NET expectancy after protocol fees, slippage, network/priority fees and executable exit cost.
4. Whether Jupiter order/quote rate limits remove measurable alpha.
5. When a direct Pump/on-chain execution path is superior enough to justify its additional security surface.

The system must be able to reject the slot-0 hypothesis if evidence says it is inferior.

## 2. Current baseline

Already present:

- src/pump/pumpCreateEvent.ts decodes official Pump CreateEvent logs.
- src/pump/pumpBondingCurve.ts handles canonical bonding-curve PDA/state and progress.
- src/pump/pumpObservatory.ts provides read-only onLogs observation, slot/signature/creator/timing and batched curve refresh.
- Dashboard and /api/status expose the Pump observatory.
- Jupiter Swap V2 execution uses local signing, preflight, slippage caps and idempotent execute retry.
- Existing discovery includes DexScreener/Gecko, a 5–60 minute maturity incubator, RugCheck/on-chain risk gates, momentum, sizing and exits.

Local uncommitted work also exists for Pump → Dex timing in pumpDexTiming.ts and tests. It must be preserved and reviewed, not overwritten.

## 3. External constraints

### Jupiter

Current Developer Platform limits relevant to this project:

- keyless: 0.5 RPS general;
- Free: 1 RPS general;
- Developer: 10 RPS;
- Launch: 50 RPS;
- Pro: 150 RPS;
- /swap/v2/execute has a separate larger bucket: Free 50 RPS and paid 100 RPS.

Minute-0 pressure is therefore expected primarily on order/quote acquisition, not signed execute submission. Rate-limit headers must be measured and persisted. Multiple keys/accounts must not be used to evade organization-level limits.

### Pump

Pump bonding-curve tokens are tradable immediately after creation. The curve exposes reserves and completion state on-chain. Current bonding-curve trading fee is 1.25% per trade before network or third-party costs. Any shadow PnL model must include both entry and exit fees.

### Solana timing

Slot is the canonical ordering primitive. Pump event timestamp/block time are useful wall-clock references but are not enough for sub-second ordering. Nexus must persist both slot and local receive time.

## 4. Architecture

### 4.1 Pump Birth Sensor

Existing PumpObservatory remains the earliest sensor.

For each CreateEvent persist:

- mint;
- creator;
- slot;
- signature;
- Pump event timestamp;
- local receive timestamp;
- create → Nexus lag;
- initial bonding-curve reserves;
- token/quote program metadata;
- Pump and Solscan links.

No synchronous per-token RPC calls are allowed in the create callback.

### 4.2 Correlation Sensors

Independent asynchronous sensors enrich each observation:

- Curve sensor: reserve/progress/complete snapshots.
- Dex sensor: first pair seen, first price, first usable liquidity, pair creation timestamp, Dex lag.
- Jupiter sensor: first order/quote attempt, first route available, order latency, rate-limit headers/status, estimated output, price impact and router.
- Exitability sensor: hypothetical immediate round-trip quote for the same shadow entry size.
- Risk sensor: deterministic facts when available, including authorities, holders/RugCheck and creator history.

Sensor failure must never block the production Solana bot because the Strategy Lab is observational.

### 4.3 Strategy cohorts

Every Pump token is evaluated into lifecycle/time cohorts. Initial boundaries are measurement bins, not trading rules:

- BIRTH_0_15S
- BIRTH_15_60S
- EARLY_1_5M
- CURVE_5_15M
- NEAR_GRAD_60_80
- NEAR_GRAD_80_95
- NEAR_GRAD_95_100
- POST_GRAD_0_2M
- POST_GRAD_2_10M

A token may generate multiple shadow samples as it crosses states.

### 4.4 Shadow trade model

For each eligible cohort sample calculate a hypothetical entry without signing.

Persist:

- proposed entry size;
- venue: PUMP_DIRECT_MODEL, JUPITER_ROUTE, later PUMPSWAP;
- expected tokens received;
- protocol/creator fee estimate;
- priority/network fee estimate;
- expected price impact/slippage;
- immediate executable exit value when available;
- round-trip retention;
- executable exit values at 15s, 30s, 1m, 2m, 5m, 10m and graduation;
- max favorable excursion;
- max adverse excursion;
- exit-route availability and latency.

PnL and expectancy must be net of all known costs.

### 4.5 Autonomous evaluator

Maintain strategy summaries by cohort and venue.

Metrics:

- sample count;
- executable-entry fraction;
- executable-exit fraction;
- median/p90 entry latency;
- median/p90 Pump→Dex and Pump→Jupiter availability;
- median net return by horizon;
- win rate;
- loss-tail/drawdown distribution;
- round-trip retention;
- rate-limit rejection rate;
- stale-route rate;
- risk-gate survival rate.

Evaluator states:

- INSUFFICIENT_DATA
- NEGATIVE_EXPECTANCY
- PROMISING_SHADOW
- EXECUTION_CANDIDATE

Promotion requires configurable minimum samples and fails closed when exitability/cost data is missing.

A strategy may never be called profitable from mark price alone; executable exit value is required.

### 4.6 Venue comparison

For the same logical entry:

- calculate direct Pump bonding-curve economics locally from canonical on-chain reserves;
- probe Jupiter only through a global rate-budget scheduler;
- record delta in availability time, expected output and net round-trip economics.

This must answer whether a higher Jupiter tier is enough or whether direct Pump execution has real value.

### 4.7 Jupiter rate-budget scheduler

Introduce one shared observation budget instead of allowing every token to call /order.

Requirements:

- plan-aware RPS cap;
- priority queues by strategy cohort;
- response-header telemetry;
- 429 backoff and jitter;
- no key rotation to bypass provider policy;
- /execute bucket tracked separately;
- shadow tests model opportunities delayed or missed while queued.

Production execution remains independent until a later integration stage.

### 4.8 Storage

Use append-only PostgreSQL records in the shared Nexus database:

- solana_pump_observations
- solana_pump_market_samples
- solana_pump_shadow_trades
- solana_pump_strategy_summary

Raw events are immutable. Derived summaries are recomputable.

No new Railway database or filesystem volume.

### 4.9 Dashboard/API

Extend the Pump panel with:

- Pump birth → Nexus lag;
- first Dex seen/ready lag;
- first Jupiter route lag;
- current curve progress;
- strategy cohort;
- shadow entry/exit venue;
- net shadow PnL;
- strategy summary table;
- Jupiter rate-limit utilization and 429 count;
- Pump, Solscan token, transaction and Dex links when available.

Existing HTML escaping/link safety remains mandatory.

## 4.10 Exit Sovereignty, STOP and Trailing Protection

Exit protection has higher priority than discovery, shadow research or new entries.

The current production path has a structural risk: the fast exit monitor obtains a Jupiter executable quote and, when a stop fires, the final swap obtains another Jupiter /order. Entry sizing and discovery probes also use the same external organisation-level general rate-limit bucket. Separate in-process queues do not create separate provider capacity.

### Single global Jupiter traffic coordinator

All Jupiter general-bucket calls must pass through one shared coordinator with strict priorities:

1. P0 — emergency liquidation / watchdog exit;
2. P1 — STOP, TRAILING_STOP, TAKE_PROFIT and manual exit order;
3. P2 — executable exit confirmation for an active position;
4. P3 — active-position exitability health;
5. P4 — new-entry order;
6. P5 — entry sizing and momentum probes;
7. P6 — Pump Strategy Lab shadow probes.

The /execute bucket is measured separately because Jupiter documents it as a dedicated bucket.

When P0–P3 work is queued, P4–P6 must yield. Shadow research must never consume capacity needed to protect live capital.

### Capacity-aware entry admission

Before opening a position, Nexus must verify that the configured Jupiter plan plus available local/on-chain sensors can protect all open positions.

With the current 1.5-second monitor, two Jupiter-only monitored positions require about 1.33 general-bucket requests/second before any sizing or entry work. A Free plan at 1 RPS is therefore not sufficient for two positions if every protection cycle depends on Jupiter.

The system must fail closed by doing one or more of:

- use a local/on-chain high-frequency exit sensor that does not consume Jupiter general RPS;
- reduce the number of concurrently admitted Jupiter-dependent positions;
- reduce non-critical polling while positions are open;
- require a higher Jupiter plan for the configured concurrency.

It must never silently accept more positions than the exit control plane can protect.

### Two-stage stop sensor

High-frequency trailing observation must be separated from final route execution.

For a Pump token still on its bonding curve:

- subscribe to or batch-read the canonical bonding-curve account;
- calculate the deterministic sell quote locally from current on-chain reserves and current Pump fee rules;
- update peak/trailing watermark from this locally sellable state without consuming Jupiter general RPS;
- persist the high-watermark independently of Jupiter availability.

For non-Pump or post-graduation positions, use the best available on-chain venue sensor when deterministic; otherwise retain periodic Jupiter executable quotes with capacity admission.

Maintain separate fields:

- observable/high-frequency peak;
- executable/local-sellable peak;
- latest Jupiter executable value;
- last healthy exit-route timestamp.

A mark-price-only peak must not be treated as executable profit. Pump bonding-curve local sell math is allowed to be an executable-equivalent sensor only while the canonical curve is active and account state is fresh.

### Exit-path degradation circuit breaker

If an open position loses its protected exit path:

- pause new entries immediately;
- cancel/defer Strategy Lab Jupiter probes;
- raise exit monitoring priority;
- expose degraded state on dashboard/API;
- keep the position and peak watermark persisted;
- do not mark it closed until an on-chain sale is confirmed.

The existing quote-failure watchdog remains, but its emergency attempt must run through P0 and must not wait behind entry or research traffic.

### Sell-only Pump fallback

A direct Pump **sell-only** path is allowed to be designed and validated earlier than a direct Pump buy path because it is a capital-protection mechanism, not an alpha feature.

It may activate only for a token that is still on its canonical Pump bonding curve and only after deterministic fail-closed validation of program IDs, mint, curve PDA, token program, account ownership, fee accounts and curve completion state.

Requirements:

- local signing;
- exact atomic token amount;
- minimum SOL out / hard slippage cap;
- priority-fee cap;
- simulation/preflight when compatible with the emergency latency objective;
- idempotency and duplicate-sale prevention;
- on-chain reconciliation before retry after uncertain submission;
- no automatic direct BUY permission as a consequence of enabling SELL fallback.

If the curve has completed during the exit attempt, the curve fallback must refuse and hand off to the post-graduation route (Jupiter/PumpSwap path) rather than guessing.

### Stop/trailing strategy lab

The current production protection remains the baseline:

- fixed stop-loss -6%;
- early trailing after +8% with 6% distance;
- partial harvest at +35%;
- runner trailing 10% from peak.

The Strategy Lab must replay the same token path through multiple protection policies, including:

- BASELINE_CURRENT;
- volatility/liquidity-adaptive trailing;
- tiered profit-lock floors for very large moves;
- partial-harvest variants.

For each policy measure net captured return, maximum give-back from peak, premature-exit rate, exit-route availability and realized slippage.

No threshold change reaches live production merely because it would have improved one historical token. Promotion requires cohort-level evidence.

## 5. Execution-path decision gate

No direct Pump **buy** executor is created in the initial Strategy Lab implementation. A narrowly scoped sell-only Pump fallback may be implemented earlier under Section 4.10 because it is an exit-safety control, not an alpha path.

A later pumpDirectExecutor is justified only if production shadow data shows all of:

1. meaningful availability/latency advantage over the configured Jupiter tier;
2. positive net expectancy in at least one lifecycle cohort after Pump fees, slippage and network costs;
3. high executable-exit availability;
4. acceptable failure/tail-loss metrics;
5. deterministic program/account validation can be fail-closed.

If these conditions are not met, Nexus keeps Jupiter.

## 6. Real-trading safety for any later live Pump path

A later live path additionally requires:

- global real-trading arming;
- dedicated Pump execution feature flag;
- local signing only;
- verified Pump program IDs and canonical PDAs;
- on-chain token-program/account ownership validation;
- hard size/slippage/priority-fee caps;
- preflight/simulation when compatible with latency target;
- idempotency and duplicate-order prevention;
- gas/rent reserve;
- two-position portfolio cap;
- daily loss circuit breaker;
- executable exit check;
- existing admin emergency stop.

## 7. Capital and strategy learning

The lab does not use leverage.

Shadow samples are evaluated at multiple capital bands so we can see whether an edge survives realistic sizing. A later live policy scales exposure with realized equity while preserving:

- minimum SOL reserve;
- room for two simultaneous positions;
- network/priority-fee reserve;
- hard per-trade cap.

Winning cohorts receive more allocation only after realized/executable evidence. Losing cohorts receive less or are disabled. Allocation cannot be based on model confidence alone.

## 8. Testing

TDD is required.

Minimum test groups:

- Pump event decode and canonical PDA validation;
- slot/local timing and deduplication;
- Dex first-seen/ready correlation;
- Jupiter scheduler/rate-limit behavior, including P0/P1 exit preemption;
- capacity-aware entry admission under Free/paid plan budgets;
- direct bonding-curve quote math against canonical examples;
- exit-path degradation circuit breaker;
- persistent dual watermark and STOP/TRAILING behavior during Jupiter outages;
- sell-only Pump fallback validation/idempotency in tests before any live arming;
- fee/net-return calculations;
- cohort classification;
- shadow trade lifecycle and horizon marks;
- evaluator state transitions;
- PostgreSQL serialization/migrations;
- dashboard escaping and links;
- failure isolation from production trading.

Full repository tests and TypeScript build must pass before merge.

## 9. Rollout

### Stage A — Observatory correlation
Complete Pump→Dex correlation, persist timing, enable on Railway read-only.

### Stage B — Exit sovereignty
Introduce the single Jupiter traffic coordinator, exit priorities, capacity-aware entry admission, degraded-exit circuit breaker and independent persistent watermarks. Prove STOP/TRAILING cannot wait behind entry/research traffic.

### Stage C — Jupiter availability/rate telemetry
Add rate-budgeted Jupiter probes and Pump→Jupiter timing. Shadow probes are always lower priority than live exit protection.

### Stage D — Shadow Strategy Lab
Generate lifecycle cohorts, hypothetical entries/exits, stop/trailing policy replays and net expectancy.

### Stage E — Sell-only fallback safety gate
If Pump bonding-curve validation and transaction construction can be proven fail-closed, validate a direct Pump sell-only fallback independently from direct buying. It remains disabled until its own tests, simulations and operational review pass.

### Stage F — Evidence review
Run until minimum-sample gates are met. Compare Free Jupiter, optionally a paid Jupiter tier if latency is the bottleneck, and locally modeled direct Pump economics.

### Stage G — Execution candidate
Only if the alpha evidence gate passes, design and separately arm a live direct-Pump BUY subsystem.

## 10. Success criteria

The Strategy Lab must answer from persisted production data:

- median/p90 Pump creation → Nexus detection;
- median/p90 Pump → Dex ready;
- median/p90 Pump → Jupiter route;
- percentage tradable in each cohort;
- percentage with immediately executable exits;
- net expectancy per cohort and venue;
- cost of Jupiter throttling in missed/late samples;
- whether a higher Jupiter tier or direct Pump route materially improves net results;
- which strategy, if any, qualifies as an execution candidate.

The correct outcome is allowed to be: none of the minute-0 strategies are worth trading.
