import dotenv from 'dotenv';
// Load .env first (defaults/comments), then .env.local overrides with real secrets
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const config = {
  telegram: {
    bot_token: require_env('TELEGRAM_BOT_TOKEN'),
    admin_chat_id: require_env('TELEGRAM_ADMIN_CHAT_ID'),
  },
  anthropic: {
    api_key: require_env('ANTHROPIC_API_KEY'),
    base_url: process.env.ANTHROPIC_BASE_URL ?? 'https://ai.ltcraft.cn:12000',
    model: 'claude-opus-4-6',
  },
  db: {
    path: process.env.DB_PATH ?? './interviews.db',
  },
  // Default locale for admin-facing messages (candidate messages use per-user prefs)
  admin_locale: process.env.ADMIN_LOCALE ?? 'zh-CN',
  interview: {
    default_duration_minutes: 30,
    // Start research when interview is within this many hours
    research_lead_hours: 2,
  },
} as const;
