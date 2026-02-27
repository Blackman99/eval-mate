import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from './config.js';
import type {
  Interview,
  InterviewStatus,
  ResearchNotes,
  Question,
  ConversationMessage,
  InterviewSummary,
} from './types.js';

// sql.js is a CommonJS module; use createRequire to import it in ESM
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const initSqlJs = require('sql.js') as (config?: object) => Promise<any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS interviews (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id             TEXT    NOT NULL,
  candidate_name               TEXT    NOT NULL,
  candidate_telegram_username  TEXT    NOT NULL DEFAULT '',
  candidate_telegram_id        TEXT    NOT NULL DEFAULT '',
  scheduled_time               INTEGER NOT NULL,
  duration_minutes             INTEGER NOT NULL DEFAULT 30,
  status                       TEXT    NOT NULL DEFAULT 'pending',
  research_notes               TEXT,
  interview_questions          TEXT,
  conversation_history         TEXT,
  summary                      TEXT,
  created_at                   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at                   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id),
  role         TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  timestamp    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_interviews_status    ON interviews(status);
CREATE INDEX IF NOT EXISTS idx_interviews_scheduled ON interviews(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_interviews_user      ON interviews(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_interview   ON messages(interview_id);
`;

export async function init_db(): Promise<void> {
  const SQL = await initSqlJs();

  if (existsSync(config.db.path)) {
    const file_buffer = readFileSync(config.db.path);
    _db = new SQL.Database(file_buffer);
  } else {
    _db = new SQL.Database();
  }

  _db.run(SCHEMA_SQL);
  // Migration: add columns for existing databases (no-op on fresh ones)
  try { _db.run("ALTER TABLE interviews ADD COLUMN candidate_telegram_username TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
  try { _db.run("ALTER TABLE interviews ADD COLUMN candidate_telegram_id TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
  persist();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function get_db(): any {
  if (!_db) throw new Error('Database not initialized. Call init_db() first.');
  return _db;
}

function persist(): void {
  const data = _db.export() as Uint8Array;
  writeFileSync(config.db.path, Buffer.from(data));
}

// Helper: run a write statement and persist
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(sql: string, params: any[] = []): void {
  get_db().run(sql, params);
  persist();
}

// Helper: query rows
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function query_all(sql: string, params: any[] = []): Record<string, unknown>[] {
  const db = get_db();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, unknown>);
  }
  stmt.free();
  return rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function query_one(sql: string, params: any[] = []): Record<string, unknown> | null {
  const rows = query_all(sql, params);
  return rows[0] ?? null;
}

function parse_interview(row: Record<string, unknown>): Interview {
  return {
    id: row.id as number,
    telegram_user_id: row.telegram_user_id as string,
    candidate_name: row.candidate_name as string,
    candidate_telegram_username: (row.candidate_telegram_username as string) ?? '',
    candidate_telegram_id: (row.candidate_telegram_id as string) ?? '',
    scheduled_time: row.scheduled_time as number,
    duration_minutes: row.duration_minutes as number,
    status: row.status as InterviewStatus,
    research_notes: row.research_notes ? JSON.parse(row.research_notes as string) : null,
    interview_questions: row.interview_questions ? JSON.parse(row.interview_questions as string) : null,
    conversation_history: row.conversation_history ? JSON.parse(row.conversation_history as string) : null,
    summary: row.summary ? JSON.parse(row.summary as string) : null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export function create_interview(params: {
  telegram_user_id: string;
  candidate_name: string;
  candidate_telegram_username: string;
  scheduled_time: number;
  duration_minutes: number;
}): number {
  run(
    `INSERT INTO interviews (telegram_user_id, candidate_name, candidate_telegram_username, scheduled_time, duration_minutes)
     VALUES (?, ?, ?, ?, ?)`,
    [params.telegram_user_id, params.candidate_name, params.candidate_telegram_username, params.scheduled_time, params.duration_minutes]
  );
  const row = query_one('SELECT last_insert_rowid() as id');
  return (row?.id as number) ?? 0;
}

export function get_interview(id: number): Interview | null {
  const row = query_one('SELECT * FROM interviews WHERE id = ?', [id]);
  return row ? parse_interview(row) : null;
}

export function get_interview_by_user(telegram_user_id: string): Interview | null {
  const row = query_one(
    `SELECT * FROM interviews
     WHERE telegram_user_id = ?
     AND status NOT IN ('completed', 'cancelled')
     ORDER BY scheduled_time ASC
     LIMIT 1`,
    [telegram_user_id]
  );
  return row ? parse_interview(row) : null;
}

export function get_interviews_by_user(telegram_user_id: string): Interview[] {
  const rows = query_all(
    `SELECT * FROM interviews
     WHERE telegram_user_id = ?
     AND status NOT IN ('completed', 'cancelled')
     ORDER BY scheduled_time ASC`,
    [telegram_user_id]
  );
  return rows.map(parse_interview);
}

export function update_interview_status(id: number, status: InterviewStatus): void {
  run('UPDATE interviews SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id]);
}

export function set_research(id: number, notes: ResearchNotes, questions: Question[]): void {
  run(
    'UPDATE interviews SET research_notes = ?, interview_questions = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(notes), JSON.stringify(questions), Date.now(), id]
  );
}

export function append_message(interview_id: number, role: 'assistant' | 'user', content: string): void {
  run(
    'INSERT INTO messages (interview_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    [interview_id, role, content, Date.now()]
  );
}

export function get_conversation(interview_id: number): ConversationMessage[] {
  const rows = query_all(
    'SELECT role, content, timestamp FROM messages WHERE interview_id = ? ORDER BY timestamp ASC',
    [interview_id]
  );
  return rows.map(r => ({
    role: r.role as 'assistant' | 'user',
    content: r.content as string,
    timestamp: r.timestamp as number,
  }));
}

export function set_summary(id: number, summary: InterviewSummary): void {
  run(
    'UPDATE interviews SET summary = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(summary), Date.now(), id]
  );
}

export function get_due_interviews(): Interview[] {
  const rows = query_all(
    "SELECT * FROM interviews WHERE status = 'ready' AND scheduled_time <= ?",
    [Date.now()]
  );
  return rows.map(parse_interview);
}

export function get_pending_for_research(): Interview[] {
  const cutoff = Date.now() + config.interview.research_lead_hours * 60 * 60 * 1000;
  const rows = query_all(
    "SELECT * FROM interviews WHERE status = 'pending' AND scheduled_time <= ? ORDER BY scheduled_time ASC",
    [cutoff]
  );
  return rows.map(parse_interview);
}

export function cancel_interview(id: number): void {
  update_interview_status(id, 'cancelled');
}

export function get_in_progress_interviews(): Array<{ id: number; telegram_user_id: string; candidate_telegram_username: string }> {
  return query_all(
    "SELECT id, telegram_user_id, candidate_telegram_username FROM interviews WHERE status = 'in_progress'"
  ) as Array<{ id: number; telegram_user_id: string; candidate_telegram_username: string }>;
}

export function get_notified_interviews(): Array<{ id: number; telegram_user_id: string; candidate_telegram_username: string }> {
  return query_all(
    "SELECT id, telegram_user_id, candidate_telegram_username FROM interviews WHERE status = 'notified'"
  ) as Array<{ id: number; telegram_user_id: string; candidate_telegram_username: string }>;
}

export function get_interviews_for_reminder(): Interview[] {
  const now = Date.now();
  const window_start = now + 10 * 60 * 1000;
  const window_end = now + 20 * 60 * 1000;
  const rows = query_all(
    "SELECT * FROM interviews WHERE status = 'ready' AND scheduled_time BETWEEN ? AND ?",
    [window_start, window_end]
  );
  return rows.map(parse_interview);
}

export function get_interview_by_candidate_username(username: string): Interview | null {
  const row = query_one(
    `SELECT * FROM interviews
     WHERE candidate_telegram_username = ?
     AND status IN ('notified', 'in_progress')
     ORDER BY scheduled_time ASC
     LIMIT 1`,
    [username]
  );
  return row ? parse_interview(row) : null;
}

export function set_candidate_telegram_id(id: number, candidate_telegram_id: string): void {
  run('UPDATE interviews SET candidate_telegram_id = ?, updated_at = ? WHERE id = ?', [candidate_telegram_id, Date.now(), id]);
}
