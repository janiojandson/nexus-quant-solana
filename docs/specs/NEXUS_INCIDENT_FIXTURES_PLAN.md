# NEXUS HISTORICAL INCIDENT FIXTURES & REPLAY SPECIFICATION
> **Document Version:** 2.0.0  
> **Status:** AUDITED & CONSOLIDATED  
> **Date:** 2026-10-04  
> **Baseline Commit:** `9879a43` (Hardening Commit 4)  
> **Classification:** FORMAL SPECIFICATION — NEXUS QUANT SOLANA  

---

## 1. Executive Summary

This document specifies the provenance, normalization rules, cryptographic lockfiles, and replay constraints governing the 4 canonical historical incident fixtures in Nexus V2.0: **Tesla**, **SSI**, **Mr Beast**, and **SUPERPIG**.

The fixtures serve as the regression baseline for all future execution algorithms. By subjecting future engines (V2.1–V2.7) to these exact historical timelines, the system guarantees zero regression against past catastrophic failure modes without introducing counterfactual or fabricated fills.

---

## 2. Cryptographic Integrity: Chain of Custody & Lockfile

To prevent silent tampering across the transformation lifecycle, every fixture is locked through a two-tier cryptographic chain:

```
┌────────────────────────┐      ┌─────────────────────────┐      ┌─────────────────────────┐
│   RAW AUDIT SOURCES    │ ──>  │  BUILDER TRANSFORMATION │ ──>  │   NORMALIZED FIXTURES   │
│ (sourceFiles sha256)   │      │ (deterministic script)  │      │   (fixtures.lock.json)  │
└────────────────────────┘      └─────────────────────────┘      └─────────────────────────┘
```

### 2.1 The Normalized Fixtures Lock (`fixtures.lock.json`)
The lockfile tracks the SHA-256 checksums of all 16 normalized fixture files (`manifest.json`, `observations.jsonl`, `transactions.json`, `expected.json` across all 4 incidents).

```json
{
  "version": "2026-10-04",
  "fixtures": {
    "tesla": {
      "manifestSha256": "f92e4ffa328df98c8f1d584e5d896f891186417c076707a1e8c56787cfc8ae3b",
      "observationsSha256": "b86728cebe6f6dfdc1cd1dffd16a32a8b773bf0cbbe3af1c34f7f5a43df34ed3",
      "transactionsSha256": "d142470ea016149fdcdd14606a7d67deb295c246dc465cc9b36a1651791ce4ac",
      "expectedSha256": "909ae011f544a0647b4de047a359e54aa22dbe64cea6bbf13a01ad107e809890"
    },
    "ssi": {
      "manifestSha256": "8fc31081aa2181d722f7db9cd40df49f46499f1d20a5eab7353c1965c59ebdeb",
      "observationsSha256": "bcd6e83b672545b644b26662bcabf6932acebd4615e62acd34bafd9f41f02182",
      "transactionsSha256": "2a6f52ef40c332f69582ac1f41fe2c5637f76bb9429c10210188decc1fb86769",
      "expectedSha256": "b6b21d0f9274e830b0ec8f4c88df4f21ca8d4f83314eb52eeb6fbe0e1624ce70"
    },
    "mr-beast": {
      "manifestSha256": "36b3d000af9468e601ac6d1b212ca0daee9d3e69d1a693062063097bbcc58d2e",
      "observationsSha256": "585ae779ef43a015056897d05f2720e9a1e1dbbb25f5f2ff20166fa41ae0c48c",
      "transactionsSha256": "e1556df10e5d051a449b4d2eadde6a3ef5d9ff077d2c8e6aee9f14819dbdf366",
      "expectedSha256": "e1d3e6614476791593664c07563ca71a22ddd745997192d3ec5a6459c77f8e2a"
    },
    "superpig": {
      "manifestSha256": "8cf94f2bcc7e37b99cfdc16dd8877c84c80c1db479bee07dbb3dc183ea390465",
      "observationsSha256": "ce5e2ec0c9362e7d903dc35704afc34fefe19eaafd700c3b4455fa52fde7532a",
      "transactionsSha256": "6d048c170a3abf4b10e70b0b31d0a06a100abb099a15b79cc2f14dc6d7214d13",
      "expectedSha256": "5878379b47b9cf9079fe4375e229beaf3a7534089d17c3b38efb0b9e50d6e652"
    }
  }
}
```

---

## 3. Strict Record Counts & Superpig Resolution

A discrepancy in earlier audit documentation was investigated and resolved:
- **Raw Log Source:** `pig-crash.jsonl` contains **154 lines** (interleaved discovery events, candidate evaluations, scanner cycles).
- **Normalized Observations:** Filtering specifically for position monitoring, PnL observations, and exit engine events produces exactly **22 observations**.
- **Both Counts Tracked:** The manifest tracks `sourceRecordCount: 154` and `normalizedRecordCount: 22`.

### Grand Total Derived Observations:
$$\text{Tesla } (2,807) + \text{SSI } (2,891) + \text{Mr Beast } (152) + \text{SUPERPIG } (22) = \mathbf{5,872 \text{ observations}}$$

---

## 4. Atomic Execution Rules for Replay Experiments

Future experiments (Crash Detector, WebSocket, Yellowstone gRPC) must respect the laws of on-chain state:
1. **Allows Pre-Crash Fill = FALSE (`allowsPreCrashFill: false`):**
   When an atomic swap lands on Solana, the AMM constant-product curve updates instantaneously. No downstream observer can submit a swap that trades against the pre-crash reserves.
2. **Detection Advantage Measurable = TRUE (`detectionAdvantageMeasurable: true`):**
   A low-latency sensor can detect the crash transaction milliseconds after block inclusion instead of waiting for the next HTTP polling tick.
3. **Retroactive Execution Prohibited (`retroactiveExecutionAllowed: false`):**
   Replay engines are forbidden from fabricating retroactive fills or assuming liquidity that no longer existed on-chain.

---

## 5. Detailed Breakdown of the 4 Incident Fixtures

### 5.1 Tesla (`3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a`)
- **Facts Confirmed:**
  - Initial Swap Capital: `0.020000000 SOL` (4,375,826,130 tokens).
  - Partial Take Profit (50%): Executed at +376% peak, recovering `0.013533348 SOL`.
  - Atomic Whale Dump: Tx `2ti4qD2YffXcJnTj5swzvgoNGYd798qQD6gECvP88UfAcacTY53mmWgoH7GzLsaqSveQ3Y6a7BS18ruyv4FX8Hye` collapsed pool reserves by **-99.77%** (605.2 SOL → 1.37 SOL).
  - Final Exit Proceeds: `0.000041149 SOL`.
  - Net Liquid SOL: `-0.006455720 SOL` (-32.28% return).
  - Fill vs Signal Quote: `0.0%` (fill matched signal quote exactly).
- **Facts Unknown:** Internal sub-millisecond dispatch latency of legacy logger.
- **Clock Precision:** `COARSE` (~1s Solana blockTime).
- **Taxonomy:** `PRICE_GAP: CONFIRMED`, `DETECTION_FAILURE: NOT_DEMONSTRATED`.

### 5.2 SSI (`Da6ptrSSQWxGtyQwYpZSgMEZbm5Z9jc1ACjife9kpump`)
- **Facts Confirmed:**
  - Initial Swap Capital: `0.021826256 SOL` (5,447,502,420 tokens).
  - Partial Take Profit (50%): Executed, recovering `0.014854168 SOL`. Peak observed PnL: `+986.98%`.
  - Atomic Whale Dump: Tx `2UJoZzLXErPHjWLsbBcdhFfbwRB8zRLHHvnmPnR3uqKffUjiENe2eZwUgFjAmxediX6iRW9m641ogYT4V55ihPML` collapsed pool reserves by **-88.24%** (863.8 SOL → 101.5 SOL).
  - Final Exit Proceeds: `0.002137281 SOL`.
  - Net Liquid SOL: `-0.004860143 SOL` (-22.27% return).
  - Fill vs Signal Quote: `+0.2171%` (fill was slightly better than quoted signal).
- **Facts Unknown:** Internal sub-millisecond dispatch latency.
- **Clock Precision:** `COARSE` (~1s Solana blockTime).
- **Taxonomy:** `PRICE_GAP: CONFIRMED`, `DETECTION_FAILURE: NOT_DEMONSTRATED`.

### 5.3 Mr Beast (`8nzyZHNFhbpZrf6VpvJPenbc6WrhW6isidrbKAgTMyJ1`)
- **Facts Confirmed:**
  - Initial Swap Capital: `0.022731387 SOL` (5,506,284,374 tokens).
  - Partial Take Profit (50%): Executed, recovering `0.015402873 SOL`.
  - Atomic Whale Dump: Tx `59U3QJFGEAEyzLUGDKeEAcd2ryJEZv9hcwQV9DSk8WySXiUKqKZzAcgsSbSyBRqx973Hm69bYYKpste7sAPd8SdA` collapsed pool reserves by **-71.57%** (302.8 SOL → 86.08 SOL).
  - Final Exit Proceeds: `0.001655182 SOL`.
  - Net Liquid SOL: `-0.005698573 SOL` (-25.07% return).
  - Fill vs Signal Quote: `+0.3062%` (fill was slightly better than quoted signal).
- **Facts Unknown:** Internal sub-millisecond dispatch latency.
- **Clock Precision:** `COARSE` (~1s Solana blockTime).
- **Taxonomy:** `PRICE_GAP: CONFIRMED`, `DETECTION_FAILURE: NOT_DEMONSTRATED`.

### 5.4 SUPERPIG (`tHj1JQKxCV2orW48CA5Nge6MYBJJ73XuJU2pwBapump`)
- **Facts Confirmed:**
  - Initial Swap Capital: `0.020000000 SOL` (120,790,429,663 tokens).
  - Partial Take Profit: None taken (position opened negative at -15.96%).
  - Simulation Failures: 3 pre-flight simulation attempts rejected with `Custom: 6001`. Emitting program ID was unproven in legacy log, classified strictly as `UNKNOWN`.
  - Confirmation Timeout: Attempt 1 experienced confirmation timeout.
  - Final Exit Fill: Successfully confirmed on retry via Tx `3bhQ9DBSfPYGf3phH4JPzVFe2xBGMQXfpYgaYP8hML5KNme6i2WKaCKbemcjC8ZZhuXqw8u7BLTiG4mjRwVkNVTu`, recovering `0.003183856 SOL` (-84.77% net return).
  - **Accounting Divergence:** Database `trade_outcomes` recorded exit proceeds of `0.010301 SOL` (-48.49% PnL) based on unconfirmed quote, generating a divergence of **`0.007117144 SOL`** (36.28 percentage points).
- **Clock Precision:** `COARSE` (~1s Solana blockTime).
- **Taxonomy:** `EXECUTION_FAILURE`, `ACCOUNTING_FAILURE`, `EXECUTION_DELAY`, `INSUFFICIENT_DEPTH`.
