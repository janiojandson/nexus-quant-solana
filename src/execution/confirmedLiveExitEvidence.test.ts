import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfirmedLiveExitEvidence } from './confirmedLiveExitEvidence.js';

const evidence = { signature: 'sig', deltaAtomic: '-741', walletLamportDelta: 1_000_250_000,
  feeLamports: 100_000, blockTimeMs: 1000 };

test('LIVE exit accepts only matching confirmed signature and exact sold amount', () => {
  assert.deepEqual(validateConfirmedLiveExitEvidence(evidence, 'sig', 741), {
    fillId: 'sig', soldAtomic: 741, receivedLamports: 1_000_250_000, feeLamports: 100_000
  });
  assert.throws(() => validateConfirmedLiveExitEvidence(evidence, 'other', 741), /SIGNATURE_MISMATCH/);
  assert.throws(() => validateConfirmedLiveExitEvidence(evidence, 'sig', 740), /TOKEN_DELTA_MISMATCH/);
  assert.throws(() => validateConfirmedLiveExitEvidence(null, 'sig', 741), /CONFIRMED_WALLET_DELTA_MISSING/);
});

test('net wallet SOL delta cannot be fabricated from quote or negative proceeds', () => {
  assert.throws(() => validateConfirmedLiveExitEvidence({ ...evidence, walletLamportDelta: 0 }, 'sig', 741),
    /NET_SOL_DELTA_INVALID/);
});
