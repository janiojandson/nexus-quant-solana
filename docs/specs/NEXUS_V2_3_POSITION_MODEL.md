# NEXUS V2.3 POSITION MODEL SPECIFICATION
> Nexus Quant Solana — Missão V2.3A · Documento de Arquitetura

## 1. Visão Geral e Princípio Central
A missão V2.3 estabelece a fundação de **Durable Position Versioning** para garantir matematicamente que toda ação financeira seja construída para:
- **A POSIÇÃO CERTA**
- **NA VERSÃO CERTA**
- **COM A QUANTIDADE CERTA**

A custódia deixa de ser um estado volátil puramente em memória (`Map<string, PositionTracking>`) e passa a ser uma entidade persistente e durável com controle otimista de concorrência (OCC) em PostgreSQL e identificadores fortemente tipados.

---

## 2. Schema Físico de Posição (`nexus_positions_v2`)
Implementado na migration `migrations/002_v2_3_position_versioning.sql`:

```sql
CREATE TABLE IF NOT EXISTS nexus_positions_v2 (
    position_id VARCHAR(64) PRIMARY KEY,
    trade_id VARCHAR(64) NOT NULL,
    wallet_id VARCHAR(64) NOT NULL,
    mint VARCHAR(64) NOT NULL,
    token_program VARCHAR(64) NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    position_version BIGINT NOT NULL DEFAULT 1,
    token_amount_atomic NUMERIC(38, 0) NOT NULL,
    initial_amount_atomic NUMERIC(38, 0) NOT NULL,
    initial_principal_lamports NUMERIC(38, 0) NOT NULL,
    confirmed_proceeds_lamports NUMERIC(38, 0) NOT NULL DEFAULT 0,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ NULL,
    last_fill_id VARCHAR(64) NULL,
    last_chain_signature VARCHAR(128) NULL,
    reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
    source VARCHAR(32) NOT NULL DEFAULT 'LIVE_EXECUTOR',
    provenance VARCHAR(64) NULL
);

-- Unicidade Econômica: Impede duas posições ativas simultâneas no mesmo par (wallet, mint, token_program)
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_position_wallet_mint
ON nexus_positions_v2(wallet_id, mint, token_program)
WHERE status NOT IN ('CLOSED', 'TERMINATED');
```

---

## 3. Log de Mutações de Versão (`nexus_position_mutations_v2`)
Cada transição de versão gera um registro imutável de auditoria:

```sql
CREATE TABLE IF NOT EXISTS nexus_position_mutations_v2 (
    id SERIAL PRIMARY KEY,
    position_id VARCHAR(64) NOT NULL REFERENCES nexus_positions_v2(position_id),
    from_version BIGINT NOT NULL,
    to_version BIGINT NOT NULL,
    mutation_type VARCHAR(32) NOT NULL,
    fill_id VARCHAR(64) NULL,
    signature VARCHAR(128) NULL,
    token_amount_before NUMERIC(38, 0) NOT NULL,
    token_amount_after NUMERIC(38, 0) NOT NULL,
    delta_atomic NUMERIC(38, 0) NOT NULL,
    proceeds_lamports NUMERIC(38, 0) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotência de Aplicação de Fill: Impede reaplicar o mesmo Fill sobre a posição
CREATE UNIQUE INDEX IF NOT EXISTS uq_position_fill_mutation
ON nexus_position_mutations_v2(position_id, fill_id)
WHERE fill_id IS NOT NULL;
```

---

## 4. Tipos e Contratos TypeScript
- `PositionVersion = bigint`: Proibido uso de `number` JS para fencing e versões. Suporta valores além de `Number.MAX_SAFE_INTEGER`.
- `tokenAmountAtomic: bigint`: Valores atômicos de tokens são estritamente inteiros de 64/128 bits.
- `PositionSnapshot`: Contrato imutável (`Object.freeze`) contendo o estado econômico exato em um instante monotônico.

```typescript
export interface PositionSnapshot {
  readonly positionId: string;
  readonly tradeId: string;
  readonly walletId: string;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly status: PositionStatus;
  readonly positionVersion: PositionVersion;
  readonly tokenAmountAtomic: bigint;
  readonly initialAmountAtomic: bigint;
  readonly initialPrincipalLamports: bigint;
  readonly confirmedProceedsLamports: bigint;
  readonly reconciliationRequired: boolean;
  readonly capturedAtWallMs: number;
  readonly capturedAtMonoNs: bigint;
}
```

---

## 5. Status de Implementação dos Componentes
- `nexus_positions_v2`: **IMPLEMENTED** (Migration 002 criada e validada em PostgreSQL 16 físico).
- `PostgresPositionRepository`: **IMPLEMENTED** (CAS atômico, transações reais, idempotência de fill).
- `InMemoryPositionRepository`: **IMPLEMENTED** (Espelhamento para suíte unitária de alta velocidade).
- `BigInt Fencing Token & MAX_SAFE_INTEGER`: **IMPLEMENTED** (Provado em testes unitários e de integração).
