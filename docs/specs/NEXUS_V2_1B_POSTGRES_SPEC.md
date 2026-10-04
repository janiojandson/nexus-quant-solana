# NEXUS QUANT SOLANA — ESPECIFICAÇÃO TÉCNICA V2.1B
## POSTGRESQL REAL & SHADOW INTEGRATION DO DURABLE EXIT JOURNAL

> **Versão:** 2.1B  
> **Status:** IMPLEMENTADO & AUDITADO  
> **Branch:** `nexus-v2-observability`  
> **Modo de Operação:** SHADOW PASSIVO (`NEXUS_V2_JOURNAL_SHADOW_ENABLED=false` default)

---

## 1. ESCOPO & ARQUITETURA DE DADOS

A missão V2.1B implementa a camada de persistência em PostgreSQL real (`PostgresJournalRepository`), integrando o Durable Exit Journal e o Fill Ledger ao fluxo de execução real de saídas do Nexus Quant Solana de forma passiva (Shadow Mode).

### 1.1 Tabelas & Invariantes de Banco de Dados

1. **`exit_intents`**:
   - `id VARCHAR(64) PRIMARY KEY`
   - `economic_dedupe_key VARCHAR(64) NOT NULL UNIQUE` (Hash SHA-256 de wallet, mint, requestedAmount, amountPolicy, positionVersion).
   - `claim_epoch INTEGER NOT NULL DEFAULT 0` (Fencing Monotônico).
   - `reconciliation_debt BOOLEAN NOT NULL DEFAULT FALSE` (Blindagem contra re-execução não auditada).
   - **Partial Unique Index**:
     ```sql
     CREATE UNIQUE INDEX IF NOT EXISTS uq_active_intent_wallet_mint
     ON exit_intents(wallet_id, mint)
     WHERE status NOT IN ('APPLIED', 'CANCELLED', 'SUPERSEDED', 'FAILED_DEFINITIVE');
     ```

2. **`execution_attempts`**:
   - `attempt_id VARCHAR(64) PRIMARY KEY`
   - `intent_id VARCHAR(64) NOT NULL REFERENCES exit_intents(id)`
   - `last_valid_block_height BIGINT NULL` (Janela de validade da transação Solana).
   - `state VARCHAR(32) NOT NULL DEFAULT 'INITIALIZED'`

3. **`intent_severity_events`**:
   - `id SERIAL PRIMARY KEY`
   - Trilha append-only de escalonamento (`ROUTINE` -> `HIGH` -> `CRITICAL` -> `EMERGENCY`).

4. **`fill_ledger`**:
   - `id VARCHAR(64) PRIMARY KEY`
   - `CONSTRAINT uq_fill_onchain_identity UNIQUE (signature, chain_leg_index, instruction_index, inner_instruction_index)`
   - `gross_proceeds_lamports NUMERIC(38, 0) NOT NULL` (Zero perda de precisão).
   - Trigger append-only: proíbe expressamente `UPDATE` e `DELETE`.

5. **`execution_reconciliation_events`**:
   - Auditoria append-only das decisões do motor puro de reconciliação.

---

## 2. MECANISMOS DE CONCORRÊNCIA E BLINDAGEM

### 2.1 FOR UPDATE SKIP LOCKED
- O worker que executa `claimNextIntent` realiza a busca via:
  ```sql
  SELECT * FROM exit_intents
  WHERE status = 'CREATED'
     OR (lease_expires_at < NOW() AND status NOT IN ('APPLIED', 'CANCELLED', 'SUPERSEDED', 'FAILED_DEFINITIVE'))
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  ```
- Workers simultâneos pulam intents bloqueadas sem colisão ou contenção de locks de banco.

### 2.2 Fencing Epoch
- Cada claim incrementa monotonicamente `claim_epoch = claim_epoch + 1`.
- Mutações posteriores (ex: `updateAttemptState`, `recordSeverityEvent`) exigem verificação de epoch:
  ```sql
  UPDATE ... WHERE claim_epoch = $expectedEpoch
  ```
- Se `rowCount = 0`, a operação é imediatamente rejeitada com `StaleEpochError`, neutralizando workers zumbis.

### 2.3 Blindagem da Blockchain (`MUST_RECONCILE`)
- O vencimento de uma lease NÃO autoriza reenvio cego de ordens se a tentativa anterior atingiu `SIGNED`, `SUBMITTED`, `SENT` ou `UNKNOWN`.
- O claim é bloqueado com `LeaseRecoveryBlockedError` até que uma reconciliação on-chain audite o destino da transação.

---

## 3. INTEGRAÇÃO SHADOW NO CICLO DE VIDA DE EXECUÇÃO

O módulo `src/journal/shadowHooks.ts` intercepta 8 fases do ciclo de saída:

```
[Decisão de Saída]
       │
       ▼ shadowOnExitDecision -> Cria ExitIntent (CREATED -> CLAIMED)
[Jupiter /order]
       │
       ▼ shadowOnJupiterOrder -> Cria ExecutionAttempt (ORDER_READY, lastValidBlockHeight)
[Assinatura Local]
       │
       ▼ shadowOnLocalSign -> ExecutionAttempt (SIGNED, reconciliationDebt = true)
[Simulação Pré-Voo]
       │
       ▼ shadowOnSimulationResult -> ExecutionAttempt (SIMULATED)
[Envio /execute]
       │
       ▼ shadowOnSubmit -> ExecutionAttempt (SUBMITTED)
[Receipt do Provedor]
       │
       ▼ shadowOnProviderReceipt -> ExecutionAttempt (CONFIRMED / FAILED / UNKNOWN)
[Confirmação On-Chain]
       │
       ▼ shadowOnFillConfirmed -> Registra FillRecord; Intent -> APPLIED; clear debt
[Atualização Legada da Posição]
       │
       ▼ shadowOnLegacyPositionUpdate -> Limpa contexto shadow e compara fatos
```

### Invariantes Estritos de Produção:
1. **Zero Latência Financeira**: Com `NEXUS_V2_JOURNAL_SHADOW_ENABLED=false` (padrão), as verificações de flag retornam em <10ns, sem criação de promises, sem I/O e sem overhead.
2. **Zero Chamadas de Rede Extras**: Os hooks operam unicamente com os dados em memória já disponíveis no executor.
3. **Fail-Safe**: Qualquer erro na camada shadow é capturado, registrado em `shadowJournalErrorCount` e NUNCA propaga exceção para a negociação ativa.

---

## 4. COMPARE MODE & RESTART MATRIX

### 4.1 Compare Mode
Compara os fatos da execução legada contra os registros do journal shadow:
- `requestedAmountAtomic`
- `signature`
- `providerResult`
- `proceedsLamports`
- `isPartial`
- `terminalState`
Gera divergências tipadas em `JournalComparisonMismatch { field, legacyValue, shadowValue, severity }`.

### 4.2 Matriz de Reinicialização (8 Crash Points)

| Crash Point | Estado do Journal | Ação Segura Permitida | Reenvio Cego Autorizado? | Reconciliação Obrigatória? |
|---|---|---|:---:|:---:|
| 1. Pós-CREATED | `CREATED` | `CLAIM_ALLOWED` | ✅ SIM | ❌ NÃO |
| 2. Pós-CLAIMED | `CLAIMED` (sem attempt) | `RECLAIM_AFTER_LEASE` | ✅ SIM | ❌ NÃO |
| 3. Pós-PREPARED | `ORDER_READY` | `RECONCILE_OR_RETRY_UNSENT` | ✅ SIM | ❌ NÃO |
| 4. Pós-SIGNED | `SIGNED` (dívida ativa) | `MUST_RECONCILE` | ❌ **PROIBIDO** | ✅ SIM |
| 5. Pós-SUBMITTED | `SUBMITTED` (dívida ativa) | `MUST_RECONCILE` | ❌ **PROIBIDO** | ✅ SIM |
| 6. Pós-UNKNOWN | `UNKNOWN` (dívida ativa) | `MUST_RECONCILE` | ❌ **PROIBIDO** | ✅ SIM |
| 7. Pós-CONFIRMED | `CONFIRMED` | `APPLY_IDEMPOTENTLY` | ❌ NÃO | ❌ NÃO |
| 8. Crash entre Fill e Apply | Fill gravado / Intent CONFIRMED | `IDEMPOTENT_RECOVERY_APPLIED` | ❌ NÃO | ❌ NÃO |

---

## 5. PROCEDIMENTO DE ROLLBACK & RECOVERY DE MIGRATIONS

### 5.1 Regras de Contenção de Banco
- **PROIBIÇÃO ABSOLUTA**: Nunca executar `DROP TABLE`, `TRUNCATE` ou scripts destrutivos em banco compartilhado ou produção.
- Todas as DDLs usam `IF NOT EXISTS` para garantir idempotência.

### 5.2 Cenários de Recuperação

1. **Migration Interrompida / Parcialmente Aplicada**:
   - As DDLs são declaradas em transação única (`BEGIN ... COMMIT`).
   - Se ocorrer erro, o PostgreSQL faz rollback automático.
   - Caso aplicada parcialmente fora de transação, reexecutar o arquivo `001_v2_1_durable_exit_journal.sql`: como todos os comandos usam `CREATE TABLE IF NOT EXISTS` e `CREATE INDEX IF NOT EXISTS`, a execução é estritamente idempotente.

2. **Índice Existente com Predicado Incompatível**:
   - Inspecionar via `\d exit_intents` ou catálogo `pg_indexes`.
   - Criar o novo índice com nome de transição `uq_active_intent_wallet_mint_v2` e apenas descartar o legado após homologação.

3. **Tabela Legada Incompatível**:
   - Não deletar a tabela.
   - Renomear via `ALTER TABLE <tab> RENAME TO <tab>_legacy_pre_v21` e reaplicar a migration.

---

## 6. SEMÂNTICA SHADOW vs AUTORITATIVA

| Aspecto | Modo SHADOW (V2.1B Atual) | Modo AUTORITATIVO (Fase Futura) |
|---|---|---|
| **Autoridade Financeira** | Código legado decide saldos e ordens | O Journal é a fonte única da verdade (Single Writer) |
| **Falha no Repositório** | Ignorada pelo executor; loga erro e métrica | Bloqueia a emissão até restabelecimento do journal |
| **Escrita no Banco** | Passiva / em background | Transacional / síncrona com confirmação de lock |
| **Reconciliação** | Passiva para auditoria e métricas | Autoritativa; trava o trade até desempatar on-chain |

### O que Impede o Journal de Ser Autoritativo Hoje?
1. Falta de tabela durável da posição V2 com `position_version` estrito no PostgreSQL.
2. Inexistência do `SingleFinancialWriter` com thread/mutex isolado na aplicação.
3. Necessidade de validação do overhead de rede da malha Railway com telemetria contínua.
