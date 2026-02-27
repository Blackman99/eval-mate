# /types — Type Definitions

You are working on `src/types.ts`, the central TypeScript type definitions for the interview bot.

## Module Overview

All shared interfaces and union types live here. No runtime logic — pure type definitions.

## Core Types

### Interview Lifecycle
```typescript
type InterviewStatus =
  | 'pending'       // Scheduled, awaiting research trigger
  | 'researching'   // Research in progress
  | 'ready'         // Questions generated, awaiting interview time
  | 'notified'      // Candidate notified, awaiting start
  | 'in_progress'   // Interview active
  | 'completed'     // Finished, report sent
  | 'cancelled';    // Cancelled by admin
```

### Evaluation
```typescript
type InterviewCategory = 'ai_fundamentals' | 'agent_frameworks' | 'system_operations' | 'business_communication';
type Recommendation = 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire';
```

## Key Interfaces

### `Interview`
Main record stored in DB. Notable fields:
- `telegram_user_id` — admin who scheduled it
- `candidate_telegram_username` — lowercase, used as key in in-memory maps
- `candidate_telegram_id` — numeric Telegram ID, populated lazily
- `research_notes: ResearchNotes | null`
- `interview_questions: Question[] | null`
- `conversation_history: ConversationMessage[] | null`
- `summary: InterviewSummary | null`

### `Question`
```typescript
interface Question {
  id: string;
  category: InterviewCategory;
  text: string;
  follow_ups: string[];
  scoring_rubric: string;
  difficulty: 'junior' | 'mid' | 'senior';
}
```

### `InterviewSummary`
```typescript
interface InterviewSummary {
  overall_recommendation: Recommendation;
  overall_score: number;           // 0–100
  category_scores: Record<InterviewCategory, CategoryScore>;  // each 0–25
  strengths: string[];
  weaknesses: string[];
  notable_quotes: string[];
  detailed_assessment: string;
  generated_at: number;
}
```

### `SchedulingSession`
In-memory wizard state (not persisted to DB):
```typescript
interface SchedulingSession {
  step: 'nl_input' | 'name' | 'telegram' | 'datetime' | 'duration' | 'confirm';
  candidate_name?: string;
  candidate_telegram_username?: string;
  scheduled_time?: number;   // UTC ms
  duration_minutes?: number;
}
```

## When modifying this file

- Adding a new `InterviewStatus` value requires updating: `db.ts` (queries), `bot.ts` (status_label), `scheduler.ts` (state machine)
- Adding fields to `Interview` requires a DB migration in `init_db()` and updating `parse_interview()`
- `candidate_telegram_username` is always stored/compared lowercase
- All timestamps are UTC milliseconds
