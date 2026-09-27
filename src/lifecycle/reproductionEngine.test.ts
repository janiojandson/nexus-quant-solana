import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ReproductionEngine } from './reproductionEngine.js';

describe('ReproductionEngine - Replicação Autônoma & Saque 50/50', () => {
  it('deve disparar reprodução e saque apenas quando a banca atingir ou dobrar o alvo (>= 0.50 SOL)', () => {
    const engine = new ReproductionEngine();

    // 0.25 SOL inicial -> Não replica ainda
    assert.strictEqual(engine.canReproduce(0.25), false);
    // 0.49 SOL -> Ainda não atingiu o limiar
    assert.strictEqual(engine.canReproduce(0.49), false);
    // 0.50 SOL -> Autoriza reprodução e colheita
    assert.strictEqual(engine.canReproduce(0.50), true);
    // 1.00 SOL -> Autoriza
    assert.strictEqual(engine.canReproduce(1.00), true);
  });

  it('deve dividir o excedente com a Regra Constitucional 50/50', () => {
    const engine = new ReproductionEngine();
    // Exemplo: Saldo acumulado de 0.60 SOL partindo de 0.20 SOL de reserva operacional
    const split = engine.calculateSurplusSplit({
      currentBalanceSol: 0.60,
      reserveOperatingBalanceSol: 0.20
    });

    // Excedente = 0.40 SOL -> 50% para Janio (0.20 SOL), 50% para o Agente Filho (0.20 SOL)
    assert.strictEqual(split.surplusTotalSol, 0.40);
    assert.strictEqual(split.profitShareJanioSol, 0.20);
    assert.strictEqual(split.childInitialStakeSol, 0.20);
  });

  it('deve gerar chave pública e missão específica ao parir um novo agente filho', async () => {
    const engine = new ReproductionEngine();
    const child = await engine.spawnChildAgent('MEME_HUNTER');

    assert.ok(child.childPublicKey);
    assert.strictEqual(child.specialty, 'MEME_HUNTER');
    assert.strictEqual(child.status, 'SPAWNED');
    assert.ok(child.spawnedAt);
  });
});
