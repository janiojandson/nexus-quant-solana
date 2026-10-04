# CURRENT POSITION LIFECYCLE AUDIT (GATE 0)
> Nexus Quant Solana — Missão V2.3A · Auditado em 2026-10-04

Este documento mapeia o ciclo de vida atual das posições antes da introdução da tabela durável versionada `nexus_positions_v2`.

---

## 1. Onde posições abertas existem em memória
- **Mapeamento:** `PositionExitEngine.activePositions = new Map<string, PositionTracking>()` em `src/execution/positionExitEngine.ts`.
- **Instância Ativa:** Instanciada em `src/index.ts` linha 130 (`const positionEngine = new PositionExitEngine();`).
- **Espelhamento Visual:** `latestState.positions` mantido em memória para consumo do Dashboard HTTP (`src/server/routes.ts`).

---

## 2. Onde são persistidas atualmente
- **Não há tabela própria de posições abertas.**
- As posições ativas são reconstruídas indiretamente a partir de:
  1. `decision_journal`: evento `ENTRY_APPROVED` com metadata `phase: 'ENTRY_EXECUTED'` e `txSignature`.
  2. `trade_outcomes`: linhas inseridas/atualizadas com `status IN ('OPEN', 'PARTIAL_CLOSED')`.
- Posições encerradas são salvas com `status IN ('FULLY_CLOSED', 'PANIC_CLOSED', 'WATCHDOG_CLOSED')`.

---

## 3. Qual é a chave usada
- **Chave em memória:** Exclusivamente o endereço do token (`mint: string`).
- **Ausência de Chave Composta:** Não há indexação por `wallet + mint + token_program` nem por `trade_id` em memória.
- **Premissa Histórica:** O sistema assume implicitamente uma única posição aberta por `mint` por carteira.

---

## 4. Como tokenAmount / tokenAmountAtomic é armazenado
- Em `PositionTracking` (`src/execution/positionExitEngine.ts`):
  - `tokenAmount: number` (ponto flutuante IEEE 754 em JavaScript).
  - `initialTokenAmount?: number`.
- No fluxo de entrada (`src/index.ts` linha 2305):
  - `managedEntryAtomic = assertAtomicAmountToNumber(actualReceivedAtomic);` converte a string atômica em `number`.
- Embora `assertStoredAtomicNumberToNumber` valide se o número é inteiro seguro (`Number.isSafeInteger`), o tipo TypeScript em memória permanece `number`.

---

## 5. Onde partial altera quantidade
- **Método do Engine:** `PositionExitEngine.commitPartialExit(mint, tokensSold, currentSolValue)` (`src/execution/positionExitEngine.ts` linha 243).
- **Chamada no Fluxo:** `src/index.ts` linha 850, executada **somente** após a confirmação do swap Jupiter (`exitSwap.status === 'SUCCESS' || exitSwap.status === 'DRY_RUN_SUCCESS'` com `isPartial = true`).
- **Mutação:**
  - `position.partialTaken = true`
  - `position.tokenAmount = position.tokenAmount - sold`
  - `position.entrySol = (position.entrySol || 0.015) * remainingRatio` (ajusta custo-base proporcionalmente).

---

## 6. Onde saída final remove posição
- **Chamada no Fluxo:** `src/index.ts` linha 989:
  ```typescript
  if (shouldCloseAta) {
    positionEngine.removePosition(pos.mint);
  }
  ```
- **Gravação Histórica:**
  - Adiciona a `positionEngine.closedPositions` via `positionEngine.recordClosedTrade(...)`.
  - Atualiza `trade_outcomes` com `status = 'FULLY_CLOSED'` (ou `'PANIC_CLOSED'`, `'WATCHDOG_CLOSED'`) e calcula PnL líquido.
  - Fecha a conta ATA via `wallet.closeTokenAccount(pos.mint)` para recuperar a caução de aluguel (rent exemption de ~0.00204 SOL).

---

## 7. Como posições são restauradas após restart
- **Funções:** `queryRecoverablePositions()` e `rehydratePositionsFromWalletOnBoot()` em `src/index.ts` (linhas 2530-2720).
- **Procedimento no Boot:**
  1. Consulta `wallet.getSplTokenAccounts()` para listar contas SPL com saldo > 0 na Phantom.
  2. Consulta PostgreSQL via `queryRecoverablePositions()` buscando linhas de `decision_journal` + `trade_outcomes` com `status IN ('OPEN', 'PARTIAL_CLOSED')`.
  3. Cruza saldos: `managedAtomic = Math.min(currentAtomic, expectedCapAtomic)`.
  4. Adiciona a posição recuperada ao `positionEngine` com os watermarks históricos de pico restaurados.
  5. Contas SPL que não possuem prova no ledger são classificadas como `orphans` e expostas apenas em `latestState.walletHoldings`, ficando fora da gestão do bot.

---

## 8. Como ATA / token balance é reconciliado
- **No Boot:** Verificação direta on-chain via `SolanaWalletService.getSplTokenAccounts()`.
- **Após Swap de Entrada:** `wallet.getReceivedTokenDeltaAtomic(txSignature, mint)` para ler a diferença exata na conta do token.
- **Após Execução Incerta:** `reconcileUncertainV2Execution(mint, startedAt, 'OUT')` consulta transações recentes na carteira buscando deltas de saldo.
- **Na Limpeza de Aluguel:** `RentRecoveryService` varre e fecha contas com saldo zero.

---

## 9. Quais caminhos podem alterar saldo fora do executor principal
- **`POST /api/wallet/liquidate-holding`:** Rota administrativa para liquidar qualquer token que esteja na carteira (mesmo que não gerenciado pelo bot).
- **`POST /api/wallet/sweep-rent`:** Fecha ATAs vazias.
- **Transações Externas:** Se o operador movimentar a carteira diretamente via Phantom/Solflare ou se outra aplicação enviar tokens, o saldo na blockchain é alterado sem notificação do `PositionExitEngine` até que ocorra um restart ou reconciliação explícita.

---

## 10. Quais endpoints manuais podem alterar / liquidar posição
- **`POST /api/panic/:mint` / `POST /api/positions/:mint/exit`:** Dispara ordem `MANUAL` de saída via `executeExitOrder(mint, 'MANUAL', 0, 0, { shouldCloseAta: true })`.
- **`POST /api/panic/all` / `POST /api/positions/liquidate-all`:** Itera sobre todas as posições em `positionEngine.getAllPositions()`, executa saídas manuais, aciona `liquidateHolding` para qualquer holding residual e executa `sweepRent`.
- **`POST /api/wallet/liquidate-holding`:** Vende montante avulso especificado pelo operador.

---

## Conclusão do Gate 0
O modelo atual é volátil (em memória), indexado unicamente por `mint`, com quantidades em `number` JS, e sem controle otimista de concorrência ou versionamento econômico formal.
A implementação de `nexus_positions_v2` com `position_version BIGINT`, chaves `wallet + mint + token_program`, `token_amount_atomic NUMERIC`, e CAS atômico resolverá essas fragilidades.
