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
  get_user_lang,
} from './db.js';
import { run_research } from './researcher.js';
import { send_opening_message, generate_summary } from './interviewer.js';
import { t } from './i18n/index.js';
import { config } from './config.js';

// candidate_telegram_username -> interview_id for interviews currently in progress
export const active_interviews = new Map<string, number>();

// candidate_telegram_username -> interview_id for interviews that have been notified
export const notified_interviews = new Map<string, number>();

// interview_ids that have already received a reminder (in-memory, resets on restart)
const reminded_interviews = new Set<number>();

// ─── Locale helpers ───────────────────────────────────────────────────────────

/** Candidate locale: use stored preference if available, fall back to zh-CN. */
function candidate_lang(candidate_telegram_id: string): string {
  return get_user_lang(candidate_telegram_id) ?? 'zh-CN';
}

/** Admin locale: configured at deployment level via ADMIN_LOCALE env var. */
function admin_lang(): string {
  return config.admin_locale;
}

/** Format a UTC timestamp for display (always CST timezone). */
function fmt_time(ts: number, lng: string): string {
  const locale = lng === 'zh-CN' ? 'zh-CN' : 'en-US';
  return new Date(ts).toLocaleString(locale, { timeZone: 'Asia/Shanghai' });
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

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

    const c_lng = candidate_lang(interview.candidate_telegram_id);
    const a_lng = admin_lang();

    // Notify candidate if we have their Telegram ID
    if (interview.candidate_telegram_id) {
      try {
        await bot.api.sendMessage(
          interview.candidate_telegram_id,
          t('notify.candidate', c_lng, {
            name: interview.candidate_name,
            duration: interview.duration_minutes,
          })
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
      const admin_msg = t('notify.admin', a_lng, {
        name: interview.candidate_name,
        username: interview.candidate_telegram_username,
      }) + (interview.candidate_telegram_id ? '' : '\n' + t('notify.admin_no_start', a_lng));

      await bot.api.sendMessage(interview.telegram_user_id, admin_msg);
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

    const c_lng = candidate_lang(interview.candidate_telegram_id);
    const a_lng = admin_lang();

    // Remind candidate if we have their ID
    if (interview.candidate_telegram_id) {
      try {
        await bot.api.sendMessage(
          interview.candidate_telegram_id,
          t('reminder.candidate', c_lng, {
            name: interview.candidate_name,
            mins: mins_left,
          })
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
        t('reminder.admin', a_lng, {
          name: interview.candidate_name,
          username: interview.candidate_telegram_username,
          mins: mins_left,
        })
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

    const a_lng = admin_lang();

    try {
      await bot.api.sendMessage(
        interview.telegram_user_id,
        t('research.started', a_lng, { name: interview.candidate_name })
      );

      const { notes, questions } = await run_research(interview.candidate_name, interview.duration_minutes);
      set_research(interview.id, notes, questions);
      update_interview_status(interview.id, 'ready');

      const scheduled_str = fmt_time(interview.scheduled_time, a_lng);
      await bot.api.sendMessage(
        interview.telegram_user_id,
        t('research.done', a_lng, { count: questions.length, time: scheduled_str })
      );
    } catch (err) {
      console.error(`[scheduler] Research failed for interview ${interview.id}:`, err);
      update_interview_status(interview.id, 'pending');
      await bot.api.sendMessage(
        interview.telegram_user_id,
        t('research.error', a_lng)
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

  const c_lng = candidate_lang(interview.candidate_telegram_id);
  const a_lng = admin_lang();

  // Thank the candidate
  if (interview.candidate_telegram_id) {
    await bot.api.sendMessage(
      interview.candidate_telegram_id,
      t('finish.thank_candidate', c_lng)
    ).catch(() => {});
  }

  try {
    console.log(`[scheduler] Generating summary for interview ${interview_id}`);
    const summary = await generate_summary(interview_id);
    set_summary(interview_id, summary);

    const rec_label = t(`finish.rec_labels.${summary.overall_recommendation}`, a_lng);

    const scores_text = Object.entries(summary.category_scores)
      .map(([cat, score]) =>
        t('finish.summary_score_item', a_lng, {
          category: t(`finish.category_labels.${cat}`, a_lng),
          score: score.score,
          notes: score.notes,
        })
      )
      .join('\n');

    const strengths_text = summary.strengths
      .map(s => t('finish.summary_bullet', a_lng, { text: s }))
      .join('\n');

    const weaknesses_text = summary.weaknesses
      .map(w => t('finish.summary_bullet', a_lng, { text: w }))
      .join('\n');

    const summary_text = [
      t('finish.summary_header', a_lng),
      '',
      t('finish.summary_candidate', a_lng, {
        name: interview.candidate_name,
        username: interview.candidate_telegram_username,
      }),
      t('finish.summary_duration', a_lng, { duration: interview.duration_minutes }),
      '',
      t('finish.summary_recommendation', a_lng, { rec: rec_label }),
      t('finish.summary_score', a_lng, { score: summary.overall_score }),
      '',
      t('finish.summary_categories_header', a_lng),
      scores_text,
      '',
      t('finish.summary_strengths_header', a_lng),
      strengths_text,
      '',
      t('finish.summary_weaknesses_header', a_lng),
      weaknesses_text,
      '',
      t('finish.summary_assessment_header', a_lng),
      summary.detailed_assessment,
    ].join('\n');

    await bot.api.sendMessage(admin_chat_id, summary_text);
    console.log(`[scheduler] Summary sent to admin for interview ${interview_id}`);
  } catch (err) {
    console.error(`[scheduler] Failed to generate/send summary for interview ${interview_id}:`, err);
    await bot.api.sendMessage(
      admin_chat_id,
      t('finish.summary_error', a_lng, {
        id: interview_id,
        name: interview.candidate_name,
      })
    ).catch(() => {});
  }
}
