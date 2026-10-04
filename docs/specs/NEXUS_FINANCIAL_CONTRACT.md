# NEXUS FINANCIAL CONTRACT & ACCOUNTING SPECIFICATION
> **Document Version:** 2.0.0  
> **Status:** AUDITED & CONSOLIDATED  
> **Date:** 2026-10-04  
> **Baseline Commit:** `9879a43` (Hardening Commit 4)  
> **Classification:** FORMAL SPECIFICATION — NEXUS QUANT SOLANA  

---

## 1. Executive Summary

This document establishes the formal mathematical contract, accounting identities, and balance invariants governing capital allocation, fee segregation, rent recovery, and PnL reporting in the Nexus Quant Solana system.

In historical operations (e.g. the SUPERPIG incident), accounting discrepancies emerged because database records registered quote values rather than actual on-chain transaction balance deltas. The Nexus V2.0 financial contract eliminates this ambiguity by enforcing strict on-chain truth.

---

## 2. Implementation Status: Contract Defined vs Ledger Not Yet Implemented

| Domain | Status | Description |
|---|---|---|
| **Mathematical Contract** | **CONTRACT DEFINED** | All equations, fee definitions, rent segregation rules, and unit invariants are fully specified, verified by unit tests (`evaluateCapitalReturn`, `TradeAccounting`), and enforced in replay analysis. |
| **Persistent Fill Ledger** | **LEDGER NOT YET IMPLEMENTED** | The dedicated PostgreSQL `fill_ledger` table, automated fill-reconciliation daemon, and database idempotency locks are NOT active in V2.0. They constitute the immediate deliverable of **Phase V2.1**. |

---

## 3. Financial Terms & Mathematical Definitions

All quantities are tracked in exact integer Lamports on-chain and converted to 9-decimal floating-point SOL exclusively for human-readable audit and reporting.

```
                           CAPITAL FLOW IDENTITY
 ┌────────────────────────────────────────────────────────────────────────┐
 │ initialPrincipal (SOL)                                                 │
 │   - entryFees (network + priority + ATA rent)                          │
 │                                                                        │
 │ + confirmedGrossProceeds (all on-chain swaps: partial + final)         │
 │   - exitFees (network + priority + tips)                               │
 │                                                                        │
 │ + rentMovement (reclaimed ATA rent on account close)                   │
 │ ────────────────────────────────────────────────────────────────────── │
 │ = netRecovered (SOL)                                                   │
 └────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Capital & Proceeds
1. **`initialPrincipal` (SOL):**
   Exact quantity of SOL swapped into the token at entry. Excludes entry fees and rent.
2. **`entryFees` (SOL):**
   Sum of signature fee (0.000005 SOL), compute budget priority fees, and ATA creation rent (0.00203928 SOL or 0.00150884 SOL).
3. **`confirmedGrossProceeds` (SOL):**
   Gross SOL credited by on-chain swap instructions across all exit transactions (partial take profits + final exit swap). Derived strictly from on-chain `postBalances - preBalances` or inner token transfer deltas.
4. **`networkFees` (SOL):**
   Standard base transaction signature fees paid to the Solana network (5,000 lamports per signature).
5. **`priorityFees` (SOL):**
   Additional micro-lamport compute budget priority fees paid to prioritize transaction inclusion.
6. **`tips` (SOL):**
   Direct lamport tips paid to Jito block engines / validators via dedicated tip accounts.
7. **`rentMovement` (SOL):**
   Solana rent-exempt reserve deposited upon Associated Token Account (ATA) creation and recovered upon ATA closure (`CloseAccount` instruction).
   - **Rent Rule:** ATA rent refund is **capital recovery**, NOT trading profit. It must be segregated from trade PnL calculations so that closing an empty account does not generate artificial alpha.

### 3.2 Net Performance & Return Metrics
1. **`netRecovered` (SOL):**
   $$\text{netRecovered} = \text{confirmedGrossProceeds} - (\text{networkFees} + \text{priorityFees} + \text{tips}) + \text{rentMovement}$$
2. **`capitalRecoveredPct` (%):**
   $$\text{capitalRecoveredPct} = \left( \frac{\text{netRecovered}}{\text{initialPrincipal}} \right) \times 100$$
3. **`realizedPnL` (SOL):**
   $$\text{realizedPnL} = \text{netRecovered} - \text{initialPrincipal} - \text{entryFees}$$
4. **`tradeEquityPnL` (%):**
   Mark-to-market executable value of currently held tokens based on immediate Jupiter quote vs initial principal while position is active:
   $$\text{tradeEquityPnL} = \left( \frac{\text{executableQuoteSol} - \text{initialPrincipal}}{\text{initialPrincipal}} \right) \times 100$$
5. **`MFE` (Maximum Favorable Excursion, %):**
   Peak positive unrealized PnL percentage recorded by any observation during position lifecycle:
   $$\text{MFE} = \max(\text{peakObservedPnlPct})$$
6. **`MAE` (Maximum Adverse Excursion, %):**
   Lowest negative unrealized PnL percentage recorded by any observation during position lifecycle:
   $$\text{MAE} = \min(\text{adverseObservedPnlPct})$$
7. **`profitGiveback` (%):**
   Percentage of peak profit forfeited between MFE and final exit:
   $$\text{profitGiveback} = \left( \frac{\text{MFE} - \text{realizedReturnPct}}{\text{MFE}} \right) \times 100 \quad (\text{for } \text{MFE} > 0)$$

---

## 4. Signal vs Fill Execution Metric (`fillVsSignalQuotePct`)

To measure execution quality without conflating market collapse with transaction slippage:

### Mathematical Definition:
$$\text{fillVsSignalQuotePct} = \left( \frac{\text{fillValue} - \text{signalExecutableValue}}{\text{signalExecutableValue}} \right) \times 100$$

Where:
- `fillValue`: Exact on-chain gross SOL proceeds realized by the final exit swap.
- `signalExecutableValue`: Jupiter executable SOL quote value recorded at the exact moment the exit decision was triggered.

### Invariant Rules:
1. **Never Uses MFE:**
   The denominator is **STRICTLY** `signalExecutableValue` (the quote that triggered the order). It is mathematically invalid to use MFE as the denominator. Doing so would conflate market price movement (which happened prior to the decision) with execution slippage.
2. **Positive Value Indicates Better Fill:**
   If `fillVsSignalQuotePct > 0`, the realized fill was higher than the quoted signal (positive slippage).
3. **Negative Value Indicates Execution Degradation:**
   If `fillVsSignalQuotePct < 0`, the transaction experienced slippage or price degradation between quote creation and block inclusion.

---

## 5. Canary Invariants & Safety Constraints

The following safety invariants are programmatically enforced by `evaluateCapitalReturn`:
1. **Zero Remaining Token Balance:**
   A position cannot be classified as fully exited if `remainingTokenBalance > 0`.
2. **ATA Closure Required:**
   The Associated Token Account must be verified closed on-chain to reclaim rent and ensure zero lingering exposure.
3. **Discrepancy Threshold:**
   If the discrepancy between expected database return and on-chain balance recovery exceeds **0.0015 SOL**, the trade is flagged with `ACCOUNTING_FAILURE` and requires human manual audit.
