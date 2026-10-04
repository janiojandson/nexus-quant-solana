# NEXUS V2.1A — FILL LEDGER & FINANCIAL ACCOUNTING SPECIFICATION
> **Documento Normativo de Contabilidade de Posições & Livro-Razão**  
> **Status:** ESPECIFICAÇÃO FORMAL VALIDADA  
> **Versão:** 2.1A  
> **Data:** 2026-10-04  

---

## 1. PRINCÍPIOS DE EXATIDÃO FINANCEIRA

O módulo de contabilidade financeira do Nexus obedece a quatro princípios inegociáveis:
1. **Aritmética Rígida em `BigInt`**: Proibição terminante de operações financeiras em ponto flutuante IEEE 754 para contabilidade de saldo. Quantidades de tokens e lamports são manipuladas estritamente em suas menores unidades atômicas (inteiros de até 38 dígitos).
2. **Imutabilidade e Append-Only**: O `fill_ledger` não suporta mutações. Erros ou discrepâncias devem ser compensados por lançamentos de ajuste, nunca por edição ou exclusão retroativa.
3. **Segregação Absoluta de Aluguel (Rent Movement)**: A devolução de SOL oriunda do fechamento de contas de token (Associated Token Accounts - ATA) é uma restituição de depósito de capital operacional, e **jamais lucro de swap**.
4. **Rateio Proporcional de Custo de Entrada**: Em liquidações parciais (ex: Take-Profit de 50%), o custo de aquisição da posição é rateado com precisão proporcional ao volume liquidado.

---

## 2. FÓRMULAS & MATEMÁTICA FORMAL

### 2.1 Custos de Trading & Retorno Líquido
Para cada fill registrado:
$$\text{confirmedTradingCostsLamports} = \text{networkFeeLamports} + \text{priorityFeeLamports} + \text{tipLamports}$$

$$\text{netRecoveredLamports} = \text{grossProceedsLamports} - \text{confirmedTradingCostsLamports}$$

### 2.2 Rateio do Custo de Entrada (Cost Basis Allocation)
Ao liquidar uma fração $\Delta T$ de tokens de uma posição com $T_{\text{inicial}}$ tokens e custo de entrada $C_{\text{inicial}}$:
$$\text{allocatedCostBasisLamports} = \frac{C_{\text{inicial}} \times \Delta T}{T_{\text{inicial}}}$$

### 2.3 PnL Realizado da Tranche (Realized PnL)
$$\text{realizedPnLLamports} = \text{netRecoveredLamports} - \text{allocatedCostBasisLamports}$$

> [!NOTE]
> Observe que $\text{rentMovementLamports}$ está rigorosamente ausente desta equação. O aluguel recuperado é acumulado separadamente em $\text{totalRentMovementLamports}$ e $\text{rentRecoveredLamports}$.

### 2.4 Percentual de Capital Recuperado
$$\text{capitalRecoveredPct} = \frac{\text{netRecoveredLamports} \times 10000}{\text{initialPrincipalLamports}} \div 100$$
(Precisão expressa em 4 casas decimais).

---

## 3. IDENTIDADE CRIPTOGRÁFICA ON-CHAIN DO FILL

Para garantir idempotência completa contra retries de rede e replays de eventos, cada registro no `fill_ledger` possui uma restrição de unicidade composta:
```sql
CONSTRAINT uq_fill_onchain_identity UNIQUE (
    signature,
    chain_leg_index,
    instruction_index,
    inner_instruction_index
)
```
Se a mesma assinatura for reenviada após uma reinicialização de processo, a inserção retorna `{ fill: existing, created: false }`, sem gerar registros redundantes no saldo do trader.
