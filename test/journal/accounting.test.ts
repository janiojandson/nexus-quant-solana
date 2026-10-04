import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createInitialPositionAccounting,
  applyFillToAccounting,
  toTradeAccounting
} from '../../src/journal/accounting';
import { FillRecord } from '../../src/journal/types';

function createMockFill(overrides: Partial<FillRecord> = {}): FillRecord {
  return {
    id: 'fill_acc_1' as any,
    tradeId: 'trade_acc_1' as any,
    positionId: 'pos_acc_1' as any,
    intentId: 'intent_acc_1' as any,
    attemptId: 'att_acc_1' as any,
    signature: 'sig_mock_fill_acc' as any,
    realizationSequence: 1,
    chainLegIndex: 0,
    instructionIndex: 3,
    innerInstructionIndex: -1,
    requestedAmountAtomic: '1000000',
    actualAmountAtomic: '1000000',
    grossProceedsLamports: '120000000', // 0.12 SOL
    networkFeeLamports: '5000',
    priorityFeeLamports: '50000',
    tipLamports: '0',
    rentMovementLamports: '0',
    evidenceType: 'CHAIN_PARSED_TRANSACTION',
    confirmedAtWallMs: 1_000_000 as any,
    createdAtWallMs: 1_000_000 as any,
    ...overrides
  };
}

test('Nexus V2.1A — Fill Ledger Financial Accounting Pure Logic (C4)', async (t) => {
  // 1. Inicialização de contabilidade de posição
  await t.test('1. createInitialPositionAccounting inicializa estado limpo com BigInt', () => {
    const initial = createInitialPositionAccounting({
      tradeId: 'trade_init' as any,
      positionId: 'pos_init' as any,
      mint: 'Mint1111111111111111111111111111111111',
      initialTokensAtomic: '1000000000',
      initialPrincipalLamports: '100000000', // 0.1 SOL
      entryFeesLamports: '55000'
    });

    assert.strictEqual(initial.initialTokensAtomic, 1000000000n);
    assert.strictEqual(initial.remainingTokensAtomic, 1000000000n);
    assert.strictEqual(initial.initialPrincipalLamports, 100000000n);
    assert.strictEqual(initial.entryFeesLamports, 55000n);
    assert.strictEqual(initial.totalGrossProceedsLamports, 0n);
    assert.strictEqual(initial.totalTradingCostsLamports, 0n);
    assert.strictEqual(initial.realizedPnlLamports, 0n);
    assert.strictEqual(initial.totalRentMovementLamports, 0n);
    assert.strictEqual(initial.isFullyClosed, false);
    assert.strictEqual(initial.fillsCount, 0);
  });

  // 2. Execução Completa (100% de saída)
  await t.test('2. applyFillToAccounting calcula PnL líquido e fecha posição completamente em saída 100%', () => {
    const initial = createInitialPositionAccounting({
      tradeId: 'trade_full' as any,
      positionId: 'pos_full' as any,
      mint: 'Mint1111111111111111111111111111111111',
      initialTokensAtomic: '1000000',
      initialPrincipalLamports: '100000000' // Custo: 0.1 SOL
    });

    const fill = createMockFill({
      actualAmountAtomic: '1000000',
      grossProceedsLamports: '120000000', // Bruto: 0.12 SOL
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '2039280' // Aluguel de conta fechada recuperado
    });

    const updated = applyFillToAccounting(initial, fill);

    assert.strictEqual(updated.remainingTokensAtomic, 0n);
    assert.strictEqual(updated.isFullyClosed, true);
    assert.strictEqual(updated.fillsCount, 1);
    assert.strictEqual(updated.totalGrossProceedsLamports, 120000000n);
    assert.strictEqual(updated.totalTradingCostsLamports, 55000n);
    assert.strictEqual(updated.totalRentMovementLamports, 2039280n);

    // Net Proceeds = 120000000 - 55000 = 119945000
    // Realized PnL = 119945000 - 100000000 = +19945000
    assert.strictEqual(updated.realizedPnlLamports, 19945000n);
  });

  // 3. Duas tranches parciais (50% e depois restante de 50%)
  await t.test('3. duas saídas parciais (50% + 50%) rateiam custo proporcionalmente e somam PnL cumulativo exato', () => {
    const initial = createInitialPositionAccounting({
      tradeId: 'trade_partial' as any,
      positionId: 'pos_partial' as any,
      mint: 'Mint1111111111111111111111111111111111',
      initialTokensAtomic: '2000000',
      initialPrincipalLamports: '200000000' // Custo inicial: 0.2 SOL
    });

    // Tranche 1: 50% dos tokens vendidos com lucro
    const fill1 = createMockFill({
      id: 'fill_t1' as any,
      realizationSequence: 1,
      actualAmountAtomic: '1000000', // 50%
      grossProceedsLamports: '150000000', // 0.15 SOL
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '0'
    });

    const step1 = applyFillToAccounting(initial, fill1);

    assert.strictEqual(step1.remainingTokensAtomic, 1000000n);
    assert.strictEqual(step1.isFullyClosed, false);
    assert.strictEqual(step1.fillsCount, 1);
    // Custo alocado da tranche 1: 200000000 * 1000000 / 2000000 = 100000000
    // Net proceeds tranche 1: 150000000 - 55000 = 149945000
    // PnL tranche 1: 149945000 - 100000000 = +49945000
    assert.strictEqual(step1.realizedPnlLamports, 49945000n);

    // Tranche 2: 50% restantes vendidos no trailing stop com preço menor
    const fill2 = createMockFill({
      id: 'fill_t2' as any,
      realizationSequence: 2,
      actualAmountAtomic: '1000000', // restante
      grossProceedsLamports: '80000000', // 0.08 SOL
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '2039280'
    });

    const step2 = applyFillToAccounting(step1, fill2);

    assert.strictEqual(step2.remainingTokensAtomic, 0n);
    assert.strictEqual(step2.isFullyClosed, true);
    assert.strictEqual(step2.fillsCount, 2);
    // Custo alocado tranche 2: 100000000
    // Net proceeds tranche 2: 80000000 - 55000 = 79945000
    // PnL tranche 2: 79945000 - 100000000 = -20055000
    // PnL total cumulativo = 49945000 + (-20055000) = +29890000 lamports
    assert.strictEqual(step2.realizedPnlLamports, 29890000n);
    assert.strictEqual(step2.totalRentMovementLamports, 2039280n);
  });

  // 4. Invariante de Segregação de Rent
  await t.test('4. invariante de rent: devolução de aluguel JAMAIS contamina o PnL de trading', () => {
    const baseParams = {
      tradeId: 'trade_rent_check' as any,
      positionId: 'pos_rent_check' as any,
      mint: 'Mint1111111111111111111111111111111111',
      initialTokensAtomic: '1000000',
      initialPrincipalLamports: '100000000'
    };

    const initialA = createInitialPositionAccounting(baseParams);
    const initialB = createInitialPositionAccounting(baseParams);

    // Caso A: sem devolução de aluguel (rentMovementLamports = 0)
    const fillA = createMockFill({ rentMovementLamports: '0' });
    const snapA = applyFillToAccounting(initialA, fillA);

    // Caso B: com devolução de 2 SOL de aluguel (ex: fechamento de ATA de aluguel alto)
    const fillB = createMockFill({ rentMovementLamports: '2000000000' });
    const snapB = applyFillToAccounting(initialB, fillB);

    // PnL de trading DEVE SER RIGOROSAMENTE IDÊNTICO
    assert.strictEqual(snapA.realizedPnlLamports, snapB.realizedPnlLamports);
    assert.strictEqual(snapA.totalGrossProceedsLamports, snapB.totalGrossProceedsLamports);
    assert.notStrictEqual(snapA.totalRentMovementLamports, snapB.totalRentMovementLamports);
    assert.strictEqual(snapB.totalRentMovementLamports, 2000000000n);
  });

  // 5. Proteção contra Oversell
  await t.test('5. violação de oversell: tentar liquidar mais tokens que o saldo restante lança exceção', () => {
    const initial = createInitialPositionAccounting({
      tradeId: 'trade_oversell' as any,
      positionId: 'pos_oversell' as any,
      mint: 'Mint1111111111111111111111111111111111',
      initialTokensAtomic: '1000',
      initialPrincipalLamports: '1000000'
    });

    const excessFill = createMockFill({ actualAmountAtomic: '1001' });

    assert.throws(
      () => applyFillToAccounting(initial, excessFill),
      /Oversell violation/
    );
  });

  // 6. Conversão para TradeAccounting Telemetry
  await t.test('6. toTradeAccounting projeta corretamente a interface de telemetria formal', () => {
    const initial = createInitialPositionAccounting({
      tradeId: 'trade_telemetry' as any,
      positionId: 'pos_telemetry' as any,
      mint: 'Mint1111111111111111111111111111111111',
      initialTokensAtomic: '1000000',
      initialPrincipalLamports: '100000000', // 0.1 SOL
      entryFeesLamports: '5000'
    });

    const fill = createMockFill({
      actualAmountAtomic: '1000000',
      grossProceedsLamports: '110000000', // 0.11 SOL
      networkFeeLamports: '5000',
      priorityFeeLamports: '0',
      tipLamports: '0',
      rentMovementLamports: '2039280'
    });

    const snapshot = applyFillToAccounting(initial, fill);
    const telemetry = toTradeAccounting(snapshot, 0n);

    assert.strictEqual(telemetry.tradeId, 'trade_telemetry');
    assert.strictEqual(telemetry.initialPrincipalLamports, 100000000n);
    assert.strictEqual(telemetry.confirmedGrossProceedsLamports, 110000000n);
    assert.strictEqual(telemetry.confirmedTradingCostsLamports, 5000n);
    assert.strictEqual(telemetry.netRecoveredLamports, 109995000n);
    // 109995000 / 100000000 = 109.995%
    assert.strictEqual(telemetry.capitalRecoveredPct, 109.99);
    assert.strictEqual(telemetry.realizedPnLLamports, 9995000n);
    assert.strictEqual(telemetry.rentRecoveredLamports, 2039280n);
  });
});
