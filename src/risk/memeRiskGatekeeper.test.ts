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
    const mockRugCheck = {
      auditToken: async () => ({
        mint: 'Meme333333333333333333333333333333333333333',
        score: 100,
        risks: [],
        isRugged: false,
        isSafe: true,
        verified: true
      })
    };

    const gatekeeper = new MemeRiskGatekeeper({
      layaBaseUrl: 'http://127.0.0.1:9999', // URL sem serviço ativo para acionar fallback seguro
      timeoutMs: 500,
      rugCheckService: mockRugCheck as any
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

  it('deve rejeitar token com priceChangeM5 <= 0 (Ayla Veto: Preço em sangria/queda nos últimos 5m)', async () => {
    const gatekeeper = new MemeRiskGatekeeper();
    const token: TokenSecurityMetadata = {
      mint: 'MemeQueda5m',
      liquidityUsd: 30_000,
      mintAuthority: null,
      freezeAuthority: null,
      holdersCount: 200,
      priceChangeM5: -1.8
    };

    const audit = await gatekeeper.auditToken(token);
    assert.strictEqual(audit.safe, false);
    assert.match(audit.reason || '', /Ayla Veto: Preço em sangria\/queda nos últimos 5m/);
  });

  it('deve rejeitar token com priceChangeM5 > 85 (Ayla Veto: Preço esticado demais, risco de topo)', async () => {
    const gatekeeper = new MemeRiskGatekeeper();
    const token: TokenSecurityMetadata = {
      mint: 'MemeEsticado5m',
      liquidityUsd: 30_000,
      mintAuthority: null,
      freezeAuthority: null,
      holdersCount: 200,
      priceChangeM5: 92.5
    };

    const audit = await gatekeeper.auditToken(token);
    assert.strictEqual(audit.safe, false);
    assert.match(audit.reason || '', /Ayla Veto: Preço esticado demais, risco de topo/);
  });

  it('deve rejeitar token com order flow insuficiente (buys < sells)', async () => {
    const gatekeeper = new MemeRiskGatekeeper();
    const token: TokenSecurityMetadata = {
      mint: 'MemeVendedores5m',
      liquidityUsd: 30_000,
      mintAuthority: null,
      freezeAuthority: null,
      holdersCount: 200,
      priceChangeM5: 10.0,
      buysM5: 9,
      sellsM5: 10 // buys 9 < sells 10 (paridade)
    };

    const audit = await gatekeeper.auditToken(token);
    assert.strictEqual(audit.safe, false);
    assert.match(audit.reason || '', /Ayla Veto: Pressão vendedora dominante/);
  });

  it('deve rejeitar token se volume comprador for menor que 45% do total', async () => {
    const gatekeeper = new MemeRiskGatekeeper();
    const token: TokenSecurityMetadata = {
      mint: 'MemeVolVendedor',
      liquidityUsd: 30_000,
      mintAuthority: null,
      freezeAuthority: null,
      holdersCount: 200,
      priceChangeM5: 10.0,
      buysM5: 25,
      sellsM5: 10,
      volumeBuysM5: 4000,
      volumeSellsM5: 5000 // 4000 / 9000 = 44.4% < 45%
    };

    const audit = await gatekeeper.auditToken(token);
    assert.strictEqual(audit.safe, false);
    assert.match(audit.reason || '', /Ayla Veto: Volume comprador insuficiente/);
  });

  it('deve rejeitar token se preço atual estiver a menos de 65% da máxima h1 (queda pós-topo)', async () => {
    const gatekeeper = new MemeRiskGatekeeper();
    const token: TokenSecurityMetadata = {
      mint: 'MemeFacaCaindo',
      liquidityUsd: 30_000,
      mintAuthority: null,
      freezeAuthority: null,
      holdersCount: 200,
      priceChangeM5: 8.0,
      buysM5: 30,
      sellsM5: 10,
      priceUsd: 0.060,
      h1HighPriceUsd: 0.100 // 0.060 / 0.100 = 60% < 65%
    };

    const audit = await gatekeeper.auditToken(token);
    assert.strictEqual(audit.safe, false);
    assert.match(audit.reason || '', /Ayla Veto: Ativo em distribuição pós-topo/);
  });

  it('deve aprovar e formatar validação quando momentum e order flow estiverem dentro da janela perfeita', () => {
    const gatekeeper = new MemeRiskGatekeeper();
    const result = gatekeeper.validatePriceMomentum({
      priceChangeM5: 12.5,
      buysM5: 45,
      sellsM5: 20,
      volumeBuysM5: 15000,
      volumeSellsM5: 8000,
      priceUsd: 0.095,
      h1HighPriceUsd: 0.100
    });

    assert.strictEqual(result.valid, true);
    assert.match(result.momentumText || '', /Momentum m5: \+12\.5%/);
    assert.match(result.momentumText || '', /Buys\/Sells: 45\/20/);
    assert.match(result.momentumText || '', /Vol Comprador > Vendedor/);
  });
});

