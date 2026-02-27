# /config — Configuration

You are working on `src/config.ts`, the environment variable configuration module.

## Module Overview

Loads environment variables from `.env` then `.env.local` (local overrides secrets), validates required vars, and exports a typed `config` object.

## Config Structure

```typescript
export const config = {
  telegram: {
    bot_token: string,       // TELEGRAM_BOT_TOKEN (required)
    admin_chat_id: string,   // TELEGRAM_ADMIN_CHAT_ID (required)
  },
  anthropic: {
    api_key: string,         // ANTHROPIC_API_KEY (required)
    base_url: string,        // ANTHROPIC_BASE_URL (default: 'https://ai.ltcraft.cn:12000')
    model: 'claude-opus-4-6',
  },
  db: {
    path: string,            // DB_PATH (default: './interviews.db')
  },
  interview: {
    default_duration_minutes: 30,
    research_lead_hours: 2,  // Trigger research this many hours before interview
  },
} as const;
```

## Environment Files

| File | Purpose | Git-tracked |
|------|---------|-------------|
| `.env` | Template with empty values and comments | ✅ Yes |
| `.env.local` | Actual secrets | ❌ No (.gitignore) |
| `.env.example` | Reference template | ✅ Yes |

## Loading Order

```typescript
dotenv.config();                              // Load .env first
dotenv.config({ path: '.env.local', override: true });  // .env.local wins
```

## Required Variables

Missing any of these throws at startup:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `ANTHROPIC_API_KEY`

## When modifying this file

- Add new required vars via `require_env('VAR_NAME')`
- Add optional vars with `process.env.VAR ?? 'default'`
- Always update `.env.example` and `.env` templates when adding new vars
- The `model` field is hardcoded — change it here to switch Claude models globally
