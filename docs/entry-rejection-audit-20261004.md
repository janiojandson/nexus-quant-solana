# ENTRY_REJECTED audit - 2026-10-04

Window: 2026-10-03 02:46 UTC to 2026-10-04 02:46 UTC (2026-10-02 23:46 through 2026-10-03 23:46 America/Sao_Paulo).
Source: read-only PostgreSQL queries, Railway deployment history, source history and runtime configuration.

## Solana findings
756 ENTRY_REJECTED records, 755 distinct mints; 1 ENTRY_APPROVED.
Reasons by phase: RugCheck 678; sizing 60; momentum 15; tactical Laya 2; Jupiter swap 1.
Overlapping risk flags: LP 654; top-five concentration 675; provider LP warning 654; creator history 61.
49 of 60 sizing rejections mention RTSE exceeding 750 bps. Earliest: 2026-10-03 04:22:23.709 UTC.
The V2 migration was committed 2026-10-03 00:23:22 Brazil time. This is consistent with the onset of the new execution-policy rejections, although commit time alone does not prove deployment time.
The same period's approval (Odyssey, 04:25:49 Brazil time) was READY_FOR_JUPITER_SWAP, not a confirmed buy; the audit has no transaction signature.
Daily Solana audit records with real transaction signatures: October 2 = 7 unique signatures; October 3 = 0 at audit time.
Do not equate historical ENTRY_APPROVED counts (83 on October 2) with actual buys.

## Actual parameters
Age 5-60 minutes; liquidity >= USD15000; five-minute change +3% to +85%; buy count >= sell count.
RugCheck LP locked/burned >=90%, top-five <=35%, holders >=100.
Entry micro-momentum enabled: 4 observations, 1500ms interval, rise 0.40%-4.00%, maximum per-step pullback 0.30%.
ceil(3 * 0.67) requires all 3 steps rising; it does not permit 2/3. This strictness already existed and was not silently relaxed.
No changes to the core RugCheck/momentum thresholds were found between cd47e54 and the deployed protection fix.
New exit-capacity checks, V2 execution, sizing and advisory changes did occur; the strategy cannot be described as completely unchanged.
Stale microprice is currently treated as indeterminate and may proceed, as Odyssey's metadata demonstrates.
Buy/sell volume filtering is conditional. Code expects split volume fields; do not claim that total volume or unique organic buyers are fully validated.

## Concrete integration correction
Automatic /order may return RTSE above the configured limit. Previously it was discarded; smaller order sizes repeatedly hit the same policy limit.
Now request ONE new order with explicit slippageBps at the configured ceiling (never >750). Validate its returned slippage, sign/simulate the new order, and reject if the replacement still violates the cap.
Never modify the original transaction or simply clamp response metadata.
The quote-only adapter uses the same bounded replacement.
Classify unresolved cap violations as ORDER_POLICY_REJECTED. Stop repeating the size ladder for a policy failure.
Generic simulation failures no longer invent liquidity/6014 causes.

Official reference: https://developers.jup.ag/docs/swap/advanced/slippage
RTSE is embedded at order time; explicit slippageBps overrides it. This does not guarantee a successful or profitable trade.

## Audit reliability defects still to address
The detailed gate list contains placeholder PASS values: TOP_HOLDERS=20 and DISTANCE_FROM_LOW=15, plus unmeasured authority checks.
Observed contradiction: RUG_CHECK FAIL for top-five 98.7%, alongside TOP_HOLDERS PASS at a hardcoded 20.
The rejection reason is informative; those individual gate values are not reliable evidence.
LP/holder classification needs pool-account identity and raw provider evidence before changing safety thresholds. No thresholds were relaxed in this patch.

## Slippage and stop basis
7.5% is maximum tolerated execution deviation, not an automatic debit.
Current executable PnL uses invested native asset and received token custody; Solana entryPriceUsd is still scanner-derived and is not the executable-stop basis.
An immediate sell quote below 94% of original cost can trigger the -6% Solana stop.
Resetting the stop to that already-depressed first sell quote would permit extra capital loss. Do not widen stops automatically.
Next gate: evaluate exact-size buy/sell round-trip cost and fees before entry, alongside a separate execution-price movement metric. No new uncalibrated gate or wider stop was activated here.

## Robinhood
Same window: 3046 VETO, 2140 WAIT_MOMENTUM, 9 BUY-labelled outcomes and 1 EXECUTION_ERROR.
1127 waits report unavailable executable BUY route; 1771 isolated liquidity rejections; 1034 isolated five-minute pump rejections.
Counts are observations/retries, not unique tokens or confirmed trades.
Jupiter correction applies only to Solana; Robinhood uses its Uniswap execution path.
