import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { RentRecoveryService } from '../../src/services/rentRecoveryService.js';
import { financialExitSafetyGuard } from '../../src/execution/financialExitSafetyGuard.js';

test('Nexus V2.3-R3 — Panic & Rent Sweep Protected by Durable Execution Debt (Commit R3-3)', async (t) => {
  const dummyKeypair = Keypair.generate();
  const testMintWithDebt = Keypair.generate().publicKey.toBase58();
  const testMintWithoutDebt = Keypair.generate().publicKey.toBase58();
  const testMintWithNonZeroBalance = Keypair.generate().publicKey.toBase58();

  // Register debt for testMintWithDebt
  financialExitSafetyGuard.registerUnresolvedDebt(testMintWithDebt);

  await t.test('1. closeTokenAccount refuses to close ATA when mint has durable execution debt', async () => {
    const mockConnection = {
      getAccountInfo: async () => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
      getTokenAccountBalance: async () => ({ value: { amount: '0' } })
    } as any;

    const rentService = new RentRecoveryService(mockConnection, dummyKeypair);
    rentService.setDebtChecker((mint) => financialExitSafetyGuard.hasUnresolvedDebt(mint));

    const result = await rentService.closeTokenAccount(testMintWithDebt);
    assert.equal(result.success, false);
    assert.match(result.error || '', /UNRESOLVED_DURABLE_DEBT/);
  });

  await t.test('2. closeTokenAccount refuses to close ATA when balance is non-zero', async () => {
    const mockConnection = {
      getAccountInfo: async () => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
      getTokenAccountBalance: async () => ({ value: { amount: '5000000' } }) // 5m tokens remaining
    } as any;

    const rentService = new RentRecoveryService(mockConnection, dummyKeypair);
    const result = await rentService.closeTokenAccount(testMintWithNonZeroBalance);
    assert.equal(result.success, false);
    assert.match(result.error || '', /NON_ZERO_BALANCE/);
  });

  await t.test('3. sweepOrphanAccounts skips mints with durable debt or in excludedMints', async () => {
    let closedCount = 0;
    const debtPubkey = Keypair.generate().publicKey;
    const noDebtPubkey = Keypair.generate().publicKey;

    const mockConnection = {
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          {
            pubkey: debtPubkey,
            account: {
              lamports: 2039280,
              owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
              data: { parsed: { info: { mint: testMintWithDebt, tokenAmount: { amount: '0' } } } }
            }
          },
          {
            pubkey: noDebtPubkey,
            account: {
              lamports: 2039280,
              owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
              data: { parsed: { info: { mint: testMintWithoutDebt, tokenAmount: { amount: '0' } } } }
            }
          }
        ]
      })
    } as any;

    const rentService = new RentRecoveryService(mockConnection, dummyKeypair);
    rentService.setDebtChecker((mint) => financialExitSafetyGuard.hasUnresolvedDebt(mint));
    (rentService as any).closeAccountAddress = async () => {
      closedCount++;
      return { success: true, txSignature: 'sig_sweep_1' };
    };

    const sweepResult = await rentService.sweepOrphanAccounts();

    // testMintWithDebt had debt -> skipped! Only testMintWithoutDebt is closed!
    assert.equal(sweepResult.closedCount, 1);
    assert.equal(closedCount, 1);
  });

  await t.test('4. sweepOrphanAccounts respects explicit excludedMints from panicAll (Finding 14 & T3-P0-02)', async () => {
    let closedCount = 0;
    const mockConnection = {
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          {
            pubkey: Keypair.generate().publicKey,
            account: {
              lamports: 2039280,
              owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
              data: { parsed: { info: { mint: testMintWithoutDebt, tokenAmount: { amount: '0' } } } }
            }
          }
        ]
      })
    } as any;

    const rentService = new RentRecoveryService(mockConnection, dummyKeypair);
    (rentService as any).closeAccountAddress = async () => {
      closedCount++;
      return { success: true, txSignature: 'sig_sweep_2' };
    };

    // Explicitly exclude testMintWithoutDebt (e.g. from panicAll result with PENDING_RECONCILIATION)
    const sweepResult = await rentService.sweepOrphanAccounts(undefined, {
      excludedMints: new Set([testMintWithoutDebt])
    });

    assert.equal(sweepResult.closedCount, 0);
    assert.equal(closedCount, 0);
  });

  // Clean up debt
  financialExitSafetyGuard.clearUnresolvedDebt(testMintWithDebt);
});
