import test from 'node:test';
import assert from 'node:assert';
import { RentRecoveryService } from './rentRecoveryService.js';

test('RentRecoveryService: deve simular fechamento de ATA com sucesso em modo sem keypair (Dry-Run)', async () => {
  const mockConnection = {} as any;
  const service = new RentRecoveryService(mockConnection, undefined);

  const res = await service.closeTokenAccount('MockMint11111111111111111111111111111111111');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.txSignature, 'DRY_RUN_ATA_CLOSED');
});

test('RentRecoveryService: deve retornar zero contas fechadas no sweep quando não há keypair', async () => {
  const mockConnection = {} as any;
  const service = new RentRecoveryService(mockConnection, undefined);

  const sweep = await service.sweepOrphanAccounts();
  assert.strictEqual(sweep.closedCount, 0);
  assert.strictEqual(sweep.reclaimedSolEst, 0);
  assert.strictEqual(sweep.errors.length, 0);
});

test('RentRecoveryService: deve calcular valor correto de aluguel devolvido por conta (~0.00204 SOL)', () => {
  const closedCount = 5;
  const reclaimedSolEst = Number((closedCount * RentRecoveryService.RENT_EXEMPTION_EST_SOL).toFixed(6));
  assert.strictEqual(reclaimedSolEst, 0.0102);
});
