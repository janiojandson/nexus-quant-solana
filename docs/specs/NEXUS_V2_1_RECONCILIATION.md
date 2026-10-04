# NEXUS V2.1A — EXECUTION ATTEMPT RECONCILIATION PROTOCOL
> **Documento Normativo de Protocolo de Reconciliação**  
> **Status:** ESPECIFICAÇÃO FORMAL VALIDADA  
> **Versão:** 2.1A  
> **Data:** 2026-10-04  

---

## 1. O PRINCÍPIO FUNDAMENTAL DA ASSINCRONIA BLOCKCHAIN

A pesquisa arquitetural do Nexus estabelece um axioma inviolável:
> **O Fencing Epoch protege o BANCO DE DADOS PostgreSQL. Ele NÃO protege a blockchain Solana.**

Quando um worker no Nexus:
1. Adquire o lease (ex: `claim_epoch = 10`);
2. Assina localmente a transação (`SIGNED`);
3. Despacha a transação para a rede (`SUBMITTED`);

A transação encontra-se nos pipelines de líderes da Solana. Se o processo do worker morrer, travar em GC, perder a conexão HTTP ou sofrer timeout, **o lease no PostgreSQL expirará temporalmente**.

Se um worker B assumir o lease (`claim_epoch = 11`), **a transação submetida pelo worker A continua viva e perfeitamente válida na blockchain**.

Portanto:
$$\text{LEASE EXPIRATION NÃO AUTORIZA NOVO ENVIO.}$$

Qualquer tentativa de despachar uma segunda ordem sem comprovação definitiva de que a primeira transação está morta causará **dupla venda, perda de capital ou rejeição por insuficiência de saldo**.

---

## 2. DÍVIDA DE RECONCILIAÇÃO (`reconciliationDebt`)

Para formalizar esse bloqueio no modelo relacional, o Nexus introduz o conceito de **Dívida de Reconciliação**:
- Sempre que uma tentativa alcança `SIGNED`, `SUBMITTED`, `SENT` ou `UNKNOWN`, o campo `reconciliation_debt` da intent é setado para `TRUE`.
- Enquanto `reconciliation_debt = true`:
  1. A posição permanece **estritamente reservada**;
  2. Nenhuma ordem concorrente pode ser criada para a carteira e o mint (`ActiveIntentExclusionError`);
  3. O executor legado está impedido de tocar no saldo;
  4. Qualquer tentativa de re-claim cego por expiração de lease é rejeitada com `LeaseRecoveryBlockedError` (`MUST_RECONCILE`);
  5. Após um restart ou crash, o sistema **deve auditar e liquidar a dívida de reconciliação** antes de autorizar qualquer operação nessa exposição.

---

## 3. TABELA-VERDADE DA FUNÇÃO PURA DE RECONCILIAÇÃO

A função `evaluateReconciliationState(attempt, evidence)` mapeia deterministamente os fatos observados on-chain para os vereditos formais:

| Estado da Tentativa | Assinatura Encontrada On-Chain | Erro On-Chain (`err`) | Validade do Blockhash | Veredito Formal | `canRetry` | `isTerminal` | `onChainStatus` |
|---|---|---|---|---|---|---|---|
| `INITIALIZED` / `ORDER_READY` | Indiferente | Indiferente | Indiferente | **`CAN_RETRY`** | **True** | **False** | `DROPPED` |
| `SIGNED` | Não fornecida | - | Desconhecida | **`MUST_RECONCILE`** | **False** | **False** | `PENDING` |
| `SUBMITTED` | **True** | **`null`** (sucesso) | - | **`CONFIRMED`** | **False** | **True** | `CONFIRMED` |
| `SUBMITTED` | **True** | **Presente** (reversão) | - | **`FAILED_DEFINITIVE`** | **True** | **True** | `FAILED` |
| `SUBMITTED` | **False** | - | **Expirado (`expired: true`)** | **`FAILED_DEFINITIVE`** | **True** | **True** | `DROPPED` |
| `SUBMITTED` | **False** | - | **Válido (`valid: true`)** | **`MUST_RECONCILE`** | **False** | **False** | `PENDING` |
| `SUBMITTED` / `UNKNOWN` | Inconclusiva | - | Timeout HTTP / RPC Error | **`UNKNOWN`** | **False** | **False** | `UNKNOWN` |

---

## 4. REGRA DE OURO: `UNKNOWN !== FAILED_DEFINITIVE`

A auditoria dos incidentes históricos do Nexus (especialmente o caso **SUPERPIG**) revelou que a principal causa de divergência financeira foi tratar timeouts HTTP ou desconexões RPC como ordens que falharam.

No Nexus:
1. `UNKNOWN` significa: **"Não possuo evidência on-chain para provar se a ordem passou ou não."**
2. `FAILED_DEFINITIVE` significa: **"Possuo evidência criptográfica conclusiva de que a ordem não teve nem terá efeito financeiro."**
3. Em caso de `UNKNOWN`, o sistema mantém o lock e entra em modo passivo até a resolução conclusiva da dívida.
