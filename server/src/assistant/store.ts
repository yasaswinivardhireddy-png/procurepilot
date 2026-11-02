import type { StatementSync } from 'node:sqlite';
import type { PendingAction, PendingActionStatus } from '../../../sdk/src/types.ts';
import { nowIso, openDb, type Db } from '../shared/db.ts';
import { newId } from '../shared/ids.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  messages TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  exec_args TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'EXECUTING', 'EXECUTED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  result TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS actions_by_user ON actions (user_id, created_at);
`;

// Conversation memory keeps the dialogue text only. Tool results go stale (prices, carts and
// budgets change), so each turn fetches live data through the tools again.
export type MemoryMessage = { role: 'user' | 'assistant'; text: string };

type ActionRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  tool: string;
  args: string;
  exec_args: string;
  summary: string;
  status: PendingActionStatus;
  result: string | null;
  expires_at: string;
};

export type StoredAction = PendingAction & { userId: string; conversationId: string; execArgs: Record<string, unknown> };

const MAX_MEMORY = 20;

export class AssistantStore {
  db: Db;
  #statements = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = openDb(path);
    this.db.exec(SCHEMA);
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

  getConversation(id: string, userId: string): MemoryMessage[] | null {
    const row = this.#stmt('SELECT messages FROM conversations WHERE id = ? AND user_id = ?').get(id, userId) as { messages: string } | undefined;
    return row ? (JSON.parse(row.messages) as MemoryMessage[]) : null;
  }

  saveConversation(id: string, userId: string, messages: MemoryMessage[]): void {
    const now = nowIso();
    this.#stmt(
      `INSERT INTO conversations (id, user_id, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
    ).run(id, userId, JSON.stringify(messages.slice(-MAX_MEMORY)), now, now);
  }

  createAction(input: {
    userId: string;
    conversationId: string;
    tool: string;
    args: Record<string, unknown>;
    execArgs: Record<string, unknown>;
    summary: string;
    ttlMs: number;
  }): StoredAction {
    const id = newId('act');
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    this.#stmt(
      `INSERT INTO actions (id, user_id, conversation_id, tool, args, exec_args, summary, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    ).run(id, input.userId, input.conversationId, input.tool, JSON.stringify(input.args), JSON.stringify(input.execArgs), input.summary, nowIso(), expiresAt);
    return this.getAction(id)!;
  }

  getAction(id: string): StoredAction | null {
    const row = this.#stmt('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      conversationId: row.conversation_id,
      tool: row.tool,
      args: JSON.parse(row.args) as Record<string, unknown>,
      execArgs: JSON.parse(row.exec_args) as Record<string, unknown>,
      summary: row.summary,
      status: row.status,
      expiresAt: row.expires_at,
      result: row.result === null ? null : JSON.parse(row.result),
    };
  }

  // Compare-and-set: moves an action from one status to another only if it is still in `from`.
  // Returns false when another request changed it first.
  transition(id: string, from: PendingActionStatus, to: PendingActionStatus, result?: unknown): boolean {
    const changes =
      result === undefined
        ? this.#stmt('UPDATE actions SET status = ?, decided_at = ? WHERE id = ? AND status = ?').run(to, nowIso(), id, from).changes
        : this.#stmt('UPDATE actions SET status = ?, result = ?, decided_at = ? WHERE id = ? AND status = ?').run(to, JSON.stringify(result), nowIso(), id, from).changes;
    return Number(changes) === 1;
  }
}

export function publicAction(action: StoredAction): PendingAction {
  return { id: action.id, tool: action.tool, args: action.args, summary: action.summary, status: action.status, expiresAt: action.expiresAt, result: action.result };
}
