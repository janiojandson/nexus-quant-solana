import test from 'node:test';
import assert from 'node:assert';
import { DexScreenerScanner, TokenCandidate } from './dexScreenerScanner.js';

test('DexScreenerScanner: deve filtrar e retornar tokens com liquidez acima do mínimo exigido', async () => {
  const mockFetch = async () => ({
    data: [
      {
        chainId: 'solana',
        dexId: 'raydium',
        baseToken: { address: 'MintTokenBom11111111111111111111111111111111', symbol: 'BOM', name: 'Token Bom' },
        priceUsd: '0.015',
        liquidity: { usd: 25000 },
        volume: { h24: 150000, m5: 3500 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000)
      },
      {
        chainId: 'solana',
        dexId: 'raydium',
        baseToken: { address: 'MintTokenRuim2222222222222222222222222222222', symbol: 'RUIM', name: 'Token Sem Liquidez' },
        priceUsd: '0.0001',
        liquidity: { usd: 1200 }, // Abaixo de $10.000
        volume: { h24: 5000, m5: 100 },
        pairCreatedAt: Date.now() - 1800000
      }
    ]
  });

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  const results: TokenCandidate[] = await scanner.scanSolanaTrends(10000);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].symbol, 'BOM');
  assert.strictEqual(results[0].liquidityUsd, 25000);
  assert.strictEqual(results[0].volume5mUsd, 3500);
  assert.strictEqual(results[0].mint, 'MintTokenBom11111111111111111111111111111111');
});

test('DexScreenerScanner: deve rejeitar armadilhas de 1 minuto e aceitar apenas maturidade na janela de 5 a 60 min', async () => {
  const mockFetch = async () => ({
    data: [
      {
        chainId: 'solana',
        baseToken: { address: 'MintTokenNovo1m', symbol: 'NEW1M', name: 'Token de 1 minuto' },
        priceUsd: '0.001',
        liquidity: { usd: 30000 },
        volume: { h24: 10000 },
        pairCreatedAt: Date.now() - (60 * 1000) // Criado há 1 minuto (armadilha)
      },
      {
        chainId: 'solana',
        baseToken: { address: 'MintTokenMaduro', symbol: 'MATURE', name: 'Token Maduro' },
        priceUsd: '0.005',
        liquidity: { usd: 30000 },
        volume: { h24: 50000 },
        pairCreatedAt: Date.now() - (35 * 60 * 1000) // Criado há 35 minutos (sobrevivente)
      }
    ]
  });

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  const results = await scanner.scanSolanaTrends(15000);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].symbol, 'MATURE');
  assert.strictEqual(results[0].mint, 'MintTokenMaduro');
});

test('DexScreenerScanner: deve sanitizar e descartar tokens com mint vazio ou symbol undefined', async () => {
  const mockFetch = async () => ({
    data: [
      {
        chainId: 'solana',
        baseToken: { address: '', symbol: 'VALID_SYM' },
        liquidity: { usd: 20000 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000)
      },
      {
        chainId: 'solana',
        baseToken: { address: 'ValidMintAddress111', symbol: 'undefined' },
        liquidity: { usd: 20000 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000)
      },
      {
        chainId: 'solana',
        baseToken: { address: 'ValidMintAddress222', symbol: undefined },
        liquidity: { usd: 20000 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000)
      },
      {
        chainId: 'solana',
        baseToken: { address: 'ValidMintAddress333', symbol: 'CORRECT' },
        liquidity: { usd: 20000 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000)
      }
    ]
  });

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  const results = await scanner.scanSolanaTrends(15000);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].symbol, 'CORRECT');
  assert.strictEqual(results[0].mint, 'ValidMintAddress333');
});

test('DexScreenerScanner: deve descartar tokens mais velhos que 60 minutos e mais novos que 5 minutos', () => {
  const scanner = new DexScreenerScanner();
  const now = Date.now();
  assert.strictEqual(scanner.isMaturityValid(now - (90 * 60 * 1000), now), false, '90 min deve ser descartado (> 60m)');
  assert.strictEqual(scanner.isMaturityValid(now - (2 * 60 * 1000), now), false, '2 min deve ser descartado (< 5m)');
  assert.strictEqual(scanner.isMaturityValid(now - (5 * 60 * 1000), now), true, '5 min deve ser aceito');
  assert.strictEqual(scanner.isMaturityValid(now - (8 * 60 * 1000), now), true, '8 min deve ser aceito');
  assert.strictEqual(scanner.isMaturityValid(now - (10 * 60 * 1000), now), true, '10 min deve ser aceito');
  assert.strictEqual(scanner.isMaturityValid(now - (35 * 60 * 1000), now), true, '35 min deve ser aceito');
  assert.strictEqual(scanner.isMaturityValid(now - (60 * 60 * 1000), now), true, '60 min deve ser aceito');
});

test('DexScreenerScanner: deve calcular ratio de agressão compradora e exigir >= 50%', () => {
  const scanner = new DexScreenerScanner();
  assert.strictEqual(scanner.isBuyingAggressionValid(75, 25), true);
  assert.strictEqual(scanner.isBuyingAggressionValid(60, 40), true);
  assert.strictEqual(scanner.isBuyingAggressionValid(40, 60), false);
});

test('DexScreenerScanner: deve rejeitar moedas em queda nos 5m e fora da janela de +3% a +85%', async () => {
  const mockFetch = async () => ({
    data: [
      {
        chainId: 'solana',
        baseToken: { address: 'MintQueda', symbol: 'QUEDA' },
        liquidity: { usd: 25000 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000),
        priceChange: { m5: -2.5 }, // Em queda
        txns: { m5: { buys: 10, sells: 5 } }
      },
      {
        chainId: 'solana',
        baseToken: { address: 'MintEsticado', symbol: 'ESTICK' },
        liquidity: { usd: 25000 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000),
        priceChange: { m5: 95.0 }, // Excessivamente esticado (> +85%)
        txns: { m5: { buys: 20, sells: 5 } }
      },
      {
        chainId: 'solana',
        baseToken: { address: 'MintVendedoresDominando', symbol: 'SELLDOG' },
        liquidity: { usd: 25000 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000),
        priceChange: { m5: 12.0 },
        txns: { m5: { buys: 5, sells: 10 } } // Vendas superam compras
      },
      {
        chainId: 'solana',
        baseToken: { address: 'MintPerfeito', symbol: 'PERFECT' },
        liquidity: { usd: 25000 },
        pairCreatedAt: Date.now() - (30 * 60 * 1000),
        priceChange: { m5: 15.0 }, // +15% (dentro de +3% a +85%)
        txns: { m5: { buys: 25, sells: 8 } } // Compras superam vendas
      }
    ]
  });

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  const results = await scanner.scanSolanaTrends(15000);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].symbol, 'PERFECT');
  assert.strictEqual(results[0].mint, 'MintPerfeito');
  assert.strictEqual(results[0].priceChangeM5, 15.0);
  assert.strictEqual(results[0].buysM5, 25);
  assert.strictEqual(results[0].sellsM5, 8);
});

test('DexScreenerScanner: deve incubar tokens recém-nascidos da GeckoTerminal e contabilizar descarte técnico pós-maturação', async () => {
  const now = Date.now();
  const mockFetch = async (url: string) => {
    if (url.includes('geckoterminal.com')) {
      return {
        data: {
          data: [
            {
              id: 'pool_recem_nascido',
              attributes: {
                address: 'PoolAddress123',
                name: 'INFANT / SOL',
                pool_created_at: new Date(now - 2 * 60 * 1000).toISOString(), // 2 min (recém-nascido)
                reserve_in_usd: '15000',
                base_token_price_usd: '0.001'
              },
              relationships: {
                base_token: { data: { id: 'solana_MintInfant123' } }
              }
            }
          ]
        }
      };
    }
    return { data: { pairs: [] } };
  };

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  await scanner.scanSolanaTrends(20000);

  // Deve ter inserido na incubadora e NÃO no cooldownCache
  assert.strictEqual(scanner.incubator.getWaitingCount(), 1);
  assert.strictEqual(scanner.cooldownCache.shouldProcess('MintInfant123'), true, 'Infant token não deve ser blacklisted no cooldown');
  assert.strictEqual(scanner.lastIncubatorStats.waiting, 1);
});


test('DexScreenerScanner: deve consumir mint maduro da incubadora uma única vez', async () => {
  const now = Date.now();
  let enrichmentCalls = 0;
  const mockFetch = async (url: string) => {
    if (url.includes('geckoterminal.com')) {
      return { data: { data: [] } };
    }
    if (url.includes('/latest/dex/tokens/MintReleasedOnce')) {
      enrichmentCalls++;
      return {
        data: {
          pairs: [{
            chainId: 'solana',
            dexId: 'raydium',
            baseToken: { address: 'MintReleasedOnce', symbol: 'RELEASED', name: 'Released Once' },
            priceUsd: '0.01',
            liquidity: { usd: 30000 },
            volume: { h24: 50000, m5: 2500 },
            pairCreatedAt: now - (8 * 60 * 1000)
          }]
        }
      };
    }
    return { data: { pairs: [] } };
  };

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  scanner.incubator.add({
    mint: 'MintReleasedOnce',
    poolAddress: 'PoolReleasedOnce',
    symbol: 'RELEASED',
    pairCreatedAt: now - (8 * 60 * 1000)
  }, now);

  const first = await scanner.scanSolanaTrends(15000);
  assert.strictEqual(first.some(token => token.mint === 'MintReleasedOnce'), true);
  assert.strictEqual(scanner.incubator.size(), 0, 'mint maduro deve sair da fila depois de liberado');

  await scanner.scanSolanaTrends(15000);
  assert.strictEqual(enrichmentCalls, 1, 'mint já liberado não deve ocupar novamente o lote de enriquecimento');
});


test('DexScreenerScanner: snapshot de saída deve trazer liquidez/volume atuais do par base mais líquido', async () => {
  const mint = 'MintSnapshotTesla';
  const mockFetch = async () => ({
    data: {
      pairs: [
        {
          chainId: 'solana',
          dexId: 'pumpfun',
          pairAddress: 'PoolBaseMenor',
          baseToken: { address: mint, symbol: 'TESLA' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
          priceUsd: '0.001',
          liquidity: { usd: 12000 },
          volume: { m5: 900 },
          txns: { m5: { buys: 10, sells: 8 } }
        },
        {
          chainId: 'solana',
          dexId: 'pumpfun',
          pairAddress: 'PoolBaseMaior',
          baseToken: { address: mint, symbol: 'TESLA' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
          priceUsd: '0.0011',
          liquidity: { usd: 42000 },
          volume: { m5: 3500 },
          txns: { m5: { buys: 33, sells: 11 } }
        },
        {
          chainId: 'solana',
          dexId: 'other',
          pairAddress: 'PoolOndeMintEhQuote',
          baseToken: { address: 'OutroMint', symbol: 'OUTRO' },
          quoteToken: { address: mint, symbol: 'TESLA' },
          priceUsd: '999',
          liquidity: { usd: 999999 }
        }
      ]
    }
  });

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  const snapshot = await scanner.fetchCurrentTokenMarketSnapshot(mint);

  assert.ok(snapshot);
  assert.strictEqual(snapshot?.symbol, 'TESLA');
  assert.strictEqual(snapshot?.priceUsd, 0.0011);
  assert.strictEqual(snapshot?.liquidityUsd, 42000);
  assert.strictEqual(snapshot?.volume5mUsd, 3500);
  assert.strictEqual(snapshot?.buysM5, 33);
  assert.strictEqual(snapshot?.sellsM5, 11);
  assert.strictEqual(snapshot?.pairAddress, 'PoolBaseMaior');
});


test('DexScreenerScanner: snapshot pode fixar a mesma pool observada na entrada', async () => {
  const mint = 'MintPreferredPool';
  const mockFetch = async () => ({
    data: {
      pairs: [
        {
          chainId: 'solana',
          pairAddress: 'PoolEntrada',
          baseToken: { address: mint, symbol: 'PREF' },
          priceUsd: '0.01',
          liquidity: { usd: 12000 },
          volume: { m5: 1000 }
        },
        {
          chainId: 'solana',
          pairAddress: 'PoolMaior',
          baseToken: { address: mint, symbol: 'PREF' },
          priceUsd: '0.011',
          liquidity: { usd: 50000 },
          volume: { m5: 5000 }
        }
      ]
    }
  });

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  const snapshot = await scanner.fetchCurrentTokenMarketSnapshot(mint, 'PoolEntrada');

  assert.strictEqual(snapshot?.pairAddress, 'PoolEntrada');
  assert.strictEqual(snapshot?.liquidityUsd, 12000);
});

test('a rejected pool cannot quarantine another eligible pool of the same mint', async () => {
  const base = { chainId: 'solana', baseToken: { address: 'SameMint', symbol: 'SAME' },
    priceUsd: '1', liquidity: { usd: 20000 }, pairCreatedAt: Date.now() - 600000 };
  for (const bad of [
    { ...base, liquidity: { usd: 1 } },
    { ...base, pairCreatedAt: Date.now() - 7200000 },
    { ...base, priceChange: { m5: -10 } }
  ]) {
    const scanner = new DexScreenerScanner({ fetchClient: async () => ({ data: [bad, base] }) });
    assert.strictEqual((await scanner.scanSolanaTrends()).length, 1);
    assert.strictEqual(scanner.cooldownCache.shouldProcess('SameMint'), true);
  }
});
test('missing liquidity waits for data without poisoning the mint cooldown', async () => {
  const scanner = new DexScreenerScanner({ fetchClient: async () => ({ data: [{
    chainId: 'solana', baseToken: { address: 'MissingLiquidity', symbol: 'WAIT' },
    priceUsd: '1', pairCreatedAt: Date.now() - 600000
  }] }) });
  assert.strictEqual((await scanner.scanSolanaTrends()).length, 0);
  assert.strictEqual(scanner.cooldownCache.shouldProcess('MissingLiquidity'), true);
});
