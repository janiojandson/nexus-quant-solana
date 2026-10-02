import test from 'node:test';
import assert from 'node:assert';
import { RugCheckService, RugCheckReport } from './rugCheckService.js';

test('AuditRugCheck: Payload A (Golpe Real / Honeypot) deve ser VETADO', async () => {
  const payloadScam = {
    score: 1200,
    token: {
      mintAuthority: 'ScamDev1111111111111111111111111111111111',
      freezeAuthority: 'ScamDev1111111111111111111111111111111111'
    },
    totalHolders: 250,
    markets: [{ lp: { lpLockedPct: 95 } }],
    topHolders: [{ pct: 5 }, { pct: 4 }],
    risks: [
      { name: 'Mint Authority Enabled', score: 1000, level: 'danger' },
      { name: 'Freeze Authority Enabled', score: 1000, level: 'danger' }
    ],
    rugged: true
  };

  const service = new RugCheckService({
    fetchClient: async () => ({ data: payloadScam })
  });

  const report = await service.auditToken('ScamToken111111111111111111111111111111111');
  assert.strictEqual(report.isSafe, false, 'Payload A deve ser considerado inseguro');
  assert.strictEqual(report.isRugged, true);
});

test('AuditRugCheck: Payload B (Token Pump.fun Legítimo Migrado) deve ser APROVADO sem veto indevido', async () => {
  // Payload típico retornado pelo RugCheck para tokens Pump.fun com LP 100% segura
  // mas com avisos não-fatais (Mutable metadata + 1 LP Provider)
  const payloadPumpFunLegit = {
    score: 500, // 400 pts (1 LP provider) + 100 pts (mutable metadata) = 500 pts
    token: {
      mintAuthority: null,
      freezeAuthority: null
    },
    tokenMeta: {
      mutable: true
    },
    totalHolders: 650,
    markets: [
      {
        marketType: 'pump_fun_amm',
        lp: {
          lpLockedPct: 100,
          lpBurnedPct: 100
        }
      }
    ],
    topHolders: [
      { address: 'RaydiumVault1111111111111111111111111111111', pct: 30.0, isLpPool: true },
      { address: 'UserHolder11111111111111111111111111111111', pct: 3.5 },
      { address: 'UserHolder22222222222222222222222222222222', pct: 2.8 },
      { address: 'UserHolder33333333333333333333333333333333', pct: 2.1 }
    ],
    risks: [
      { name: 'Low amount of LP Providers', score: 400, level: 'warn', description: 'Single LP provider on Raydium' },
      { name: 'Mutable metadata', score: 100, level: 'warn', description: 'Token metadata is mutable' }
    ],
    rugged: false
  };

  const service = new RugCheckService({
    fetchClient: async () => ({ data: payloadPumpFunLegit })
  });

  const report = await service.auditToken('PumpFunLegit111111111111111111111111111111');
  assert.strictEqual(report.isRugged, false);
  assert.strictEqual(report.isSafe, true, 'Token Pump.fun legítimo com LP 100% queimada e mint revogado DEVE ser aprovado');
});
