import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { get_interview, append_message, get_conversation, set_interview_phase, set_candidate_profile } from './db.js';
import type { Interview, InterviewSummary, InterviewCategory, CandidateProfile } from './types.js';

const client = new Anthropic({ apiKey: config.anthropic.api_key, baseURL: config.anthropic.base_url });

function build_interviewer_system_prompt(interview: Interview, time_remaining_ms: number | null): string {
  const time_info = time_remaining_ms !== null
    ? `剩余时间：约 ${Math.max(0, Math.round(time_remaining_ms / 60000))} 分钟`
    : '';

  const questions_text = interview.interview_questions
    ? JSON.stringify(interview.interview_questions, null, 2)
    : '使用默认面试题库';

  const research_text = interview.research_notes
    ? `研究背景：\n${interview.research_notes.summary}`
    : '';

  if (interview.interview_phase === 'intro') {
    return `你是一位专业的技术面试官，正在对候选人进行"AI Agent 管理员"职位的面试。

候选人姓名：${interview.candidate_name}
面试时长：${interview.duration_minutes} 分钟
${time_info}

${research_text}

面试指导原则：
1. 保持专业、友好、鼓励的态度
2. 全程使用中文交流
3. 不要透露评分标准，不要主动说明你是 AI（除非被直接询问）

面试开始时，先做简短的自我介绍，说明本次面试的职位和大致流程，然后请候选人做自我介绍（介绍自己的背景、技术栈、工作经验、项目经历等）。`;
  }

  const profile_text = interview.candidate_profile
    ? `候选人背景（从自我介绍中提取）：
- 技术栈：${interview.candidate_profile.tech_stack.join('、') || '未提及'}
- 经验年限：${interview.candidate_profile.years_of_experience !== null ? `约 ${interview.candidate_profile.years_of_experience} 年` : '未明确'}
- 项目亮点：${interview.candidate_profile.project_highlights.join('；') || '未提及'}
- 建议重点考察方向：${interview.candidate_profile.suggested_focus_areas.join('、') || '按标准流程'}

请根据候选人背景调整提问深度和方向。例如：候选人提到有 LangChain 经验，则在 agent_frameworks 维度深入考察 LangChain 的具体使用；候选人经验年限较浅，则适当降低难度；候选人有丰富的系统运维经验，则在 system_operations 维度深入考察。`
    : '';

  return `你是一位专业的技术面试官，正在对候选人进行"AI Agent 管理员"职位的面试。

候选人姓名：${interview.candidate_name}
面试时长：${interview.duration_minutes} 分钟
${time_info}

${research_text}

${profile_text}

准备好的面试题目：
${questions_text}

面试指导原则：
1. 保持专业、友好、鼓励的态度
2. 每次只问一个问题，根据回答自然追问
3. 覆盖四个考察维度：AI基础知识、Agent框架经验、系统运维、业务沟通
4. 对模糊的回答深入追问；对优秀的回答给予认可
5. 时间不足5分钟时，礼貌地进行收尾
6. 面试结束时，在回复末尾单独一行写 INTERVIEW_COMPLETE
7. 全程使用中文交流
8. 不要透露评分标准，不要主动说明你是 AI（除非被直接询问）`;
}

const SUMMARY_SYSTEM_PROMPT = `你是一位资深技术招聘官，负责分析 AI Agent 管理员职位的面试结果。
请根据完整的面试对话，生成客观、详细的评估报告。
必须严格按照 JSON 格式输出，不包含任何其他文字。

评分标准：
- ai_fundamentals（AI基础知识）：0-25分
- agent_frameworks（Agent框架经验）：0-25分
- system_operations（系统运维）：0-25分
- business_communication（业务沟通）：0-25分
- overall_score = 四项之和（0-100）

推荐结论：
- strong_hire：85分以上，各维度均衡优秀
- hire：70-84分，整体良好，有明显优势
- no_hire：50-69分，存在明显短板
- strong_no_hire：50分以下，不符合岗位要求`;

export async function send_opening_message(interview_id: number): Promise<string> {
  const interview = get_interview(interview_id);
  if (!interview) throw new Error(`Interview ${interview_id} not found`);

  const response = await generate_interviewer_turn(interview, null);
  append_message(interview_id, 'assistant', response);
  return response;
}

export async function handle_candidate_reply(
  interview_id: number,
  candidate_message: string,
): Promise<{ response: string; should_end: boolean }> {
  append_message(interview_id, 'user', candidate_message);

  const interview = get_interview(interview_id);
  if (!interview) throw new Error(`Interview ${interview_id} not found`);

  // If still in intro phase, analyze the self-introduction and transition
  if (interview.interview_phase === 'intro') {
    const profile = await analyze_self_introduction(interview_id, candidate_message);
    set_candidate_profile(interview_id, profile);
    set_interview_phase(interview_id, 'questioning');

    // Reload interview with updated phase and profile
    const updated_interview = get_interview(interview_id);
    if (!updated_interview) throw new Error(`Interview ${interview_id} not found`);

    const elapsed_ms = Date.now() - updated_interview.scheduled_time;
    const time_remaining_ms = updated_interview.duration_minutes * 60_000 - elapsed_ms;

    const response = await generate_interviewer_turn(updated_interview, time_remaining_ms);
    append_message(interview_id, 'assistant', response);

    const should_end = response.includes('INTERVIEW_COMPLETE') || time_remaining_ms <= 0;
    return { response: response.replace('INTERVIEW_COMPLETE', '').trim(), should_end };
  }

  const elapsed_ms = Date.now() - interview.scheduled_time;
  const time_remaining_ms = interview.duration_minutes * 60_000 - elapsed_ms;

  const response = await generate_interviewer_turn(interview, time_remaining_ms);
  append_message(interview_id, 'assistant', response);

  const should_end = response.includes('INTERVIEW_COMPLETE') || time_remaining_ms <= 0;
  return { response: response.replace('INTERVIEW_COMPLETE', '').trim(), should_end };
}

async function analyze_self_introduction(interview_id: number, intro_text: string): Promise<CandidateProfile> {
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1000,
    system: `你是一位专业的技术招聘分析师。请从候选人的自我介绍中提取关键信息，输出严格的 JSON 格式，不包含任何其他文字。`,
    messages: [{
      role: 'user',
      content: `请分析以下自我介绍，提取关键信息：

${intro_text}

请输出如下 JSON 格式：
{
  "tech_stack": ["技术1", "技术2"],
  "years_of_experience": 数字或null,
  "project_highlights": ["项目亮点1", "项目亮点2"],
  "suggested_focus_areas": ["建议重点考察方向1", "方向2"]
}

说明：
- tech_stack：候选人提到的所有技术、框架、工具
- years_of_experience：从描述中估算的工作年限（整数），无法判断则为 null
- project_highlights：候选人提到的值得深入了解的项目或经历（简短描述）
- suggested_focus_areas：根据候选人背景，建议在面试中重点考察的方向（结合 AI基础知识、Agent框架经验、系统运维、业务沟通四个维度）`,
    }],
  });

  const text_blocks = (response.content ?? []).filter(b => b.type === 'text');
  const full_text = text_blocks.map(b => (b as Anthropic.TextBlock).text).join('\n');

  const json_match = full_text.match(/\{[\s\S]*"tech_stack"[\s\S]*\}/);
  if (json_match) {
    try {
      return JSON.parse(json_match[0]) as CandidateProfile;
    } catch {
      // fall through to default
    }
  }

  return {
    tech_stack: [],
    years_of_experience: null,
    project_highlights: [],
    suggested_focus_areas: [],
  };
}

async function generate_interviewer_turn(
  interview: Interview,
  time_remaining_ms: number | null,
): Promise<string> {
  const history = get_conversation(interview.id);

  const messages: Anthropic.MessageParam[] = history.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // First turn: inject a trigger message
  if (messages.length === 0) {
    const trigger = interview.interview_phase === 'intro'
      ? '[系统提示：面试时间到，请开始面试。做简短自我介绍，说明面试职位和流程，然后请候选人做自我介绍。]'
      : '[系统提示：候选人已完成自我介绍，请根据候选人背景开始正式提问。先简短过渡（如"感谢您的介绍，接下来我们开始正式面试"），然后从第一个问题开始。]';
    messages.push({ role: 'user', content: trigger });
  }

  let full_response = '';

  const stream = client.messages.stream({
    model: config.anthropic.model,
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    system: build_interviewer_system_prompt(interview, time_remaining_ms),
    messages,
  });

  for await (const chunk of stream) {
    if (
      chunk.type === 'content_block_delta' &&
      chunk.delta.type === 'text_delta'
    ) {
      full_response += chunk.delta.text;
    }
  }

  return full_response;
}

export async function generate_summary(interview_id: number): Promise<InterviewSummary> {
  const interview = get_interview(interview_id);
  if (!interview) throw new Error(`Interview ${interview_id} not found`);

  const history = get_conversation(interview_id);
  const conversation_text = history
    .map(m => `【${m.role === 'assistant' ? '面试官' : '候选人'}】\n${m.content}`)
    .join('\n\n---\n\n');

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `请分析以下面试对话，生成评估报告。

候选人：${interview.candidate_name}
面试时长：${interview.duration_minutes} 分钟
面试题目：${JSON.stringify(interview.interview_questions?.map(q => q.text) ?? [])}

完整对话记录：
${conversation_text}

请输出 JSON 格式的评估报告，结构如下：
{
  "overall_recommendation": "strong_hire|hire|no_hire|strong_no_hire",
  "overall_score": 数字(0-100),
  "category_scores": {
    "ai_fundamentals": { "score": 数字(0-25), "notes": "评价" },
    "agent_frameworks": { "score": 数字(0-25), "notes": "评价" },
    "system_operations": { "score": 数字(0-25), "notes": "评价" },
    "business_communication": { "score": 数字(0-25), "notes": "评价" }
  },
  "strengths": ["优势1", "优势2"],
  "weaknesses": ["不足1", "不足2"],
  "notable_quotes": ["值得关注的回答片段1", "片段2"],
  "detailed_assessment": "详细评估段落",
  "generated_at": ${Date.now()}
}`,
    }],
  });

  return extract_summary(response);
}

function extract_summary(response: Anthropic.Message): InterviewSummary {
  const text_blocks = (response.content ?? []).filter(b => b.type === 'text');
  const full_text = text_blocks.map(b => (b as Anthropic.TextBlock).text).join('\n');

  const json_match = full_text.match(/\{[\s\S]*"overall_recommendation"[\s\S]*\}/);
  if (json_match) {
    try {
      return JSON.parse(json_match[0]) as InterviewSummary;
    } catch {
      // fall through
    }
  }

  // Fallback summary
  const categories: InterviewCategory[] = [
    'ai_fundamentals', 'agent_frameworks', 'system_operations', 'business_communication',
  ];
  return {
    overall_recommendation: 'no_hire',
    overall_score: 0,
    category_scores: Object.fromEntries(
      categories.map(c => [c, { score: 0, notes: '解析失败，请人工评估' }])
    ) as InterviewSummary['category_scores'],
    strengths: [],
    weaknesses: ['评估报告解析失败，请查看原始对话记录'],
    notable_quotes: [],
    detailed_assessment: full_text.slice(0, 500),
    generated_at: Date.now(),
  };
}
