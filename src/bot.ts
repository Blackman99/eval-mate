import { createRequire } from 'module';
import { Bot, type Context } from 'grammy';
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
} from './db.js';
import { start_scheduler, active_interviews, notified_interviews, start_interview_for_user, finish_interview } from './scheduler.js';
import { handle_candidate_reply } from './interviewer.js';
import { parse_schedule_request } from './parser.js';
import type { SchedulingSession } from './types.js';

// In-memory scheduling wizard state: user_id -> session
const scheduling_sessions = new Map<string, SchedulingSession>();

const bot = new Bot(config.telegram.bot_token, {
  client: { fetch: proxy_fetch },
});

// ─── Commands ────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  await ctx.reply(
    `👋 欢迎使用 AI Agent 管理员招聘面试机器人！\n\n` +
    `可用命令：\n` +
    `/schedule — 预约面试时间\n` +
    `/begin — 主动开始面试\n` +
    `/status — 查看当前面试状态\n` +
    `/cancel — 取消待进行的面试\n` +
    `/help — 显示帮助信息`
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 使用说明\n\n` +
    `【面试官】\n` +
    `1. /schedule — 预约面试（需填写候选人 Telegram 用户名）\n` +
    `   支持自然语言，例如："张三，明天下午3点，45分钟"\n` +
    `2. /status — 查看所有待进行的面试\n` +
    `3. /cancel [编号] — 取消面试预约\n\n` +
    `【候选人】\n` +
    `4. /begin — 主动开始面试\n` +
    `   到预约时间后可用此命令立即开始，无需等待机器人通知\n\n` +
    `⏰ 建议提前至少 2 小时预约，以便系统完成资料准备。\n` +
    `📢 候选人需先向机器人发送 /start，机器人才能主动通知他们。`
  );
});

bot.command('schedule', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const inline_text = ctx.match?.trim();

  if (inline_text) {
    // Inline text provided — parse immediately
    const session: SchedulingSession = { step: 'nl_input' };
    scheduling_sessions.set(user_id, session);
    await ctx.replyWithChatAction('typing');
    await handle_nl_parse(ctx, session, inline_text);
  } else {
    scheduling_sessions.set(user_id, { step: 'nl_input' });
    await ctx.reply(
      `📝 请描述面试信息，例如：\n` +
      `"张三（@zhangsan），明天下午3点，45分钟"\n` +
      `"帮我预约李四 @lisi 的面试，3月15日14:30，一小时"\n\n` +
      `支持识别：姓名、Telegram 用户名、时间、时长`
    );
  }
});

bot.command('status', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const interviews = get_interviews_by_user(user_id);

  if (interviews.length === 0) {
    await ctx.reply('暂无待进行的面试。使用 /schedule 预约新面试。');
    return;
  }

  const lines = [`📋 您的面试列表（共 ${interviews.length} 场）`];
  for (const iv of interviews) {
    const time_str = new Date(iv.scheduled_time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    lines.push(
      `\n#${iv.id}  候选人：${iv.candidate_name}（@${iv.candidate_telegram_username}）\n` +
      `    时间：${time_str}\n` +
      `    时长：${iv.duration_minutes} 分钟\n` +
      `    状态：${status_label(iv.status)}`
    );
  }
  await ctx.reply(lines.join('\n'));
});

bot.command('begin', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const username = ctx.from!.username?.toLowerCase() ?? '';

  if (!username) {
    await ctx.reply('您的 Telegram 账号未设置用户名，无法使用此功能。请先在 Telegram 设置中添加用户名。');
    return;
  }

  // Already in an active interview
  if (active_interviews.has(username)) {
    await ctx.reply('面试正在进行中，请继续回答问题。');
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
      else await ctx.reply('抱歉，启动面试时遇到了问题，请稍后再试。');
    } catch (err) {
      console.error(`[bot] Error starting interview for user ${username}:`, err);
      await ctx.reply('抱歉，启动面试时遇到了问题，请稍后再试。');
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
        else await ctx.reply('抱歉，启动面试时遇到了问题，请稍后再试。');
      } catch (err) {
        console.error(`[bot] Error starting interview for user ${username}:`, err);
        await ctx.reply('抱歉，启动面试时遇到了问题，请稍后再试。');
      }
      return;
    }
    const time_str = new Date(db_iv.scheduled_time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    await ctx.reply(`您的面试（${db_iv.candidate_name}）预约于 ${time_str}，届时机器人会主动通知您。`);
    return;
  }

  await ctx.reply('暂无待进行的面试。如有疑问请联系面试官。');
});

bot.command('cancel', async (ctx) => {
  const user_id = String(ctx.from!.id);

  // Parse optional interview ID from command text, e.g. "/cancel 3"
  const arg = ctx.match?.trim();
  const target_id = arg ? parseInt(arg, 10) : NaN;

  if (!isNaN(target_id)) {
    // Cancel a specific interview by ID
    const iv = get_interview(target_id);
    if (!iv || iv.telegram_user_id !== user_id) {
      await ctx.reply('未找到该面试，请检查编号是否正确。');
      return;
    }
    if (iv.status === 'in_progress') {
      await ctx.reply('面试正在进行中，无法取消。');
      return;
    }
    cancel_interview(iv.id);
    notified_interviews.delete(user_id);
    await ctx.reply(`✅ 已取消 ${iv.candidate_name} 的面试预约（#${iv.id}）。`);
    return;
  }

  // No ID provided — look at all active interviews
  const interviews = get_interviews_by_user(user_id).filter(iv => iv.status !== 'in_progress');

  if (interviews.length === 0) {
    const has_active = get_interviews_by_user(user_id).some(iv => iv.status === 'in_progress');
    await ctx.reply(has_active ? '面试正在进行中，无法取消。' : '暂无可取消的面试。');
    return;
  }

  if (interviews.length === 1) {
    cancel_interview(interviews[0].id);
    notified_interviews.delete(user_id);
    scheduling_sessions.delete(user_id);
    await ctx.reply(`✅ 已取消 ${interviews[0].candidate_name} 的面试预约。`);
    return;
  }

  // Multiple interviews — show list and ask for ID
  const lines = ['您有多场待取消的面试，请使用 /cancel <编号> 取消指定面试：'];
  for (const iv of interviews) {
    const time_str = new Date(iv.scheduled_time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    lines.push(`  #${iv.id}  ${iv.candidate_name}  ${time_str}  ${status_label(iv.status)}`);
  }
  await ctx.reply(lines.join('\n'));
});

// ─── Message handler ──────────────────────────────────────────────────────────

bot.on('message:text', async (ctx) => {
  const user_id = String(ctx.from!.id);
  const username = ctx.from!.username?.toLowerCase() ?? '';
  const text = ctx.message.text;

  // Skip commands (already handled above)
  if (text.startsWith('/')) return;

  // Priority 1: candidate confirming start of a notified interview (keyed by username)
  if (username && notified_interviews.has(username)) {
    // Record their numeric ID so the scheduler can message them directly
    const iv_id = notified_interviews.get(username)!;
    const iv = get_interview(iv_id);
    if (iv && !iv.candidate_telegram_id) set_candidate_telegram_id(iv_id, user_id);

    try {
      await ctx.replyWithChatAction('typing');
      const opening = await start_interview_for_user(username);
      if (opening) {
        await ctx.reply(opening);
      } else {
        await ctx.reply('抱歉，启动面试时遇到了问题，请稍后再试。');
      }
    } catch (err) {
      console.error(`[bot] Error starting interview for user ${username}:`, err);
      await ctx.reply('抱歉，启动面试时遇到了问题，请稍后再试。');
    }
    return;
  }

  // Priority 2: candidate in active interview (keyed by username)
  if (username && active_interviews.has(username)) {
    const interview_id = active_interviews.get(username)!;

    // Verify this sender is actually the candidate for this interview
    const interview = get_interview(interview_id);
    if (!interview || interview.candidate_telegram_username.toLowerCase() !== username) {
      // Not the candidate — fall through to wizard/default
    } else {
      // Keep candidate_telegram_id up to date
      if (!interview.candidate_telegram_id) set_candidate_telegram_id(interview_id, user_id);

      try {
        await ctx.replyWithChatAction('typing');
        const { response, should_end } = await handle_candidate_reply(interview_id, text);
        await ctx.reply(response);

        if (should_end) {
          await ctx.reply('⏳ 面试已结束，正在生成评估报告，请稍候...');
          await finish_interview(bot, interview_id, config.telegram.admin_chat_id);
        }
      } catch (err) {
        console.error(`[bot] Error handling interview reply for ${interview_id}:`, err);
        await ctx.reply('抱歉，处理您的回复时遇到了问题，请稍后再试。');
      }
      return;
    }
  }

  // Priority 2b: candidate not in memory map but has a notified/in_progress interview in DB
  // (handles bot restarts where username-keyed maps were not yet restored)
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
          else await ctx.reply('抱歉，启动面试时遇到了问题，请稍后再试。');
        } catch (err) {
          console.error(`[bot] Error starting interview for user ${username}:`, err);
          await ctx.reply('抱歉，启动面试时遇到了问题，请稍后再试。');
        }
        return;
      } else if (db_iv.status === 'in_progress') {
        active_interviews.set(username, db_iv.id);
        try {
          await ctx.replyWithChatAction('typing');
          const { response, should_end } = await handle_candidate_reply(db_iv.id, text);
          await ctx.reply(response);
          if (should_end) {
            await ctx.reply('⏳ 面试已结束，正在生成评估报告，请稍候...');
            await finish_interview(bot, db_iv.id, config.telegram.admin_chat_id);
          }
        } catch (err) {
          console.error(`[bot] Error handling interview reply for ${db_iv.id}:`, err);
          await ctx.reply('抱歉，处理您的回复时遇到了问题，请稍后再试。');
        }
        return;
      }
    }
  }

  // Priority 3: scheduling wizard (admin flow, keyed by numeric user_id)
  const session = scheduling_sessions.get(user_id);
  if (session) {
    await handle_scheduling_step(ctx, user_id, session, text);
    return;
  }

  // Default: guide user
  await ctx.reply('请使用 /schedule 预约面试，或 /help 查看帮助。');
});

// ─── Scheduling wizard ────────────────────────────────────────────────────────

async function handle_nl_parse(
  ctx: Context,
  session: SchedulingSession,
  text: string,
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

  // Route to first missing field, or confirm if complete
  if (!session.candidate_name) {
    session.step = 'name';
    await ctx.reply('请问候选人叫什么名字？');
    return;
  }
  if (!session.candidate_telegram_username) {
    session.step = 'telegram';
    await ctx.reply(
      `好的，候选人：${session.candidate_name}\n\n` +
      `请输入候选人的 Telegram 用户名（@username 格式）：`
    );
    return;
  }
  if (!session.scheduled_time) {
    session.step = 'datetime';
    await ctx.reply(
      `好的，候选人：${session.candidate_name}（@${session.candidate_telegram_username}）\n\n` +
      `请问面试时间是什么时候？（北京时间，格式：YYYY-MM-DD HH:MM）`
    );
    return;
  }
  // Duration defaults to 30 min if not specified
  if (!session.duration_minutes) session.duration_minutes = 30;

  session.step = 'confirm';
  const time_str = new Date(session.scheduled_time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  await ctx.reply(
    `📋 请确认面试信息：\n\n` +
    `候选人：${session.candidate_name}\n` +
    `Telegram：@${session.candidate_telegram_username}\n` +
    `时间：${time_str}（北京时间）\n` +
    `时长：${session.duration_minutes} 分钟\n\n` +
    `输入 "确认" 或 "yes" 完成预约，输入其他内容取消。`
  );
}

async function handle_scheduling_step(
  ctx: Context,
  user_id: string,
  session: SchedulingSession,
  text: string,
): Promise<void> {
  switch (session.step) {
    case 'nl_input': {
      await ctx.replyWithChatAction('typing');
      await handle_nl_parse(ctx, session, text);
      break;
    }

    case 'name': {
      const name = text.trim();
      if (name.length < 2) {
        await ctx.reply('姓名太短，请重新输入：');
        return;
      }
      session.candidate_name = name;
      session.step = 'telegram';
      await ctx.reply(`好的，候选人：${name}\n\n请输入候选人的 Telegram 用户名（@username 格式）：`);
      break;
    }

    case 'telegram': {
      const raw = text.trim().replace(/^@/, '');
      if (raw.length < 3) {
        await ctx.reply('用户名无效，请重新输入（@username 格式）：');
        return;
      }
      session.candidate_telegram_username = raw;
      session.step = 'datetime';
      await ctx.reply(
        `好的，候选人：${session.candidate_name}（@${raw}）\n\n` +
        `请输入面试时间（北京时间）：\n` +
        `格式：YYYY-MM-DD HH:MM\n` +
        `例如：2026-03-15 14:30`
      );
      break;
    }

    case 'datetime': {
      // Parse as China Standard Time (UTC+8)
      const input = text.trim();
      const match = input.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
      if (!match) {
        await ctx.reply('格式不正确，请使用 YYYY-MM-DD HH:MM 格式，例如：2026-03-15 14:30');
        return;
      }
      const [, year, month, day, hour, minute] = match;
      // CST = UTC+8, so subtract 8 hours to get UTC
      const utc_ms = Date.UTC(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour) - 8, parseInt(minute)
      );
      if (isNaN(utc_ms) || utc_ms <= Date.now()) {
        await ctx.reply('时间无效或已过期，请输入未来的时间：');
        return;
      }
      session.scheduled_time = utc_ms;
      session.step = 'duration';
      await ctx.reply(
        `面试时间：${text.trim()}（北京时间）\n\n` +
        `请输入面试时长（分钟）：\n` +
        `建议：30、45 或 60 分钟`
      );
      break;
    }

    case 'duration': {
      const mins = parseInt(text.trim(), 10);
      if (isNaN(mins) || mins < 10 || mins > 120) {
        await ctx.reply('请输入 10 到 120 之间的分钟数：');
        return;
      }
      session.duration_minutes = mins;
      session.step = 'confirm';

      const time_str = new Date(session.scheduled_time!).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      });
      await ctx.reply(
        `📋 请确认面试信息：\n\n` +
        `候选人：${session.candidate_name}（@${session.candidate_telegram_username}）\n` +
        `时间：${time_str}（北京时间）\n` +
        `时长：${mins} 分钟\n\n` +
        `输入 "确认" 或 "yes" 完成预约，输入其他内容取消。`
      );
      break;
    }

    case 'confirm': {
      const input = text.trim().toLowerCase();
      if (input === '确认' || input === 'yes' || input === 'y') {
        const id = create_interview({
          telegram_user_id: user_id,
          candidate_name: session.candidate_name!,
          candidate_telegram_username: session.candidate_telegram_username!,
          scheduled_time: session.scheduled_time!,
          duration_minutes: session.duration_minutes!,
        });
        scheduling_sessions.delete(user_id);

        const time_str = new Date(session.scheduled_time!).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
        });
        await ctx.reply(
          `✅ 面试预约成功！（编号：#${id}）\n\n` +
          `候选人：${session.candidate_name}（@${session.candidate_telegram_username}）\n` +
          `时间：${time_str}\n` +
          `时长：${session.duration_minutes} 分钟\n\n` +
          `系统将在面试前 2 小时自动收集资料并设计面试题目。\n` +
          `到预约时间后，机器人会主动通知候选人。`
        );
      } else {
        scheduling_sessions.delete(user_id);
        await ctx.reply('已取消预约。使用 /schedule 重新开始。');
      }
      break;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function status_label(status: string): string {
  const labels: Record<string, string> = {
    pending: '⏳ 等待资料收集',
    researching: '🔍 正在收集资料',
    ready: '✅ 准备就绪',
    notified: '📢 等待候选人确认开始',
    in_progress: '🎤 面试进行中',
    completed: '✔️ 已完成',
    cancelled: '❌ 已取消',
  };
  return labels[status] ?? status;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error('[bot] Unhandled error:', err);
});

async function main() {
  await init_db(); // Initialize schema on startup
  start_scheduler(bot);
  await bot.start({
    onStart: (info) => {
      console.log(`[bot] Started as @${info.username}`);
    },
  });
}

main().catch(console.error);
