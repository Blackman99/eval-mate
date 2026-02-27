import { describe, it, expect, vi } from 'vitest';

// Mock config
vi.mock('../src/config.js', () => ({
  config: {
    anthropic: { api_key: 'test', base_url: 'http://localhost', model: 'test-model' },
    telegram: { bot_token: 'test', admin_chat_id: 'test' },
    db: { path: ':memory:' },
    admin_locale: 'zh-CN',
    interview: { research_lead_hours: 2 },
  },
}));

// Mock db module (scheduler imports it)
vi.mock('../src/db.js', () => ({
  get_due_interviews: vi.fn(() => []),
  get_pending_for_research: vi.fn(() => []),
  update_interview_status: vi.fn(),
}));

// Mock researcher
vi.mock('../src/researcher.js', () => ({
  research_candidate: vi.fn(),
}));

// Mock interviewer
vi.mock('../src/interviewer.js', () => ({
  send_opening_message: vi.fn(),
}));

// Mock grammy Bot
vi.mock('grammy', () => ({
  Bot: class {
    api = { sendMessage: vi.fn() };
  },
}));

// Mock i18n
vi.mock('../src/i18n/index.js', () => ({
  t: vi.fn((_key: string, _lng: string, _vars?: Record<string, unknown>) => 'mocked'),
  SUPPORTED_LANGS: ['zh-CN', 'en-US'],
}));

import { fmt_time } from '../src/scheduler.js';

describe('fmt_time', () => {
  it('should format timestamp in zh-CN locale', () => {
    // 2026-01-15 10:30:00 UTC = 2026-01-15 18:30:00 CST
    const ts = Date.UTC(2026, 0, 15, 10, 30, 0);
    const result = fmt_time(ts, 'zh-CN');

    // Should contain date and time in Chinese format
    expect(result).toContain('2026');
    expect(result).toContain('1');
    expect(result).toContain('15');
  });

  it('should format timestamp in en-US locale', () => {
    const ts = Date.UTC(2026, 0, 15, 10, 30, 0);
    const result = fmt_time(ts, 'en-US');

    expect(result).toContain('2026');
  });

  it('should always use CST timezone (Asia/Shanghai)', () => {
    // Midnight UTC = 8:00 AM CST
    const ts = Date.UTC(2026, 5, 1, 0, 0, 0);
    const result = fmt_time(ts, 'zh-CN');

    // Should show 8:00 (CST), not 0:00 (UTC)
    expect(result).toContain('8');
  });

  it('should handle different dates correctly', () => {
    // 2026-12-31 23:00 UTC = 2027-01-01 07:00 CST (date crosses midnight)
    const ts = Date.UTC(2026, 11, 31, 23, 0, 0);
    const result = fmt_time(ts, 'zh-CN');

    // Should show January 1, 2027 in CST
    expect(result).toContain('2027');
  });
});
