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
  assert.strictEqual(scanner.isMaturityValid(now - (90 * 60 * 1000)), false, '90 min deve ser descartado (> 60m)');
  assert.strictEqual(scanner.isMaturityValid(now - (2 * 60 * 1000)), false, '2 min deve ser descartado (< 5m)');
  assert.strictEqual(scanner.isMaturityValid(now - (5 * 60 * 1000)), true, '5 min deve ser aceito');
  assert.strictEqual(scanner.isMaturityValid(now - (8 * 60 * 1000)), true, '8 min deve ser aceito');
  assert.strictEqual(scanner.isMaturityValid(now - (10 * 60 * 1000)), true, '10 min deve ser aceito');
  assert.strictEqual(scanner.isMaturityValid(now - (35 * 60 * 1000)), true, '35 min deve ser aceito');
  assert.strictEqual(scanner.isMaturityValid(now - (60 * 60 * 1000)), true, '60 min deve ser aceito');
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

