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
        pairCreatedAt: Date.now() - 3600000
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

test('DexScreenerScanner: deve rejeitar armadilhas de 1 minuto e aceitar apenas maturidade >= 20 min', async () => {
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

test('DexScreenerScanner: deve descartar tokens mais velhos que 4 horas (fora da janela de momentum)', () => {
  const scanner = new DexScreenerScanner();
  const now = Date.now();
  assert.strictEqual(scanner.isMaturityValid(now - (5 * 60 * 60 * 1000)), false);
  assert.strictEqual(scanner.isMaturityValid(now - (15 * 60 * 1000)), false);
  assert.strictEqual(scanner.isMaturityValid(now - (45 * 60 * 1000)), true);
});

test('DexScreenerScanner: deve calcular ratio de agressão compradora e exigir >= 70%', () => {
  const scanner = new DexScreenerScanner();
  assert.strictEqual(scanner.isBuyingAggressionValid(75, 25), true);
  assert.strictEqual(scanner.isBuyingAggressionValid(60, 40), false);
});
