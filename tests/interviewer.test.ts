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

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn(),
      stream: vi.fn(),
    };
  },
}));

// Mock db module
vi.mock('../src/db.js', () => ({
  get_interview: vi.fn(),
  append_message: vi.fn(),
  get_conversation: vi.fn(() => []),
  set_phase_and_profile: vi.fn(),
  get_db: vi.fn(),
}));

import { build_interviewer_system_prompt, extract_summary } from '../src/interviewer.js';
import type { Interview, InterviewSummary, CandidateProfile } from '../src/types.js';
import type Anthropic from '@anthropic-ai/sdk';

function makeInterview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: 1,
    telegram_user_id: 'user1',
    candidate_name: '测试候选人',
    candidate_telegram_username: 'test_user',
    candidate_telegram_id: '',
    scheduled_time: Date.now(),
    duration_minutes: 30,
    status: 'in_progress',
    interview_phase: 'questioning',
    candidate_profile: null,
    research_notes: null,
    interview_questions: null,
    conversation_history: null,
    summary: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe('build_interviewer_system_prompt', () => {
  it('should generate intro phase prompt', () => {
    const interview = makeInterview({ interview_phase: 'intro' });
    const prompt = build_interviewer_system_prompt(interview, null);

    expect(prompt).toContain('测试候选人');
    expect(prompt).toContain('30 分钟');
    expect(prompt).toContain('自我介绍');
    // Intro phase should NOT contain question bank
    expect(prompt).not.toContain('准备好的面试题目');
  });

  it('should generate questioning phase prompt with default questions', () => {
    const interview = makeInterview({ interview_phase: 'questioning' });
    const prompt = build_interviewer_system_prompt(interview, 1500_000); // 25 min

    expect(prompt).toContain('测试候选人');
    expect(prompt).toContain('约 25 分钟');
    expect(prompt).toContain('准备好的面试题目');
    expect(prompt).toContain('使用默认面试题库');
    expect(prompt).toContain('INTERVIEW_COMPLETE');
  });

  it('should include candidate profile when available', () => {
    const profile: CandidateProfile = {
      tech_stack: ['Python', 'LangChain', 'Docker'],
      years_of_experience: 5,
      project_highlights: ['Built a RAG pipeline'],
      suggested_focus_areas: ['agent_frameworks', 'system_operations'],
    };
    const interview = makeInterview({
      interview_phase: 'questioning',
      candidate_profile: profile,
    });
    const prompt = build_interviewer_system_prompt(interview, null);

    expect(prompt).toContain('Python、LangChain、Docker');
    expect(prompt).toContain('约 5 年');
    expect(prompt).toContain('Built a RAG pipeline');
    expect(prompt).toContain('agent_frameworks、system_operations');
  });

  it('should handle null years_of_experience', () => {
    const profile: CandidateProfile = {
      tech_stack: ['TypeScript'],
      years_of_experience: null,
      project_highlights: [],
      suggested_focus_areas: [],
    };
    const interview = makeInterview({
      interview_phase: 'questioning',
      candidate_profile: profile,
    });
    const prompt = build_interviewer_system_prompt(interview, null);

    expect(prompt).toContain('未明确');
  });

  it('should handle empty profile arrays', () => {
    const profile: CandidateProfile = {
      tech_stack: [],
      years_of_experience: null,
      project_highlights: [],
      suggested_focus_areas: [],
    };
    const interview = makeInterview({
      interview_phase: 'questioning',
      candidate_profile: profile,
    });
    const prompt = build_interviewer_system_prompt(interview, null);

    expect(prompt).toContain('未提及');
    expect(prompt).toContain('按标准流程');
  });

  it('should include research notes when available', () => {
    const interview = makeInterview({
      research_notes: {
        summary: '候选人有丰富的 AI 经验',
        topics: [],
        generated_at: Date.now(),
      },
    });
    const prompt = build_interviewer_system_prompt(interview, null);

    expect(prompt).toContain('候选人有丰富的 AI 经验');
  });

  it('should include interview questions when available', () => {
    const interview = makeInterview({
      interview_questions: [{
        id: 'q1',
        category: 'ai_fundamentals',
        text: '什么是 Transformer？',
        follow_ups: [],
        scoring_rubric: 'test',
        difficulty: 'junior',
      }],
    });
    const prompt = build_interviewer_system_prompt(interview, null);

    expect(prompt).toContain('什么是 Transformer？');
  });

  it('should show 0 minutes when time is up', () => {
    const interview = makeInterview();
    const prompt = build_interviewer_system_prompt(interview, -5000);

    expect(prompt).toContain('约 0 分钟');
  });

  it('should omit time info when time_remaining_ms is null', () => {
    const interview = makeInterview();
    const prompt = build_interviewer_system_prompt(interview, null);

    expect(prompt).not.toContain('剩余时间');
  });
});

describe('extract_summary', () => {
  function makeMessage(text: string) {
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [{ type: 'text' as const, text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, inference_geo: null, server_tool_use: null, service_tier: null },
    } as unknown as Anthropic.Message;
  }

  it('should parse valid summary JSON', () => {
    const summary: InterviewSummary = {
      overall_recommendation: 'hire',
      overall_score: 78,
      category_scores: {
        ai_fundamentals: { score: 20, notes: '扎实' },
        agent_frameworks: { score: 18, notes: '有经验' },
        system_operations: { score: 22, notes: '优秀' },
        business_communication: { score: 18, notes: '良好' },
      },
      strengths: ['技术深度好'],
      weaknesses: ['沟通可以加强'],
      notable_quotes: ['我做过 RAG 系统'],
      detailed_assessment: '整体不错的候选人',
      generated_at: Date.now(),
    };

    const result = extract_summary(makeMessage(JSON.stringify(summary)));
    expect(result.overall_recommendation).toBe('hire');
    expect(result.overall_score).toBe(78);
    expect(result.category_scores.ai_fundamentals.score).toBe(20);
  });

  it('should extract JSON embedded in markdown code block', () => {
    const json = JSON.stringify({
      overall_recommendation: 'strong_hire',
      overall_score: 90,
      category_scores: {
        ai_fundamentals: { score: 23, notes: 'Excellent' },
        agent_frameworks: { score: 24, notes: 'Outstanding' },
        system_operations: { score: 22, notes: 'Very good' },
        business_communication: { score: 21, notes: 'Good' },
      },
      strengths: ['Deep knowledge'],
      weaknesses: [],
      notable_quotes: [],
      detailed_assessment: 'Top candidate',
      generated_at: Date.now(),
    });

    const result = extract_summary(makeMessage(`以下是评估报告：\n\`\`\`json\n${json}\n\`\`\``));
    expect(result.overall_recommendation).toBe('strong_hire');
    expect(result.overall_score).toBe(90);
  });

  it('should return fallback summary for invalid JSON', () => {
    const result = extract_summary(makeMessage('这不是有效的 JSON'));
    expect(result.overall_recommendation).toBe('no_hire');
    expect(result.overall_score).toBe(0);
    expect(result.weaknesses).toContain('评估报告解析失败，请查看原始对话记录');
  });

  it('should return fallback for empty content', () => {
    const msg = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Anthropic.Message;
    const result = extract_summary(msg);
    expect(result.overall_recommendation).toBe('no_hire');
    expect(result.overall_score).toBe(0);
  });

  it('should return fallback for JSON without overall_recommendation', () => {
    const result = extract_summary(makeMessage('{"foo": "bar"}'));
    expect(result.overall_recommendation).toBe('no_hire');
    expect(result.overall_score).toBe(0);
  });

  it('should truncate detailed_assessment in fallback to 500 chars', () => {
    const longText = 'A'.repeat(1000);
    const result = extract_summary(makeMessage(longText));
    expect(result.detailed_assessment.length).toBeLessThanOrEqual(500);
  });

  it('should handle thinking blocks mixed with text', () => {
    const json = JSON.stringify({
      overall_recommendation: 'no_hire',
      overall_score: 45,
      category_scores: {
        ai_fundamentals: { score: 10, notes: 'Weak' },
        agent_frameworks: { score: 12, notes: 'Basic' },
        system_operations: { score: 13, notes: 'OK' },
        business_communication: { score: 10, notes: 'Poor' },
      },
      strengths: [],
      weaknesses: ['Lacks depth'],
      notable_quotes: [],
      detailed_assessment: 'Not ready',
      generated_at: Date.now(),
    });

    const msg = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [
        { type: 'thinking', thinking: 'Let me analyze...' },
        { type: 'text', text: json, citations: null },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Anthropic.Message;

    const result = extract_summary(msg);
    expect(result.overall_recommendation).toBe('no_hire');
    expect(result.overall_score).toBe(45);
  });
});
