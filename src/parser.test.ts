import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting
const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

// Mock config
vi.mock('./config.js', () => ({
  config: {
    anthropic: { api_key: 'test', base_url: 'http://localhost', model: 'test-model' },
    telegram: { bot_token: 'test', admin_chat_id: 'test' },
    db: { path: ':memory:' },
    admin_locale: 'zh-CN',
    interview: { research_lead_hours: 2 },
  },
}));

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { parse_schedule_request } from './parser.js';

function makeResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('parse_schedule_request', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('should parse a complete schedule request', async () => {
    const futureDate = new Date(Date.now() + 86400_000 + 8 * 3600_000);
    const cstStr = futureDate.toISOString().slice(0, 10) + ' 14:00';

    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: '张三',
      candidate_telegram_username: '@zhangsan',
      scheduled_time_cst: cstStr,
      duration_minutes: 45,
    })));

    const result = await parse_schedule_request('明天下午2点面试张三');
    expect(result.candidate_name).toBe('张三');
    expect(result.candidate_telegram_username).toBe('zhangsan');
    expect(result.scheduled_time).toBeTypeOf('number');
    expect(result.duration_minutes).toBe(45);
  });

  it('should handle partial response (name only)', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: '李四',
      candidate_telegram_username: null,
      scheduled_time_cst: null,
      duration_minutes: null,
    })));

    const result = await parse_schedule_request('面试李四');
    expect(result.candidate_name).toBe('李四');
    expect(result.candidate_telegram_username).toBeUndefined();
    expect(result.scheduled_time).toBeUndefined();
    expect(result.duration_minutes).toBeUndefined();
  });

  it('should return empty object when no JSON in response', async () => {
    mockCreate.mockResolvedValue(makeResponse('抱歉，我无法理解您的请求。'));
    const result = await parse_schedule_request('随便说点什么');
    expect(result).toEqual({});
  });

  it('should return empty object for malformed JSON', async () => {
    mockCreate.mockResolvedValue(makeResponse('{invalid json'));
    const result = await parse_schedule_request('test');
    expect(result).toEqual({});
  });

  it('should reject past scheduled_time', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: '王五',
      candidate_telegram_username: null,
      scheduled_time_cst: '2020-01-01 10:00',
      duration_minutes: 30,
    })));

    const result = await parse_schedule_request('2020年面试王五');
    expect(result.candidate_name).toBe('王五');
    expect(result.scheduled_time).toBeUndefined();
    expect(result.duration_minutes).toBe(30);
  });

  it('should reject duration below 10', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: '赵六',
      candidate_telegram_username: null,
      scheduled_time_cst: null,
      duration_minutes: 5,
    })));

    const result = await parse_schedule_request('面试赵六5分钟');
    expect(result.duration_minutes).toBeUndefined();
  });

  it('should reject duration over 120', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: null,
      candidate_telegram_username: null,
      scheduled_time_cst: null,
      duration_minutes: 200,
    })));

    const result = await parse_schedule_request('test');
    expect(result.duration_minutes).toBeUndefined();
  });

  it('should handle empty content array', async () => {
    mockCreate.mockResolvedValue({ content: [] });
    const result = await parse_schedule_request('test');
    expect(result).toEqual({});
  });

  it('should strip @ from telegram username', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: 'Test',
      candidate_telegram_username: '@testuser',
      scheduled_time_cst: null,
      duration_minutes: null,
    })));

    const result = await parse_schedule_request('test');
    expect(result.candidate_telegram_username).toBe('testuser');
  });

  it('should handle non-string candidate_name', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: 123,
      candidate_telegram_username: null,
      scheduled_time_cst: null,
      duration_minutes: null,
    })));

    const result = await parse_schedule_request('test');
    expect(result.candidate_name).toBeUndefined();
  });

  it('should round float duration_minutes', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: null,
      candidate_telegram_username: null,
      scheduled_time_cst: null,
      duration_minutes: 30.7,
    })));

    const result = await parse_schedule_request('test');
    expect(result.duration_minutes).toBe(31);
  });

  it('should handle JSON embedded in other text', async () => {
    mockCreate.mockResolvedValue(makeResponse(
      '好的，以下是解析结果：\n```json\n{"candidate_name": "嵌入测试", "candidate_telegram_username": null, "scheduled_time_cst": null, "duration_minutes": null}\n```'
    ));

    const result = await parse_schedule_request('test');
    expect(result.candidate_name).toBe('嵌入测试');
  });

  it('should reject invalid time format', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: null,
      candidate_telegram_username: null,
      scheduled_time_cst: '明天下午三点',
      duration_minutes: null,
    })));

    const result = await parse_schedule_request('test');
    expect(result.scheduled_time).toBeUndefined();
  });

  it('should trim whitespace from candidate_name', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: '  张三  ',
      candidate_telegram_username: null,
      scheduled_time_cst: null,
      duration_minutes: null,
    })));

    const result = await parse_schedule_request('test');
    expect(result.candidate_name).toBe('张三');
  });

  it('should trim whitespace from telegram username', async () => {
    mockCreate.mockResolvedValue(makeResponse(JSON.stringify({
      candidate_name: null,
      candidate_telegram_username: '  @user  ',
      scheduled_time_cst: null,
      duration_minutes: null,
    })));

    const result = await parse_schedule_request('test');
    expect(result.candidate_telegram_username).toBe('user');
  });
});
