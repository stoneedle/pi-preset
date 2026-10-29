import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const receiptSchema = `CREATE TABLE IF NOT EXISTS session_results (
  session_id TEXT NOT NULL, result_id TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
  completion_pending INTEGER NOT NULL DEFAULT 0,
  completion_children TEXT NOT NULL DEFAULT '[]',
  completion_outcome TEXT CHECK(completion_outcome IN ('error','aborted')),
  PRIMARY KEY (session_id, result_id)
)`;

/** Shared with Go in pi-web.sqlite. Each write changes one result, never a session-wide watermark. */
export class Receipts {
  private db: DatabaseSync;

  constructor(agentDir: string) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(agentDir, 'pi-web.sqlite'));
    try {
      this.db.exec('PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL;');
      this.db.exec(receiptSchema);
      this.db.exec('BEGIN IMMEDIATE');
      const columns = this.db.prepare('PRAGMA table_info(session_results)').all();
      if (!columns.some((column) => column.name === 'completion_pending'))
        this.db.exec('ALTER TABLE session_results ADD COLUMN completion_pending INTEGER NOT NULL DEFAULT 0');
      if (!columns.some((column) => column.name === 'completion_children')) {
        this.db.exec("ALTER TABLE session_results ADD COLUMN completion_children TEXT NOT NULL DEFAULT '[]'");
        this.db.exec("UPDATE session_results SET completion_children='null' WHERE completion_pending=1");
      }
      if (!columns.some((column) => column.name === 'completion_outcome'))
        this.db.exec("ALTER TABLE session_results ADD COLUMN completion_outcome TEXT CHECK(completion_outcome IN ('error','aborted'))");
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Initialization may have failed before the transaction. */ }
      this.db.close(); throw error;
    }
  }

  read(sessionId: string, resultId: string) {
    return this.db.prepare('SELECT acknowledged, completed, completion_pending, completion_children, completion_outcome FROM session_results WHERE session_id=? AND result_id=?')
      .get(sessionId, resultId) as { acknowledged: number; completed: number; completion_pending: number; completion_children: string; completion_outcome: 'error' | 'aborted' | null } | undefined;
  }

  settled(sessionId: string, resultId: string, children: string[] | null) {
    this.db.prepare(`INSERT INTO session_results (session_id,result_id,completion_pending,completion_children) VALUES (?,?,1,?)
      ON CONFLICT(session_id,result_id) DO UPDATE SET completion_pending=CASE WHEN completed=0 AND completion_outcome IS NULL THEN 1 ELSE 0 END,
      completion_children=excluded.completion_children`).run(sessionId, resultId, JSON.stringify(children));
  }

  complete(sessionId: string, resultId: string) {
    this.db.prepare(`UPDATE session_results SET completed=1,completion_pending=0
      WHERE session_id=? AND result_id=? AND completion_pending=1 AND completed=0`).run(sessionId, resultId);
  }

  cancelCompletion(sessionId: string, resultId: string, outcome: 'error' | 'aborted') {
    this.db.prepare(`UPDATE session_results SET completion_pending=0,completion_outcome=?
      WHERE session_id=? AND result_id=? AND completed=0 AND completion_outcome IS NULL`)
      .run(outcome, sessionId, resultId);
  }

  acknowledge(sessionId: string, resultId: string) {
    this.db.prepare(`INSERT INTO session_results (session_id,result_id,acknowledged) VALUES (?,?,1)
      ON CONFLICT(session_id,result_id) DO UPDATE SET acknowledged=1`).run(sessionId, resultId);
  }

  close() { this.db.close(); }
}
