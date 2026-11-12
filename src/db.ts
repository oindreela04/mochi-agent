// Persistence. One SQLite file via Node's built-in `node:sqlite`: no native
// build step, so `npm install` cannot fail on a missing compiler.
//
// The unit of memory is a *turn* (one question + one answer), not a message.
// Each turn keeps what we searched, what we read (with publish dates) and,
// written asynchronously after the reply, the concrete claims the answer made.
// That is what lets the agent later answer "has any of that changed since?".
//
// Every row belongs to a user (an anonymous per-browser id on the public
// deployment), and every read is scoped to it: visitors never see each
// other's memory.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Source {
  n: number;
  url: string;
  title: string;
  published?: string | null;
  retrievedAt: number;
}

export interface Turn {
  id: number;
  userId: string;
  threadId: string;
  createdAt: number;
  tz: string;
  userText: string;
  assistantText: string;
  sources: Source[];
  queries: string[];
}

export interface Claim {
  turnId: number;
  subject: string;
  attribute: string;
  value: string;
  sourceUrl: string | null;
}

/** A durable fact about the user, learned from conversation ("sales team size: 20"). */
export interface ProfileFact {
  key: string;
  value: string;
  updatedAt: number;
  sourceTurnId: number | null;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, unknown>;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        thread_id TEXT NOT NULL REFERENCES threads(id),
        created_at INTEGER NOT NULL,
        tz TEXT NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        sources_json TEXT NOT NULL DEFAULT '[]',
        queries_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        user_text, assistant_text, content='turns', content_rowid='id',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, user_text, assistant_text)
        VALUES (new.id, new.user_text, new.assistant_text);
      END;
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        subject TEXT NOT NULL,
        attribute TEXT NOT NULL,
        value TEXT NOT NULL,
        source_url TEXT
      );
      CREATE INDEX IF NOT EXISTS claims_turn ON claims(turn_id);
      CREATE TABLE IF NOT EXISTS profile (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        source_turn_id INTEGER,
        PRIMARY KEY (user_id, key)
      );
    `);
    // Databases created before per-user scoping lack the column.
    for (const table of ['threads', 'turns']) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (!cols.some((c) => c.name === 'user_id')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local'`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS threads_user ON threads(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS turns_user_created ON turns(user_id, created_at);
      CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id, created_at);
    `);
  }

  // ---- threads ----

  /** Returns the user's thread `id`, or creates a new one. Never returns another user's thread. */
  ensureThread(userId: string, id: string | undefined, firstMessage: string, nowMs: number): Thread {
    if (id) {
      const row = this.db.prepare('SELECT * FROM threads WHERE id = ? AND user_id = ?').get(id, userId) as
        | Row
        | undefined;
      if (row) return toThread(row);
    }
    const thread: Thread = {
      id: randomUUID(),
      title: firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat',
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this.db
      .prepare('INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(thread.id, userId, thread.title, thread.createdAt, thread.updatedAt);
    return thread;
  }

  listThreads(userId: string, limit = 50): Thread[] {
    // Threads whose first message failed have no turns; don't list them.
    const sql = `SELECT * FROM threads WHERE user_id = ?
                 AND EXISTS (SELECT 1 FROM turns WHERE thread_id = threads.id)
                 ORDER BY updated_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(userId, limit) as Row[]).map(toThread);
  }

  // ---- turns ----

  addTurn(t: Omit<Turn, 'id'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO turns (user_id, thread_id, created_at, tz, user_text, assistant_text, sources_json, queries_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.userId,
        t.threadId,
        t.createdAt,
        t.tz,
        t.userText,
        t.assistantText,
        JSON.stringify(t.sources),
        JSON.stringify(t.queries),
      );
    this.db
      .prepare('UPDATE threads SET updated_at = MAX(updated_at, ?) WHERE id = ?')
      .run(t.createdAt, t.threadId);
    return Number(res.lastInsertRowid);
  }

  threadTurns(userId: string, threadId: string, limit = 50): Turn[] {
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE user_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, threadId, limit) as Row[];
    return rows.map(toTurn).reverse();
  }

  turnsBetween(userId: string, startMs: number, endMs: number, limit = 20): Turn[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM turns WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at LIMIT ?',
        )
        .all(userId, startMs, endMs, limit) as Row[]
    ).map(toTurn);
  }

  recentTurns(userId: string, limit: number): Turn[] {
    return (
      this.db
        .prepare('SELECT * FROM turns WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(userId, limit) as Row[]
    ).map(toTurn);
  }

  hasTurn(userId: string, userText: string, createdAt: number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM turns WHERE user_id = ? AND user_text = ? AND created_at = ?')
      .get(userId, userText, createdAt);
  }

  /** Full-text search over the user's past questions and answers. Best first. */
  searchTurns(userId: string, terms: string[], limit = 5): Turn[] {
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    try {
      const rows = this.db
        .prepare(
          `SELECT turns.* FROM turns_fts JOIN turns ON turns.id = turns_fts.rowid
           WHERE turns_fts MATCH ? AND turns.user_id = ?
           ORDER BY bm25(turns_fts, 3.0, 1.0) LIMIT ?`,
        )
        .all(match, userId, limit) as Row[];
      return rows.map(toTurn);
    } catch {
      return [];
    }
  }

  // ---- claims (always reached through a turn the caller already scoped) ----

  addClaims(claims: Claim[]): void {
    if (claims.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT INTO claims (turn_id, subject, attribute, value, source_url) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const c of claims) stmt.run(c.turnId, c.subject, c.attribute, c.value, c.sourceUrl);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  claimsFor(turnIds: number[]): Map<number, Claim[]> {
    const out = new Map<number, Claim[]>();
    if (turnIds.length === 0) return out;
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE turn_id IN (${turnIds.map(() => '?').join(',')}) ORDER BY id`)
      .all(...turnIds) as Row[];
    for (const r of rows) {
      const c: Claim = {
        turnId: Number(r.turn_id),
        subject: String(r.subject),
        attribute: String(r.attribute),
        value: String(r.value),
        sourceUrl: (r.source_url as string | null) ?? null,
      };
      out.set(c.turnId, [...(out.get(c.turnId) ?? []), c]);
    }
    return out;
  }

  // ---- profile ----

  /** Newer statements replace older ones for the same key; an empty value deletes it. */
  upsertProfile(userId: string, facts: { key: string; value: string }[], turnId: number | null, nowMs: number): void {
    const put = this.db.prepare(
      `INSERT INTO profile (user_id, key, value, updated_at, source_turn_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
       source_turn_id = excluded.source_turn_id`,
    );
    for (const f of facts) {
      const key = normalizeKey(f.key);
      if (!key) continue;
      if (f.value.trim()) put.run(userId, key, f.value.trim().slice(0, 300), nowMs, turnId);
      else this.deleteProfile(userId, key);
    }
    // Keep the profile small: it goes into every prompt.
    this.db
      .prepare(
        `DELETE FROM profile WHERE user_id = ? AND key NOT IN
         (SELECT key FROM profile WHERE user_id = ? ORDER BY updated_at DESC LIMIT 40)`,
      )
      .run(userId, userId);
  }

  getProfile(userId: string): ProfileFact[] {
    return (
      this.db.prepare('SELECT * FROM profile WHERE user_id = ? ORDER BY key').all(userId) as Row[]
    ).map((r) => ({
      key: String(r.key),
      value: String(r.value),
      updatedAt: Number(r.updated_at),
      sourceTurnId: r.source_turn_id == null ? null : Number(r.source_turn_id),
    }));
  }

  deleteProfile(userId: string, key: string): void {
    this.db.prepare('DELETE FROM profile WHERE user_id = ? AND key = ?').run(userId, normalizeKey(key));
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
}

function toThread(r: Row): Thread {
  return {
    id: String(r.id),
    title: String(r.title),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toTurn(r: Row): Turn {
  return {
    id: Number(r.id),
    userId: String(r.user_id),
    threadId: String(r.thread_id),
    createdAt: Number(r.created_at),
    tz: String(r.tz),
    userText: String(r.user_text),
    assistantText: String(r.assistant_text),
    sources: JSON.parse(String(r.sources_json)),
    queries: JSON.parse(String(r.queries_json)),
  };
}
