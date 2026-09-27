import test from 'node:test';
import assert from 'node:assert';
import { RugCheckService, RugCheckReport } from './rugCheckService.js';

test('RugCheckService: deve aprovar token seguro com score baixo e sem honeypot', async () => {
  const mockFetch = async () => ({
    data: {
      score: 150, // Seguro (< 500)
      token: {
        mintAuthority: null,
        freezeAuthority: null
      },
      risks: [
        { name: 'Low Liquidity', level: 'warn', description: 'Liquidez moderada' }
      ],
      rugged: false,
      verification: { verified: true }
    }
  });

  const service = new RugCheckService({ fetchClient: mockFetch as any });
  const report: RugCheckReport = await service.auditToken('MintSeguro11111111111111111111111111111111');

  assert.strictEqual(report.isRugged, false);
  assert.strictEqual(report.isSafe, true);
  assert.strictEqual(report.score, 150);
});

test('RugCheckService: deve vetar token com mintAuthority ativo ou score de perigo', async () => {
  const mockFetch = async () => ({
    data: {
      score: 1200, // Alto risco (> 1000)
      token: {
        mintAuthority: 'DevMalicioso1111111111111111111111111111111',
        freezeAuthority: null
      },
      risks: [
        { name: 'Mint Authority Enabled', level: 'danger', description: 'Dev pode cunhar infinitos tokens' }
      ],
      rugged: true,
      verification: { verified: false }
    }
  });

  const service = new RugCheckService({ fetchClient: mockFetch as any });
  const report: RugCheckReport = await service.auditToken('MintScam222222222222222222222222222222222');

  assert.strictEqual(report.isRugged, true);
  assert.strictEqual(report.isSafe, false);
  assert.ok(report.risks.some(r => r.includes('Mint Authority Enabled')));
});
