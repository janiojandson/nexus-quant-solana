# Initial stop and Jupiter V2 evidence audit ? 2026-10-04

## Requested policy
The initial stop is -12.5% of the position's actual swap cost. If the position cost 1 SOL, its initial trigger is an executable sale value of 0.875 SOL. Slippage tolerance is a limit on execution, not an automatic realized loss. It is not added again to the stop: 7.5% tolerance plus this stop does not create a 20% stop.

New positions use final wallet input/output amounts from Jupiter execution. Restored positions adopt the new negative initial stop; an existing nonnegative protective stop and the post-partial +1% stop remain protected. Trailing, breakeven, quote-health, time and liquidity exits still apply. A trigger cannot guarantee the final fill price; network fees and exit execution can worsen realized results. Jupiter token totals include applicable token swap fees, not every separate network/rent cost.

## Why TOP_HOLDERS=20/PASS was wrong
The journal had literal TOP_HOLDERS=20/PASS, mint/freeze PASS and distance-from-low=15/PASS placeholders. The actual RugCheck veto was separate. This could display a passed holder gate on the same decision that rejected excessive concentration.

The journal now receives the exact RugCheck report used by the risk gatekeeper, even on veto. TOP_HOLDERS reports the top-five concentration and the existing 35% maximum. Missing observations are WARN/NOT_EVALUATED with no fabricated value. Provider failures no longer manufacture 100% concentration or 0% locked LP. Invalid/empty percentages and invalid authorities stay unknown and fail the safety completeness check. The top-five calculation sorts reported eligible holders rather than relying on provider ordering. LP warnings retain their observed percentage. Existing pool exclusions remain provider-based; protocol ownership verification is not newly implemented here.

The normalized safety score is forwarded directly: unsafe score 0 is no longer inverted into 100. This repairs score telemetry; it does not remove a RugCheck veto. Age gate reporting now reflects the existing 5?60 minute interval.

New gate sets carry gateEvidenceVersion=2. The rejections endpoint selects only ENTRY_REJECTED, highlights the first actual failing gate, and marks old placeholder gates LEGACY_UNVERIFIED. Old records are not rewritten. Future calibration excludes these legacy gate samples and does not count WARN as FAIL. Previously stored calibration snapshots are historical and are not retroactively recomputed by this deployment.

## Jupiter V2 contract reviewed
Official references consulted 2026-10-04:
- https://developers.jup.ag/docs/swap/order-and-execute
- https://developers.jup.ag/docs/api-reference/swap/order
- https://developers.jup.ag/docs/api-reference/swap/execute
- https://developers.jup.ag/docs/swap/advanced/slippage

The current /swap/v2/order -> partial wallet signature -> /execute flow is appropriate. Quote-only /order requests omit taker; executable orders provide it. requestId and lastValidBlockHeight are forwarded. Empty executable transactions are rejected. No additional payer/router restriction is introduced.

Changes:
- Validate expireAt before signing and again after preflight, before submission.
- Require measured integer slippage in both quote and execution responses; missing no longer means zero.
- Preserve the 750 bps hard cap and the prior single fresh fixed-cap order when RTSE exceeds the chosen cap. Revalidate the replacement.
- Include the caller's cap in quote caching so a quote accepted under a wider cap cannot bypass a later narrower cap.
- Read modern priceImpact as percentage points; fall back from a null field to legacy priceImpactPct, which is a fractional ratio.
- Use totalInputAmount/totalOutputAmount for final wallet amounts. Route gross amounts and quoted amounts are not substitutes. Incomplete successful receipts become SUBMITTED_UNCONFIRMED for reconciliation, not permission for a new buy.
- Stop recording slippageBps/100 as realized entry slippage. Preserve tolerance separately; realized slippage stays unknown without measurement.

## Validation
Regression tests cover initial stop at -12.5% (and holding at -7.5%), unchanged protective exits, measured vs unavailable holder evidence, historical placeholders, calibration sample selection, missing final amounts, RFQ expiry, missing slippage, cap-aware quote reuse and impact units. Run npm test and npm run build before merge/deploy. No manual trade is used as a test.
