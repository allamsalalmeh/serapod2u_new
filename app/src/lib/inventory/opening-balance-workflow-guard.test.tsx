import { describe, expect, it } from 'vitest'
import {
  transactionsContinueGate,
  transactionsGateFor,
  canEnterReviewStep,
  guardedAdvanceTarget,
} from './opening-balance-workflow-guard'
import type { OpeningBalanceReadiness, OpeningBalanceBlocker } from './opening-balance-readiness'
import type { OpeningBalanceBlockerDetail } from './opening-balance-blockers'
import type { OpeningBalanceStepId } from './opening-balance-workspace'

const blocker = (id: string, step: OpeningBalanceStepId): OpeningBalanceBlocker => ({
  id, type: 'Allocation Reconciliation', step, reason: 'x', actionLabel: 'Review',
})

const readiness = (
  ready: boolean,
  blockers: OpeningBalanceBlocker[],
): OpeningBalanceReadiness => ({
  ready,
  level: ready ? 'ready' : 'blocked',
  statusLabel: ready ? 'Ready to Post' : 'Blocked',
  blockerCount: blockers.length,
  blockers,
})

const remaining = (o: Partial<Record<OpeningBalanceStepId, number>> = {}): Record<OpeningBalanceStepId, number> => ({
  freeze: 0, d2h: 0, h2m: 0, transactions: 0, review: 0, ...o,
})

describe('transactionsContinueGate', () => {
  it('allows continue when there are no transaction blockers and no pending decisions', () => {
    const gate = transactionsContinueGate(readiness(true, []), 0)
    expect(gate.canContinue).toBe(true)
    expect(gate.unresolvedCount).toBe(0)
    expect(gate.message).toBeNull()
  })

  it('blocks continue for an unresolved transaction-step blocker (allocation reconciliation)', () => {
    const gate = transactionsContinueGate(readiness(false, [blocker('allocation_reconciliation:v:c', 'transactions')]), 0)
    expect(gate.canContinue).toBe(false)
    expect(gate.unresolvedCount).toBe(1)
    expect(gate.firstUnresolvedKey).toBe('allocation_reconciliation:v:c')
    expect(gate.message).toMatch(/Resolve 1 transaction blocker/)
  })

  it('blocks continue while a transaction decision is still pending, even with zero blockers', () => {
    const gate = transactionsContinueGate(readiness(true, []), 2)
    expect(gate.canContinue).toBe(false)
    expect(gate.unresolvedCount).toBe(2)
  })

  it('ignores blockers that resolve on other steps', () => {
    const gate = transactionsContinueGate(readiness(false, [blocker('policy:d2h', 'd2h')]), 0)
    expect(gate.canContinue).toBe(true)
    expect(gate.unresolvedCount).toBe(0)
  })
})

describe('canEnterReviewStep', () => {
  it('is false for null / not-ready readiness', () => {
    expect(canEnterReviewStep(null, remaining())).toBe(false)
    expect(canEnterReviewStep(readiness(false, [blocker('a', 'transactions')]), remaining())).toBe(false)
  })

  it('is false when readiness is ready but a blocker is still counted', () => {
    const r: OpeningBalanceReadiness = { ...readiness(true, []), blockerCount: 1 }
    expect(canEnterReviewStep(r, remaining())).toBe(false)
  })

  it('is false when an earlier step still has decisions remaining', () => {
    expect(canEnterReviewStep(readiness(true, []), remaining({ transactions: 1 }))).toBe(false)
    expect(canEnterReviewStep(readiness(true, []), remaining({ d2h: 3 }))).toBe(false)
  })

  it('is true only when ready, zero blockers and no pending decisions', () => {
    expect(canEnterReviewStep(readiness(true, []), remaining())).toBe(true)
    expect(canEnterReviewStep(readiness(true, []), null)).toBe(true)
  })
})

describe('guardedAdvanceTarget', () => {
  it('always permits navigating to a non-review step (go back to fix)', () => {
    expect(guardedAdvanceTarget('d2h', null, null)).toBe('d2h')
    expect(guardedAdvanceTarget('transactions', readiness(false, [blocker('a', 'transactions')]), remaining())).toBe('transactions')
  })

  it('permits entering review only when the authoritative guard passes', () => {
    expect(guardedAdvanceTarget('review', readiness(true, []), remaining())).toBe('review')
  })

  it('refuses entering review while blocked or with pending decisions', () => {
    expect(guardedAdvanceTarget('review', readiness(false, [blocker('a', 'transactions')]), remaining())).toBeNull()
    expect(guardedAdvanceTarget('review', readiness(true, []), remaining({ transactions: 1 }))).toBeNull()
  })
})

describe('transactionsGateFor — single authoritative dedup', () => {
  const ws = (transactions: number, allocationBlockers: number) => ({
    remainingByStep: remaining({ transactions }),
    allocationBlockers: Array.from<OpeningBalanceBlockerDetail>({ length: allocationBlockers }),
  })

  it('does not double-count an orphan allocation (blocker also folded into remaining)', () => {
    // 1 allocation blocker present in readiness AND counted in remaining → count 1, not 2.
    const gate = transactionsGateFor(readiness(false, [blocker('alloc:v:c', 'transactions')]), ws(1, 1))
    expect(gate.canContinue).toBe(false)
    expect(gate.unresolvedCount).toBe(1)
  })

  it('allows continue once the resolved allocation leaves both signals at zero', () => {
    const gate = transactionsGateFor(readiness(false, []), ws(0, 0))
    expect(gate.canContinue).toBe(true)
    expect(gate.unresolvedCount).toBe(0)
  })

  it('still blocks a genuine pending transaction decision that is not an allocation blocker', () => {
    const gate = transactionsGateFor(readiness(false, []), ws(1, 0))
    expect(gate.canContinue).toBe(false)
    expect(gate.unresolvedCount).toBe(1)
  })
})

describe('canEnterReviewStep — Review Required is enterable', () => {
  it('permits entry when there are zero blockers even if readiness is not the strict "Ready"', () => {
    // Server "Review Required" → ready:false, blockerCount:0. Must be enterable.
    expect(canEnterReviewStep(readiness(false, []), remaining())).toBe(true)
  })

  it('still refuses entry when a real blocker remains', () => {
    expect(canEnterReviewStep(readiness(false, [blocker('a', 'transactions')]), remaining())).toBe(false)
  })

  it('still refuses entry when a pending decision remains', () => {
    expect(canEnterReviewStep(readiness(false, []), remaining({ d2h: 1 }))).toBe(false)
  })
})
