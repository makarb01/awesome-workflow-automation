# inch_task_bot

Telegram bot for capturing team requests from group chats and creating Asana tasks in **General Tasks**.

## What it does
- Listens to group messages via Telegram long polling.
- Tracks mentions of configured users:
  - `@makarbizyukin`
  - `@dshwwxzz`
  - `@yaroslavandreev00`
  - `@Mitali_1515`
- Determines assignee by mentioned username + `TG_ASANA_MAP`.
- Includes sender information in Asana task title/notes.
- Deduplicates to avoid duplicate tasks.
- Sends debug notifications to a dedicated debug chat.

## Important Telegram requirement
For this bot to see regular group messages, disable BotFather privacy:
- BotFather -> `/setprivacy` -> `@inch_task_bot` -> `Disable`

## Setup
1. Copy env template:
   ```bash
   cp .env.inch_task_bot.example .env.inch_task_bot
   ```
2. Fill required values in `.env.inch_task_bot`:
   - `TELEGRAM_BOT_TOKEN`
   - `ASANA_ACCESS_TOKEN`
3. Optional but recommended:
   - set `ASANA_WORKSPACE_GID` / `ASANA_PROJECT_GID` (or keep auto-discovery)
   - set `WORKING_CHAT_IDS` / `DEBUG_CHAT_IDS` if you already know them
4. Run:
   ```bash
   node inch_task_bot.mjs
   ```

## Commands
- `/status` — bot status and current chat bindings.
- `/set_working_chat` — marks current chat as task-capture working chat.
- `/set_debug_chat` — marks current chat as debug notifications chat.

## Chat detection behavior
- Working chats:
  - explicit IDs from `WORKING_CHAT_IDS`, or
  - auto-match by title from `WORKING_CHAT_TITLES` (default: `Melon 303 Shahin`), or
  - manual `/set_working_chat`.
- Debug chats:
  - explicit IDs from `DEBUG_CHAT_IDS`, or
  - auto-match by title from `DEBUG_CHAT_TITLES` (default: `tech notifs`), or
  - manual `/set_debug_chat`.

## Mention to Asana mapping
Configured with:
```env
TG_ASANA_MAP=@makarbizyukin=makar@love-medo.com,@dshwwxzz=daspash.pro@gmail.com,@yaroslavandreev00=yaroslav@love-medo.com,@Mitali_1515=mitali0115@gmail.com
```

Map value can be:
- Asana user email (resolved to gid), or
- direct Asana user gid.

## Internal workers filter (anti-noise)
To avoid creating tasks from internal team chatter:
- `BLOCK_INTERNAL_REQUESTERS=1`
- `INTERNAL_REQUESTERS=...`

With this enabled, internal requesters are skipped unless message has an explicit override marker, e.g.:
- `#task`
- `/task`
- `task:`

Also, if a short follow-up is sent as a reply, bot can merge context from the replied message.

## Deduplication
- Primary key: `<chat_id>:<message_id>:<target_username>`
- Also checks open project tasks for:
  - source marker in notes (`[tg-source:...]`), and
  - similar task title for same assignee.
