import Anthropic from '@anthropic-ai/sdk';
import type { WebSearchTool20260209 } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { config } from './config.js';
import type { ResearchNotes, Question, InterviewCategory } from './types.js';

const client = new Anthropic({ apiKey: config.anthropic.api_key, baseURL: config.anthropic.base_url });

const RESEARCH_SYSTEM_PROMPT = `你是一位专业的技术招聘官，正在为"AI Agent 管理员"职位准备面试。
使用 web_search 工具搜集以下信息：
1. AI Agent 生态系统现状（LangChain、AutoGen、CrewAI、Claude SDK、LlamaIndex 等框架）
2. AI Agent 管理员岗位的技能要求和职责
3. LLM 部署与监控的最佳实践
4. RAG、Prompt 工程、Agent 编排的最新进展

将搜索结果整合为结构化的研究报告，用中文输出。`;

const QUESTION_SYSTEM_PROMPT = `你是一位资深技术面试官，专注于 AI Agent 管理员岗位的面试设计。
根据提供的研究资料，生成结构化的面试题目。
必须严格按照 JSON 格式输出，不要包含任何其他文字。`;

export async function run_research(candidate_name: string, duration_minutes: number): Promise<{
  notes: ResearchNotes;
  questions: Question[];
}> {
  // 5 minutes per question, max 10
  const total_questions = Math.min(10, Math.max(1, Math.floor(duration_minutes / 5)));
  // Distribute evenly across 4 categories, remainder goes to first categories
  const per_category = Math.floor(total_questions / 4);
  const remainder = total_questions % 4;
  const category_counts = [
    per_category + (remainder > 0 ? 1 : 0),
    per_category + (remainder > 1 ? 1 : 0),
    per_category + (remainder > 2 ? 1 : 0),
    per_category,
  ];

  console.log(`[researcher] Starting research for candidate: ${candidate_name}, duration: ${duration_minutes}min, questions: ${total_questions}`);

  // Phase 1: Web research
  const research_response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    tools: [{ type: 'web_search_20260209', name: 'web_search' } satisfies WebSearchTool20260209],
    tool_choice: { type: 'auto' },
    system: RESEARCH_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `请搜索并整理"AI Agent 管理员"岗位的面试准备资料。
重点搜索：
- 2024-2025年 AI Agent 框架的最新发展
- AI Agent 管理员的核心技能要求
- LLM 生产环境部署和监控实践
- 常见的 Agent 架构模式

最终以 JSON 格式输出，结构如下：
{
  "summary": "2-3段综合概述",
  "topics": [
    {
      "category": "ai_fundamentals|agent_frameworks|system_operations|business_communication",
      "key_concepts": ["概念1", "概念2"],
      "suggested_depth": "surface|moderate|deep"
    }
  ],
  "generated_at": ${Date.now()}
}`,
    }],
  });

  const notes = extract_research_notes(research_response);
  console.log(`[researcher] Research complete, generating questions...`);

  // Phase 2: Generate interview questions based on research
  const questions_response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 6000,
    thinking: { type: 'adaptive' },
    system: QUESTION_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
  content: `基于以下研究资料，为"AI Agent 管理员"岗位生成 ${total_questions} 道面试题，均匀分布在4个类别中（ai_fundamentals ${category_counts[0]} 道、agent_frameworks ${category_counts[1]} 道、system_operations ${category_counts[2]} 道、business_communication ${category_counts[3]} 道）。

研究资料：
${JSON.stringify(notes, null, 2)}

输出格式（严格 JSON 数组）：
[
  {
    "id": "q1",
    "category": "ai_fundamentals",
    "text": "问题内容",
    "follow_ups": ["追问1", "追问2"],
    "scoring_rubric": "评分标准描述",
    "difficulty": "junior|mid|senior"
  }
]

类别说明：
- ai_fundamentals: AI/LLM 基础知识（模型原理、Prompt 工程、RAG 等）
- agent_frameworks: Agent 框架使用经验（LangChain、AutoGen、Claude SDK 等）
- system_operations: 系统运维与监控（部署、日志、性能监控、故障排查）
- business_communication: 业务理解与沟通能力（需求分析、跨团队协作、文档撰写）

每个类别难度分布尽量均衡（junior、mid、senior）。`,
    }],
  });

  const questions = extract_questions(questions_response);
  console.log(`[researcher] Generated ${questions.length} questions`);

  return { notes, questions };
}

function extract_research_notes(response: Anthropic.Message): ResearchNotes {
  const text_blocks = (response.content ?? []).filter(b => b.type === 'text');
  const full_text = text_blocks.map(b => (b as Anthropic.TextBlock).text).join('\n');

  // Try to extract JSON from the response
  const json_match = full_text.match(/\{[\s\S]*"summary"[\s\S]*"topics"[\s\S]*\}/);
  if (json_match) {
    try {
      const parsed = JSON.parse(json_match[0]);
      return {
        summary: parsed.summary ?? full_text.slice(0, 500),
        topics: parsed.topics ?? get_default_topics(),
        generated_at: Date.now(),
      };
    } catch {
      // fall through to default
    }
  }

  // Fallback: use text as summary with default topics
  return {
    summary: full_text.slice(0, 1000),
    topics: get_default_topics(),
    generated_at: Date.now(),
  };
}

function extract_questions(response: Anthropic.Message): Question[] {
  const text_blocks = (response.content ?? []).filter(b => b.type === 'text');
  const full_text = text_blocks.map(b => (b as Anthropic.TextBlock).text).join('\n');

  // Extract JSON array
  const json_match = full_text.match(/\[[\s\S]*\]/);
  if (json_match) {
    try {
      const parsed = JSON.parse(json_match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as Question[];
      }
    } catch {
      // fall through to defaults
    }
  }

  return get_default_questions();
}

function get_default_topics() {
  const categories: InterviewCategory[] = [
    'ai_fundamentals',
    'agent_frameworks',
    'system_operations',
    'business_communication',
  ];
  return categories.map(category => ({
    category,
    key_concepts: [],
    suggested_depth: 'moderate' as const,
  }));
}

function get_default_questions(): Question[] {
  return [
    {
      id: 'q1', category: 'ai_fundamentals', difficulty: 'mid',
      text: '请解释 RAG（检索增强生成）的工作原理，以及在什么场景下会选择使用它？',
      follow_ups: ['如何评估 RAG 系统的效果？', '遇到过哪些 RAG 的局限性？'],
      scoring_rubric: '能清晰解释原理得基础分，能结合实际场景和权衡得高分',
    },
    {
      id: 'q2', category: 'ai_fundamentals', difficulty: 'junior',
      text: '什么是 Prompt 工程？你有哪些常用的 Prompt 优化技巧？',
      follow_ups: ['能举一个你优化 Prompt 的实际案例吗？'],
      scoring_rubric: '了解基本概念得基础分，有实践经验和具体技巧得高分',
    },
    {
      id: 'q3', category: 'ai_fundamentals', difficulty: 'mid',
      text: '如何处理 LLM 的幻觉问题？在生产环境中有哪些缓解策略？',
      follow_ups: ['你如何在系统层面检测幻觉？'],
      scoring_rubric: '了解问题本质得基础分，有系统性解决方案得高分',
    },
    {
      id: 'q4', category: 'ai_fundamentals', difficulty: 'senior',
      text: '请比较不同的 LLM 微调方法（全量微调、LoRA、RLHF），各自适用什么场景？',
      follow_ups: ['你有实际微调模型的经验吗？'],
      scoring_rubric: '能准确比较各方法得基础分，有实践经验和深度理解得高分',
    },
    {
      id: 'q5', category: 'agent_frameworks', difficulty: 'junior',
      text: '你使用过哪些 AI Agent 框架？请介绍一个你最熟悉的框架的核心概念。',
      follow_ups: ['为什么选择这个框架而不是其他的？'],
      scoring_rubric: '了解至少一个框架得基础分，能深入讲解架构和权衡得高分',
    },
    {
      id: 'q6', category: 'agent_frameworks', difficulty: 'mid',
      text: '如何设计一个多 Agent 协作系统？请描述你会考虑的关键设计决策。',
      follow_ups: ['如何处理 Agent 之间的通信和状态同步？'],
      scoring_rubric: '有基本设计思路得基础分，考虑到容错、扩展性等得高分',
    },
    {
      id: 'q7', category: 'agent_frameworks', difficulty: 'mid',
      text: '在使用 Claude API 或类似 LLM API 时，如何管理 Token 消耗和成本控制？',
      follow_ups: ['有没有用过 Prompt Caching 等优化手段？'],
      scoring_rubric: '了解基本成本概念得基础分，有实际优化经验得高分',
    },
    {
      id: 'q8', category: 'agent_frameworks', difficulty: 'senior',
      text: '请描述一个你构建或维护的复杂 Agent 系统，遇到了什么挑战，如何解决的？',
      follow_ups: ['如果重新设计，你会做哪些不同的决策？'],
      scoring_rubric: '有实际项目经验得基础分，能深入分析问题和解决方案得高分',
    },
    {
      id: 'q9', category: 'system_operations', difficulty: 'junior',
      text: '如何监控一个 LLM 应用的健康状态？你会关注哪些关键指标？',
      follow_ups: ['如何设置告警阈值？'],
      scoring_rubric: '了解基本监控概念得基础分，有完整监控体系思路得高分',
    },
    {
      id: 'q10', category: 'system_operations', difficulty: 'mid',
      text: '当 LLM 服务出现延迟突增时，你的排查思路是什么？',
      follow_ups: ['如何区分是模型问题还是基础设施问题？'],
      scoring_rubric: '有系统性排查思路得基础分，能快速定位根因得高分',
    },
    {
      id: 'q11', category: 'system_operations', difficulty: 'mid',
      text: '如何设计 LLM 应用的日志系统？需要记录哪些信息？',
      follow_ups: ['如何在日志详细度和存储成本之间取得平衡？'],
      scoring_rubric: '了解日志基础得基础分，考虑到可观测性和隐私保护得高分',
    },
    {
      id: 'q12', category: 'system_operations', difficulty: 'senior',
      text: '如何为 AI Agent 系统设计灾备和降级方案？',
      follow_ups: ['如何在不影响用户体验的情况下进行模型版本升级？'],
      scoring_rubric: '有基本高可用思路得基础分，有完整的灾备和发布策略得高分',
    },
    {
      id: 'q13', category: 'business_communication', difficulty: 'junior',
      text: '如何向非技术背景的业务方解释 AI Agent 的能力边界和局限性？',
      follow_ups: ['遇到过业务方对 AI 期望过高的情况吗？如何处理？'],
      scoring_rubric: '能清晰表达得基础分，有实际沟通经验和技巧得高分',
    },
    {
      id: 'q14', category: 'business_communication', difficulty: 'mid',
      text: '在推进一个 AI Agent 项目时，如何与产品、研发、运营等团队协作？',
      follow_ups: ['如何处理不同团队之间的优先级冲突？'],
      scoring_rubric: '了解跨团队协作基础得基础分，有实际项目管理经验得高分',
    },
    {
      id: 'q15', category: 'business_communication', difficulty: 'mid',
      text: '如何评估一个 AI Agent 项目的 ROI？你会用哪些指标来衡量成功？',
      follow_ups: ['如何向管理层汇报 AI 项目的进展和价值？'],
      scoring_rubric: '有基本业务思维得基础分，能量化 AI 价值并有效汇报得高分',
    },
    {
      id: 'q16', category: 'business_communication', difficulty: 'senior',
      text: '请描述一个你主导推动的 AI 相关技术决策，如何获得各方认可并落地执行？',
      follow_ups: ['遇到阻力时如何处理？'],
      scoring_rubric: '有实际决策经验得基础分，展现出领导力和影响力得高分',
    },
  ];
}
