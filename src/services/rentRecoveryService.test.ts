import test from 'node:test';
import assert from 'node:assert';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
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
  assert.strictEqual(sweep.reclaimedSolActual, 0);
  assert.deepStrictEqual(sweep.txSignatures, []);
  assert.strictEqual(sweep.errors.length, 0);
});

test('RentRecoveryService: deve calcular valor correto de aluguel devolvido por conta (~0.00204 SOL)', () => {
  const closedCount = 5;
  const reclaimedSolEst = Number((closedCount * RentRecoveryService.RENT_EXEMPTION_EST_SOL).toFixed(6));
  assert.strictEqual(reclaimedSolEst, 0.0102);
});

test('RentRecoveryService: deve consultar SPL clássico e Token-2022', async () => {
  const keypair = Keypair.generate();
  const seenPrograms: string[] = [];
  const mockConnection = {
    getParsedTokenAccountsByOwner: async (_owner: PublicKey, filter: any) => {
      seenPrograms.push(filter.programId.toBase58());
      return { value: [] };
    }
  } as any;

  const service = new RentRecoveryService(mockConnection, keypair);
  const accounts = await (service as any).getParsedTokenAccountsForSupportedPrograms();

  assert.deepStrictEqual(accounts, []);
  assert.ok(seenPrograms.includes(TOKEN_PROGRAM_ID.toBase58()));
  assert.ok(seenPrograms.includes(TOKEN_2022_PROGRAM_ID.toBase58()));
});

test('RentRecoveryService: deve resolver e propagar Token-2022 no fechamento da ATA', async () => {
  const keypair = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  let capturedProgram = '';

  const mockConnection = {
    getAccountInfo: async (_pubkey: PublicKey) => ({ owner: TOKEN_2022_PROGRAM_ID })
  } as any;

  const service = new RentRecoveryService(mockConnection, keypair);
  (service as any).closeAccountAddress = async (
    _ata: PublicKey,
    _destination?: string,
    tokenProgramId?: PublicKey
  ) => {
    capturedProgram = tokenProgramId?.toBase58() || '';
    return { success: true, txSignature: 'MOCK_TOKEN_2022_CLOSE' };
  };

  const res = await service.closeTokenAccount(mint.toBase58());
  assert.strictEqual(res.success, true);
  assert.strictEqual(capturedProgram, TOKEN_2022_PROGRAM_ID.toBase58());
});
