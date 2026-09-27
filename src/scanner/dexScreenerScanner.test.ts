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
        volume: { h24: 150000 },
        pairCreatedAt: Date.now() - 3600000
      },
      {
        chainId: 'solana',
        dexId: 'raydium',
        baseToken: { address: 'MintTokenRuim2222222222222222222222222222222', symbol: 'RUIM', name: 'Token Sem Liquidez' },
        priceUsd: '0.0001',
        liquidity: { usd: 1200 }, // Abaixo de $10.000
        volume: { h24: 5000 },
        pairCreatedAt: Date.now() - 1800000
      }
    ]
  });

  const scanner = new DexScreenerScanner({ fetchClient: mockFetch as any });
  const results: TokenCandidate[] = await scanner.scanSolanaTrends(10000);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].symbol, 'BOM');
  assert.strictEqual(results[0].liquidityUsd, 25000);
  assert.strictEqual(results[0].mint, 'MintTokenBom11111111111111111111111111111111');
});
