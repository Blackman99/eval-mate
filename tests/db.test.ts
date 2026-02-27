import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// vi.mock is hoisted — factory must be self-contained (no external refs)
vi.mock('../src/config.js', async () => {
  const os = await import('os');
  const path = await import('path');
  return {
    config: {
      db: { path: path.join(os.tmpdir(), 'test-eval-mate.db') },
      interview: { research_lead_hours: 2 },
      anthropic: { api_key: 'test', base_url: 'http://localhost', model: 'test' },
      telegram: { bot_token: 'test', admin_chat_id: 'test' },
      admin_locale: 'zh-CN',
    },
  };
});

const TEST_DB_PATH = join(tmpdir(), 'test-eval-mate.db');

import {
  init_db,
  create_interview,
  get_interview,
  get_interview_by_user,
  get_interviews_by_user,
  update_interview_status,
  set_interview_phase,
  set_candidate_profile,
  set_phase_and_profile,
  append_message,
  get_conversation,
  set_research,
  set_summary,
  cancel_interview,
  get_user_lang,
  set_user_lang,
  get_due_interviews,
  get_notified_interviews,
  get_in_progress_interviews,
  get_db,
  is_valid_candidate_profile,
  safe_parse_candidate_profile,
} from '../src/db.js';
import type { CandidateProfile, ResearchNotes, Question, InterviewSummary } from '../src/types.js';

describe('Database', () => {
  beforeEach(async () => {
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(TEST_DB_PATH);
    } catch { /* file doesn't exist */ }
    await init_db();
  });

  describe('init_db', () => {
    it('should create a new database file', () => {
      expect(existsSync(TEST_DB_PATH)).toBe(true);
    });

    it('should be idempotent', async () => {
      await init_db();
      expect(existsSync(TEST_DB_PATH)).toBe(true);
    });
  });

  describe('create_interview & get_interview', () => {
    it('should create and retrieve an interview', () => {
      const id = create_interview({
        telegram_user_id: 'user123',
        candidate_name: 'Alice',
        candidate_telegram_username: 'alice_tg',
        scheduled_time: Date.now() + 3600_000,
        duration_minutes: 30,
      });

      expect(id).toBeGreaterThan(0);
      const interview = get_interview(id);
      expect(interview).not.toBeNull();
      expect(interview!.candidate_name).toBe('Alice');
      expect(interview!.status).toBe('pending');
      expect(interview!.interview_phase).toBe('intro');
      expect(interview!.candidate_profile).toBeNull();
    });

    it('should return null for non-existent interview', () => {
      expect(get_interview(9999)).toBeNull();
    });
  });

  describe('update_interview_status', () => {
    it('should update status correctly', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'Bob',
        candidate_telegram_username: 'bob',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      update_interview_status(id, 'researching');
      expect(get_interview(id)!.status).toBe('researching');
      update_interview_status(id, 'ready');
      expect(get_interview(id)!.status).toBe('ready');
    });
  });

  describe('interview_phase & candidate_profile', () => {
    it('should set interview phase', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'C',
        candidate_telegram_username: 'c',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      expect(get_interview(id)!.interview_phase).toBe('intro');
      set_interview_phase(id, 'questioning');
      expect(get_interview(id)!.interview_phase).toBe('questioning');
    });

    it('should set candidate profile', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'D',
        candidate_telegram_username: 'd',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      const profile: CandidateProfile = {
        tech_stack: ['Python', 'LangChain'],
        years_of_experience: 3,
        project_highlights: ['Built a RAG system'],
        suggested_focus_areas: ['agent_frameworks'],
      };
      set_candidate_profile(id, profile);
      expect(get_interview(id)!.candidate_profile).toEqual(profile);
    });

    it('should atomically set phase and profile', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'E',
        candidate_telegram_username: 'e',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      const profile: CandidateProfile = {
        tech_stack: ['TypeScript'], years_of_experience: 5,
        project_highlights: [], suggested_focus_areas: [],
      };
      set_phase_and_profile(id, 'questioning', profile);
      const interview = get_interview(id)!;
      expect(interview.interview_phase).toBe('questioning');
      expect(interview.candidate_profile).toEqual(profile);
    });

    it('should fallback invalid phase to intro', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'F',
        candidate_telegram_username: 'f',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      get_db().run('UPDATE interviews SET interview_phase = ? WHERE id = ?', ['invalid_phase', id]);
      expect(get_interview(id)!.interview_phase).toBe('intro');
    });

    it('should handle malformed candidate_profile JSON', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'G',
        candidate_telegram_username: 'g',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      get_db().run('UPDATE interviews SET candidate_profile = ? WHERE id = ?', ['not-json', id]);
      expect(get_interview(id)!.candidate_profile).toBeNull();
    });

    it('should handle structurally invalid candidate_profile', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'H',
        candidate_telegram_username: 'h',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      get_db().run('UPDATE interviews SET candidate_profile = ? WHERE id = ?', ['{"foo":"bar"}', id]);
      expect(get_interview(id)!.candidate_profile).toBeNull();
    });
  });

  describe('messages', () => {
    it('should append and retrieve conversation', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'I',
        candidate_telegram_username: 'i',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      append_message(id, 'assistant', 'Hello');
      append_message(id, 'user', 'Hi');
      append_message(id, 'assistant', 'Tell me about yourself');
      const conv = get_conversation(id);
      expect(conv).toHaveLength(3);
      expect(conv[0].role).toBe('assistant');
      expect(conv[1].content).toBe('Hi');
    });

    it('should return empty array for no messages', () => {
      const id = create_interview({
        telegram_user_id: 'u1', candidate_name: 'J',
        candidate_telegram_username: 'j',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      expect(get_conversation(id)).toEqual([]);
    });
  });

  describe('user language', () => {
    it('should return null for unknown user', () => {
      expect(get_user_lang('unknown')).toBeNull();
    });

    it('should set and get language', () => {
      set_user_lang('ua', 'en-US');
      expect(get_user_lang('ua')).toBe('en-US');
    });

    it('should update existing language', () => {
      set_user_lang('ub', 'zh-CN');
      set_user_lang('ub', 'en-US');
      expect(get_user_lang('ub')).toBe('en-US');
    });
  });

  describe('query helpers', () => {
    it('get_interview_by_user returns active interview', () => {
      const id = create_interview({
        telegram_user_id: 'uq', candidate_name: 'Q',
        candidate_telegram_username: 'q',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      expect(get_interview_by_user('uq')!.id).toBe(id);
    });

    it('get_interview_by_user skips completed', () => {
      const id = create_interview({
        telegram_user_id: 'ud', candidate_name: 'D',
        candidate_telegram_username: 'd',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      update_interview_status(id, 'completed');
      expect(get_interview_by_user('ud')).toBeNull();
    });

    it('get_interviews_by_user returns multiple', () => {
      create_interview({
        telegram_user_id: 'um', candidate_name: 'A',
        candidate_telegram_username: 'a',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      create_interview({
        telegram_user_id: 'um', candidate_name: 'B',
        candidate_telegram_username: 'b',
        scheduled_time: Date.now() + 7200_000, duration_minutes: 30,
      });
      expect(get_interviews_by_user('um')).toHaveLength(2);
    });

    it('cancel_interview sets cancelled', () => {
      const id = create_interview({
        telegram_user_id: 'uc', candidate_name: 'C',
        candidate_telegram_username: 'c',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      cancel_interview(id);
      expect(get_interview(id)!.status).toBe('cancelled');
    });

    it('get_due_interviews returns ready past-scheduled', () => {
      const id = create_interview({
        telegram_user_id: 'udue', candidate_name: 'Due',
        candidate_telegram_username: 'due',
        scheduled_time: Date.now() - 1000, duration_minutes: 30,
      });
      update_interview_status(id, 'ready');
      expect(get_due_interviews().some(i => i.id === id)).toBe(true);
    });

    it('get_notified_interviews returns notified', () => {
      const id = create_interview({
        telegram_user_id: 'un', candidate_name: 'N',
        candidate_telegram_username: 'n',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      update_interview_status(id, 'notified');
      expect(get_notified_interviews().some(i => i.id === id)).toBe(true);
    });

    it('get_in_progress_interviews returns in_progress', () => {
      const id = create_interview({
        telegram_user_id: 'uip', candidate_name: 'IP',
        candidate_telegram_username: 'ip',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      update_interview_status(id, 'in_progress');
      expect(get_in_progress_interviews().some(i => i.id === id)).toBe(true);
    });
  });

  describe('research & summary', () => {
    it('should set and retrieve research notes', () => {
      const id = create_interview({
        telegram_user_id: 'ur', candidate_name: 'R',
        candidate_telegram_username: 'r',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      const notes: ResearchNotes = {
        summary: 'Test research',
        topics: [{ category: 'ai_fundamentals', key_concepts: ['transformers'], suggested_depth: 'moderate' }],
        generated_at: Date.now(),
      };
      const questions: Question[] = [{
        id: 'q1', category: 'ai_fundamentals', text: 'What is a transformer?',
        follow_ups: ['Explain attention'], scoring_rubric: 'Knows basics', difficulty: 'junior',
      }];
      set_research(id, notes, questions);
      const interview = get_interview(id)!;
      expect(interview.research_notes!.summary).toBe('Test research');
      expect(interview.interview_questions).toHaveLength(1);
    });

    it('should set and retrieve summary', () => {
      const id = create_interview({
        telegram_user_id: 'us', candidate_name: 'S',
        candidate_telegram_username: 's',
        scheduled_time: Date.now() + 3600_000, duration_minutes: 30,
      });
      const summary: InterviewSummary = {
        overall_recommendation: 'hire', overall_score: 75,
        category_scores: {
          ai_fundamentals: { score: 20, notes: 'Good' },
          agent_frameworks: { score: 18, notes: 'Decent' },
          system_operations: { score: 20, notes: 'Strong' },
          business_communication: { score: 17, notes: 'OK' },
        },
        strengths: ['Technical depth'], weaknesses: ['Communication'],
        notable_quotes: ['I built a RAG system'],
        detailed_assessment: 'Overall good candidate', generated_at: Date.now(),
      };
      set_summary(id, summary);
      expect(get_interview(id)!.summary!.overall_recommendation).toBe('hire');
      expect(get_interview(id)!.summary!.overall_score).toBe(75);
    });
  });

  describe('is_valid_candidate_profile', () => {
    it('should accept valid profile', () => {
      expect(is_valid_candidate_profile({
        tech_stack: ['Python'],
        years_of_experience: 3,
        project_highlights: ['RAG'],
        suggested_focus_areas: ['ai_fundamentals'],
      })).toBe(true);
    });

    it('should accept null years_of_experience', () => {
      expect(is_valid_candidate_profile({
        tech_stack: [],
        years_of_experience: null,
        project_highlights: [],
        suggested_focus_areas: [],
      })).toBe(true);
    });

    it('should reject null', () => {
      expect(is_valid_candidate_profile(null)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(is_valid_candidate_profile(undefined)).toBe(false);
    });

    it('should reject non-object', () => {
      expect(is_valid_candidate_profile('string')).toBe(false);
      expect(is_valid_candidate_profile(42)).toBe(false);
    });

    it('should reject missing tech_stack', () => {
      expect(is_valid_candidate_profile({
        years_of_experience: 3,
        project_highlights: [],
        suggested_focus_areas: [],
      })).toBe(false);
    });

    it('should reject non-array tech_stack', () => {
      expect(is_valid_candidate_profile({
        tech_stack: 'Python',
        years_of_experience: 3,
        project_highlights: [],
        suggested_focus_areas: [],
      })).toBe(false);
    });

    it('should reject string years_of_experience', () => {
      expect(is_valid_candidate_profile({
        tech_stack: [],
        years_of_experience: '3',
        project_highlights: [],
        suggested_focus_areas: [],
      })).toBe(false);
    });

    it('should reject missing project_highlights', () => {
      expect(is_valid_candidate_profile({
        tech_stack: [],
        years_of_experience: null,
        suggested_focus_areas: [],
      })).toBe(false);
    });

    it('should reject missing suggested_focus_areas', () => {
      expect(is_valid_candidate_profile({
        tech_stack: [],
        years_of_experience: null,
        project_highlights: [],
      })).toBe(false);
    });
  });

  describe('safe_parse_candidate_profile', () => {
    it('should parse valid JSON profile', () => {
      const profile = safe_parse_candidate_profile(JSON.stringify({
        tech_stack: ['TypeScript'],
        years_of_experience: 5,
        project_highlights: ['Built eval-mate'],
        suggested_focus_areas: ['agent_frameworks'],
      }));
      expect(profile).not.toBeNull();
      expect(profile!.tech_stack).toEqual(['TypeScript']);
    });

    it('should return null for null input', () => {
      expect(safe_parse_candidate_profile(null)).toBeNull();
    });

    it('should return null for undefined input', () => {
      expect(safe_parse_candidate_profile(undefined)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(safe_parse_candidate_profile('')).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      expect(safe_parse_candidate_profile('not json')).toBeNull();
    });

    it('should return null for valid JSON with wrong structure', () => {
      expect(safe_parse_candidate_profile('{"foo":"bar"}')).toBeNull();
    });

    it('should return null for array JSON', () => {
      expect(safe_parse_candidate_profile('[1,2,3]')).toBeNull();
    });

    it('should return null for JSON with wrong types', () => {
      expect(safe_parse_candidate_profile(JSON.stringify({
        tech_stack: 'not an array',
        years_of_experience: 3,
        project_highlights: [],
        suggested_focus_areas: [],
      }))).toBeNull();
    });
  });
});
