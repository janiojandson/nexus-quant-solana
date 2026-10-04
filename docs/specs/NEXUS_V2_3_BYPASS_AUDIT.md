# NEXUS V2.3 BYPASS AUDIT & REMAINING UNVERSIONED PATHS
> Nexus Quant Solana — Missão V2.3A · Auditado em 2026-10-04

Este documento mapeia todas as rotas e fluxos existentes que podem alterar custódia ou enviar ordens financeiras sem validação de `PositionVersion`, preparando o terreno para a unificação no futuro `SingleFinancialWriter` (V2.2).

---

## 1. Inventário de Caminhos de Bypass Mapeados

### Bypass 1: Liquidação Manual Individual (`POST /api/positions/:mint/exit` e `/api/panic/:mint`)
- **Arquivo:** `src/server/routes.ts` (linhas 347-386) -> `executeExitOrder(mint, 'MANUAL', 0, 0, { shouldCloseAta: true })`.
- **Comportamento Atual:** Obtém cotação na hora (ou usa fallback Pump), envia swap e liquida 100% dos tokens sem ler ou verificar `position_version`.
- **Risco:** Pode colidir com saída automática em andamento ou vender sobre um snapshot desatualizado.
- **Status V2.3A:** Mapeado e instrumentado. O version gate (quando habilitado) exigirá `positionVersion`.

### Bypass 2: Liquidação de Pânico Geral (`POST /api/positions/liquidate-all` e `/api/panic/all`)
- **Arquivo:** `src/server/routes.ts` (linhas 401-487).
- **Comportamento Atual:** Itera `getAllOpenPositions()` e chama `executeExitOrder` em laço síncrono.
- **Risco:** Execução concorrente sem travas otimistas por posição.
- **Status V2.3A:** Mapeado.

### Bypass 3: Liquidação Avulsa de Carteira (`POST /api/wallet/liquidate-holding`)
- **Arquivo:** `src/server/routes.ts` (linhas 490-516) e `src/index.ts`.
- **Comportamento Atual:** Executa swap de saída diretamente na carteira para tokens residuais ou órfãos, sem qualquer registro em `PositionExitEngine`.
- **Risco:** Ignora completamente o conceito de posição e versões de custódia.
- **Status V2.3A:** Mapeado como caminho avulso que será unificado sob a autoridade da V2.2.

### Bypass 4: Varredura de Rent (`POST /api/wallet/sweep-rent`)
- **Arquivo:** `src/server/routes.ts` (linhas 519-534) e `src/services/rentRecoveryService.ts`.
- **Comportamento Atual:** Fecha ATAs com saldo zero.
- **Risco:** Se uma transação de entrada estiver pendente (ou reconciliação atrasada), fechar a ATA pode causar falhas em cascata.
- **Status V2.3A:** Protegido por verificação de saldo zero, mas não sincronizado com o versionamento da posição.

### Bypass 5: Watchdog Emergency Exit (`buildWatchdogExitPlan`)
- **Arquivo:** `src/index.ts` (linhas 1500-1530).
- **Comportamento Atual:** Se o monitor acumula 8 falhas consecutivas de cotação Jupiter, força uma liquidação defensiva imediata.
- **Risco:** Se o saldo mudou na chain enquanto o watchdog contava falhas, a ordem pode ser enviada com quantidade velha.
- **Status V2.3A:** O Pre-Send Version Gate protegerá contra envio caso a versão econômica tenha sofrido mutação.

### Bypass 6: Pump Direct Sell Fallback (`ExitRouter`)
- **Arquivo:** `src/index.ts` (linhas 709-760) e `src/execution/exitRouter.ts`.
- **Comportamento Atual:** Quando a rota Jupiter falha definitivamente, aciona `pumpSellExecutor.executeSell` diretamente com a quantidade inicial cotada para o Jupiter.
- **Risco:** Reutilização de `exitAmountAtomic` sem revalidação de versão.
- **Status V2.3A:** Vinculado à `BoundExecutionQuote` para garantir idempotência de quantidade e versão.

---

## 2. Ações Planejadas para V2.2 (SingleFinancialWriter)
1. Todas as mutações financeiras (manuais, automáticas, watchdog, rent sweep) deverão emitir uma intenção formal despachada exclusivamente pelo `SingleFinancialWriter`.
2. O `SingleFinancialWriter` exigirá CAS sobre `nexus_positions_v2.position_version`.
3. Nenhum swap ou RPC de envio poderá ser transmitido sem que o CAS prévio tenha reservado a versão de custódia.
