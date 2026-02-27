import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const client = new Anthropic({ apiKey: config.anthropic.api_key, baseURL: config.anthropic.base_url });

const SYSTEM_PROMPT = `你是一个面试预约助手。从用户输入中提取面试信息，严格输出 JSON，不含任何其他文字：
{
  "candidate_name": "候选人姓名，无法确定则为 null",
  "candidate_telegram_username": "候选人 Telegram 用户名（不含@），无法确定则为 null",
  "scheduled_time_cst": "YYYY-MM-DD HH:MM 格式的北京时间，无法确定则为 null",
  "duration_minutes": 面试时长整数（10-120），无法确定则为 null
}`;

export interface ParsedSchedule {
  candidate_name?: string;
  candidate_telegram_username?: string;
  scheduled_time?: number;   // UTC ms
  duration_minutes?: number;
}

export async function parse_schedule_request(text: string): Promise<ParsedSchedule> {
  const now_cst = new Date(Date.now() + 8 * 3600_000)
    .toISOString().slice(0, 16).replace('T', ' ');

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `当前北京时间：${now_cst}\n\n用户输入：${text}`,
    }],
  });

  const raw = (response.content ?? [])
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('');

  const json_match = raw.match(/\{[\s\S]*\}/);
  if (!json_match) return {};

  try {
    const parsed = JSON.parse(json_match[0]);
    const result: ParsedSchedule = {};

    if (parsed.candidate_name && typeof parsed.candidate_name === 'string') {
      result.candidate_name = parsed.candidate_name.trim();
    }

    if (parsed.candidate_telegram_username && typeof parsed.candidate_telegram_username === 'string') {
      result.candidate_telegram_username = parsed.candidate_telegram_username.trim().replace(/^@/, '');
    }

    if (parsed.scheduled_time_cst && typeof parsed.scheduled_time_cst === 'string') {
      const match = parsed.scheduled_time_cst.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
      if (match) {
        const [, year, month, day, hour, minute] = match;
        const utc_ms = Date.UTC(
          parseInt(year), parseInt(month) - 1, parseInt(day),
          parseInt(hour) - 8, parseInt(minute)
        );
        if (!isNaN(utc_ms) && utc_ms > Date.now()) {
          result.scheduled_time = utc_ms;
        }
      }
    }

    if (typeof parsed.duration_minutes === 'number' &&
        parsed.duration_minutes >= 10 && parsed.duration_minutes <= 120) {
      result.duration_minutes = Math.round(parsed.duration_minutes);
    }

    return result;
  } catch {
    return {};
  }
}
