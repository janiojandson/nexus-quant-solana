# Plano de Implementação: Funil Ayla Zero-Cost (4 Camadas) & OCO Local Sniper

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reestruturar a ingestão de tokens e a gestão de saída do `nexus-quant-solana`, eliminando endpoints promocionais de pump (< 5 min), filtrando maturidade de 15 a 60 minutos com liquidez $\ge \$20.000$, introduzindo L1 TTL Cache de 5 min contra repetição de I/O, calibrando o PositionExitEngine para SL -8%, Breakeven +12%, Parcial +35%, Trailing -10%, e ajustando a mão por trade para 0.05 SOL.

**Architecture:** A arquitetura em 4 camadas desacopla a triagem on-chain (GeckoTerminal `/new_pools` + DexScreener search) da validação de risco (RugCheck + Laya Sistema 1), do motor decisório Ayla (+EV order flow) e da execução no cliente (Jupiter V6 com monitor de saída ultra-rápido de 1.5s e devolução de rent de ATA).

**Tech Stack:** TypeScript (ESM), Node.js, Axios, `@solana/web3.js`, Jupiter Aggregator API V6, Native Node Test Runner (`tsx --test`).

**Spec:** Baseado no diagnóstico dos logs de deploy e no parecer técnico aprovado pelo sócio em 2026-09-28.

## Global Constraints

- **Preservação de Saldo & Gás:** Nunca alocar mais que o saldo disponível menos 0.05 SOL de reserva intocável na carteira Phantom `FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi`.
- **Custo Zero de Tokens/APIs:** Usar exclusivamente endpoints públicos da GeckoTerminal, DexScreener, RugCheck e o disjuntor interno Laya/Sentinel.
- **Porta e Infraestrutura:** Manter porta oficial 3009 e banco PostgreSQL compartilhado sem criação de volumes.
- **Protocolo Safe-Dev:** Edições cirúrgicas; manter compatibilidade com os 57 testes existentes.

---

### Task 1: Script de Diagnóstico e Simulação Local (`scripts/test-ayla-pipeline.ts`)

**Files:**
- Create: `d:/Programas/Desenvolvendo/nexus-quant-solana/scripts/test-ayla-pipeline.ts`

**Interfaces:**
- Consumes: GeckoTerminal Public API `/networks/solana/new_pools`
- Produces: CLI output com contagem de piscinas, aprovados em idade (15-60m), liquidez (>= $20k) e dominância compradora (+EV Ayla). Extrai tanto o pool address quanto o base token mint (`solana_<mint>`).

- [ ] **Step 1: Criar o script isolado de teste de funil**

Criar `scripts/test-ayla-pipeline.ts` com suporte a headers realistas (`User-Agent`, `Accept`), extração de mint (`pool.relationships?.base_token?.data?.id`), filtros de maturidade 15-60m, liquidez >= $20.000 e cálculo de dominância compradora m5:

```typescript
import axios from 'axios';

interface PoolData {
  id: string;
  type: string;
  attributes: {
    address: string;
    name: string;
    pool_created_at: string;
    base_token_price_usd: string;
    reserve_in_usd: string;
    volume_usd: { h1?: string; m5?: string; h24?: string };
    transactions?: {
      m5?: { buys: number; sells: number };
      h1?: { buys: number; sells: number };
    };
  };
  relationships?: {
    base_token?: {
      data?: { id: string; type: string };
    };
  };
}

export async function simularFunilAyla(): Promise<{
  totalPools: number;
  aprovadosIdade: number;
  aprovadosLiquidez: number;
  aprovadosAyla: number;
}> {
  console.log('🔍 [TEST HARNESS] Iniciando auditoria do funil da Ayla em tempo real...');

  const response = await axios.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    },
    timeout: 10000
  });

  const pools: PoolData[] = response.data?.data || [];
  console.log(`📦 Piscinas recebidas: ${pools.length}`);

  const agora = Date.now();
  let aprovadosIdade = 0;
  let aprovadosLiquidez = 0;
  let aprovadosAyla = 0;

  for (const pool of pools) {
    const rawMint = pool.relationships?.base_token?.data?.id || '';
    const mint = rawMint.replace(/^solana_/, '');
    const createdAt = new Date(pool.attributes.pool_created_at).getTime();
    const idadeMinutos = (agora - createdAt) / (1000 * 60);
    const liquidez = parseFloat(pool.attributes.reserve_in_usd || '0');
    const buysM5 = pool.attributes.transactions?.m5?.buys || 0;
    const sellsM5 = pool.attributes.transactions?.m5?.sells || 0;
    const totalTradesM5 = buysM5 + sellsM5;

    // Filtro 1: Janela de Maturação (15 a 60 min)
    if (idadeMinutos < 15 || idadeMinutos > 60) continue;
    aprovadosIdade++;

    // Filtro 2: Liquidez Mínima ($20.000)
    if (liquidez < 20000) continue;
    aprovadosLiquidez++;

    // Filtro 3: Dominância Compradora da Ayla (Buys >= 65% e buys >= sells * 1.5)
    const pressaoCompradora = totalTradesM5 > 0 ? (buysM5 / totalTradesM5) * 100 : 0;
    const sinalAyla = pressaoCompradora >= 65 && buysM5 >= sellsM5 * 1.5;

    console.log(`\n🎯 Candidato: ${pool.attributes.name}`);
    console.log(`   - Pool AMM: ${pool.attributes.address}`);
    console.log(`   - Token Mint: ${mint || 'N/A'}`);
    console.log(`   - Idade: ${idadeMinutos.toFixed(1)} min`);
    console.log(`   - Liquidez: $${liquidez.toLocaleString()}`);
    console.log(`   - Trades 5m: ${buysM5} compras / ${sellsM5} vendas (${pressaoCompradora.toFixed(1)}% dominância)`);
    console.log(`   - Status Ayla (+EV): ${sinalAyla ? '✅ APROVADO' : '❌ VETADO'}`);

    if (sinalAyla) aprovadosAyla++;
  }

  console.log('\n================ RESUMO DO DIAGNÓSTICO ================');
  console.log(`Recebidas:            ${pools.length}`);
  console.log(`Na janela (15-60 min): ${aprovadosIdade}`);
  console.log(`Com liquidez > $20k:   ${aprovadosLiquidez}`);
  console.log(`Elegíveis para Ayla:    ${aprovadosAyla}`);
  console.log('=======================================================');

  return { totalPools: pools.length, aprovadosIdade, aprovadosLiquidez, aprovadosAyla };
}

if (process.argv[1]?.includes('test-ayla-pipeline')) {
  simularFunilAyla().catch((err) => {
    console.error('❌ Erro no teste de pipeline:', err.message);
  });
}
```

- [ ] **Step 2: Executar o script de teste**

Rodar: `npx tsx scripts/test-ayla-pipeline.ts`
Esperado: Conexão bem-sucedida, sem falhas de sintaxe e listagem formatada dos candidatos da rede Solana.

---

### Task 2: Implementar TTL Cooldown Cache no Scanner

**Files:**
- Create: `d:/Programas/Desenvolvendo/nexus-quant-solana/src/scanner/mintCooldownCache.ts`
- Create: `d:/Programas/Desenvolvendo/nexus-quant-solana/src/scanner/mintCooldownCache.test.ts`
- Modify: `d:/Programas/Desenvolvendo/nexus-quant-solana/src/scanner/dexScreenerScanner.ts`

**Interfaces:**
- Produces: `MintCooldownCache` com métodos `shouldProcess(mint: string): boolean`, `recordRejection(mint: string): void`, `clear(): void`, `size(): number`.

- [ ] **Step 1: Escrever teste de unidade que falha para `MintCooldownCache`**

Criar `src/scanner/mintCooldownCache.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { MintCooldownCache } from './mintCooldownCache.js';

describe('MintCooldownCache - L1 Cache Anti-Redundância', () => {
  test('deve permitir processar novo mint e bloquear reprocessamento após rejeição', () => {
    const cache = new MintCooldownCache(5); // 5 minutos TTL
    const mint = 'So11111111111111111111111111111111111111112';

    assert.strictEqual(cache.shouldProcess(mint), true);
    cache.recordRejection(mint);
    assert.strictEqual(cache.shouldProcess(mint), false, 'Deve bloquear reprocessamento dentro do TTL');
  });

  test('deve expirar e liberar mint após TTL', () => {
    const cache = new MintCooldownCache(0.001); // ~60ms TTL
    const mint = 'TokenExpiravel1111111111111111111111111111';

    cache.recordRejection(mint);
    assert.strictEqual(cache.shouldProcess(mint), false);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.strictEqual(cache.shouldProcess(mint), true, 'Deve liberar após expiração');
        resolve();
      }, 100);
    });
  });
});
```

- [ ] **Step 2: Executar teste para verificar falha**

Rodar: `npx tsx --test src/scanner/mintCooldownCache.test.ts`
Esperado: FAIL com `Cannot find module './mintCooldownCache.js'`.

- [ ] **Step 3: Implementar `MintCooldownCache`**

Criar `src/scanner/mintCooldownCache.ts`:
```typescript
export class MintCooldownCache {
  private cache = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMinutes: number = 5) {
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  public shouldProcess(mint: string): boolean {
    if (!mint) return false;
    const now = Date.now();
    const expiry = this.cache.get(mint);

    if (expiry && now < expiry) {
      return false; // Dentro da quarentena TTL
    }

    if (expiry && now >= expiry) {
      this.cache.delete(mint);
    }
    return true;
  }

  public recordRejection(mint: string, customTtlMs?: number): void {
    if (!mint) return;
    const now = Date.now();
    this.cache.set(mint, now + (customTtlMs || this.ttlMs));
    this.cleanExpired(now);
  }

  public size(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
  }

  private cleanExpired(now: number): void {
    if (this.cache.size > 500) {
      for (const [mint, exp] of this.cache.entries()) {
        if (now >= exp) this.cache.delete(mint);
      }
    }
  }
}
```

- [ ] **Step 4: Executar testes de unidade e verificar aprovação**

Rodar: `npx tsx --test src/scanner/mintCooldownCache.test.ts`
Esperado: PASS (2/2 testes passando).

---

### Task 3: Reorientação do Scanner e Desativação de Boosts Promocionais

**Files:**
- Modify: `d:/Programas/Desenvolvendo/nexus-quant-solana/src/scanner/dexScreenerScanner.ts`
- Modify: `d:/Programas/Desenvolvendo/nexus-quant-solana/src/scanner/dexScreenerScanner.test.ts`

**Interfaces:**
- `DexScreenerScanner.scanSolanaTrends(minLiquidityUsd: number = 20000): Promise<TokenCandidate[]>`
- Desativa chamadas a `token-profiles/latest` e `token-boosts/*`.
- Ativa consumo de GeckoTerminal `new_pools` + DexScreener `dex/search?q=solana`.
- Janela de maturidade calibrada para $15 \le \text{Idade} \le 60\text{ min}$ (tokens jovens pós-exaustão).
- Integração com `MintCooldownCache` para armazenar rejeitados por liquidez e idade.

- [ ] **Step 1: Atualizar testes em `dexScreenerScanner.test.ts`**

Ajustar expectativas de maturidade e liquidez no teste unitário para validar a janela estrita de 15 a 60 min e rejeição com cache:

```typescript
// Em src/scanner/dexScreenerScanner.test.ts:
// Garantir que token com 14 min é rejeitado e token com 25 min é aceito
// Garantir que liquidez padrão mínima seja de $20.000
```

- [ ] **Step 2: Atualizar `dexScreenerScanner.ts` com a nova fonte de ingestão**

1. Importar `MintCooldownCache`.
2. Adicionar instância `cooldownCache = new MintCooldownCache(5)`.
3. Em `scanSolanaTrends`:
   - Remover as requisições `TOKEN_PROFILES_URL`, `TOKEN_BOOSTS_LATEST_URL`, `TOKEN_BOOSTS_TOP_URL`.
   - Adicionar busca filtrada na DexScreener: `https://api.dexscreener.com/latest/dex/search?q=solana`.
   - Manter GeckoTerminal `GECKOTERMINAL_POOLS_URL` respeitando espaçamento.
   - Filtrar antes de enrich: se `!this.cooldownCache.shouldProcess(mint)`, pula.
   - Ajustar `isMaturityValid(pairCreatedAt, now)` para:
     ```typescript
     public isMaturityValid(pairCreatedAtMs: number, nowMs: number = Date.now()): boolean {
       const ageMinutes = (nowMs - pairCreatedAtMs) / (60 * 1000);
       return ageMinutes >= 15 && ageMinutes <= 60;
     }
     ```
   - Quando um token for descartado por idade ou liquidez < minLiquidityUsd ($20k), chamar `this.cooldownCache.recordRejection(mint)`.

- [ ] **Step 3: Executar testes de unidade do scanner**

Rodar: `npx tsx --test src/scanner/dexScreenerScanner.test.ts`
Esperado: PASS.

---

### Task 4: Calibração de Saída e Proteção em `PositionExitEngine`

**Files:**
- Modify: `d:/Programas/Desenvolvendo/nexus-quant-solana/src/execution/positionExitEngine.ts`
- Modify: `d:/Programas/Desenvolvendo/nexus-quant-solana/src/execution/positionExitEngine.test.ts` (ou testes existentes)

**Interfaces:**
- `DEFAULT_STOP_LOSS_PCT = -0.08` (-8%)
- `BREAKEVEN_TRIGGER_PCT = 0.12` (+12% de lucro move SL para +0.01 / +1%)
- `DEFAULT_TAKE_PROFIT_PCT = 0.35` (+35% para parcial de 50%)
- `TRAILING_DISTANCE = 0.10` (-10% de recuo em relação à máxima atingida)
- `shouldCloseAta = true` na saída total para resgatar ~0.00204 SOL de aluguel.

- [ ] **Step 1: Atualizar testes de unidade de saída**

Ajustar os testes para validar os novos patamares:
- -8% dispara `STOP_LOSS`.
- +12% ativa Breakeven (+1%).
- +35% dispara `PARTIAL_TAKE_PROFIT_50`.
- Recuo de 10% do topo pós-parcial dispara `TRAILING_STOP`.

- [ ] **Step 2: Aplicar as constantes no `PositionExitEngine`**

Atualizar as constantes e a lógica de verificação em `src/execution/positionExitEngine.ts`:
```typescript
public static readonly DEFAULT_STOP_LOSS_PCT = -0.08; // -8% Stop Loss Inicial
public static readonly BREAKEVEN_TRIGGER_PCT = 0.12;  // +12% ativa Breakeven (+1%)
public static readonly DEFAULT_TAKE_PROFIT_PCT = 0.35; // +35% Parcial de 50%
public static readonly TRAILING_DISTANCE = 0.10;       // -10% do Pico
```

- [ ] **Step 3: Executar a suíte de testes de saída**

Rodar: `npx tsx --test src/execution/positionExitEngine.test.ts`
Esperado: PASS.

---

### Task 5: Dimensionamento de Lote (Position Sizing) em `src/index.ts`

**Files:**
- Modify: `d:/Programas/Desenvolvendo/nexus-quant-solana/src/index.ts`

**Interfaces:**
- Mão por trade ajustada para `0.05 SOL` (respeitando banca de ~0.29 SOL e reserva intocável de 0.05 SOL).
- Máximo de 1 posição simultânea ativa (`MAX_CONCURRENT_POSITIONS = 1`).
- Liquidez mínima configurada para `$20.000`.

- [ ] **Step 1: Ajustar parâmetros operacionais em `src/index.ts`**

1. Definir `const TRADE_ALLOCATION_SOL = 0.05;`.
2. Na chamada de compra `jupiterEngine.executeSwap(...)`, garantir que o valor de entrada seja `0.05 SOL`.
3. Na varredura do scanner, passar `scanner.scanSolanaTrends(20000)`.

- [ ] **Step 2: Executar suíte completa de testes de regressão**

Rodar: `npm test`
Esperado: 100% de testes passando sem regressão.

---

### Task 6: Validação Final e Relatório de Auditoria

- [ ] **Step 1: Rodar o script de diagnóstico do funil contra a mainnet real**

Rodar: `npx tsx scripts/test-ayla-pipeline.ts`
Confirmar que piscinas com idade de 15 a 60 min e liquidez > $20k são devidamente identificadas e classificadas.

- [ ] **Step 2: Verificar integridade do build TypeScript**

Rodar: `npx tsc --noEmit`
Esperado: Exit code 0, sem erros de compilação.
