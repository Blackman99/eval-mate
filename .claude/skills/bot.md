# /bot — Telegram Bot Entry Point

You are working on `src/bot.ts`, the main application file that handles all Telegram interactions.

## Module Overview

Telegram bot built with grammY. Handles commands, routes messages to the right handler, and manages the scheduling wizard state machine.

## Proxy Setup

The bot uses a proxy-aware fetch to route Telegram API calls through `HTTPS_PROXY` / `HTTP_PROXY` if set:
```typescript
const proxy_fetch = (url, init?) => nodeFetch(url, { ...init, agent: proxy_agent });
const bot = new Bot(token, { client: { fetch: proxy_fetch } });
```

## Commands

| Command | Handler | Notes |
|---------|---------|-------|
| `/start` | Inline | Welcome + command list |
| `/help` | Inline | Separate sections for interviewer / candidate |
| `/schedule [text]` | `handle_nl_parse` or wizard | Inline text → immediate parse; no text → enter `nl_input` step |
| `/status` | Inline | Lists all non-cancelled interviews for this user |
| `/begin` | Inline | Candidate starts interview proactively |
| `/cancel [id]` | Inline | Cancel by ID or auto-cancel if only one pending |

## Message Routing Priority

Incoming text messages (non-commands) are routed in this order:

1. **Notified candidate** (`notified_interviews.has(username)`) → call `start_interview_for_user()`
2. **Active candidate** (`active_interviews.has(username)`) → call `handle_candidate_reply()`
3. **DB fallback** (bot restart recovery) → check `get_interview_by_candidate_username()`, restore maps, route accordingly
4. **Scheduling wizard** (`scheduling_sessions.has(user_id)`) → call `handle_scheduling_step()`
5. **Default** → guide user to `/schedule` or `/help`

## Scheduling Wizard State Machine

```
nl_input → (parse) → name? → telegram? → datetime? → duration? → confirm → done
```

- `nl_input`: free-form text, parsed by `parse_schedule_request()`, fills whatever fields it can, routes to first missing field
- `name`: validates length ≥ 2
- `telegram`: strips `@`, validates length ≥ 3
- `datetime`: strict `YYYY-MM-DD HH:MM` format, CST→UTC conversion, rejects past times
- `duration`: integer 10–120
- `confirm`: "确认" / "yes" / "y" → `create_interview()`, anything else → cancel

## `/begin` Command Logic

```
1. No username set → error
2. active_interviews.has(username) → "already in progress"
3. notified_interviews.has(username) → start immediately
4. DB lookup → if notified/ready+time → start; if future → show scheduled time
5. No interview found → "no pending interview"
```

## In-Memory State

```typescript
const scheduling_sessions = new Map<string, SchedulingSession>();  // user_id → session
// active_interviews and notified_interviews imported from scheduler.ts
```

## Key Patterns

- `user_id` = numeric Telegram user ID as string (admin key)
- `username` = `ctx.from.username?.toLowerCase()` (candidate key)
- Always call `set_candidate_telegram_id()` when candidate first interacts
- `ctx.replyWithChatAction('typing')` before any Claude call for UX feedback

## When modifying this file

- Message routing priority order is critical — do not reorder without understanding all cases
- The DB fallback (priority 3) handles bot restarts — it must restore both `active_interviews` and `notified_interviews` maps
- `/cancel` uses `user_id` (admin), not `username` — only the scheduling admin can cancel
- `handle_nl_parse` is called both from `/schedule` inline and from the `nl_input` wizard step
- All Claude calls are wrapped in try/catch with user-facing error messages
