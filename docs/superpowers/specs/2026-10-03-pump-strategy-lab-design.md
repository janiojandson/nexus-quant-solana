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

## 5. Execution-path decision gate

No direct Pump executor is created in the initial Strategy Lab implementation.

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
- Jupiter scheduler/rate-limit behavior;
- direct bonding-curve quote math against canonical examples;
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

### Stage B — Jupiter availability/rate telemetry
Add rate-budgeted Jupiter probes and Pump→Jupiter timing. No signing.

### Stage C — Shadow Strategy Lab
Generate lifecycle cohorts, hypothetical entries/exits and net expectancy.

### Stage D — Evidence review
Run until minimum-sample gates are met. Compare Free Jupiter, optionally a paid Jupiter tier if latency is the bottleneck, and locally modeled direct Pump economics.

### Stage E — Execution candidate
Only if the evidence gate passes, design and separately arm a live direct-Pump execution subsystem.

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
