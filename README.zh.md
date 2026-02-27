# AI Agent 管理员面试助手

专为招聘「AI Agent 管理员」岗位设计的自动化面试机器人，目前支持 Telegram 平台。

[English](README.md) · [Landing Page](https://blackman99.github.io/eval-mate/)

面试官通过 Telegram 预约面试，机器人自动完成资料收集、题目设计、面试主持、评估报告全流程，无需人工介入。

## 功能概览

- **自然语言预约**：支持直接描述面试信息（如"张三 @zhangsan，明天下午3点，45分钟"），Claude 自动提取字段
- **自动资料收集**：面试前 2 小时，机器人通过网络搜索收集 AI Agent 领域最新动态，生成定制化面试题
- **全程自动面试**：候选人通过 Telegram 与机器人对话完成面试，支持追问和动态调整
- **智能评估报告**：面试结束后自动生成结构化评估报告，包含各维度评分和录用建议，发送给面试官
- **候选人提醒**：面试前 15 分钟自动提醒候选人，到时间自动发起面试通知

## 面试维度

| 维度 | 说明 |
|------|------|
| AI 基础知识 | LLM 原理、Prompt 工程、RAG、幻觉处理、微调方法 |
| Agent 框架经验 | LangChain、AutoGen、CrewAI、Claude SDK 等实践经验 |
| 系统运维 | 部署、监控、日志、故障排查、灾备方案 |
| 业务沟通 | 需求分析、跨团队协作、ROI 评估、技术决策推动 |

## 快速开始

### 环境要求

- Node.js 20+
- Telegram Bot Token（通过 [@BotFather](https://t.me/BotFather) 创建）
- Anthropic API Key

### 安装

```bash
git clone https://github.com/Blackman99/eval-mate.git
cd eval-mate
npm install
```

### 配置

复制配置模板并填入实际值：

```bash
cp .env.example .env.local
```

编辑 `.env.local`：

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ADMIN_CHAT_ID=your_admin_chat_id_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# 可选
# ANTHROPIC_BASE_URL=https://api.anthropic.com
# DB_PATH=./interviews.db
# HTTPS_PROXY=http://127.0.0.1:7890
```

> 获取 `TELEGRAM_ADMIN_CHAT_ID`：向 [@userinfobot](https://t.me/userinfobot) 发送任意消息即可获得你的 Chat ID。

### 运行

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run build && npm start
```

## 使用说明

### 面试官操作

| 命令 | 说明 |
|------|------|
| `/schedule` | 预约面试，支持自然语言输入 |
| `/status` | 查看所有待进行的面试 |
| `/cancel [编号]` | 取消面试预约 |

**预约示例：**

```
/schedule 张三（@zhangsan），明天下午3点，45分钟
/schedule 帮我预约李四 @lisi 的面试，3月15日14:30，一小时
```

系统将在面试前 2 小时自动收集资料并设计题目。

### 候选人操作

1. 向机器人发送 `/start` 完成注册（必须，否则机器人无法主动联系）
2. 到预约时间后，机器人会主动发送面试通知
3. 也可在预约时间后主动发送 `/begin` 开始面试
4. 直接在对话框回复问题即可完成面试

## 技术架构

```
src/
├── bot.ts          # Telegram Bot 入口，命令与消息路由
├── scheduler.ts    # 定时任务：通知、提醒、研究触发
├── researcher.ts   # 资料收集与题目生成（Claude + Web Search）
├── interviewer.ts  # 面试主持与评估报告生成
├── parser.ts       # 自然语言解析（提取面试信息）
├── db.ts           # SQLite 数据持久化（sql.js）
├── config.ts       # 环境变量配置
└── types.ts        # TypeScript 类型定义
```

**技术栈：**

- [grammY](https://grammy.dev/) — Telegram Bot 框架
- [Anthropic Claude](https://www.anthropic.com/) — claude-opus-4-6，含 extended thinking 和 web search
- [sql.js](https://sql.js.org/) — 纯 JS SQLite，无需系统依赖
- [node-cron](https://github.com/node-cron/node-cron) — 定时任务调度
- TypeScript + ESM

## 面试状态流转

```
pending → researching → ready → notified → in_progress → completed
                                                        ↘ cancelled
```

| 状态 | 说明 |
|------|------|
| `pending` | 已预约，等待资料收集（面试前 2 小时触发） |
| `researching` | 正在收集资料、生成题目 |
| `ready` | 题目已就绪，等待面试时间 |
| `notified` | 已通知候选人，等待候选人确认开始 |
| `in_progress` | 面试进行中 |
| `completed` | 面试结束，报告已发送 |
| `cancelled` | 已取消 |

## 注意事项

- 候选人必须先向机器人发送 `/start`，机器人才能主动联系他们
- 建议提前至少 2 小时预约，以便系统完成资料准备
- 代理配置：如需通过代理访问 Telegram，设置 `HTTPS_PROXY` 或 `HTTP_PROXY` 环境变量
