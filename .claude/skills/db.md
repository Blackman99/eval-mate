# /db — Database Layer

You are working on `src/db.ts`, the SQLite persistence layer for the interview bot.

## Module Overview

Uses **sql.js** (pure JS/WASM SQLite, no native deps). The database is loaded from disk on startup and flushed back after every write via `save_db()`.

## Schema

**`interviews` table** — one row per scheduled interview:
```sql
id, telegram_user_id, candidate_name, candidate_telegram_username,
candidate_telegram_id, scheduled_time (UTC ms), duration_minutes,
status, research_notes (JSON), interview_questions (JSON),
summary (JSON), created_at, updated_at
```

**`messages` table** — conversation history:
```sql
id, interview_id (FK), role ('assistant'|'user'), content, timestamp
```

## Key Functions

| Function | Description |
|----------|-------------|
| `init_db()` | Load or create DB file, run schema migrations |
| `create_interview(data)` | Insert new interview, return numeric ID |
| `get_interview(id)` | Fetch single interview by ID |
| `get_interviews_by_user(user_id)` | All non-cancelled interviews for an admin |
| `update_interview_status(id, status)` | Transition interview state |
| `set_research(id, notes, questions)` | Store research notes + questions JSON |
| `append_message(id, role, content)` | Add one conversation turn |
| `get_conversation(id)` | Return full `ConversationMessage[]` |
| `set_summary(id, summary)` | Store final evaluation report |
| `get_due_interviews()` | Status=ready AND scheduled_time ≤ now |
| `get_pending_for_research()` | Status=pending AND scheduled_time ≤ now + 2h, ORDER BY scheduled_time ASC |
| `get_interviews_for_reminder()` | Status=ready AND 10–20 min before scheduled_time |
| `get_in_progress_interviews()` | Status=in_progress (for restart recovery) |
| `get_notified_interviews()` | Status=notified (for restart recovery) |
| `get_interview_by_candidate_username(username)` | Lookup by candidate username, status IN (notified, in_progress) |
| `set_candidate_telegram_id(id, telegram_id)` | Lazily populate candidate's numeric Telegram ID |
| `cancel_interview(id)` | Set status=cancelled |

## Migration Pattern

New columns are added via try/catch `ALTER TABLE` in `init_db()` — safe to run on existing DBs:
```typescript
try { db.run('ALTER TABLE interviews ADD COLUMN new_col TEXT DEFAULT ""') } catch {}
```

## Important Patterns

- All JSON fields (research_notes, interview_questions, summary) are stored as serialized strings and parsed in `parse_interview()`
- `save_db()` writes the WASM buffer to disk after every mutation
- `candidate_telegram_id` starts empty and is populated lazily when the candidate first messages the bot
- All timestamps are UTC milliseconds

## When modifying this file

- Always call `save_db()` after any write operation
- Add new columns via migration in `init_db()`, never recreate the table
- Keep `parse_interview()` in sync with any schema changes
- Use `run()` for writes, `query_one()` / `query_all()` for reads
