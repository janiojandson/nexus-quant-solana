# NEXUS V2.3 QUOTE & INTENT BINDING SPECIFICATION
> Nexus Quant Solana — Missão V2.3A · Regras de Vinculação e Pre-Send Version Gate

## 1. Visão Geral
Toda cotação financeira obtida para execução de saída deve estar estritamente vinculada a uma posição específica em uma versão específica:

```typescript
export interface BoundExecutionQuote {
  readonly positionId: string;
  readonly positionVersion: PositionVersion;
  readonly requestedAmountAtomic: bigint;
  readonly quoteReceivedAtWallMs: number;
  readonly quoteReceivedAtMonoNs: bigint;
  readonly quoteSource: 'JUPITER' | 'PUMP_DIRECT' | 'MANUAL';
  readonly requestId?: string | null;
  readonly inAmountAtomic: bigint;
  readonly outAmountLamports: bigint;
  readonly slippageBps: number;
  readonly rawQuote?: any;
}
```

A cotação é imutável (`Object.freeze`). Os metadados de vinculação pertencem ao Nexus e não alteram o payload do Jupiter.

---

## 2. Pre-Send Version Gate
Imediatamente antes da operação irreversível de transmissão da transação:
1. Recarrega o `PositionSnapshot` atual da posição.
2. Executa a função pura `evaluatePreSendVersionGate(...)`:
   - `current.positionVersion === quote.positionVersion`
   - Se política `FULL_REMAINDER`: `quote.requestedAmountAtomic === current.tokenAmountAtomic`
   - Se política `PARTIAL`: `quote.requestedAmountAtomic <= current.tokenAmountAtomic` e `quote.requestedAmountAtomic === intendedAmountAtomic`
   - `current.reconciliationRequired === false`
3. Se qualquer invariante divergir:
   - **NÃO ENVIAR**.
   - Retorna erro tipado: `QUOTE_STALE_FOR_POSITION`, `QUOTE_AMOUNT_MISMATCH` ou `POSITION_RECONCILIATION_REQUIRED`.
   - **Garantia de Zero Envio:** Nenhum `/execute` do Jupiter ou RPC de envio é transmitido.

---

## 3. Política de Supersede Pré-Envio (Requirement 9)
Se a versão da posição avançar enquanto uma intenção está aberta:
- **Estados Pré-Transmissão (`CREATED`, `CLAIMED`, `PREPARED` comprovadamente não transmitida):**
  - A intenção pode ser cancelada e **SUPERSEDED** com segurança.
  - Uma nova intenção pode ser gerada para a nova versão de custódia segundo a política ativa.
- **Estados Pós-Transmissão / Inconclusivos (`SUBMITTED`, `UNKNOWN`):**
  - **NÃO** podem ser superseded silenciosamente.
  - Exigem estritamente: **`MUST_RECONCILE`**.
  - A posição fica com `reconciliationRequired = true` até que a blockchain confirme ou expire o bloco.

---

## 4. Cache de Cotações (Requirement 18)
- Entradas de cache de cotações podem ser indexadas por `mint / amount / slippage`.
- No entanto, a camada de despacho financeiro **RECUSA** qualquer cotação cuja metadata local esteja atrelada a uma versão econômica defasada.
- Uma quote antiga nunca é injetada para uma versão mais nova da posição.

---

## 5. Status de Implementação
- `BoundExecutionQuote`: **IMPLEMENTED** (`src/position/quoteBinding.ts`).
- `evaluatePreSendVersionGate`: **IMPLEMENTED** (`src/position/versionGate.ts`).
- `evaluateIntentSupersedeEligibility`: **IMPLEMENTED** (`src/position/versionGate.ts`).
- Pre-Send Enforcement Flag: **ENFORCEMENT-READY** (`NEXUS_V2_POSITION_VERSION_GATE_ENABLED=false`).
