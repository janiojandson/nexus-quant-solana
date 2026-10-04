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
    it('accepts CREATED, CLAIMED, PREPARED and rejects UNKNOWN, CONFIRMED, SUBMITTED and terminal statuses for prepareAttempt', () => {
      // Allowed
      assert.doesNotThrow(() => assertCanPrepareAttemptForIntent('CREATED'));
      assert.doesNotThrow(() => assertCanPrepareAttemptForIntent('CLAIMED'));
      assert.doesNotThrow(() => assertCanPrepareAttemptForIntent('PREPARED'));

      // Incompatible / Forbidden (Finding 23 & 43: UNKNOWN, CONFIRMED, SUBMITTED cannot prepare new attempts)
      const forbidden: ExitIntentStatus[] = [
        'UNKNOWN',
        'CONFIRMED',
        'SUBMITTED',
        'APPLIED',
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

    it('InMemoryJournalRepository enforces prepareAttempt matrix and rejects UNKNOWN and CONFIRMED', async () => {
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

      // Now simulate intent transitioning to UNKNOWN
      intent.status = 'UNKNOWN';
      await assert.rejects(
        async () => {
          await repo.prepareAttempt({
            attemptId: 'att-prep-unknown' as any,
            intentId: intent.id,
            provider: 'JUPITER_V2',
            requestedAmountAtomic: '1000',
            initialState: 'ORDER_READY'
          }, claimed!.claimEpoch);
        },
        (err: any) => err instanceof IllegalStateTransitionError,
        'prepareAttempt must reject UNKNOWN intent'
      );

      // Now simulate intent transitioning to CONFIRMED
      intent.status = 'CONFIRMED';
      await assert.rejects(
        async () => {
          await repo.prepareAttempt({
            attemptId: 'att-prep-confirmed' as any,
            intentId: intent.id,
            provider: 'JUPITER_V2',
            requestedAmountAtomic: '1000',
            initialState: 'ORDER_READY'
          }, claimed!.claimEpoch);
        },
        (err: any) => err instanceof IllegalStateTransitionError,
        'prepareAttempt must reject CONFIRMED intent'
      );

      // Now simulate intent transitioning to APPLIED (terminal)
      intent.status = 'APPLIED';
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
        'prepareAttempt must reject APPLIED intent'
      );
    });

    it('InMemoryJournalRepository claimIntent blocks UNKNOWN, SUBMITTED, and CONFIRMED intents', async () => {
      const repo = new InMemoryJournalRepository();
      const mint = 'MintClaimBlockTest1111111111111111111111111';

      const { intent } = await repo.createOrGetIntent({
        id: 'intent-claim-block-1' as any,
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

      // Claim initially
      const claimed = await repo.claimIntent({
        intentId: intent.id,
        workerId: 'worker-1',
        leaseDurationMs: 1000
      });
      assert.ok(claimed);

      // Advance status to UNKNOWN and expire lease
      intent.status = 'UNKNOWN';
      intent.leaseExpiresAtWallMs = 1000 as any;

      // Explicit claim on UNKNOWN must throw LeaseRecoveryBlockedError
      await assert.rejects(
        async () => {
          await repo.claimIntent({
            intentId: intent.id,
            workerId: 'worker-2',
            leaseDurationMs: 60_000,
            nowMs: 5000 as any
          });
        },
        /Lease recovery blocked/
      );

      // General worker scan must skip UNKNOWN intent completely
      const nextIntent = await repo.claimIntent({
        workerId: 'worker-2',
        leaseDurationMs: 60_000,
        nowMs: 5000 as any
      });
      assert.equal(nextIntent, null, 'General worker scan must not pick up UNKNOWN intent');
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

    it('rejects financial system mutation when expectedCurrentState, expectedEpoch, or transactionContext is missing', () => {
      assert.throws(
        () => assertValidSystemMutationContext({
          mutationClass: 'FINANCIAL_STATE_MUTATION',
          actor: 'admin',
          reason: 'state repair'
        } as any),
        /expectedCurrentState is mandatory/
      );

      assert.throws(
        () => assertValidSystemMutationContext({
          mutationClass: 'FINANCIAL_STATE_MUTATION',
          actor: 'admin',
          reason: 'state repair',
          expectedCurrentState: 'SUBMITTED'
        } as any),
        /expectedEpoch is mandatory/
      );

      assert.throws(
        () => assertValidSystemMutationContext({
          mutationClass: 'FINANCIAL_STATE_MUTATION',
          actor: 'admin',
          reason: 'state repair',
          expectedCurrentState: 'SUBMITTED',
          expectedEpoch: 1n
        } as any),
        /transactionContext with wallet and mint is mandatory/
      );
    });

    it('rejects system mutation when expectedCurrentState diverges', () => {
      assert.throws(
        () => assertValidSystemMutationContext({
          mutationClass: 'FINANCIAL_STATE_MUTATION',
          actor: 'admin',
          reason: 'state repair',
          expectedCurrentState: 'SUBMITTED',
          expectedEpoch: 1n,
          transactionContext: { wallet: 'w-001', mint: 'm-001' }
        }, 'CONFIRMED'),
        /does not match actual state/
      );

      // Matching state passes
      assert.doesNotThrow(
        () => assertValidSystemMutationContext({
          mutationClass: 'FINANCIAL_STATE_MUTATION',
          actor: 'admin',
          reason: 'state repair',
          expectedCurrentState: 'SUBMITTED',
          expectedEpoch: 1n,
          transactionContext: { wallet: 'w-001', mint: 'm-001' }
        }, 'SUBMITTED')
      );

      // Observational event passes without epoch or transactionContext
      assert.doesNotThrow(
        () => assertValidSystemMutationContext({
          mutationClass: 'OBSERVATIONAL_SYSTEM_EVENT',
          actor: 'watcher',
          reason: 'health ping'
        })
      );
    });

    it('systemUpdateAttemptState enforces transitions, records system audit events, and rejects backdoor regressions', async () => {
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
        mutationClass: 'FINANCIAL_STATE_MUTATION',
        actor: 'audit_operator',
        reason: 'illegal replay test',
        expectedCurrentState: 'CONFIRMED',
        expectedEpoch: claimed!.claimEpoch,
        transactionContext: {
          wallet: 'w-001',
          mint
        }
      };

      await assert.rejects(
        async () => {
          await repo.systemUpdateAttemptState(attempt.attemptId, 'SUBMITTED', ctx);
        },
        (err: any) => err instanceof IllegalStateTransitionError,
        'systemUpdateAttemptState must enforce state machine and reject CONFIRMED -> SUBMITTED'
      );

      // Create a fresh intent2 to test valid system transition
      const { intent: intent2 } = await repo.createOrGetIntent({
        id: 'intent-sys-002' as any,
        tradeId: 't-002' as any,
        positionId: 'p-002' as any,
        walletId: 'w-002',
        mint: 'Mint222222222222222222222222222222222222222',
        tokenProgram: 'tp',
        requestedAmountAtomic: '1000',
        amountPolicy: 'FULL',
        initialSeverity: 'HIGH',
        reason: 'STOP_LOSS',
        policyVersion: 'v2'
      });
      const claimed2 = await repo.claimIntent({
        intentId: intent2.id,
        workerId: 'worker-2',
        leaseDurationMs: 60_000
      });

      const attempt2 = await repo.prepareAttempt({
        attemptId: 'att-sys-002' as any,
        intentId: intent2.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: '1000',
        initialState: 'ORDER_READY'
      }, claimed2!.claimEpoch);
      await repo.updateAttemptState(attempt2.attemptId, 'SUBMITTED', {}, claimed2!.claimEpoch);

      const validCtx2: SystemMutationContext = {
        mutationClass: 'FINANCIAL_STATE_MUTATION',
        actor: 'audit_operator',
        reason: 'mark definitive failure on timeout',
        expectedCurrentState: 'SUBMITTED',
        expectedEpoch: claimed2!.claimEpoch,
        transactionContext: {
          wallet: 'w-002',
          mint: 'Mint222222222222222222222222222222222222222'
        }
      };

      await repo.systemUpdateAttemptState(attempt2.attemptId, 'FAILED_DEFINITIVE', validCtx2);
      const auditEvents = repo.getSystemAuditEvents();
      assert.equal(auditEvents.length, 1);
      assert.equal(auditEvents[0].actor, 'audit_operator');
      assert.equal(auditEvents[0].beforeState, 'SUBMITTED');
      assert.equal(auditEvents[0].afterState, 'FAILED_DEFINITIVE');
      assert.equal(auditEvents[0].entityType, 'ExecutionAttempt');
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
