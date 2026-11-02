import type { StatementSync } from 'node:sqlite';
import type { User } from '../../../sdk/src/types.ts';
import { nowIso, openDb, type Db } from '../shared/db.ts';
import { newToken, sha256 } from '../shared/ids.ts';

export type SessionInfo = { key: string; user: User };

// Bearer sessions for the app. Only a SHA-256 hash of each token is stored, so a copy of the
// database cannot be used to sign in. The user profile is cached in the session so the home
// screen can still render if the orders service is down.
export class SessionStore {
  db: Db;
  #ttlMs: number;
  #cache = new Map<string, { user: User; expiresAt: number }>();
  #insert: StatementSync;
  #select: StatementSync;
  #delete: StatementSync;

  constructor(path: string, ttlMs = 12 * 3_600_000) {
    this.db = openDb(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    this.#ttlMs = ttlMs;
    this.#insert = this.db.prepare('INSERT INTO sessions (token_hash, user_json, created_at, expires_at) VALUES (?, ?, ?, ?)');
    this.#select = this.db.prepare('SELECT user_json, expires_at FROM sessions WHERE token_hash = ?');
    this.#delete = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  }

  close(): void {
    this.db.close();
  }

  create(user: User): string {
    const token = newToken('pp');
    this.#insert.run(sha256(token), JSON.stringify(user), nowIso(), Date.now() + this.#ttlMs);
    return token;
  }

  resolve(token: string): SessionInfo | null {
    const key = sha256(token);
    const now = Date.now();
    let entry = this.#cache.get(key);
    if (!entry) {
      const row = this.#select.get(key) as { user_json: string; expires_at: number } | undefined;
      if (!row) return null;
      entry = { user: JSON.parse(row.user_json) as User, expiresAt: row.expires_at };
      if (this.#cache.size >= 10_000) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(key, entry);
    }
    if (entry.expiresAt <= now) {
      this.revoke(token);
      return null;
    }
    return { key, user: entry.user };
  }

  revoke(token: string): void {
    const key = sha256(token);
    this.#cache.delete(key);
    this.#delete.run(key);
  }
}
