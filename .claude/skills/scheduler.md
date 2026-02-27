# /scheduler — Interview Lifecycle Orchestrator

You are working on `src/scheduler.ts`, which drives the automated interview lifecycle via cron jobs and manages in-memory state maps.

## Module Overview

Cron-based orchestrator that monitors interview states, triggers research, sends notifications, and manages the transition from `notified` → `in_progress` → `completed`.

## Exported State Maps

```typescript
// Keyed by candidate_telegram_username (lowercase)
export const active_interviews = new Map<string, number>();    // username → interview_id
export const notified_interviews = new Map<string, number>();  // username → interview_id
```

These maps are the primary lookup for routing incoming Telegram messages to the right interview.

## Cron Jobs

| Schedule | Function | Purpose |
|----------|----------|---------|
| Every minute | `check_and_notify_interviews` | Notify candidates when scheduled time arrives |
| Every minute | `check_and_send_reminders` | Send 15-min-before reminders |
| Every 5 minutes | `process_pending_research` | Trigger research for upcoming interviews |

## Key Functions

### `start_scheduler(bot)`
Initializes cron jobs and calls `restore_active_interviews()` to rebuild in-memory maps from DB on startup.

### `restore_active_interviews()`
On bot restart, repopulates `active_interviews` and `notified_interviews` from DB rows with status `in_progress` / `notified`.

### `check_and_notify_interviews(bot)`
- Queries `get_due_interviews()` (status=ready, time reached)
- Sets status → `notified`, adds to `notified_interviews` map
- Sends Telegram message to candidate (if `candidate_telegram_id` known)
- Always notifies admin; warns if candidate hasn't sent `/start`
- On send failure: reverts status to `ready`, removes from map

### `check_and_send_reminders(bot)`
- Queries `get_interviews_for_reminder()` (10–20 min before start)
- Uses `reminded_interviews` Set (in-memory, resets on restart) to avoid duplicate reminders
- Sends reminder to candidate + admin

### `start_interview_for_user(key: string): Promise<string | null>`
Called from `bot.ts` when a notified candidate sends any message:
1. Removes from `notified_interviews`
2. Sets status → `in_progress`
3. Adds to `active_interviews`
4. Calls `send_opening_message(interview_id)`
5. On failure: reverts all state changes

### `finish_interview(bot, interview_id, admin_chat_id)`
Called from `bot.ts` when `should_end: true`:
1. Removes from `active_interviews`
2. Sets status → `completed`
3. Sends thank-you to candidate
4. Calls `generate_summary()` → formats report → sends to admin
5. Report includes: recommendation label, overall score, per-category scores with notes, strengths, weaknesses, detailed assessment

### `process_pending_research(bot)`
- Queries `get_pending_for_research()` (pending, within 2-hour window, ordered by time)
- Sets status → `researching`
- Notifies admin that research started
- Calls `run_research()` → stores results → sets status → `ready`
- On failure: reverts to `pending`, notifies admin

## When modifying this file

- Both maps are keyed by **lowercase** `candidate_telegram_username` — always `.toLowerCase()` before lookup
- `active_interviews` and `notified_interviews` must stay in sync with DB status — always update both together
- `reminded_interviews` is intentionally in-memory only (resets on restart = harmless duplicate reminder)
- `finish_interview` is called from `bot.ts`, not from cron — cron only handles pre-interview lifecycle
- Admin notifications in `finish_interview` use `config.telegram.admin_chat_id`, not `interview.telegram_user_id` — these may differ
