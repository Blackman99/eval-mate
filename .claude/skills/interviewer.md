# /interviewer — Interview Conductor & Evaluator

You are working on `src/interviewer.ts`, which manages the live interview conversation and generates the final evaluation report.

## Module Overview

Three exported functions covering the full interview lifecycle: opening, conversation turns, and final evaluation.

## Interface

```typescript
export async function send_opening_message(interview_id: number): Promise<string>
export async function handle_candidate_reply(interview_id: number, text: string): Promise<{ response: string; should_end: boolean }>
export async function generate_summary(interview_id: number): Promise<InterviewSummary>
```

## `send_opening_message`

- Loads interview + questions from DB
- Calls Claude to generate a warm, professional opening in Chinese
- Appends opening to conversation history via `append_message()`
- Returns the opening string (sent to candidate by `bot.ts`)

## `handle_candidate_reply`

1. Appends candidate message to DB conversation history
2. Builds full conversation context for Claude (system prompt + history)
3. System prompt includes: remaining questions, elapsed time, total duration, scoring rubrics
4. Claude responds with next question or follow-up
5. Detects `INTERVIEW_COMPLETE` marker in response → sets `should_end: true`
6. Appends Claude response to DB
7. Returns `{ response, should_end }`

**Time tracking:** Calculates elapsed time from first message timestamp vs. `duration_minutes`.

**Completion triggers:**
- All questions asked + follow-ups exhausted
- Time limit reached
- Claude explicitly outputs `INTERVIEW_COMPLETE`

## `generate_summary`

1. Loads full conversation history from DB
2. Calls Claude with all conversation turns + original questions
3. Requests structured JSON evaluation:
```json
{
  "overall_recommendation": "strong_hire|hire|no_hire|strong_no_hire",
  "overall_score": 0-100,
  "category_scores": {
    "ai_fundamentals": { "score": 0-25, "notes": "..." },
    "agent_frameworks": { "score": 0-25, "notes": "..." },
    "system_operations": { "score": 0-25, "notes": "..." },
    "business_communication": { "score": 0-25, "notes": "..." }
  },
  "strengths": ["..."],
  "weaknesses": ["..."],
  "notable_quotes": ["..."],
  "detailed_assessment": "..."
}
```

## Critical Pattern

```typescript
// ALWAYS use null guard — proxy API may return undefined content
const text_blocks = (response.content ?? []).filter(b => b.type === 'text');
```

## When modifying this file

- Keep `(response.content ?? [])` null guard in `extract_summary()` and any new response parsing
- The interviewer conducts the interview **in Chinese** — system prompts and responses are in Chinese
- `should_end: true` triggers `finish_interview()` in `scheduler.ts` which generates the report and notifies admin
- Category scores are each 0–25, summing to 100 total
- `generate_summary` uses `thinking: { type: 'adaptive' }` for deeper evaluation reasoning
