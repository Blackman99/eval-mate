import { createRequire } from 'module';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { config } from './config.js';

// grammy uses node-fetch internally; patch it to use the system proxy
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFetch = _require('node-fetch') as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { HttpsProxyAgent } = _require('https-proxy-agent') as any;

const proxy_url = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
const proxy_agent = proxy_url ? new HttpsProxyAgent(proxy_url) : undefined;
if (proxy_url) console.log(`[bot] Proxy configured: ${proxy_url}`);

// Proxy-aware fetch passed to grammy
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proxy_fetch = (url: string | URL, init?: any) =>
  nodeFetch(url as string, { ...init, agent: proxy_agent }) as unknown as Promise<Response>;
import { init_db } from './db.js';
import {
  create_interview,
  get_interview,
  get_interviews_by_user,
  cancel_interview,
  get_interview_by_candidate_username,
  set_candidate_telegram_id,
  get_user_lang,
  set_user_lang,
} from './db.js';
import { start_scheduler, active_interviews, notified_interviews, start_interview_for_user, finish_interview } from './scheduler.js';
import { handle_candidate_reply } from './interviewer.js';
import { parse_schedule_request } from './parser.js';
import { t, SUPPORTED_LANGS } from './i18n/index.js';
import type { SchedulingSession } from './types.js';

// In-memory scheduling wizard state: user_id -> session
const scheduling_sessions = new Map<string, SchedulingSession>();

const bot = new Bot(config.telegram.bot_token, {
  client: { fetch: proxy_fetch },
});

// ─── i18n helpers ─────────────────────────────────────────────────────────────

/** Resolve display locale for the Telegram context sender. */
function get_lang(ctx: Context): string {
  const stored = get_user_lang(String(ctx.from!.id));
  if (stored) return stored;
  // Fall back on Telegram UI language
  const tg = ctx.from?.language_code;
  return tg?.startsWith('zh') ? 'zh-CN' : 'en-US';
}

/** Format a UTC timestamp for display using the user's locale (always CST timezone). */
function fmt_time(ts: number, lng: string): string {
  const locale = lng === 'zh-CN' ? 'zh-CN' : 'en-US';
  return new Date(ts).toLocaleString(locale, { timeZone: 'Asia/Shanghai' });
}

/** Translate a status code to a human-readable label. */
function status_label(status: string, lng: string): string {
  const key = `status_labels.${status}`;
  const label = t(key, lng);
  return label !== key ? label : status;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const lng = get_lang(ctx);
  await ctx.reply(t('start.welcome', lng));
});

bot.command('help', async (ctx) => {
  const lng = get_lang(ctx);
  await ctx.reply(t('help.text', lng));
});

bot.command('schedule', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const lng = get_lang(ctx);
  const inline_text = ctx.match?.trim();

  if (inline_text) {
    const session: SchedulingSession = { step: 'nl_input', lang: lng };
    scheduling_sessions.set(user_id, session);
    await ctx.replyWithChatAction('typing');
    await handle_nl_parse(ctx, session, inline_text, lng);
  } else {
    scheduling_sessions.set(user_id, { step: 'nl_input', lang: lng });
    await ctx.reply(t('schedule.prompt', lng));
  }
});

bot.command('status', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const lng = get_lang(ctx);
  const interviews = get_interviews_by_user(user_id);

  if (interviews.length === 0) {
    await ctx.reply(t('status.empty', lng));
    return;
  }

  const lines = [t('status.header', lng, { count: interviews.length })];
  for (const iv of interviews) {
    const time_str = fmt_time(iv.scheduled_time, lng);
    lines.push(
      t('status.item', lng, {
        id: iv.id,
        name: iv.candidate_name,
        username: iv.candidate_telegram_username,
        time: time_str,
        duration: iv.duration_minutes,
        status_label: status_label(iv.status, lng),
      })
    );
  }
  await ctx.reply(lines.join('\n'));
});

bot.command('begin', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const lng = get_lang(ctx);
  const username = ctx.from!.username?.toLowerCase() ?? '';

  if (!username) {
    await ctx.reply(t('begin.no_username', lng));
    return;
  }

  // Already in an active interview
  if (active_interviews.has(username)) {
    await ctx.reply(t('begin.already_active', lng));
    return;
  }

  // Notified state — start immediately
  if (notified_interviews.has(username)) {
    const iv_id = notified_interviews.get(username)!;
    const iv = get_interview(iv_id);
    if (iv && !iv.candidate_telegram_id) set_candidate_telegram_id(iv_id, user_id);
    try {
      await ctx.replyWithChatAction('typing');
      const opening = await start_interview_for_user(username);
      if (opening) await ctx.reply(opening);
      else await ctx.reply(t('begin.error', lng));
    } catch (err) {
      console.error(`[bot] Error starting interview for user ${username}:`, err);
      await ctx.reply(t('begin.error', lng));
    }
    return;
  }

  // Check DB for a notified/ready interview assigned to this candidate username
  const db_iv = get_interview_by_candidate_username(username);
  if (db_iv) {
    if (!db_iv.candidate_telegram_id) set_candidate_telegram_id(db_iv.id, user_id);
    if (db_iv.status === 'notified' || (db_iv.status === 'ready' && db_iv.scheduled_time <= Date.now() + 5 * 60_000)) {
      const { update_interview_status } = await import('./db.js');
      if (db_iv.status === 'ready') update_interview_status(db_iv.id, 'notified');
      notified_interviews.set(username, db_iv.id);
      try {
        await ctx.replyWithChatAction('typing');
        const opening = await start_interview_for_user(username);
        if (opening) await ctx.reply(opening);
        else await ctx.reply(t('begin.error', lng));
      } catch (err) {
        console.error(`[bot] Error starting interview for user ${username}:`, err);
        await ctx.reply(t('begin.error', lng));
      }
      return;
    }
    const time_str = fmt_time(db_iv.scheduled_time, lng);
    await ctx.reply(t('begin.scheduled', lng, { name: db_iv.candidate_name, time: time_str }));
    return;
  }

  await ctx.reply(t('begin.not_found', lng));
});

bot.command('cancel', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const lng = get_lang(ctx);

  const arg = ctx.match?.trim();
  const target_id = arg ? parseInt(arg, 10) : NaN;

  if (!isNaN(target_id)) {
    const iv = get_interview(target_id);
    if (!iv || iv.telegram_user_id !== user_id) {
      await ctx.reply(t('cancel.not_found', lng));
      return;
    }
    if (iv.status === 'in_progress') {
      await ctx.reply(t('cancel.in_progress', lng));
      return;
    }
    cancel_interview(iv.id);
    notified_interviews.delete(user_id);
    await ctx.reply(t('cancel.success', lng, { name: iv.candidate_name, id: iv.id }));
    return;
  }

  const interviews = get_interviews_by_user(user_id).filter(iv => iv.status !== 'in_progress');

  if (interviews.length === 0) {
    const has_active = get_interviews_by_user(user_id).some(iv => iv.status === 'in_progress');
    await ctx.reply(has_active ? t('cancel.in_progress', lng) : t('cancel.no_cancellable', lng));
    return;
  }

  if (interviews.length === 1) {
    cancel_interview(interviews[0].id);
    notified_interviews.delete(user_id);
    scheduling_sessions.delete(user_id);
    await ctx.reply(t('cancel.success_no_id', lng, { name: interviews[0].candidate_name }));
    return;
  }

  const lines = [t('cancel.multiple_header', lng)];
  for (const iv of interviews) {
    const time_str = fmt_time(iv.scheduled_time, lng);
    lines.push(`  #${iv.id}  ${iv.candidate_name}  ${time_str}  ${status_label(iv.status, lng)}`);
  }
  await ctx.reply(lines.join('\n'));
});

bot.command('lang', async (ctx) => {
  const lng = get_lang(ctx);
  const keyboard = new InlineKeyboard()
    .text('🇨🇳 中文', 'set_lang:zh-CN')
    .text('🇺🇸 English', 'set_lang:en-US');
  await ctx.reply(t('lang.choose', lng), { reply_markup: keyboard });
});

// ─── Callback queries (language picker) ───────────────────────────────────────

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('set_lang:')) {
    await ctx.answerCallbackQuery();
    return;
  }

  const requested = data.replace('set_lang:', '');
  const lang = (SUPPORTED_LANGS as readonly string[]).includes(requested) ? requested : 'zh-CN';
  const user_id = String(ctx.from!.id);

  set_user_lang(user_id, lang);

  await ctx.answerCallbackQuery({ text: t('lang.changed', lang) });
  await ctx.editMessageReplyMarkup(); // remove the inline keyboard
});

// ─── Message handler ──────────────────────────────────────────────────────────

bot.on('message:text', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const lng = get_lang(ctx);
  const username = ctx.from!.username?.toLowerCase() ?? '';
  const text = ctx.message.text;

  if (text.startsWith('/')) return;

  // Priority 1: candidate confirming start of a notified interview
  if (username && notified_interviews.has(username)) {
    const iv_id = notified_interviews.get(username)!;
    const iv = get_interview(iv_id);
    if (iv && !iv.candidate_telegram_id) set_candidate_telegram_id(iv_id, user_id);

    try {
      await ctx.replyWithChatAction('typing');
      const opening = await start_interview_for_user(username);
      if (opening) {
        await ctx.reply(opening);
      } else {
        await ctx.reply(t('begin.error', lng));
      }
    } catch (err) {
      console.error(`[bot] Error starting interview for user ${username}:`, err);
      await ctx.reply(t('begin.error', lng));
    }
    return;
  }

  // Priority 2: candidate in active interview
  if (username && active_interviews.has(username)) {
    const interview_id = active_interviews.get(username)!;
    const interview = get_interview(interview_id);
    if (!interview || interview.candidate_telegram_username.toLowerCase() !== username) {
      // not the candidate — fall through
    } else {
      if (!interview.candidate_telegram_id) set_candidate_telegram_id(interview_id, user_id);

      try {
        await ctx.replyWithChatAction('typing');
        const { response, should_end } = await handle_candidate_reply(interview_id, text);
        await ctx.reply(response);

        if (should_end) {
          await ctx.reply(t('interview.ending', lng));
          await finish_interview(bot, interview_id, config.telegram.admin_chat_id);
        }
      } catch (err) {
        console.error(`[bot] Error handling interview reply for ${interview_id}:`, err);
        await ctx.reply(t('interview.reply_error', lng));
      }
      return;
    }
  }

  // Priority 2b: restore from DB after bot restart
  if (username) {
    const db_iv = get_interview_by_candidate_username(username);
    if (db_iv) {
      if (!db_iv.candidate_telegram_id) set_candidate_telegram_id(db_iv.id, user_id);
      if (db_iv.status === 'notified') {
        notified_interviews.set(username, db_iv.id);
        try {
          await ctx.replyWithChatAction('typing');
          const opening = await start_interview_for_user(username);
          if (opening) await ctx.reply(opening);
          else await ctx.reply(t('begin.error', lng));
        } catch (err) {
          console.error(`[bot] Error starting interview for user ${username}:`, err);
          await ctx.reply(t('begin.error', lng));
        }
        return;
      } else if (db_iv.status === 'in_progress') {
        active_interviews.set(username, db_iv.id);
        try {
          await ctx.replyWithChatAction('typing');
          const { response, should_end } = await handle_candidate_reply(db_iv.id, text);
          await ctx.reply(response);
          if (should_end) {
            await ctx.reply(t('interview.ending', lng));
            await finish_interview(bot, db_iv.id, config.telegram.admin_chat_id);
          }
        } catch (err) {
          console.error(`[bot] Error handling interview reply for ${db_iv.id}:`, err);
          await ctx.reply(t('interview.reply_error', lng));
        }
        return;
      }
    }
  }

  // Priority 3: scheduling wizard
  const session = scheduling_sessions.get(user_id);
  if (session) {
    await handle_scheduling_step(ctx, user_id, session, text, session.lang ?? lng);
    return;
  }

  // Default
  await ctx.reply(t('default_reply', lng));
});

// ─── Scheduling wizard ────────────────────────────────────────────────────────

async function handle_nl_parse(
  ctx: Context,
  session: SchedulingSession,
  text: string,
  lng: string,
): Promise<void> {
  let parsed;
  try {
    parsed = await parse_schedule_request(text);
  } catch (err) {
    console.error('[bot] NL parse error:', err);
    parsed = {};
  }

  if (parsed.candidate_name) session.candidate_name = parsed.candidate_name;
  if (parsed.candidate_telegram_username) session.candidate_telegram_username = parsed.candidate_telegram_username;
  if (parsed.scheduled_time) session.scheduled_time = parsed.scheduled_time;
  if (parsed.duration_minutes) session.duration_minutes = parsed.duration_minutes;

  if (!session.candidate_name) {
    session.step = 'name';
    await ctx.reply(t('wizard.ask_name', lng));
    return;
  }
  if (!session.candidate_telegram_username) {
    session.step = 'telegram';
    await ctx.reply(t('wizard.name_ok', lng, { name: session.candidate_name }));
    return;
  }
  if (!session.scheduled_time) {
    session.step = 'datetime';
    await ctx.reply(
      t('wizard.username_ok', lng, {
        name: session.candidate_name,
        username: session.candidate_telegram_username,
      })
    );
    return;
  }
  if (!session.duration_minutes) session.duration_minutes = 30;

  session.step = 'confirm';
  const time_str = fmt_time(session.scheduled_time, lng);
  await ctx.reply(
    t('wizard.confirm', lng, {
      name: session.candidate_name,
      username: session.candidate_telegram_username,
      time: time_str,
      duration: session.duration_minutes,
    })
  );
}

async function handle_scheduling_step(
  ctx: Context,
  user_id: string,
  session: SchedulingSession,
  text: string,
  lng: string,
): Promise<void> {
  switch (session.step) {
    case 'nl_input': {
      await ctx.replyWithChatAction('typing');
      await handle_nl_parse(ctx, session, text, lng);
      break;
    }

    case 'name': {
      const name = text.trim();
      if (name.length < 2) {
        await ctx.reply(t('wizard.name_too_short', lng));
        return;
      }
      session.candidate_name = name;
      session.step = 'telegram';
      await ctx.reply(t('wizard.name_ok', lng, { name }));
      break;
    }

    case 'telegram': {
      const raw = text.trim().replace(/^@/, '');
      if (raw.length < 3) {
        await ctx.reply(t('wizard.invalid_username', lng));
        return;
      }
      session.candidate_telegram_username = raw;
      session.step = 'datetime';
      await ctx.reply(
        t('wizard.username_ok', lng, {
          name: session.candidate_name,
          username: raw,
        })
      );
      break;
    }

    case 'datetime': {
      const input = text.trim();
      const match = input.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
      if (!match) {
        await ctx.reply(t('wizard.invalid_datetime', lng));
        return;
      }
      const [, year, month, day, hour, minute] = match;
      const utc_ms = Date.UTC(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour) - 8, parseInt(minute)
      );
      if (isNaN(utc_ms) || utc_ms <= Date.now()) {
        await ctx.reply(t('wizard.expired_datetime', lng));
        return;
      }
      session.scheduled_time = utc_ms;
      session.step = 'duration';
      await ctx.reply(t('wizard.datetime_ok', lng, { time: input }));
      break;
    }

    case 'duration': {
      const mins = parseInt(text.trim(), 10);
      if (isNaN(mins) || mins < 10 || mins > 120) {
        await ctx.reply(t('wizard.invalid_duration', lng));
        return;
      }
      session.duration_minutes = mins;
      session.step = 'confirm';

      const time_str = fmt_time(session.scheduled_time!, lng);
      await ctx.reply(
        t('wizard.confirm', lng, {
          name: session.candidate_name,
          username: session.candidate_telegram_username,
          time: time_str,
          duration: mins,
        })
      );
      break;
    }

    case 'confirm': {
      const input = text.trim().toLowerCase();
      if (['确认', 'yes', 'y', 'confirm'].includes(input)) {
        const id = create_interview({
          telegram_user_id: user_id,
          candidate_name: session.candidate_name!,
          candidate_telegram_username: session.candidate_telegram_username!,
          scheduled_time: session.scheduled_time!,
          duration_minutes: session.duration_minutes!,
        });
        scheduling_sessions.delete(user_id);

        const time_str = fmt_time(session.scheduled_time!, lng);
        await ctx.reply(
          t('wizard.booked', lng, {
            id,
            name: session.candidate_name,
            username: session.candidate_telegram_username,
            time: time_str,
            duration: session.duration_minutes,
          })
        );
      } else {
        scheduling_sessions.delete(user_id);
        await ctx.reply(t('wizard.booking_cancelled', lng));
      }
      break;
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error('[bot] Unhandled error:', err);
});

async function main() {
  await init_db();
  start_scheduler(bot);
  await bot.start({
    onStart: (info) => {
      console.log(`[bot] Started as @${info.username}`);
    },
  });
}

main().catch(console.error);
