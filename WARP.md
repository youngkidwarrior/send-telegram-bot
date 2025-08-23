# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

Overview
- Telegram bot implemented in ReScript targeting Node.js (ESM). ReScript compiles in-source to .res.js files.
- Source entry: src/Index.res (compiled to src/Index.res.js). Commands registered: /send, /guess, /kill, /help, /start.
- BOT_TOKEN is required (from environment/.env). If DOMAIN is set, the bot uses webhook mode; otherwise it uses long polling.

Prerequisites
- Node.js >= 16 (CI runs on Node 20.x; use Node 20 locally for parity).
- Yarn.
- .env in repo root with: BOT_TOKEN=your_telegram_bot_token. Optional: DOMAIN (enables webhook), PORT (webhook port; defaults to 3000 if DOMAIN is set).

Common commands
- Install dependencies: yarn install --frozen-lockfile
- Build ReScript: yarn build
- One-shot compile and run: yarn dev (rescript build && node src/Index.res.js)
- Watch and auto-restart: yarn dev:watch (nodemon builds and runs on .res changes)
- Start (requires compiled output present): yarn start (node src/Index.res.js)
- ReScript watch only: yarn res:dev (rescript build -w)
- Formatting check (same as CI): npx rescript format -c
- Tests: none configured in this repo (no test runner or scripts)

Runtime behavior
- Long polling: default when DOMAIN is unset (Telegraf.launch()).
- Webhook mode: when DOMAIN is set, launches with webhook options; optional PORT (defaults to 3000 when DOMAIN is set).

High-level architecture (big picture)
- src/Bindings.res: Typed FFI bindings to telegraf and dotenv. Defines branded Telegram ID types (messageId, chatId, userId, callbackQueryId), ReplyMarkup, MessageOptions, Context helpers, and Telegram methods (sendMessage, editMessageTextL, answerCbQuery, getChatAdministrators, etc.). Serves as the strongly-typed bridge to the Telegram API.
- src/MessageFormat.res: Repository-wide message abstraction. Provides message formats (Regular/Markdown/HTML), inline keyboard/button types, MarkdownV2 escaping, and toTelegramOptions to convert repo-level options/markup into Bindings.Telegraf.MessageOptions. All replies should pass through this to ensure correct parse mode and markup.
- src/Command.res: Parses commands from Telegraf.Context.
  - Supported variants: Guess, Send, Kill, Help.
  - /send: cleans sendtags, parses decimal amounts into base units (bigint) using SEND token settings (address, decimals, symbol), and builds send.app links (generateSendUrl).
  - /guess: interprets args as player count vs base amount (mirrors TS semantics), falling back to sensible defaults.
  - fromContext returns result<t, error> for dispatcher use.
- src/Game.res: Game state machine and utilities.
  - States: Initializing, Collecting, Completed, Cancelled (with reasons).
  - createGame initializes state (random winning slot); addPlayer transitions to Completed when maxPlayers reached and computes winner; cancelGame handles termination; formatWinnerMessage and gameStateText render user-facing summaries.
  - Surge tracking (cooldown-based) increases minimum/total amounts while active.
- src/Index.res: Orchestrator and runtime wiring.
  - Boot: loads env via dotenv; creates Telegraf with BOT_TOKEN; selects webhook vs long polling based on DOMAIN; graceful SIGINT shutdown.
  - Utilities: withRetry for resilient API calls; buildSendText for MarkdownV2 output.
  - State stores: in-memory maps for games, surges, pendingJoins, plus a deleteQueue that asynchronously deletes original command messages (drained with a one-shot scheduler).
  - AdminUtils: caches chat admin IDs (1‑hour TTL) for authorizing /kill.
  - Handlers: /send replies with MarkdownV2 and inline keyboard linking to send.app; /guess creates/edits game messages and batches joins; join_game callback processes pending joins and completes games; /kill restricted to admins and edits existing game message; /help and /start provide guidance.

CI
- GitHub Actions (on pull_request): Node 20.x, yarn install --frozen-lockfile, yarn build, and ReScript formatting check (npx rescript format -c). Keep local Node at 20.x for parity.

Pitfalls (repo-specific)
- yarn start expects compiled output (src/Index.res.js). Run yarn dev or yarn build first.
- Missing BOT_TOKEN will fail startup; DOMAIN controls webhook mode.

Notes
- rescript.json uses in-source compilation with suffix .res.js and ES module output; package.json has "type": "module" for ESM execution under Node.

