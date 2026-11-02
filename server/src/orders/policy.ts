import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import type { RequiredApproval, Role } from '../../../sdk/src/types.ts';
import type { Logger } from '../shared/log.ts';

// Approval rules are configuration, not code: finance can change thresholds without a deploy.
// Every order records the policy version that evaluated it.
export type PolicyCondition = {
  totalAtLeast?: number;
  categoryIn?: string[];
  exceedsBudget?: boolean;
  lineQtyAtLeast?: number;
};

export type PolicyRule = { id: string; description: string; when: PolicyCondition; requireRole: Role };

export type ApprovalPolicy = { version: number; roleOrder: Role[]; escalationRole?: Role; rules: PolicyRule[] };

export type PolicyContext = {
  total: number;
  available: number;
  lines: { category: string; qty: number; lineTotal: number }[];
};

const APPROVER_ROLES: Role[] = ['MANAGER', 'IT_ADMIN', 'FINANCE'];
const CONDITION_KEYS = new Set(['totalAtLeast', 'categoryIn', 'exceedsBudget', 'lineQtyAtLeast']);

const isNonNegativeInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

export function validatePolicy(input: unknown): { policy: ApprovalPolicy | null; errors: string[] } {
  const errors: string[] = [];
  const p = input as Partial<ApprovalPolicy> | null;
  if (typeof p !== 'object' || p === null) return { policy: null, errors: ['policy must be an object'] };
  if (!Number.isInteger(p.version) || (p.version as number) < 1) errors.push('version must be a positive integer');
  if (!Array.isArray(p.roleOrder) || p.roleOrder.length === 0) {
    errors.push('roleOrder must be a non-empty array');
  } else {
    for (const role of p.roleOrder) if (!APPROVER_ROLES.includes(role)) errors.push(`roleOrder contains unknown role ${String(role)}`);
    if (new Set(p.roleOrder).size !== p.roleOrder.length) errors.push('roleOrder has duplicates');
  }
  if (p.escalationRole !== undefined && !(Array.isArray(p.roleOrder) && p.roleOrder.includes(p.escalationRole))) {
    errors.push('escalationRole must be listed in roleOrder');
  }
  if (!Array.isArray(p.rules) || p.rules.length === 0) {
    errors.push('rules must be a non-empty array');
  } else {
    const ids = new Set<string>();
    p.rules.forEach((rule, i) => {
      const at = `rules[${i}]`;
      if (typeof rule?.id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(rule.id)) errors.push(`${at}.id must be kebab-case`);
      else if (ids.has(rule.id)) errors.push(`${at}.id ${rule.id} is duplicated`);
      else ids.add(rule.id);
      if (typeof rule?.description !== 'string' || rule.description.trim() === '') errors.push(`${at}.description is required`);
      if (!Array.isArray(p.roleOrder) || !p.roleOrder.includes(rule?.requireRole)) errors.push(`${at}.requireRole must be listed in roleOrder`);
      const when = rule?.when as Record<string, unknown> | undefined;
      if (typeof when !== 'object' || when === null || Object.keys(when).length === 0) {
        errors.push(`${at}.when must have at least one condition`);
        return;
      }
      for (const key of Object.keys(when)) if (!CONDITION_KEYS.has(key)) errors.push(`${at}.when.${key} is not a known condition`);
      if (when.totalAtLeast !== undefined && !isNonNegativeInt(when.totalAtLeast)) errors.push(`${at}.when.totalAtLeast must be paise (integer >= 0)`);
      if (when.lineQtyAtLeast !== undefined && !(Number.isInteger(when.lineQtyAtLeast) && (when.lineQtyAtLeast as number) > 0)) {
        errors.push(`${at}.when.lineQtyAtLeast must be a positive integer`);
      }
      if (when.exceedsBudget !== undefined && typeof when.exceedsBudget !== 'boolean') errors.push(`${at}.when.exceedsBudget must be a boolean`);
      if (
        when.categoryIn !== undefined &&
        (!Array.isArray(when.categoryIn) || when.categoryIn.length === 0 || when.categoryIn.some((c) => typeof c !== 'string'))
      ) {
        errors.push(`${at}.when.categoryIn must be a non-empty array of category names`);
      }
    });
  }
  return errors.length > 0 ? { policy: null, errors } : { policy: p as ApprovalPolicy, errors: [] };
}

// All conditions in a rule must hold. With categoryIn, the amount and quantity conditions apply to
// the lines in those categories only (for example "IT hardware worth ₹5,000 or more").
function matches(when: PolicyCondition, ctx: PolicyContext): boolean {
  const scoped = when.categoryIn ? ctx.lines.filter((l) => when.categoryIn!.includes(l.category)) : ctx.lines;
  if (when.categoryIn && scoped.length === 0) return false;
  if (when.totalAtLeast !== undefined) {
    const amount = when.categoryIn ? scoped.reduce((sum, l) => sum + l.lineTotal, 0) : ctx.total;
    if (amount < when.totalAtLeast) return false;
  }
  if (when.lineQtyAtLeast !== undefined && !scoped.some((l) => l.qty >= when.lineQtyAtLeast!)) return false;
  if (when.exceedsBudget !== undefined && ctx.total > ctx.available !== when.exceedsBudget) return false;
  return true;
}

// Returns the approval chain: one step per role, ordered by roleOrder. Empty means auto-approve.
export function evaluatePolicy(policy: ApprovalPolicy, ctx: PolicyContext): RequiredApproval[] {
  const byRole = new Map<Role, RequiredApproval>();
  for (const rule of policy.rules) {
    if (!matches(rule.when, ctx)) continue;
    const existing = byRole.get(rule.requireRole);
    if (existing) existing.reason = `${existing.reason}; ${rule.description}`;
    else byRole.set(rule.requireRole, { role: rule.requireRole, ruleId: rule.id, reason: rule.description });
  }
  return [...byRole.values()].sort((a, b) => policy.roleOrder.indexOf(a.role) - policy.roleOrder.indexOf(b.role));
}

const ROLE_TEXT: Record<Role, string> = { REQUESTER: 'requester', MANAGER: 'manager', IT_ADMIN: 'IT admin', FINANCE: 'finance approver' };

// A step that nobody but the requester could approve (for example a manager ordering for their own
// cost center) escalates to the policy's escalation role, so an order can never get stuck.
export function escalateUnapprovable(policy: ApprovalPolicy, steps: RequiredApproval[], hasApprover: (role: Role) => boolean): RequiredApproval[] {
  const escalationRole = policy.escalationRole ?? policy.roleOrder[policy.roleOrder.length - 1]!;
  const byRole = new Map<Role, RequiredApproval>();
  const add = (step: RequiredApproval) => {
    const existing = byRole.get(step.role);
    if (existing) existing.reason = `${existing.reason}; ${step.reason}`;
    else byRole.set(step.role, { ...step });
  };
  for (const step of steps) {
    if (step.role === escalationRole || hasApprover(step.role)) add(step);
    else add({ role: escalationRole, ruleId: step.ruleId, reason: `${step.reason} (escalated: no other ${ROLE_TEXT[step.role]} can approve)` });
  }
  return [...byRole.values()].sort((a, b) => policy.roleOrder.indexOf(a.role) - policy.roleOrder.indexOf(b.role));
}

export function loadPolicyFile(path: string): ApprovalPolicy {
  const { policy, errors } = validatePolicy(JSON.parse(readFileSync(path, 'utf8')));
  if (!policy) throw new Error(`Invalid approval policy ${path}: ${errors.join('; ')}`);
  return policy;
}

// Holds the active policy. With watch enabled, edits are hot-reloaded; an invalid edit is rejected
// and the last good policy stays active.
export class PolicyStore {
  #policy: ApprovalPolicy;
  #path: string;
  #logger: Logger;
  #watching = false;

  constructor(path: string, logger: Logger, options: { watch?: boolean } = {}) {
    this.#path = path;
    this.#logger = logger;
    this.#policy = loadPolicyFile(path);
    if (options.watch) {
      this.#watching = true;
      watchFile(path, { interval: 1000 }, () => this.reload());
    }
  }

  current(): ApprovalPolicy {
    return this.#policy;
  }

  reload(): boolean {
    try {
      const next = loadPolicyFile(this.#path);
      if (next.version !== this.#policy.version) this.#logger.info('policy_reloaded', { from: this.#policy.version, to: next.version });
      this.#policy = next;
      return true;
    } catch (error) {
      this.#logger.error('policy_reload_rejected', { error: (error as Error).message, activeVersion: this.#policy.version });
      return false;
    }
  }

  close(): void {
    if (this.#watching) unwatchFile(this.#path);
  }
}
