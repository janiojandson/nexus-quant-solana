# Especificação Técnica de Arquitetura: Nexus Quant Solana (Painel Web & Dual-Stage Trailing Stop)

**Data:** 2026-09-27  
**Status:** Aprovado para Implementação  
**Escopo:** Refatoração Completa da Interface Web, Sentinela RugCheck, Scanner de Agressão On-Chain e Motor Dual-Stage Trailing Stop com Rent-Exemption Close Account.

---

## 1. Visão Geral do Sistema
O **Nexus Quant Solana** é um agente autônomo de alta performance para operação em memecoins e tokens SPL na rede Solana. O sistema opera em arquitetura modular sob modelo de vitalidade darwinista, integrando auditoria on-chain, análise de liquidez e agressão de fluxo, execução Jupiter V6 com priority fee dedicada e painel web interativo para monitoramento e controle direto de custódia.

---

## 2. Componentes da Arquitetura

### 2.1 Painel Web & API REST (`public/` + `src/server/routes.ts`)
- **Arquitetura:** Servidor HTTP desacoplado com rotas REST e interface frontend em Vanilla HTML5/CSS3/JavaScript (Dark Mode Institucional).
- **Rotas de API:**
  - `GET /api/status`: Retorna saldo SOL, posições ativas, histórico de trades fechados, quarentena e logs de auditoria.
  - `GET /api/holdings`: Realiza varredura das Contas Token Associadas (ATAs) com saldo $> 0$ custodiadas na carteira Phantom.
  - `POST /api/emergency-exit`: Dispara ordem de venda imediata a mercado para uma posição sob gestão do robô.
  - `POST /api/liquidate-token`: Permite liquidar **qualquer token SPL custodiado na Phantom** diretamente para SOL a partir de comando no painel.

### 2.2 Sentinela Anti-Golpe (`src/risk/rugCheckService.ts` & `memeRiskGatekeeper.ts`)
- **Integração RugCheck API (`https://api.rugcheck.xyz/v1/tokens/{mint}/report`):**
  - Exige `mint_authority == null` (sem emissão infinita) e `freeze_authority == null` (sem trava de conta).
  - Exige LP Burned / Locked $\ge 90\%$ (mínimo de 6 meses de bloqueio de liquidez).
  - Exige Top 5 Holders com detenção conjunta $< 20\%$ do *supply* total.

### 2.3 Scanner On-Chain & Agressão de Fluxo (`src/scanner/dexScreenerScanner.ts`)
- **Filtros Mandatórios de Elegibilidade:**
  - **Maturidade da Pool:** Idade entre **20 minutos e 4 horas** (tokens $< 20\text{ min}$ são sumariamente descartados).
  - **Liquidez Mínima Comprovada:** Liquidez em pool $\ge \$15.000\text{ USD}$.
  - **Volume Mínimo:** Volume $\ge \$10.000\text{ USD}$ com pelo menos 50 transações únicas.
  - **Ratio de Agressão Compra/Venda:** Análise de fluxo das últimas 100 transações on-chain exigindo $\ge 70\%$ de volume comprador.
- **Teto de Concorrência (Modo Sniper):** `MAX_CONCURRENT_POSITIONS = 1`. Se houver 1 posição aberta em custódia ou gestão, a busca por novas entradas entra em pausa absoluta.

### 2.4 Motor Dual-Stage Trailing Stop & Gestão de Posições (`src/execution/positionExitEngine.ts`)
- **Frequência de Monitoramento:** Loop dedicado a cada **1.500 ms** via cotações diretas da Jupiter V6 e RPC Helius/QuickNode.
- **Fase 0 (Entrada e Risco Fixo):**
  - **Stop-Loss Inicial:** $-20\%$ fixo em relação ao valor de entrada.
  - **Time-Stop de Estagnação:** 15 minutos (se nem o TP parcial nem o SL forem atingidos em 15 minutos, encerra a mercado).
- **Fase 1 (Colheita Parcial / Free-Ride):**
  - **Gatilho Parcial:** $+100\%$ ($2\times$ / dobrar capital).
  - **Ação:** Vende **50% do lote** a mercado. Move o Stop-Loss dos 50% restantes para **Breakeven** ($0\%$ de perda / preço de entrada).
- **Fase 2 (Super Runner & Trailing Stop 15%):**
  - O Stop-Loss mexe-se dinamicamente acompanhando o topo máximo atingido pós-parcial ($P_{\text{máx}}$):
    $$\text{Stop Loss} = \max(\text{Preço Entrada}, P_{\text{máx}} \times 0.85)$$
  - Encerra os 50% restantes se o preço recuar $15\%$ do topo máximo.

### 2.5 Higiene On-Chain & Devolução de Caução (`src/blockchain/solanaWallet.ts`)
- **Encerramento de Conta Token (ATA Close):** Em **todas** as liquidações (venda dos 50% finais, Stop-Loss, Time-Stop ou Venda Manual via Web), o robô emite compulsoriamente a instrução `createCloseAccountInstruction`, encerrando a ATA e devolvendo os **~0.00204 SOL de caução (Rent Exemption)** para o saldo livre da Phantom.

### 2.6 Parâmetros de Execução & Latência On-Chain (`src/blockchain/jupiterExecutionEngine.ts`)
- **Slippage de Compra:** 400 bps (4.0%).
- **Slippage de Saída / Stop:** 500 bps (5.0%) com `priorityLevel: 'high'`.

---

## 3. Matriz de Requisitos e Testes
1. `rugCheckService.test.ts`: Validar rejeição de `mint_authority` ativo e concentração de holders $> 20\%$.
2. `dexScreenerScanner.test.ts`: Validar descarte de pools com idade $< 20\text{ min}$ e liquidez $< \$15.000\text{ USD}$.
3. `positionExitEngine.test.ts`: Testar gatilho parcial de 50% em $+100\%$, Stop-Loss inicial em $-20\%$, Time-Stop de 15 min e Trailing Stop de 15% do topo.
4. `solanaWallet.test.ts`: Verificar emissão de instrução de fechamento de ATA e cálculo de Rent Exemption.
