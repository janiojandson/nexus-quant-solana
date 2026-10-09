import { describe, it } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import { MemeRiskGatekeeper, TokenSecurityMetadata } from './memeRiskGatekeeper.js';

describe('MemeRiskGatekeeper - Auditoria determinística de Memecoins + Laya shadow', () => {
  it('deve rejeitar localmente token se mintAuthority ainda estiver ativo (risco de mint infinito)', async () => {
    const gatekeeper = new MemeRiskGatekeeper();

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

  it('deve bloquear quando o Sentinel estiver indisponível, independente da Laya shadow', async () => {
    const mockRugCheck = {
      auditToken: async () => ({
        mint: 'Meme333333333333333333333333333333333333333',
        score: 100,
        risks: [],
        isRugged: false,
        isSafe: true,
        verified: true,
        mintAuthority: null,
        freezeAuthority: null,
        holdersCount: 320,
        factsComplete: true,
        lpLockedPct: 95,
        topHoldersPct: 12
      })
    };

    const gatekeeper = new MemeRiskGatekeeper({
      
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
    assert.strictEqual(audit.safe, false);
    assert.strictEqual(audit.validatedBy, 'MACRO_CIRCUIT_BREAKER');
    assert.match(audit.reason || '', /SENTINEL_UNAVAILABLE/);

  });

  it('deve rejeitar token com priceChangeM5 <= 0 (Filtro Solana: Preço em sangria/queda nos últimos 5m)', async () => {
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
    assert.match(audit.reason || '', /Filtro Solana: Preço em sangria\/queda nos últimos 5m/);
  });

  it('deve rejeitar token com priceChangeM5 > 85 (Filtro Solana: Preço esticado demais, risco de topo)', async () => {
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
    assert.match(audit.reason || '', /Filtro Solana: Preço esticado demais, risco de topo/);
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
    assert.match(audit.reason || '', /Filtro Solana: Pressão vendedora dominante/);
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
    assert.match(audit.reason || '', /Filtro Solana: Volume comprador insuficiente/);
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
    assert.match(audit.reason || '', /Filtro Solana: Ativo em distribuição pós-topo/);
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



it('Laya nativa em shadow pode falhar sem bloquear entrada já aprovada pelos gates determinísticos', async () => {
  const originalGet = axios.get;
  try {
    axios.get = (async () => ({
      data: { is_circuit_breaker_active: false, regime: 'NEUTRAL_RANGING' }
    })) as any;

    const mockRugCheck = {
      auditToken: async () => ({
        mint: 'ShadowFail11111111111111111111111111111111111',
        score: 120, risks: [], isRugged: false, isSafe: true, verified: true,
        mintAuthority: null, freezeAuthority: null, holdersCount: 420,
        factsComplete: true, lpLockedPct: 95, topHoldersPct: 11
      })
    };

    const gatekeeper = new MemeRiskGatekeeper({
      rugCheckService: mockRugCheck as any,
      
      
    });

    const audit = await gatekeeper.auditToken({
      mint: 'ShadowFail11111111111111111111111111111111111',
      liquidityUsd: 50_000, priceChangeM5: 8, buysM5: 40, sellsM5: 20,
      volumeBuysM5: 12_000, volumeSellsM5: 6_000, priceUsd: 0.001, h1HighPriceUsd: 0.0011
    });

    assert.strictEqual(audit.safe, true);
    assert.strictEqual(audit.validatedBy, 'DETERMINISTIC_SOLANA_PIPELINE');
    assert.strictEqual(audit.layaNativeShadow, undefined);
  } finally { axios.get = originalGet; }
});

it('ABSTAIN de baixa confiança da Laya shadow não substitui os gates determinísticos', async () => {
  const originalGet = axios.get;
  try {
    axios.get = (async () => ({
      data: { is_circuit_breaker_active: false, regime: 'NEUTRAL_RANGING' }
    })) as any;

    const mockRugCheck = {
      auditToken: async () => ({
        mint: 'ShadowAbstain1111111111111111111111111111111',
        score: 100, risks: [], isRugged: false, isSafe: true, verified: true,
        mintAuthority: null, freezeAuthority: null, holdersCount: 500,
        factsComplete: true, lpLockedPct: 100, topHoldersPct: 10
      })
    };
    const shadowDecision = {
      route: 'ABSTAIN', routeConfidence: 0.55,
      residualRiskScore: 1.4, residualRiskConfidence: 0.61,
      needsLlm: 0.99, needsLlmConfidence: 0.99,
      routingModel: 'multilingual', latencyMs: 20
    };

    const gatekeeper = new MemeRiskGatekeeper({
      rugCheckService: mockRugCheck as any,
      
      
    });

    const audit = await gatekeeper.auditToken({
      mint: 'ShadowAbstain1111111111111111111111111111111',
      liquidityUsd: 60_000, priceChangeM5: 9, buysM5: 50, sellsM5: 20,
      volumeBuysM5: 18_000, volumeSellsM5: 7_000, priceUsd: 0.001, h1HighPriceUsd: 0.0011
    });

    assert.strictEqual(audit.safe, true);
    assert.strictEqual(audit.validatedBy, 'DETERMINISTIC_SOLANA_PIPELINE');
    assert.strictEqual(audit.layaNativeShadow?.route, 'ABSTAIN');
    assert.strictEqual(audit.layaNativeShadow?.routeConfidence, 0.55);
  } finally { axios.get = originalGet; }
});
