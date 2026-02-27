# /researcher — Research & Question Generation

You are working on `src/researcher.ts`, which conducts web research on the AI Agent ecosystem and generates tailored interview questions.

## Module Overview

Two-phase pipeline:
1. **Research phase** — Claude uses `web_search_20260209` to gather current AI Agent ecosystem info
2. **Question generation phase** — Claude generates structured questions based on research findings

## Interface

```typescript
export async function run_research(
  candidate_name: string,
  duration_minutes: number
): Promise<{ notes: ResearchNotes; questions: Question[] }>
```

## Question Count Logic

```typescript
const total_questions = Math.min(10, Math.max(1, Math.floor(duration_minutes / 5)));
// 5 min per question, max 10
// Distributed evenly across 4 categories, remainder to first categories
```

## Phase 1: Web Research

- Model: `claude-opus-4-6` with `thinking: { type: 'adaptive' }` and `web_search_20260209` tool
- `max_tokens: 8000`
- Searches for: AI Agent frameworks (LangChain, AutoGen, CrewAI, Claude SDK), AI Agent admin skills, LLM deployment practices, RAG/prompt engineering advances
- Output: JSON with `summary`, `topics[]`, `generated_at`

## Phase 2: Question Generation

- Model: `claude-opus-4-6` with `thinking: { type: 'adaptive' }`
- `max_tokens: 6000`
- Input: research notes from phase 1
- Output: JSON array of `Question[]`

## Question Categories

| Category | Description |
|----------|-------------|
| `ai_fundamentals` | LLM principles, prompt engineering, RAG, hallucination, fine-tuning |
| `agent_frameworks` | LangChain, AutoGen, CrewAI, Claude SDK hands-on experience |
| `system_operations` | Deployment, monitoring, logging, incident response, disaster recovery |
| `business_communication` | Requirements, cross-team collaboration, ROI, stakeholder reporting |

## Fallback Behavior

If JSON extraction fails, `get_default_questions()` returns 16 hardcoded questions covering all categories and difficulty levels (junior/mid/senior).

## Critical Pattern

```typescript
// ALWAYS use null guard — proxy API may return undefined content
const text_blocks = (response.content ?? []).filter(b => b.type === 'text');
```

## When modifying this file

- Keep `(response.content ?? [])` null guard in both `extract_research_notes()` and `extract_questions()`
- The `web_search_20260209` tool type must be imported from `@anthropic-ai/sdk/resources/messages/messages.js`
- `thinking: { type: 'adaptive' }` is intentional — research and question design benefit from extended reasoning
- Default questions in `get_default_questions()` should be kept up to date as fallback
- Research prompt injects `Date.now()` for `generated_at` — this is intentional
