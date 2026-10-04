# NEXUS V2.3 POSITION VERSIONING RULES
> Nexus Quant Solana — Missão V2.3A · Regras Formais de Versionamento Econômico

## 1. Princípio Fundamental de Versão Econômica
`positionVersion` identifica uma **versão ECONÔMICA da custódia**.
Versão incrementa estritamente quando ocorre uma **mutação confirmada relevante na quantidade real disponível**.

---

## 2. O Que Incrementa Versão (newVersion = previousVersion + 1n)
1. **Compra confirmada (Entry Open):** Versão inicial `1n`.
2. **Partial Fill confirmado:** Redução de saldo atômico on-chain -> avança versão (`v1 -> v2`).
3. **Final Fill confirmado:** Encerramento do lote -> avança versão (`v2 -> v3`, status `CLOSED`).
4. **Reconciliação com delta real (External Balance Divergence):** Detecção de divergência on-chain -> avança versão e registra `RECONCILIATION_ADJUSTMENT`.
5. **Ajuste formal / Correção manual formal:** Intervenção autorizada que altere a quantidade de custódia.

---

## 3. O Que NUNCA Incrementa Versão
- **Cotação (Quote request):** Obtenção de rota Jupiter ou Pump.
- **Observação de preço:** Tick do DexScreener ou WebSocket.
- **Atualização de Trailing Stop / Watermarks:** Atualização de pico (`peakSolValue`, `observablePeakSolValue`).
- **MFE / Telemetria:** Métricas de desvio de slippage.
- **Falha de Simulação / Rejeição:** Erro 6001, simulação falha ou tx rejeitada pré-envio.
- **Erro HTTP / Timeout RPC:** Falhas transitórias de infraestrutura.
- **Transação UNKNOWN:** Estado pendente de reconciliação.
- **Claim de Intent:** Aquisição de lease de worker.
- **Reprocessamento de Fill já aplicado (Duplicate Fill):** Detecção idempotente via `uq_position_fill_mutation`.

---

## 4. Controle Otimista de Concorrência (CAS SQL)
Toda mutação no PostgreSQL físico é executada via Compare-And-Swap estrito:

```sql
UPDATE nexus_positions_v2
SET
  position_version = position_version + 1,
  token_amount_atomic = $1::numeric,
  status = COALESCE($2::varchar, status),
  confirmed_proceeds_lamports = confirmed_proceeds_lamports + $3::numeric,
  updated_at = NOW(),
  closed_at = CASE
    WHEN $2::varchar IN ('CLOSED', 'TERMINATED') OR ($1::numeric = 0 AND closed_at IS NULL) THEN NOW()
    ELSE closed_at
  END,
  last_fill_id = COALESCE($4::varchar, last_fill_id),
  last_chain_signature = COALESCE($5::varchar, last_chain_signature),
  reconciliation_required = COALESCE($6::boolean, reconciliation_required)
WHERE position_id = $7::varchar
  AND position_version = $8::bigint
RETURNING *;
```

### Regras de Concorrência:
- Se `rowCount === 0`: lançar `StalePositionVersionError`.
- **Nunca "Last Write Wins":** O worker que perde a corrida é obrigado a abortar e recarregar o snapshot atualizado da posição.
- **Nenhum saldo negativo:** O débito é estritamente validado antes e durante o CAS.

---

## 5. Idempotência de Fill
Ao receber confirmação de swap:
1. Verifica se `(position_id, fill_id)` já consta em `nexus_position_mutations_v2`.
2. Se já existir:
   - Retorna `alreadyApplied: true`.
   - `positionVersion` **NÃO** é incrementada.
   - Saldo **NÃO** é debitado novamente.
3. Se não existir:
   - Executa CAS com `expectedVersion`.
   - Insere linha em `nexus_position_mutations_v2`.
   - Garante transação atômica única no banco.

---

## 6. Status de Implementação
- Regras de CAS: **IMPLEMENTED** (Validado em testes reais de concorrência no PostgreSQL 16).
- Idempotência de Fill: **IMPLEMENTED** (Provado no Requisito 12 & 13).
- Proibição de incremento por simulação/UNKNOWN: **IMPLEMENTED** (Provado no replay histórico do SUPERPIG).
