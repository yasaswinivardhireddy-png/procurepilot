import type { StatementSync } from 'node:sqlite';
import type {
  ApprovalStep,
  Budget,
  BuyAgainItem,
  CartItemInput,
  DemoUser,
  Order,
  OrderEvent,
  OrderLine,
  OrderStatus,
  OrderSummary,
  Paged,
  Quote,
  RequiredApproval,
  Role,
  User,
} from '../../../sdk/src/types.ts';
import { nowIso, openDb, transaction, type Db } from '../shared/db.ts';
import { HttpError } from '../shared/http.ts';
import { newId } from '../shared/ids.ts';
import { isCompanyWide, type Actor, type Transition, type WorkflowOrder } from './workflow.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('REQUESTER', 'MANAGER', 'IT_ADMIN', 'FINANCE'))
);
CREATE TABLE IF NOT EXISTS cost_centers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  budget INTEGER NOT NULL CHECK (budget >= 0),
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  cost_center_id TEXT NOT NULL REFERENCES cost_centers(id),
  PRIMARY KEY (user_id, cost_center_id)
);
CREATE TABLE IF NOT EXISTS cart_items (
  user_id TEXT NOT NULL REFERENCES users(id),
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0 AND qty <= 10000),
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, sku)
);
CREATE TABLE IF NOT EXISTS orders (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  cost_center_id TEXT NOT NULL REFERENCES cost_centers(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  po_number TEXT,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'PLACED', 'REJECTED', 'CANCELLED')),
  subtotal INTEGER NOT NULL,
  gst INTEGER NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  policy_version INTEGER NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS orders_by_user ON orders (user_id, seq);
CREATE INDEX IF NOT EXISTS orders_by_cost_center ON orders (cost_center_id, status);
CREATE TABLE IF NOT EXISTS order_lines (
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  line_subtotal INTEGER NOT NULL,
  gst INTEGER NOT NULL,
  PRIMARY KEY (order_id, sku)
);
CREATE TABLE IF NOT EXISTS approval_steps (
  order_id TEXT NOT NULL REFERENCES orders(id),
  step INTEGER NOT NULL,
  role TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED')),
  decided_by TEXT,
  decided_at TEXT,
  comment TEXT,
  PRIMARY KEY (order_id, step)
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_order ON order_events (order_id, id);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`;

export const COST_CENTERS = [
  { id: 'cc_eng', name: 'Engineering', budget: 120_000_000 },
  { id: 'cc_ops', name: 'Facilities', budget: 20_000_000 },
  { id: 'cc_mkt', name: 'Marketing', budget: 30_000_000 },
];

export const USERS: User[] = [
  { id: 'u_asha', name: 'Asha Reddy', title: 'Marketing Executive', role: 'REQUESTER', costCenterIds: ['cc_mkt', 'cc_ops'] },
  { id: 'u_vikram', name: 'Vikram Rao', title: 'Software Engineer', role: 'REQUESTER', costCenterIds: ['cc_eng'] },
  { id: 'u_ravi', name: 'Ravi Kumar', title: 'Marketing Manager', role: 'MANAGER', costCenterIds: ['cc_mkt', 'cc_ops'] },
  { id: 'u_neha', name: 'Neha Sharma', title: 'Engineering Manager', role: 'MANAGER', costCenterIds: ['cc_eng'] },
  { id: 'u_kiran', name: 'Kiran Patel', title: 'IT Administrator', role: 'IT_ADMIN', costCenterIds: [] },
  { id: 'u_meera', name: 'Meera Iyer', title: 'Finance Controller', role: 'FINANCE', costCenterIds: [] },
];

const ROLE_LABELS: Record<Role, string> = { REQUESTER: 'Requester', MANAGER: 'Manager', IT_ADMIN: 'IT admin', FINANCE: 'Finance' };

const SUMMARY_SELECT = `
SELECT o.id, o.seq, o.status, o.user_id, u.name AS requester_name, o.cost_center_id, cc.name AS cost_center_name,
  o.total, o.subtotal, o.gst, o.version, o.created_at, o.po_number, o.note, o.policy_version,
  (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS item_count,
  CASE WHEN o.status = 'PENDING_APPROVAL'
    THEN (SELECT cs.role FROM approval_steps cs WHERE cs.order_id = o.id AND cs.step = o.current_step) END AS current_role
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN cost_centers cc ON cc.id = o.cost_center_id`;

type SummaryRow = {
  id: string;
  seq: number;
  status: OrderStatus;
  user_id: string;
  requester_name: string;
  cost_center_id: string;
  cost_center_name: string;
  total: number;
  subtotal: number;
  gst: number;
  version: number;
  created_at: string;
  po_number: string | null;
  note: string | null;
  policy_version: number;
  item_count: number;
  current_role: Role | null;
};

type CostCenterRow = { id: string; name: string; budget: number; committed: number; reserved: number };

type Param = string | number | null;

export type OrderScope = { kind: 'mine'; userId: string } | { kind: 'team'; managerId: string } | { kind: 'all' };

export const ORDER_NUMBER_BASE = 1000;

function toSummary(row: SummaryRow): OrderSummary {
  return {
    id: row.id,
    number: ORDER_NUMBER_BASE + row.seq,
    status: row.status,
    requesterId: row.user_id,
    requesterName: row.requester_name,
    costCenterId: row.cost_center_id,
    costCenterName: row.cost_center_name,
    total: row.total,
    itemCount: row.item_count,
    currentApproverRole: row.current_role,
    version: row.version,
    createdAt: row.created_at,
  };
}

function toBudget(row: CostCenterRow): Budget {
  return {
    costCenterId: row.id,
    name: row.name,
    budget: row.budget,
    committed: row.committed,
    reserved: row.reserved,
    available: row.budget - row.committed - row.reserved,
  };
}

export class OrdersStore {
  db: Db;
  #statements = new Map<string, StatementSync>();

  constructor(path: string, options: { loadTestUsers?: number } = {}) {
    this.db = openDb(path);
    this.db.exec(SCHEMA);
    this.#seed();
    if (options.loadTestUsers) this.#seedLoadTestUsers(options.loadTestUsers);
  }

  close(): void {
    this.db.close();
  }

  #stmt(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.#stmt(sql).get(...params) as T | undefined;
  }

  #all<T>(sql: string, ...params: Param[]): T[] {
    return this.#stmt(sql).all(...params) as T[];
  }

  #run(sql: string, ...params: Param[]): number {
    return Number(this.#stmt(sql).run(...params).changes);
  }

  #seed(): void {
    if (this.#get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n > 0) return;
    transaction(this.db, () => {
      for (const cc of COST_CENTERS) this.#run('INSERT INTO cost_centers (id, name, budget) VALUES (?, ?, ?)', cc.id, cc.name, cc.budget);
      for (const user of USERS) {
        this.#run('INSERT INTO users (id, name, title, role) VALUES (?, ?, ?, ?)', user.id, user.name, user.title, user.role);
        for (const cc of user.costCenterIds) this.#run('INSERT INTO memberships (user_id, cost_center_id) VALUES (?, ?)', user.id, cc);
      }
    });
  }

  // Requester accounts for load and chaos tests, each with its own cart, on a large test budget.
  #seedLoadTestUsers(count: number): void {
    transaction(this.db, () => {
      this.#run("INSERT OR IGNORE INTO cost_centers (id, name, budget) VALUES ('cc_load', 'Load test', 100000000000)");
      for (let i = 1; i <= count; i++) {
        const id = `u_load_${String(i).padStart(3, '0')}`;
        this.#run("INSERT OR IGNORE INTO users (id, name, title, role) VALUES (?, ?, 'Load test buyer', 'REQUESTER')", id, `Load User ${i}`);
        this.#run("INSERT OR IGNORE INTO memberships (user_id, cost_center_id) VALUES (?, 'cc_load')", id);
      }
    });
  }

  // Users and budgets
  getUser(id: string): User | null {
    const row = this.#get<{ id: string; name: string; title: string; role: Role }>('SELECT id, name, title, role FROM users WHERE id = ?', id);
    if (!row) return null;
    const costCenterIds = this.#all<{ cost_center_id: string }>(
      'SELECT cost_center_id FROM memberships WHERE user_id = ? ORDER BY cost_center_id',
      id,
    ).map((r) => r.cost_center_id);
    return { ...row, costCenterIds };
  }

  listUsers(): DemoUser[] {
    return this.#all<DemoUser>(
      `SELECT id, name, title, role FROM users
       ORDER BY CASE role WHEN 'REQUESTER' THEN 0 WHEN 'MANAGER' THEN 1 WHEN 'IT_ADMIN' THEN 2 ELSE 3 END, name`,
    );
  }

  budgetsFor(user: User): Budget[] {
    const rows = isCompanyWide(user.role)
      ? this.#all<CostCenterRow>('SELECT id, name, budget, committed, reserved FROM cost_centers ORDER BY name')
      : this.#all<CostCenterRow>(
          `SELECT cc.id, cc.name, cc.budget, cc.committed, cc.reserved FROM cost_centers cc
           JOIN memberships m ON m.cost_center_id = cc.id WHERE m.user_id = ? ORDER BY cc.name`,
          user.id,
        );
    return rows.map(toBudget);
  }

  costCenter(id: string): Budget | null {
    const row = this.#get<CostCenterRow>('SELECT id, name, budget, committed, reserved FROM cost_centers WHERE id = ?', id);
    return row ? toBudget(row) : null;
  }

  // Cart
  cartItems(userId: string): CartItemInput[] {
    return this.#all<CartItemInput>('SELECT sku, qty FROM cart_items WHERE user_id = ? ORDER BY added_at, sku', userId);
  }

  setCartItem(userId: string, sku: string, qty: number): void {
    if (qty === 0) {
      this.#run('DELETE FROM cart_items WHERE user_id = ? AND sku = ?', userId, sku);
      return;
    }
    this.#run(
      `INSERT INTO cart_items (user_id, sku, qty, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, sku) DO UPDATE SET qty = excluded.qty`,
      userId,
      sku,
      qty,
      nowIso(),
    );
  }

  addCartItem(userId: string, sku: string, qty: number): void {
    this.#run(
      `INSERT INTO cart_items (user_id, sku, qty, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, sku) DO UPDATE SET qty = MIN(10000, cart_items.qty + excluded.qty)`,
      userId,
      sku,
      qty,
      nowIso(),
    );
  }

  clearCart(userId: string): void {
    this.#run('DELETE FROM cart_items WHERE user_id = ?', userId);
  }

  // Idempotency
  findIdempotent(userId: string, key: string): { requestHash: string; status: number; body: string } | null {
    const row = this.#get<{ request_hash: string; status: number; body: string }>(
      'SELECT request_hash, status, body FROM idempotency_keys WHERE user_id = ? AND key = ?',
      userId,
      key,
    );
    return row ? { requestHash: row.request_hash, status: row.status, body: row.body } : null;
  }

  saveIdempotent(userId: string, key: string, requestHash: string, status: number, body: unknown): void {
    this.#run(
      'INSERT INTO idempotency_keys (user_id, key, request_hash, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId,
      key,
      requestHash,
      status,
      JSON.stringify(body ?? null),
      nowIso(),
    );
  }

  purgeIdempotency(beforeIso: string): number {
    return this.#run('DELETE FROM idempotency_keys WHERE created_at < ?', beforeIso);
  }

  // Orders keep their idempotency key and request hash forever, so a checkout replayed after the
  // general idempotency records were purged (say, a phone offline for days) still finds its order.
  orderByIdempotencyKey(userId: string, key: string): { id: string; requestHash: string } | null {
    const row = this.#get<{ id: string; request_hash: string }>('SELECT id, request_hash FROM orders WHERE user_id = ? AND idempotency_key = ?', userId, key);
    return row ? { id: row.id, requestHash: row.request_hash } : null;
  }

  // True if someone other than the requester can approve a step with this role on this cost center.
  hasEligibleApprover(role: Role, costCenterId: string, excludeUserId: string): boolean {
    const row = this.#get<{ found: number }>(
      `SELECT 1 AS found FROM users u
       WHERE u.role = ? AND u.id <> ?
         AND (? = 1 OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.cost_center_id = ?))
       LIMIT 1`,
      role,
      excludeUserId,
      isCompanyWide(role) ? 1 : 0,
      costCenterId,
    );
    return row !== undefined;
  }

  // Orders
  createOrder(input: {
    user: User;
    costCenterId: string;
    poNumber: string | null;
    note: string | null;
    quote: Quote;
    approvals: RequiredApproval[];
    policyVersion: number;
    idempotencyKey: string;
    requestHash: string;
  }): Order {
    const id = newId('ord');
    const now = nowIso();
    const { quote, approvals, user } = input;
    const status: OrderStatus = approvals.length === 0 ? 'PLACED' : 'PENDING_APPROVAL';
    this.#run(
      `INSERT INTO orders (id, user_id, cost_center_id, idempotency_key, request_hash, po_number, note, status, subtotal, gst, total,
         policy_version, current_step, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      id,
      user.id,
      input.costCenterId,
      input.idempotencyKey,
      input.requestHash,
      input.poNumber,
      input.note,
      status,
      quote.subtotal,
      quote.gst,
      quote.total,
      input.policyVersion,
      now,
      now,
    );
    for (const line of quote.lines) {
      this.#run(
        `INSERT INTO order_lines (order_id, sku, title, category, qty, unit_price, line_subtotal, gst)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        line.sku,
        line.title,
        line.category,
        line.qty,
        line.unitPrice,
        line.lineSubtotal,
        line.gst,
      );
    }
    approvals.forEach((a, step) => {
      this.#run('INSERT INTO approval_steps (order_id, step, role, rule_id, reason) VALUES (?, ?, ?, ?, ?)', id, step, a.role, a.ruleId, a.reason);
    });
    this.#event(id, 'CREATED', user.name, `${quote.lines.length} line(s) under policy v${input.policyVersion}`);
    if (status === 'PLACED') {
      this.#run('UPDATE cost_centers SET committed = committed + ? WHERE id = ?', quote.total, input.costCenterId);
      this.#event(id, 'AUTO_APPROVED', 'Policy engine', 'Within policy limits; no approval needed');
      this.#event(id, 'PLACED', 'Policy engine', 'Order placed with sellers');
    } else {
      this.#run('UPDATE cost_centers SET reserved = reserved + ? WHERE id = ?', quote.total, input.costCenterId);
      this.#event(id, 'SUBMITTED', user.name, `Needs approval from ${approvals.map((a) => ROLE_LABELS[a.role]).join(' → ')}`);
    }
    return this.getOrder(id)!;
  }

  workflowOrder(id: string): (WorkflowOrder & { total: number }) | null {
    const row = this.#get<{ id: string; user_id: string; cost_center_id: string; status: OrderStatus; current_step: number; version: number; total: number }>(
      'SELECT id, user_id, cost_center_id, status, current_step, version, total FROM orders WHERE id = ?',
      id,
    );
    if (!row) return null;
    const steps = this.#all<WorkflowOrder['steps'][number]>('SELECT step, role, status FROM approval_steps WHERE order_id = ? ORDER BY step', id);
    return {
      id: row.id,
      userId: row.user_id,
      costCenterId: row.cost_center_id,
      status: row.status,
      currentStep: row.current_step,
      version: row.version,
      total: row.total,
      steps,
    };
  }

  applyTransition(order: WorkflowOrder & { total: number }, t: Transition, actor: Actor, comment: string | null): void {
    const now = nowIso();
    const changed = this.#run(
      'UPDATE orders SET status = ?, current_step = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
      t.status,
      t.currentStep,
      now,
      order.id,
      order.version,
    );
    if (changed !== 1) throw new HttpError(409, 'version_conflict', 'The order changed; refresh and try again');
    if (t.decidedStep) {
      this.#run(
        'UPDATE approval_steps SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE order_id = ? AND step = ?',
        t.decidedStep.status,
        actor.name,
        now,
        comment,
        order.id,
        t.decidedStep.step,
      );
    }
    if (t.skipRemaining) this.#run("UPDATE approval_steps SET status = 'SKIPPED' WHERE order_id = ? AND status = 'PENDING'", order.id);
    if (t.budget === 'commit') {
      this.#run('UPDATE cost_centers SET reserved = reserved - ?, committed = committed + ? WHERE id = ?', order.total, order.total, order.costCenterId);
    } else if (t.budget === 'release') {
      this.#run('UPDATE cost_centers SET reserved = reserved - ? WHERE id = ?', order.total, order.costCenterId);
    }
    for (const type of t.events) {
      const detail =
        type === 'APPROVED'
          ? `${ROLE_LABELS[actor.role]} approved${comment ? `: ${comment}` : ''}`
          : type === 'REJECTED'
            ? `${ROLE_LABELS[actor.role]} rejected: ${comment ?? ''}`
            : type === 'CANCELLED'
              ? 'Cancelled by the requester'
              : 'All approvals complete; order placed with sellers';
      this.#event(order.id, type, type === 'PLACED' ? 'Workflow' : actor.name, detail);
    }
  }

  #event(orderId: string, type: string, actor: string, detail: string | null): void {
    this.#run('INSERT INTO order_events (order_id, type, actor, detail, at) VALUES (?, ?, ?, ?, ?)', orderId, type, actor, detail, nowIso());
  }

  getOrder(id: string): Order | null {
    const row = this.#get<SummaryRow>(`${SUMMARY_SELECT} WHERE o.id = ?`, id);
    if (!row) return null;
    const lines = this.#all<{ sku: string; title: string; category: string; qty: number; unit_price: number; line_subtotal: number; gst: number }>(
      'SELECT sku, title, category, qty, unit_price, line_subtotal, gst FROM order_lines WHERE order_id = ? ORDER BY rowid',
      id,
    ).map(
      (l): OrderLine => ({ sku: l.sku, title: l.title, category: l.category, qty: l.qty, unitPrice: l.unit_price, lineSubtotal: l.line_subtotal, gst: l.gst }),
    );
    const approvals = this.#all<{
      step: number;
      role: Role;
      rule_id: string;
      reason: string;
      status: ApprovalStep['status'];
      decided_by: string | null;
      decided_at: string | null;
      comment: string | null;
    }>('SELECT step, role, rule_id, reason, status, decided_by, decided_at, comment FROM approval_steps WHERE order_id = ? ORDER BY step', id).map(
      (s): ApprovalStep => ({
        step: s.step,
        role: s.role,
        ruleId: s.rule_id,
        reason: s.reason,
        status: s.status,
        decidedBy: s.decided_by,
        decidedAt: s.decided_at,
        comment: s.comment,
      }),
    );
    const events = this.#all<OrderEvent>('SELECT type, actor, detail, at FROM order_events WHERE order_id = ? ORDER BY id', id);
    return {
      ...toSummary(row),
      poNumber: row.po_number,
      note: row.note,
      subtotal: row.subtotal,
      gst: row.gst,
      policyVersion: row.policy_version,
      lines,
      approvals,
      events,
    };
  }

  listOrders(scope: OrderScope, filter: { status?: OrderStatus; limit: number; offset: number }): Paged<OrderSummary> {
    const where: string[] = [];
    const params: Param[] = [];
    if (scope.kind === 'mine') {
      where.push('o.user_id = ?');
      params.push(scope.userId);
    } else if (scope.kind === 'team') {
      where.push('o.cost_center_id IN (SELECT cost_center_id FROM memberships WHERE user_id = ?)');
      params.push(scope.managerId);
    }
    if (filter.status) {
      where.push('o.status = ?');
      params.push(filter.status);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const total = this.#get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders o${clause}`, ...params)!.n;
    const items = this.#all<SummaryRow>(`${SUMMARY_SELECT}${clause} ORDER BY o.seq DESC LIMIT ? OFFSET ?`, ...params, filter.limit, filter.offset).map(toSummary);
    return { items, total };
  }

  pendingFor(actor: Actor): OrderSummary[] {
    return this.#all<SummaryRow>(
      `${SUMMARY_SELECT}
       JOIN approval_steps s ON s.order_id = o.id AND s.step = o.current_step
       WHERE o.status = 'PENDING_APPROVAL' AND s.role = ? AND o.user_id <> ?
         AND (? = 1 OR o.cost_center_id IN (SELECT cost_center_id FROM memberships WHERE user_id = ?))
       ORDER BY o.seq ASC LIMIT 100`,
      actor.role,
      actor.id,
      isCompanyWide(actor.role) ? 1 : 0,
      actor.id,
    ).map(toSummary);
  }

  buyAgain(userId: string, limit: number): BuyAgainItem[] {
    return this.#all<{ sku: string; times: number; last_qty: number }>(
      `SELECT l.sku, COUNT(*) AS times,
         (SELECT l2.qty FROM order_lines l2 JOIN orders o2 ON o2.id = l2.order_id
          WHERE o2.user_id = ? AND l2.sku = l.sku ORDER BY o2.seq DESC LIMIT 1) AS last_qty
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE o.user_id = ? AND o.status = 'PLACED'
       GROUP BY l.sku ORDER BY times DESC, MAX(o.seq) DESC LIMIT ?`,
      userId,
      userId,
      limit,
    ).map((r) => ({ sku: r.sku, timesOrdered: r.times, lastQty: r.last_qty }));
  }

  // Recomputes committed and reserved budget from the orders and compares with the running totals.
  audit(): {
    balanced: boolean;
    orders: number;
    duplicateIdempotencyKeys: number;
    costCenters: { id: string; committed: number; reserved: number; placedTotal: number; pendingTotal: number }[];
  } {
    const costCenters = this.#all<{ id: string; committed: number; reserved: number; placedTotal: number; pendingTotal: number }>(
      `SELECT cc.id, cc.committed, cc.reserved,
         COALESCE((SELECT SUM(total) FROM orders o WHERE o.cost_center_id = cc.id AND o.status = 'PLACED'), 0) AS placedTotal,
         COALESCE((SELECT SUM(total) FROM orders o WHERE o.cost_center_id = cc.id AND o.status = 'PENDING_APPROVAL'), 0) AS pendingTotal
       FROM cost_centers cc ORDER BY cc.id`,
    );
    const orders = this.#get<{ n: number }>('SELECT COUNT(*) AS n FROM orders')!.n;
    const duplicateIdempotencyKeys = this.#get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM (SELECT user_id, idempotency_key FROM orders GROUP BY user_id, idempotency_key HAVING COUNT(*) > 1)',
    )!.n;
    const balanced = costCenters.every((c) => c.committed === c.placedTotal && c.reserved === c.pendingTotal) && duplicateIdempotencyKeys === 0;
    return { balanced, orders, duplicateIdempotencyKeys, costCenters };
  }
}
