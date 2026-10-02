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
      totalHolders: 500,
      markets: [{ lp: { lpLockedPct: 95 } }],
      topHolders: [{ pct: 4 }, { pct: 3 }, { pct: 2 }],
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
  assert.ok(report.score >= 80);
});

test('RugCheckService: deve vetar token com mintAuthority ativo ou score de perigo', async () => {
  const mockFetch = async () => ({
    data: {
      score: 1200, // Alto risco (> 1000)
      token: {
        mintAuthority: 'DevMalicioso1111111111111111111111111111111',
        freezeAuthority: null
      },
      totalHolders: 500,
      markets: [{ lp: { lpLockedPct: 95 } }],
      topHolders: [{ pct: 4 }, { pct: 3 }],
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

test('RugCheckService: deve vetar se freezeAuthority for ativa', async () => {
  const mockFetch = async () => ({
    data: {
      score: 100,
      token: {
        mintAuthority: null,
        freezeAuthority: 'FreezeDev1111111111111111111111111111111111'
      },
      totalHolders: 500,
      markets: [{ lp: { lpLockedPct: 95 } }],
      topHolders: [{ pct: 4 }, { pct: 3 }],
      risks: [],
      rugged: false
    }
  });

  const service = new RugCheckService({ fetchClient: mockFetch as any });
  const report = await service.auditToken('MintFreeze11111111111111111111111111111111');
  assert.strictEqual(report.isSafe, false);
  assert.strictEqual(report.isRugged, true);
});

test('RugCheckService: deve vetar se top 5 holders possuírem mais de 35% do supply', async () => {
  const mockFetch = async () => ({
    data: {
      score: 100,
      token: { mintAuthority: null, freezeAuthority: null },
      totalHolders: 500,
      markets: [{ lp: { lpLockedPct: 95 } }],
      topHolders: [{ pct: 15 }, { pct: 12 }, { pct: 10 }] // Top 3 = 37% > 35%
    }
  });

  const service = new RugCheckService({ fetchClient: mockFetch as any });
  const report = await service.auditToken('MintWhales11111111111111111111111111111111');
  assert.strictEqual(report.isSafe, false);
  assert.ok(report.risks.some(r => r.includes('Top 5 Holders')));
});


test('RugCheckService: usa o relatório completo /report, nunca /report/summary', async () => {
  let seenUrl = '';
  const service = new RugCheckService({
    fetchClient: async (url: string) => {
      seenUrl = url;
      return {
        data: {
          token: { mintAuthority: null, freezeAuthority: null },
          totalHolders: 500,
          lpLockedPct: 95,
          topHolders: [],
          markets: [],
          risks: [],
          rugged: false
        }
      };
    }
  });

  await service.auditToken('MintUrl111111111111111111111111111111111');
  assert.match(seenUrl, /\/report$/);
  assert.doesNotMatch(seenUrl, /\/report\/summary$/);
});

test('RugCheckService: campo crítico ausente deve bloquear em fail-closed', async () => {
  const service = new RugCheckService({
    fetchClient: async () => ({
      data: {
        score: 100,
        token: {},
        risks: [],
        rugged: false
      }
    })
  });

  const report = await service.auditToken('MintIncomplete111111111111111111111111111111');
  assert.strictEqual(report.isSafe, false);
  assert.strictEqual(report.factsComplete, false);
  assert.match(report.risks.join(' | '), /RugCheck sem fatos críticos/);
  assert.match(report.risks.join(' | '), /mintAuthority/);
  assert.match(report.risks.join(' | '), /totalHolders/);
});
