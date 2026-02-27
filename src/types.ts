export type InterviewStatus =
  | 'pending'
  | 'researching'
  | 'ready'
  | 'notified'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type InterviewPhase = 'intro' | 'questioning';

export type InterviewCategory =
  | 'ai_fundamentals'
  | 'agent_frameworks'
  | 'system_operations'
  | 'business_communication';

export type Recommendation =
  | 'strong_hire'
  | 'hire'
  | 'no_hire'
  | 'strong_no_hire';

export interface CandidateProfile {
  tech_stack: string[];
  years_of_experience: number | null;
  project_highlights: string[];
  suggested_focus_areas: string[];
}

export interface Interview {
  id: number;
  telegram_user_id: string;
  candidate_name: string;
  candidate_telegram_username: string;
  candidate_telegram_id: string;
  scheduled_time: number;
  duration_minutes: number;
  status: InterviewStatus;
  interview_phase: InterviewPhase;
  candidate_profile: CandidateProfile | null;
  research_notes: ResearchNotes | null;
  interview_questions: Question[] | null;
  conversation_history: ConversationMessage[] | null;
  summary: InterviewSummary | null;
  created_at: number;
  updated_at: number;
}

export interface ResearchNotes {
  summary: string;
  topics: ResearchTopic[];
  generated_at: number;
}

export interface ResearchTopic {
  category: InterviewCategory;
  key_concepts: string[];
  suggested_depth: 'surface' | 'moderate' | 'deep';
}

export interface Question {
  id: string;
  category: InterviewCategory;
  text: string;
  follow_ups: string[];
  scoring_rubric: string;
  difficulty: 'junior' | 'mid' | 'senior';
}

export interface ConversationMessage {
  role: 'assistant' | 'user';
  content: string;
  timestamp: number;
}

export interface CategoryScore {
  score: number;
  notes: string;
}

export interface InterviewSummary {
  overall_recommendation: Recommendation;
  overall_score: number;
  category_scores: Record<InterviewCategory, CategoryScore>;
  strengths: string[];
  weaknesses: string[];
  notable_quotes: string[];
  detailed_assessment: string;
  generated_at: number;
}

// In-memory scheduling wizard state
export interface SchedulingSession {
  step: 'nl_input' | 'name' | 'telegram' | 'datetime' | 'duration' | 'confirm';
  lang?: string; // locale code for this wizard session
  candidate_name?: string;
  candidate_telegram_username?: string;
  scheduled_time?: number;
  duration_minutes?: number;
}
