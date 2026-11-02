import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Role } from '../sdk/src/types.ts';
import { HttpError } from '../server/src/shared/http.ts';
import { canDecide, canView, transition, type Actor, type WorkflowOrder } from '../server/src/orders/workflow.ts';

const actor = (id: string, role: Role, costCenterIds: string[] = []): Actor => ({ id, name: id, role, costCenterIds });
const asha = actor('u_asha', 'REQUESTER', ['cc_mkt']);
const ravi = actor('u_ravi', 'MANAGER', ['cc_mkt']);
const neha = actor('u_neha', 'MANAGER', ['cc_eng']);
const kiran = actor('u_kiran', 'IT_ADMIN');

const order = (overrides: Partial<WorkflowOrder> = {}): WorkflowOrder => ({
  id: 'ord_1',
  userId: 'u_asha',
  costCenterId: 'cc_mkt',
  status: 'PENDING_APPROVAL',
  currentStep: 0,
  version: 1,
  steps: [
    { step: 0, role: 'MANAGER', status: 'PENDING' },
    { step: 1, role: 'IT_ADMIN', status: 'PENDING' },
  ],
  ...overrides,
});

function rejectsWith(fn: () => unknown, code: string, status: number) {
  assert.throws(fn, (error: unknown) => error instanceof HttpError && error.code === code && error.status === status);
}

describe('approval workflow', () => {
  it('moves to the next step, then places the order and commits the budget', () => {
    const first = transition(order(), { type: 'APPROVE' }, ravi, 1);
    assert.equal(first.status, 'PENDING_APPROVAL');
    assert.equal(first.currentStep, 1);
    assert.equal(first.budget, 'none');
    const last = transition(order({ currentStep: 1, version: 2 }), { type: 'APPROVE' }, kiran, 2);
    assert.deepEqual([last.status, last.budget, last.events], ['PLACED', 'commit', ['APPROVED', 'PLACED']]);
  });

  it('rejects with a reason, releasing the reservation and skipping later steps', () => {
    const t = transition(order(), { type: 'REJECT', comment: 'Use the existing monitors' }, ravi, 1);
    assert.deepEqual([t.status, t.budget, t.skipRemaining], ['REJECTED', 'release', true]);
    rejectsWith(() => transition(order(), { type: 'REJECT', comment: ' ' }, ravi, 1), 'comment_required', 400);
  });

  it('enforces separation of duties, the step role and the cost-center scope', () => {
    const own = order({ userId: 'u_ravi' });
    rejectsWith(() => transition(own, { type: 'APPROVE' }, ravi, 1), 'self_approval_forbidden', 403);
    rejectsWith(() => transition(order(), { type: 'APPROVE' }, kiran, 1), 'not_your_step', 403);
    rejectsWith(() => transition(order(), { type: 'APPROVE' }, neha, 1), 'out_of_scope', 403);
    assert.equal(canDecide(order(), ravi), true);
    assert.equal(canDecide(order(), neha), false);
  });

  it('uses the version for optimistic concurrency', () => {
    rejectsWith(() => transition(order({ version: 3 }), { type: 'APPROVE' }, ravi, 2), 'version_conflict', 409);
  });

  it('does not change orders that are already final', () => {
    for (const status of ['PLACED', 'REJECTED', 'CANCELLED'] as const) {
      rejectsWith(() => transition(order({ status }), { type: 'APPROVE' }, ravi, 1), 'invalid_state', 409);
    }
  });

  it('lets only the requester cancel', () => {
    assert.equal(transition(order(), { type: 'CANCEL' }, asha, 1).status, 'CANCELLED');
    rejectsWith(() => transition(order(), { type: 'CANCEL' }, ravi, 1), 'forbidden', 403);
  });

  it('limits visibility to the requester, scoped managers and company-wide roles', () => {
    assert.equal(canView(asha, order()), true);
    assert.equal(canView(ravi, order()), true);
    assert.equal(canView(neha, order()), false);
    assert.equal(canView(kiran, order()), true);
    assert.equal(canView(actor('u_vikram', 'REQUESTER', ['cc_mkt']), order()), false);
  });
});
