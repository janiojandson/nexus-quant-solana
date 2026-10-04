import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidIntentTransition,
  assertValidAttemptTransition,
  assertCanPrepareAttemptForIntent,
  assertValidSystemMutationContext,
  IllegalStateTransitionError,
  SystemMutationContext,
  ExitIntentStatus,
  ExecutionAttemptState
} from '../../src/journal/types.js';
import { InMemoryJournalRepository } from '../../src/journal/repository.js';

describe('State Machine & System Mutations Fencing (Fase 9, P1-03, P1-04)', () => {
  describe('9.1 — Prepare Attempt Eligibility Matrix', () => {
    it('accepts only CREATED, CLAIMED, and PREPARED for prepareAttempt', () => {
      // Allowed
      assert.doesNotThrow(() => assertCanPrepareAttemptForIntent('CREATED'));
      assert.doesNotThrow(() => assertCanPrepareAttemptForIntent('CLAIMED'));
      assert.doesNotThrow(() => assertCanPrepareAttemptForIntent('PREPARED'));

      // Incompatible / Forbidden
      const forbidden: ExitIntentStatus[] = [
        'SUBMITTED',
        'CONFIRMED',
        'APPLIED',
        'UNKNOWN',
        'FAILED_DEFINITIVE',
        'SUPERSEDED',
        'CANCELLED'
      ];

      for (const status of forbidden) {
        assert.throws(
          () => assertCanPrepareAttemptForIntent(status),
          (err: any) => err instanceof IllegalStateTransitionError && err.message.includes('PREPARE_ATTEMPT_REJECTED'),
          `prepareAttempt must reject intent in state '${status}'`
        );
      }
    });

    it('InMemoryJournalRepository enforces prepareAttempt matrix', async () => {
      const repo = new InMemoryJournalRepository();
      const mint = 'MintPrepTest11111111111111111111111111111111';

      const { intent } = await repo.createOrGetIntent({
        id: 'intent-prep-001' as any,
        tradeId: 't-001' as any,
        positionId: 'p-001' as any,
        walletId: 'w-001',
        mint,
        tokenProgram: 'tp',
        requestedAmountAtomic: '1000',
        amountPolicy: 'FULL',
        initialSeverity: 'HIGH',
        reason: 'STOP_LOSS',
        policyVersion: 'v2'
      });

      const claimed = await repo.claimIntent({
        intentId: intent.id,
        workerId: 'worker-1',
        leaseDurationMs: 60_000
      });

      // Prepare attempt while CLAIMED -> succeeds
      const attempt1 = await repo.prepareAttempt({
        attemptId: 'att-prep-1' as any,
        intentId: intent.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: '1000',
        initialState: 'ORDER_READY'
      }, claimed!.claimEpoch);
      assert.ok(attempt1);

      // Now simulate intent transitioning to CONFIRMED
      intent.status = 'CONFIRMED';

      // Attempting to prepare another attempt while CONFIRMED MUST fail
      await assert.rejects(
        async () => {
          await repo.prepareAttempt({
            attemptId: 'att-prep-2' as any,
            intentId: intent.id,
            provider: 'JUPITER_V2',
            requestedAmountAtomic: '1000',
            initialState: 'ORDER_READY'
          }, claimed!.claimEpoch);
        },
        (err: any) => err instanceof IllegalStateTransitionError,
        'prepareAttempt must reject CONFIRMED intent'
      );
    });
  });

  describe('9.2 — System Mutation Fencing', () => {
    let repo: InMemoryJournalRepository;

    beforeEach(() => {
      repo = new InMemoryJournalRepository();
    });

    it('rejects system mutation when actor or reason is missing', () => {
      assert.throws(
        () => assertValidSystemMutationContext({ actor: '', reason: 'audit cleanup' } as any),
        /actor is required/
      );
      assert.throws(
        () => assertValidSystemMutationContext({ actor: 'admin', reason: '' } as any),
        /reason is required/
      );
    });

    it('rejects system mutation when expectedCurrentState diverges', () => {
      assert.throws(
        () => assertValidSystemMutationContext({
          actor: 'admin',
          reason: 'state repair',
          expectedCurrentState: 'SUBMITTED'
        }, 'CONFIRMED'),
        /does not match actual state/
      );

      // Matching state passes
      assert.doesNotThrow(
        () => assertValidSystemMutationContext({
          actor: 'admin',
          reason: 'state repair',
          expectedCurrentState: 'SUBMITTED'
        }, 'SUBMITTED')
      );
    });

    it('systemUpdateAttemptState enforces transitions and does not allow backdoor regressions', async () => {
      const mint = 'MintSystemMutTest111111111111111111111111111';

      const { intent } = await repo.createOrGetIntent({
        id: 'intent-sys-001' as any,
        tradeId: 't-001' as any,
        positionId: 'p-001' as any,
        walletId: 'w-001',
        mint,
        tokenProgram: 'tp',
        requestedAmountAtomic: '1000',
        amountPolicy: 'FULL',
        initialSeverity: 'HIGH',
        reason: 'STOP_LOSS',
        policyVersion: 'v2'
      });

      const claimed = await repo.claimIntent({
        intentId: intent.id,
        workerId: 'worker-1',
        leaseDurationMs: 60_000
      });

      const attempt = await repo.prepareAttempt({
        attemptId: 'att-sys-001' as any,
        intentId: intent.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: '1000',
        initialState: 'ORDER_READY'
      }, claimed!.claimEpoch);

      // Submit
      await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {}, claimed!.claimEpoch);

      // Confirm
      await repo.updateAttemptState(attempt.attemptId, 'CONFIRMED', {}, claimed!.claimEpoch);

      // System mutation cannot regress CONFIRMED back to SUBMITTED
      const ctx: SystemMutationContext = {
        actor: 'audit_operator',
        reason: 'illegal replay test',
        expectedCurrentState: 'CONFIRMED',
        expectedEpoch: claimed!.claimEpoch
      };

      await assert.rejects(
        async () => {
          await repo.systemUpdateAttemptState(attempt.attemptId, 'SUBMITTED', ctx);
        },
        (err: any) => err instanceof IllegalStateTransitionError,
        'systemUpdateAttemptState must enforce state machine and reject CONFIRMED -> SUBMITTED'
      );
    });
  });

  describe('9.3 — Strict Transition Invariants', () => {
    it('blocks illegal intent regressions', () => {
      // CONFIRMED cannot regress to SUBMITTED, UNKNOWN, or CLAIMED
      assert.throws(() => assertValidIntentTransition('CONFIRMED', 'SUBMITTED'), IllegalStateTransitionError);
      assert.throws(() => assertValidIntentTransition('CONFIRMED', 'UNKNOWN'), IllegalStateTransitionError);
      assert.throws(() => assertValidIntentTransition('CONFIRMED', 'CLAIMED'), IllegalStateTransitionError);

      // APPLIED cannot transition anywhere
      assert.throws(() => assertValidIntentTransition('APPLIED', 'CLAIMED'), IllegalStateTransitionError);
      assert.throws(() => assertValidIntentTransition('APPLIED', 'SUBMITTED'), IllegalStateTransitionError);

      // FAILED_DEFINITIVE cannot transition anywhere
      assert.throws(() => assertValidIntentTransition('FAILED_DEFINITIVE', 'SUBMITTED'), IllegalStateTransitionError);

      // UNKNOWN cannot regress to SUBMITTED
      assert.throws(() => assertValidIntentTransition('UNKNOWN', 'SUBMITTED'), IllegalStateTransitionError);

      // Valid transitions pass
      assert.doesNotThrow(() => assertValidIntentTransition('CONFIRMED', 'APPLIED'));
      assert.doesNotThrow(() => assertValidIntentTransition('UNKNOWN', 'CONFIRMED'));
      assert.doesNotThrow(() => assertValidIntentTransition('UNKNOWN', 'FAILED_DEFINITIVE'));
    });

    it('blocks illegal attempt regressions', () => {
      // CONFIRMED cannot regress
      assert.throws(() => assertValidAttemptTransition('CONFIRMED', 'SUBMITTED'), IllegalStateTransitionError);
      assert.throws(() => assertValidAttemptTransition('CONFIRMED', 'UNKNOWN'), IllegalStateTransitionError);
      assert.throws(() => assertValidAttemptTransition('CONFIRMED', 'INITIALIZED'), IllegalStateTransitionError);

      // FAILED_DEFINITIVE cannot regress
      assert.throws(() => assertValidAttemptTransition('FAILED_DEFINITIVE', 'SUBMITTED'), IllegalStateTransitionError);

      // UNKNOWN cannot transition to FAILED (only FAILED_DEFINITIVE or CONFIRMED)
      assert.throws(() => assertValidAttemptTransition('UNKNOWN', 'FAILED'), IllegalStateTransitionError);

      // Valid transitions pass
      assert.doesNotThrow(() => assertValidAttemptTransition('SUBMITTED', 'PROVIDER_SUCCESS'));
      assert.doesNotThrow(() => assertValidAttemptTransition('PROVIDER_SUCCESS', 'CONFIRMED'));
      assert.doesNotThrow(() => assertValidAttemptTransition('SUBMITTED', 'CONFIRMED'));
      assert.doesNotThrow(() => assertValidAttemptTransition('SUBMITTED', 'UNKNOWN'));
      assert.doesNotThrow(() => assertValidAttemptTransition('UNKNOWN', 'CONFIRMED'));
      assert.doesNotThrow(() => assertValidAttemptTransition('UNKNOWN', 'FAILED_DEFINITIVE'));
    });
  });
});
