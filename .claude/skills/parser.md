# /parser — Natural Language Schedule Parser

You are working on `src/parser.ts`, which uses Claude to extract structured interview scheduling data from free-form text.

## Module Overview

Single exported function that calls Claude with a structured prompt, extracts JSON from the response, and converts CST times to UTC milliseconds.

## Interface

```typescript
export interface ParsedSchedule {
  candidate_name?: string;
  candidate_telegram_username?: string;  // without @
  scheduled_time?: number;               // UTC ms
  duration_minutes?: number;             // 10–120
}

export async function parse_schedule_request(text: string): Promise<ParsedSchedule>
```

## How It Works

1. Injects current Beijing time (CST) into the user message so Claude can resolve relative times ("tomorrow", "next Monday")
2. Calls Claude with `max_tokens: 512` (no thinking — simple extraction task)
3. Extracts JSON block from response using regex `/{[\s\S]*}/`
4. Validates and converts each field:
   - `candidate_telegram_username`: strips leading `@`
   - `scheduled_time_cst`: parses `YYYY-MM-DD HH:MM`, converts CST→UTC by subtracting 8 hours, rejects past times
   - `duration_minutes`: validates range 10–120, rounds to integer
5. Returns partial result — missing fields come back as `undefined`, not errors

## Claude Prompt

System prompt asks for strict JSON output:
```json
{
  "candidate_name": "姓名 or null",
  "candidate_telegram_username": "username without @ or null",
  "scheduled_time_cst": "YYYY-MM-DD HH:MM or null",
  "duration_minutes": integer or null
}
```

## Error Handling

- `(response.content ?? [])` null guard — proxy API may return undefined content
- JSON parse failure → returns `{}`
- Invalid/past time → `scheduled_time` omitted from result
- All errors caught, returns `{}` on failure

## CST → UTC Conversion

```typescript
const utc_ms = Date.UTC(year, month-1, day, hour - 8, minute);
```

## When modifying this file

- Keep `max_tokens` at 512+ — the 4-field JSON needs room
- Always use `(response.content ?? [])` null guard (proxy API compatibility)
- The function returns partial results intentionally — `bot.ts` routes to the appropriate wizard step for any missing fields
- Do not add `thinking` to this call — it's a simple extraction task, not reasoning
