import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateRunwayHours,
  getAgentVitalityState,
  canExecuteAction,
  VitalityState
} from './vitalityEngine.js';

describe('VitalityEngine - Regras de Sobrevivência Darwinista', () => {
  it('deve declarar estado DEAD se o saldo for menor ou igual a 0.001 SOL', () => {
    assert.strictEqual(getAgentVitalityState(0.001), VitalityState.DEAD);
    assert.strictEqual(getAgentVitalityState(0.0005), VitalityState.DEAD);
    assert.strictEqual(getAgentVitalityState(0), VitalityState.DEAD);
  });

  it('deve entrar em SPARTAN_SURVIVAL se o saldo for menor que 0.05 SOL', () => {
    assert.strictEqual(getAgentVitalityState(0.049), VitalityState.SPARTAN_SURVIVAL);
    assert.strictEqual(getAgentVitalityState(0.01), VitalityState.SPARTAN_SURVIVAL);
  });

  it('deve manter estado NORMAL entre 0.05 e 0.50 SOL', () => {
    assert.strictEqual(getAgentVitalityState(0.05), VitalityState.NORMAL);
    assert.strictEqual(getAgentVitalityState(0.25), VitalityState.NORMAL);
    assert.strictEqual(getAgentVitalityState(0.50), VitalityState.NORMAL);
  });

  it('deve atingir PROSPERITY quando saldo ultrapassar 0.50 SOL (gatilho de spawn/saque)', () => {
    assert.strictEqual(getAgentVitalityState(0.51), VitalityState.PROSPERITY);
    assert.strictEqual(getAgentVitalityState(1.20), VitalityState.PROSPERITY);
  });

  it('deve calcular corretamente as horas de Runway restantes', () => {
    // 0.25 SOL com gasto de 0.001 SOL/hora = 250 horas
    const hours = calculateRunwayHours(0.25, 0.001);
    assert.strictEqual(hours, 250);
  });

  it('deve bloquear acao se o custo for maior que o saldo disponivel', () => {
    const canRun = canExecuteAction({
      actionCostSol: 0.1,
      currentBalanceSol: 0.05,
      estimatedYieldSol: 0.2
    });
    assert.strictEqual(canRun, false);
  });

  it('em modo de sobrevivencia espartana, deve permitir apenas acoes com retorno assimetrico imediato', () => {
    // Saldo baixo (0.02 SOL), custo 0.005 SOL, yield esperado baixo (0.006) -> Bloqueia
    const lowYield = canExecuteAction({
      actionCostSol: 0.005,
      currentBalanceSol: 0.02,
      estimatedYieldSol: 0.006
    });
    assert.strictEqual(lowYield, false);

    // Saldo baixo (0.02 SOL), custo 0.002 SOL, yield esperado alto (0.010 = 5x) -> Autoriza
    const highAsymmetry = canExecuteAction({
      actionCostSol: 0.002,
      currentBalanceSol: 0.02,
      estimatedYieldSol: 0.010
    });
    assert.strictEqual(highAsymmetry, true);
  });
});
