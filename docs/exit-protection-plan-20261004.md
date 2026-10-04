# Exit protection implementation - 2026-10-04

## Evidence and scope
Tesla mint: 3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a.
UTC 2026-10-03: entry 00:29:24 for 0.02 SOL; partial signal 00:39:31 at +35.29%; custody reduction confirmed 00:39:34.
At 01:51:01.321 remaining-position quote was approximately 0.0476 SOL (+376.26% on remaining cost).
At 01:51:02.846 quote was 0.000041149 SOL, impact 96.969%, and trailing dispatched an exit.
The trailing triggered; this is not evidence that it could fill at the trailing threshold.
Dex displayed a divergent gain. Pool transactions and final net receipts still require reconciliation; do not classify this as a confirmed rug or claim final trade PnL.

## Released
- Scanner audit fixes in the same PR: correctly scoped token/pool identity and reconsideration of alternative pools.
- Dex metadata runs asynchronously, with one in-flight request per key, bounded cache, and a conservative five-second TTL from REQUEST START. Late results do not become fresh merely because they completed.
- After obtaining an executable quote, the monitor reads only already-available fresh metadata. Missing/stale/error metadata is unknown, never zero liquidity. First observation can have no metadata.
- Trailing/full-protection decisions precede eligible runner profit reductions in Robinhood; Solana evaluates trailing and liquidity drain before its initial partial.
- Solana partial confirmation retains the proportional executable high-water mark.
- PROFIT_PROTECTION_SHADOW logs research decisions without orders or assumed fills. Logs include input values, quote age, remaining fraction, and costsComplete=false.
- Existing live flags, entry thresholds, sizing, and maximum 750 bps remain unchanged.

## Shadow hypotheses (not new live order rules)
Compare estimated original-capital recovery after +100%, exposure reductions at +200%/+300%, and a ten-percent executable drawdown.
A partial requires its own exact-size quote, fees, and confirmed receipts before a recovery claim.
Current realized-proceeds fields can include quote fallbacks. Therefore partial positions deliberately report confirmed proceeds as unknown.
Exposure-only harvesting can still be evaluated without asserting recovered capital.
The shadow is stateless with respect to hypothetical fills: repeated observations are NOT a counterfactual portfolio backtest.
Do not interpret zero estimated fees as free trading. Pending reconciliation blocks any net-profit claim.

## Next implementation gates
1. Persist transaction-reconciled native/token deltas and fees for every reduction, including restart and residual balances. Separate confirmed, estimated, and unavailable receipts.
2. Build event-time replay using executable full/partial quotes, quote age, latency, rejection, confirmation, impact, and net outcomes. Compare baseline against shadow with realistic fill bounds and an untouched evaluation period.
3. Add pool-native subscriptions only with verified protocol/account identity, decoded reserve changes, reconnect/backfill, slot/block age, and sell-quote cross-checks. Pump bonding curve and Pump AMM require separate adapters; Robinhood requires chain-specific Uniswap pool handling.
4. Use Pump events for discovery/flow, Jupiter or verified direct routes for executable Solana exit quotes, and Dex for supplementary discovery/metadata. A missing Jupiter route is not proof of a sellable direct Pump route.
5. Evaluate age buckets 0-1, 1-5, 5-15, and 15-60 minutes against unique funded buyers, volume acceleration, concentration, liquidity/depth, sellability, impact, observed slippage and net results. Volume alone is insufficient; reject stale or inconsistent evidence. Keep rejected candidates in research, without bypassing live risk checks.
6. Enable live recovery changes only after reconciliation and replay support the thresholds. Do not raise slippage to twenty percent or infer guaranteed first-block viral volume.

## Validation and deployment
Regression tests cover the Tesla gap, preserved proportional peak, stop-before-partial priority, pending/failed/stale metadata, and shadow inputs.
Both builds and complete test suites must pass before merge.
Deploy into existing production services; do not create duplicate trading services.
Verify Git SHA (or clean archive SHA for CLI deployment), startup identification, and runtime logs.
Rollback to the prior successful build if startup/monitor behavior regresses; do not revert newer custody records.
