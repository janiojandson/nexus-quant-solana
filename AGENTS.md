# AGENTE: Nexus Quant Solana (Agente Soberano Darwinista)
**Módulo:** Nexus Quant Solana
**Versão do Agente:** 1.0.0
**Porta do Serviço:** 3009 (`nexus-quant-solana.railway.internal:3009`)
**Decisor de Sistema 1:** Laya ✅ (`http://nexus-decisor-laya.railway.internal:8080`)
**Carteira Phantom Oficial:** `FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi`

---

## 🎯 1. MISSÃO E ESCOPO

- **Objetivo Primário:** Varredura on-chain contínua 24/7 (DexScreener), auditoria de segurança anti-rug (RugCheck API + Laya Sistema 1) e roteamento de swaps protegidos via Jupiter DEX Aggregator V6.
- **Porta Oficial Estrita:** Porta `3009` (bind `0.0.0.0` com fallback para `process.env.PORT`). Rota `/health` e `/` para probe de vitalidade do Railway.
- **Limites de Contenção:** Proibido invadir portas 3000-3003, 4000, 8000 ou 8080.
- **Zero-Knowledge de Credenciais:** Proibido expor chaves privadas (`AGENT_SOLANA_PRIVATE_KEY`) no console, logs ou GitHub.

---

## 🏗️ 2. ARQUITETURA DE OPERAÇÃO 24/7

```
Loop Contínuo (a cada 30 segundos)
  → ETAPA 1 — VITALIDADE DARWINISTA: Checa saldo SOL na Phantom (FBx2SKLD...). Se < 0.001 SOL, fica em DEAD.
  → ETAPA 2 — SCANNER ON-CHAIN: DexScreener busca pares em tendência na Solana com liquidez > $5.000.
  → ETAPA 3 — TRÍPLICE BARREIRA ANTI-RUG:
      1. Pré-filtro local (0ms): Checa se mintAuthority/freezeAuthority estão ativos e liquidez mínima.
      2. RugCheck API: Score de risco on-chain (< 500 = seguro).
      3. Laya Sistema 1: Confirmação de anomalias sem custo de tokens.
  → ETAPA 4 — EXECUÇÃO JUPITER V6:
      - DRY_RUN=true: Roteia cotação exata e simula trade sem assinar na rede.
      - DRY_RUN=false: Assina e transmite swap com slippage protegido (teto máx 5%).
  → ETAPA 5 — REPRODUÇÃO & SAQUE (50/50):
      Se saldo atingir >= 0.50 SOL, reserva 0.20 SOL, divide 50% de lucro para o Janio e 50% para parir um subagente filho.
  → ETAPA 6 — EVENT STORE POSTGRESQL:
      Grava o resultado da auditoria na tabela `solana_agent_audits` no PostgreSQL Central.
```

---

## 💰 3. REGRA DE OURO DE INFRAESTRUTURA & ECONOMIA (VOLUMES & BANCO)

- **PostgreSQL Central Compartilhado (:5432):**
  - O agente conecta diretamente no PostgreSQL Central do projeto `nexus-multi`:
    `DATABASE_URL=postgresql://postgres:eyxuLapofrztxnKcfhRZVgBAajjfAuUY@postgres.railway.internal:5432/railway`
  - Tabela dedicada: `solana_agent_audits` (histórico de tokens analisados, vetados e trades).
  - **PROIBIDO CRIAR NOVO BANCO DE DADOS**: O compartilhamento do banco principal economiza instâncias e custos no Railway.
- **Política de Volumes (Stateless):**
  - **NÃO PRECISA DE VOLUME NO RAILWAY**: O agente é 100% Stateless no filesystem. Toda a persistência é feita via PostgreSQL e leitura on-chain direta na blockchain Solana. Custo de volume = R$ 0,00.

---

## 🔌 4. TOPOLOGIA DE PORTAS & MALHA PRIVADA RAILWAY

| Serviço | Porta | Domínio Interno Railway | Função |
|---|---|---|---|
| **nexus-quant-solana** | **3009** | `nexus-quant-solana.railway.internal:3009` | Agente Solana 24/7 |
| **nexus-cerebro** | **3000** | `nexus-cerebro.railway.internal:3000` | Orquestrador Central |
| **Mercado Financeiro** | **4000** | `operacional.railway.internal:4000` | MarketFlow Pro / Bybit |
| **Postgres Principal** | **5432** | `postgres.railway.internal:5432` | Banco Central (Auditoria e Posições) |
| **nexus-decisor-laya** | **8080** | `nexus-decisor-laya.railway.internal:8080` | Sentinela Sistema 1 |

---

## 🛡️ 5. REGRAS OBRIGATÓRIAS (NEXUS SAFE-DEV)

1. **SLIPPAGE MÁXIMO:** 500 bps (5%). Qualquer rota com slippage superior é descartada para evitar front-running e sandwich attacks.
2. **ALOCAÇÃO MÁXIMA POR TRADE:** Máximo de 10% do saldo total por operação.
3. **RESERVA DE GÁS INTOCÁVEL:** Nunca alocar mais do que o saldo menos 0.005 SOL para garantir taxa de rede.
