import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_POLICY_PATH } from '../server/src/orders/service.ts';
import { PolicyStore, escalateUnapprovable, evaluatePolicy, loadPolicyFile, validatePolicy, type PolicyContext } from '../server/src/orders/policy.ts';
import { createLogger } from '../server/src/shared/log.ts';

const policy = loadPolicyFile(DEFAULT_POLICY_PATH);
const ctx = (total: number, lines: PolicyContext['lines'], available = 100_000_000): PolicyContext => ({ total, available, lines });
const office = (lineTotal: number, qty = 10) => ({ category: 'Office Supplies', qty, lineTotal });
const it_ = (lineTotal: number, qty = 1) => ({ category: 'IT & Electronics', qty, lineTotal });

describe('approval policy', () => {
  it('auto-approves small orders', () => {
    assert.deepEqual(evaluatePolicy(policy, ctx(1_000_000, [office(1_000_000)])), []);
  });

  it('requires the manager from ₹25,000', () => {
    assert.deepEqual(
      evaluatePolicy(policy, ctx(2_500_000, [office(2_500_000)])).map((s) => s.role),
      ['MANAGER'],
    );
  });

  it('applies amount conditions to the scoped category only', () => {
    // ₹4,000 of IT hardware inside a ₹30,000 order: manager yes, IT admin no.
    const steps = evaluatePolicy(policy, ctx(3_000_000, [office(2_600_000), it_(400_000)]));
    assert.deepEqual(steps.map((s) => s.role), ['MANAGER']);
    const withIt = evaluatePolicy(policy, ctx(3_200_000, [office(2_600_000), it_(600_000)]));
    assert.deepEqual(withIt.map((s) => s.role), ['MANAGER', 'IT_ADMIN']);
  });

  it('merges rules for the same role into one step and orders steps by roleOrder', () => {
    const steps = evaluatePolicy(policy, ctx(25_000_000, [it_(25_000_000, 3)], 10_000_000));
    assert.deepEqual(steps.map((s) => s.role), ['MANAGER', 'IT_ADMIN', 'FINANCE']);
    const finance = steps.find((s) => s.role === 'FINANCE')!;
    assert.equal(finance.ruleId, 'finance-above-2l');
    assert.match(finance.reason, /₹2,00,000/);
    assert.match(finance.reason, /remaining cost-center budget/);
  });

  it('routes over-budget orders to Finance even when they are small', () => {
    assert.deepEqual(evaluatePolicy(policy, ctx(500_000, [office(500_000)], 100_000)).map((s) => s.role), ['FINANCE']);
  });

  it('flags bulk quantities', () => {
    assert.deepEqual(evaluatePolicy(policy, ctx(1_000_000, [office(1_000_000, 250)])).map((s) => s.role), ['MANAGER']);
  });

  it('escalates steps that nobody but the requester could approve', () => {
    const managerStep = evaluatePolicy(policy, ctx(3_000_000, [office(3_000_000)]));
    const routed = escalateUnapprovable(policy, managerStep, (role) => role !== 'MANAGER');
    assert.deepEqual(routed.map((s) => s.role), ['FINANCE']);
    assert.match(routed[0]!.reason, /escalated: no other manager can approve/);
    const merged = escalateUnapprovable(
      policy,
      [
        { role: 'MANAGER', ruleId: 'a', reason: 'Big order' },
        { role: 'FINANCE', ruleId: 'b', reason: 'Over budget' },
      ],
      (role) => role !== 'MANAGER',
    );
    assert.deepEqual(merged.map((s) => s.role), ['FINANCE']);
    assert.match(merged[0]!.reason, /Big order.*Over budget/);
    assert.deepEqual(escalateUnapprovable(policy, managerStep, () => true), managerStep);
  });

  it('rejects invalid policies with useful errors', () => {
    const { policy: parsed, errors } = validatePolicy({
      version: 0,
      roleOrder: ['MANAGER', 'CEO'],
      escalationRole: 'FINANCE',
      rules: [
        { id: 'Bad Id', description: '', when: {}, requireRole: 'FINANCE' },
        { id: 'x', description: 'x', when: { totalAtLeast: -1, colour: 'red' }, requireRole: 'MANAGER' },
      ],
    });
    assert.equal(parsed, null);
    for (const fragment of ['version', 'unknown role CEO', 'escalationRole', 'kebab-case', 'description', 'at least one condition', 'roleOrder', 'colour', 'totalAtLeast']) {
      assert.ok(errors.some((e) => e.includes(fragment)), `expected an error about ${fragment}: ${errors.join(' | ')}`);
    }
  });

  it('keeps the last good policy when a hot reload is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-policy-'));
    try {
      const file = join(dir, 'policy.json');
      writeFileSync(file, JSON.stringify(policy));
      const store = new PolicyStore(file, createLogger('test', 'silent'));
      writeFileSync(file, JSON.stringify({ ...policy, version: 99, rules: [] }));
      assert.equal(store.reload(), false);
      assert.equal(store.current().version, policy.version);
      writeFileSync(file, JSON.stringify({ ...policy, version: 5 }));
      assert.equal(store.reload(), true);
      assert.equal(store.current().version, 5);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
