# AI Agent Administrator Interview Bot

An automated interview bot designed specifically for hiring **AI Agent Administrators**, currently running on Telegram.

Interviewers schedule interviews once — the bot handles everything else: research, question generation, conducting the interview, and delivering a structured evaluation report.

[中文文档](README.zh.md) · [Landing Page](https://blackman99.github.io/eval-mate/)

## Features

- **Natural language scheduling** — describe the interview in plain text (e.g. "Interview John @john tomorrow at 3pm, 45 minutes") and Claude extracts all fields automatically
- **Automated research** — 2 hours before the interview, the bot searches for the latest AI Agent ecosystem updates and generates tailored questions
- **Fully automated interview** — the candidate chats with the bot on Telegram; the bot asks questions, follows up dynamically, and adapts in real time
- **Smart evaluation report** — after the interview, a structured report with per-dimension scores and a hire/no-hire recommendation is sent to the interviewer
- **Reminders & notifications** — candidate is reminded 15 minutes before, and notified automatically when it's time to start

## Interview Dimensions

| Dimension | Coverage |
|-----------|----------|
| AI Fundamentals | LLM principles, prompt engineering, RAG, hallucination mitigation, fine-tuning (LoRA, RLHF) |
| Agent Frameworks | LangChain, AutoGen, CrewAI, Claude SDK, LlamaIndex hands-on experience |
| System Operations | Deployment, monitoring, logging, incident response, disaster recovery |
| Business Communication | Requirements analysis, cross-team collaboration, ROI evaluation, stakeholder reporting |

## Quick Start

### Prerequisites

- Node.js 20+
- Telegram Bot Token (create one via [@BotFather](https://t.me/BotFather))
- Anthropic API Key

### Install

```bash
git clone https://github.com/Blackman99/eval-mate.git
cd eval-mate
npm install
```

### Configure

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ADMIN_CHAT_ID=your_admin_chat_id_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Optional
# ANTHROPIC_BASE_URL=https://api.anthropic.com
# DB_PATH=./interviews.db
# HTTPS_PROXY=http://127.0.0.1:7890
```

> To get your `TELEGRAM_ADMIN_CHAT_ID`, message [@userinfobot](https://t.me/userinfobot) on Telegram.

### Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

## Bot Commands

### Interviewer

| Command | Description |
|---------|-------------|
| `/schedule` | Schedule an interview — supports natural language input |
| `/status` | List all upcoming interviews |
| `/cancel [id]` | Cancel an interview by ID |

**Scheduling examples:**

```
/schedule John (@john), tomorrow at 3pm, 45 minutes
/schedule Book an interview with Jane @jane on March 15 at 14:30, one hour
```

The system will automatically collect research and generate questions 2 hours before the interview.

### Candidate

1. Send `/start` to the bot first — required so the bot can reach you proactively
2. The bot will notify you when it's time for your interview
3. You can also send `/begin` after the scheduled time to start immediately
4. Just reply in the chat to answer questions

## Architecture

```
src/
├── bot.ts          # Telegram bot entry point — command & message routing
├── scheduler.ts    # Cron jobs: notifications, reminders, research triggers
├── researcher.ts   # Research & question generation (Claude + Web Search)
├── interviewer.ts  # Interview conductor & evaluation report generator
├── parser.ts       # Natural language parsing (extract scheduling info)
├── db.ts           # SQLite persistence (sql.js)
├── config.ts       # Environment variable config
└── types.ts        # TypeScript type definitions
```

**Stack:**

- [grammY](https://grammy.dev/) — Telegram Bot framework
- [Anthropic Claude](https://www.anthropic.com/) — claude-opus-4-6 with extended thinking and web search
- [sql.js](https://sql.js.org/) — pure JS SQLite, no native dependencies
- [node-cron](https://github.com/node-cron/node-cron) — cron-based task scheduling
- TypeScript + ESM

## Interview Status Flow

```
pending → researching → ready → notified → in_progress → completed
                                                        ↘ cancelled
```

| Status | Description |
|--------|-------------|
| `pending` | Scheduled, waiting for research (triggers 2 hours before) |
| `researching` | Collecting research and generating questions |
| `ready` | Questions ready, waiting for interview time |
| `notified` | Candidate notified, waiting for them to start |
| `in_progress` | Interview in progress |
| `completed` | Interview finished, report sent |
| `cancelled` | Cancelled |

## Notes

- Candidates must send `/start` to the bot before their interview — otherwise the bot cannot reach them proactively
- Schedule at least 2 hours in advance to allow time for research and question generation
- Proxy support: set `HTTPS_PROXY` or `HTTP_PROXY` if your environment requires it
