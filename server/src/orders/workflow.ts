import type { ApprovalStepStatus, OrderStatus, Role } from '../../../sdk/src/types.ts';
import { HttpError } from '../shared/http.ts';

// The order approval workflow as a pure state machine:
//
//   PENDING_APPROVAL --approve (more steps)--> PENDING_APPROVAL (next step)
//   PENDING_APPROVAL --approve (last step)---> PLACED      budget: reserved -> committed
//   PENDING_APPROVAL --reject----------------> REJECTED    budget: reservation released
//   PENDING_APPROVAL --cancel (requester)----> CANCELLED   budget: reservation released
//
// Orders that need no approval are created directly as PLACED.

export type Actor = { id: string; name: string; role: Role; costCenterIds: string[] };

export type WorkflowOrder = {
  id: string;
  userId: string;
  costCenterId: string;
  status: OrderStatus;
  currentStep: number;
  version: number;
  steps: { step: number; role: Role; status: ApprovalStepStatus }[];
};

export type WorkflowCommand = { type: 'APPROVE'; comment?: string } | { type: 'REJECT'; comment?: string } | { type: 'CANCEL' };

export type Transition = {
  status: OrderStatus;
  currentStep: number;
  decidedStep: { step: number; status: 'APPROVED' | 'REJECTED' } | null;
  skipRemaining: boolean;
  budget: 'commit' | 'release' | 'none';
  events: string[];
};

export const isCompanyWide = (role: Role): boolean => role === 'FINANCE' || role === 'IT_ADMIN';

export function canView(actor: Actor, order: Pick<WorkflowOrder, 'userId' | 'costCenterId'>): boolean {
  if (order.userId === actor.id || isCompanyWide(actor.role)) return true;
  return actor.role === 'MANAGER' && actor.costCenterIds.includes(order.costCenterId);
}

function checkApprover(order: WorkflowOrder, actor: Actor): void {
  if (actor.id === order.userId) throw new HttpError(403, 'self_approval_forbidden', 'You cannot approve or reject your own order');
  const step = order.steps[order.currentStep];
  if (!step) throw new HttpError(409, 'invalid_state', 'This order has no pending approval step');
  if (actor.role !== step.role) throw new HttpError(403, 'not_your_step', `This step needs a ${step.role} approver`);
  if (!isCompanyWide(actor.role) && !actor.costCenterIds.includes(order.costCenterId)) {
    throw new HttpError(403, 'out_of_scope', 'You are not an approver for this cost center');
  }
}

export function canDecide(order: WorkflowOrder, actor: Actor): boolean {
  if (order.status !== 'PENDING_APPROVAL') return false;
  try {
    checkApprover(order, actor);
    return true;
  } catch {
    return false;
  }
}

export function transition(order: WorkflowOrder, command: WorkflowCommand, actor: Actor, expectedVersion: number): Transition {
  if (expectedVersion !== order.version) {
    throw new HttpError(409, 'version_conflict', 'The order changed since you loaded it; refresh and try again', { currentVersion: order.version });
  }
  if (order.status !== 'PENDING_APPROVAL') {
    throw new HttpError(409, 'invalid_state', `Order is ${order.status} and can no longer change`);
  }
  if (command.type === 'CANCEL') {
    if (actor.id !== order.userId) throw new HttpError(403, 'forbidden', 'Only the requester can cancel this order');
    return { status: 'CANCELLED', currentStep: order.currentStep, decidedStep: null, skipRemaining: true, budget: 'release', events: ['CANCELLED'] };
  }
  checkApprover(order, actor);
  if (command.type === 'REJECT') {
    if ((command.comment ?? '').trim().length < 3) throw new HttpError(400, 'comment_required', 'Add a short reason when rejecting');
    return {
      status: 'REJECTED',
      currentStep: order.currentStep,
      decidedStep: { step: order.currentStep, status: 'REJECTED' },
      skipRemaining: true,
      budget: 'release',
      events: ['REJECTED'],
    };
  }
  const isLast = order.currentStep === order.steps.length - 1;
  return {
    status: isLast ? 'PLACED' : 'PENDING_APPROVAL',
    currentStep: isLast ? order.currentStep : order.currentStep + 1,
    decidedStep: { step: order.currentStep, status: 'APPROVED' },
    skipRemaining: false,
    budget: isLast ? 'commit' : 'none',
    events: isLast ? ['APPROVED', 'PLACED'] : ['APPROVED'],
  };
}
