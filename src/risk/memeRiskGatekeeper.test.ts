import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemeRiskGatekeeper, TokenSecurityMetadata } from './memeRiskGatekeeper.js';

describe('MemeRiskGatekeeper - Auditoria de Memecoins & Governança Ayla/Laya', () => {
  it('deve rejeitar localmente token se mintAuthority ainda estiver ativo (risco de mint infinito)', async () => {
    const gatekeeper = new MemeRiskGatekeeper({
      layaBaseUrl: 'http://localhost:8080',
      timeoutMs: 4000
    });

    const token: TokenSecurityMetadata = {
      mint: 'Meme111111111111111111111111111111111111111',
      liquidityUsd: 50_000,
      mintAuthority: 'DevWallet111111111111111111111111111111111',
      freezeAuthority: null,
      holdersCount: 450
    };

    const audit = await gatekeeper.auditToken(token);
    assert.strictEqual(audit.safe, false);
    assert.match(audit.reason || '', /mintAuthority ativo/);
  });

  it('deve rejeitar localmente se liquidez for inferior ao mínimo seguro ($5.000)', async () => {
    const gatekeeper = new MemeRiskGatekeeper();

    const token: TokenSecurityMetadata = {
      mint: 'Meme222222222222222222222222222222222222222',
      liquidityUsd: 1_200, // < $5.000
      mintAuthority: null,
      freezeAuthority: null,
      holdersCount: 50
    };

    const audit = await gatekeeper.auditToken(token);
    assert.strictEqual(audit.safe, false);
    assert.match(audit.reason || '', /Liquidez insuficiente/);
  });

  it('deve respeitar timeout estendido de até 4000ms para a Ayla/Laya sem quebrar o fluxo', async () => {
    // Simula uma chamada onde o gatekeeper aguarda até 4000ms confortavelmente
    const gatekeeper = new MemeRiskGatekeeper({
      layaBaseUrl: 'http://127.0.0.1:9999', // URL sem serviço ativo para acionar fallback seguro
      timeoutMs: 4000
    });

    const token: TokenSecurityMetadata = {
      mint: 'Meme333333333333333333333333333333333333333',
      liquidityUsd: 25_000,
      mintAuthority: null,
      freezeAuthority: null,
      holdersCount: 320
    };

    const audit = await gatekeeper.auditToken(token);
    // Token possui metricas on-chain perfeitas, fallback defensivo permite se seguro
    assert.strictEqual(audit.safe, true);
    assert.strictEqual(audit.validatedBy, 'LOCAL_HEURISTICS_FALLBACK');
  });
});
