import cron from 'node-cron';
import type { Bot } from 'grammy';
import {
  get_in_progress_interviews,
  get_notified_interviews,
  get_due_interviews,
  get_pending_for_research,
  get_interviews_for_reminder,
  update_interview_status,
  set_research,
  set_summary,
  get_interview,
} from './db.js';
import { run_research } from './researcher.js';
import { send_opening_message, generate_summary } from './interviewer.js';

// candidate_telegram_username -> interview_id for interviews currently in progress
export const active_interviews = new Map<string, number>();

// candidate_telegram_username -> interview_id for interviews that have been notified
export const notified_interviews = new Map<string, number>();

// interview_ids that have already received a reminder (in-memory, resets on restart)
const reminded_interviews = new Set<number>();

export function start_scheduler(bot: Bot): void {
  // Every minute: notify due interviews + send reminders
  cron.schedule('* * * * *', () => {
    void check_and_notify_interviews(bot);
    void check_and_send_reminders(bot);
  });

  // Every 5 minutes: trigger research for upcoming interviews
  cron.schedule('*/5 * * * *', () => {
    void process_pending_research(bot);
  });

  console.log('[scheduler] Started — checking interviews every minute, research every 5 minutes');

  restore_active_interviews();
}

function restore_active_interviews(): void {
  for (const row of get_in_progress_interviews()) {
    active_interviews.set(row.candidate_telegram_username, row.id);
    console.log(`[scheduler] Restored in_progress interview ${row.id} for @${row.candidate_telegram_username}`);
  }
  for (const row of get_notified_interviews()) {
    notified_interviews.set(row.candidate_telegram_username, row.id);
    console.log(`[scheduler] Restored notified interview ${row.id} for @${row.candidate_telegram_username}`);
  }
}

// When the scheduled time arrives: notify the candidate (and admin), set status to notified
async function check_and_notify_interviews(bot: Bot): Promise<void> {
  const due = get_due_interviews();
  for (const interview of due) {
    const key = interview.candidate_telegram_username;
    if (active_interviews.has(key)) continue;
    if (notified_interviews.has(key)) continue;

    console.log(`[scheduler] Notifying candidate for interview ${interview.id} (${interview.candidate_name})`);
    update_interview_status(interview.id, 'notified');
    notified_interviews.set(key, interview.id);

    // Notify candidate if we have their Telegram ID
    if (interview.candidate_telegram_id) {
      try {
        await bot.api.sendMessage(
          interview.candidate_telegram_id,
          `🎤 ${interview.candidate_name}，您的面试时间到了！\n\n` +
          `面试时长约 ${interview.duration_minutes} 分钟。\n\n` +
          `请回复任意内容或发送 /begin 开始面试。`
        );
      } catch (err) {
        console.error(`[scheduler] Failed to notify candidate for interview ${interview.id}:`, err);
        notified_interviews.delete(key);
        update_interview_status(interview.id, 'ready');
        continue;
      }
    }

    // Always notify admin
    try {
      await bot.api.sendMessage(
        interview.telegram_user_id,
        `📢 面试通知已发送给候选人 ${interview.candidate_name}（@${interview.candidate_telegram_username}）。\n` +
        (interview.candidate_telegram_id ? '' : `⚠️ 候选人尚未启动机器人，请提醒他们先向机器人发送 /start。`)
      );
    } catch { /* admin notification failure is non-critical */ }
  }
}

// Send a reminder ~15 minutes before the interview starts
async function check_and_send_reminders(bot: Bot): Promise<void> {
  const upcoming = get_interviews_for_reminder();
  for (const interview of upcoming) {
    if (reminded_interviews.has(interview.id)) continue;

    reminded_interviews.add(interview.id);
    const mins_left = Math.round((interview.scheduled_time - Date.now()) / 60_000);
    console.log(`[scheduler] Sending reminder for interview ${interview.id}, starts in ~${mins_left} min`);

    // Remind candidate if we have their ID
    if (interview.candidate_telegram_id) {
      try {
        await bot.api.sendMessage(
          interview.candidate_telegram_id,
          `⏰ 提醒：${interview.candidate_name}，您的面试将在约 ${mins_left} 分钟后开始。\n\n` +
          `请做好准备，届时机器人会主动通知您。`
        );
      } catch (err) {
        console.error(`[scheduler] Failed to send reminder to candidate for interview ${interview.id}:`, err);
        reminded_interviews.delete(interview.id);
        continue;
      }
    }

    // Also remind admin
    try {
      await bot.api.sendMessage(
        interview.telegram_user_id,
        `⏰ 提醒：${interview.candidate_name}（@${interview.candidate_telegram_username}）的面试将在约 ${mins_left} 分钟后开始。`
      );
    } catch { /* non-critical */ }
  }
}

// Called from bot.ts when a candidate in notified state sends any message
// key = candidate_telegram_username (lowercase)
export async function start_interview_for_user(
  key: string,
): Promise<string | null> {
  const interview_id = notified_interviews.get(key);
  if (interview_id === undefined) return null;

  notified_interviews.delete(key);
  update_interview_status(interview_id, 'in_progress');
  active_interviews.set(key, interview_id);

  console.log(`[scheduler] Starting interview ${interview_id} for @${key}`);

  try {
    return await send_opening_message(interview_id);
  } catch (err) {
    console.error(`[scheduler] Failed to generate opening for interview ${interview_id}:`, err);
    active_interviews.delete(key);
    update_interview_status(interview_id, 'notified');
    notified_interviews.set(key, interview_id);
    return null;
  }
}

async function process_pending_research(bot: Bot): Promise<void> {
  const pending = get_pending_for_research();
  for (const interview of pending) {
    console.log(`[scheduler] Starting research for interview ${interview.id} (${interview.candidate_name})`);
    update_interview_status(interview.id, 'researching');

    try {
      await bot.api.sendMessage(
        interview.telegram_user_id,
        `📚 正在为 ${interview.candidate_name} 的面试收集资料，设计面试流程...`
      );

      const { notes, questions } = await run_research(interview.candidate_name, interview.duration_minutes);
      set_research(interview.id, notes, questions);
      update_interview_status(interview.id, 'ready');

      const scheduled_str = new Date(interview.scheduled_time).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      });
      await bot.api.sendMessage(
        interview.telegram_user_id,
        `✅ 面试准备完成！已生成 ${questions.length} 道面试题。\n面试将于 ${scheduled_str} 开始，届时机器人会主动通知候选人。`
      );
    } catch (err) {
      console.error(`[scheduler] Research failed for interview ${interview.id}:`, err);
      update_interview_status(interview.id, 'pending');
      await bot.api.sendMessage(
        interview.telegram_user_id,
        `⚠️ 面试资料收集遇到问题，将在下次自动重试。`
      ).catch(() => {});
    }
  }
}

export async function finish_interview(
  bot: Bot,
  interview_id: number,
  admin_chat_id: string,
): Promise<void> {
  const interview = get_interview(interview_id);
  if (!interview) return;

  active_interviews.delete(interview.candidate_telegram_username);
  update_interview_status(interview_id, 'completed');

  // Thank the candidate
  if (interview.candidate_telegram_id) {
    await bot.api.sendMessage(
      interview.candidate_telegram_id,
      '感谢您参加本次面试！我们将尽快处理您的面试结果。'
    ).catch(() => {});
  }

  try {
    console.log(`[scheduler] Generating summary for interview ${interview_id}`);
    const summary = await generate_summary(interview_id);
    set_summary(interview_id, summary);

    const rec_labels: Record<string, string> = {
      strong_hire: '✅✅ 强烈推荐录用',
      hire: '✅ 推荐录用',
      no_hire: '❌ 不推荐录用',
      strong_no_hire: '❌❌ 强烈不推荐录用',
    };

    const category_labels: Record<string, string> = {
      ai_fundamentals: 'AI基础知识',
      agent_frameworks: 'Agent框架经验',
      system_operations: '系统运维',
      business_communication: '业务沟通',
    };

    const scores_text = Object.entries(summary.category_scores)
      .map(([cat, score]) => `  • ${category_labels[cat] ?? cat}：${score.score}/25 — ${score.notes}`)
      .join('\n');

    const summary_text = [
      `📋 面试总结报告`,
      ``,
      `候选人：${interview.candidate_name}（@${interview.candidate_telegram_username}）`,
      `面试时长：${interview.duration_minutes} 分钟`,
      ``,
      `🎯 综合推荐：${rec_labels[summary.overall_recommendation] ?? summary.overall_recommendation}`,
      `📊 综合评分：${summary.overall_score}/100`,
      ``,
      `各维度评分：`,
      scores_text,
      ``,
      `✨ 优势：`,
      summary.strengths.map(s => `  • ${s}`).join('\n'),
      ``,
      `⚠️ 不足：`,
      summary.weaknesses.map(w => `  • ${w}`).join('\n'),
      ``,
      `📝 详细评估：`,
      summary.detailed_assessment,
    ].join('\n');

    await bot.api.sendMessage(admin_chat_id, summary_text);
    console.log(`[scheduler] Summary sent to admin for interview ${interview_id}`);
  } catch (err) {
    console.error(`[scheduler] Failed to generate/send summary for interview ${interview_id}:`, err);
    await bot.api.sendMessage(
      admin_chat_id,
      `⚠️ 面试 #${interview_id}（${interview.candidate_name}）已完成，但总结生成失败，请手动查看对话记录。`
    ).catch(() => {});
  }
}
