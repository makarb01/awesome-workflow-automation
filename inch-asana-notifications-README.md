# inch_asana_notificaitons_bot

Telegram bot that polls an Asana board project and posts notifications to a group chat about:
- new tasks
- status/section changes

## Target Asana project
- `ASANA_PROJECT_GID=1214101654879689`

## Setup
1. Copy env template:
   ```bash
   cp .env.inch_asana_notificaitons_bot.example .env.inch_asana_notificaitons_bot
   ```
2. Fill required variables:
   - `TELEGRAM_BOT_TOKEN`
   - `ASANA_ACCESS_TOKEN`
   - `TARGET_CHAT_IDS` (comma-separated Telegram chat ids)
3. Run:
   ```bash
   node inch_asana_notificaitons_bot.mjs
   ```

## Chat id discovery
If `TARGET_CHAT_IDS` is empty, add bot to target chat and send any message containing:
- `@inch_asana_notificaitons_bot set_notifications_chat`

Then bot will store that chat id in state and use it for notifications.

## Commands
- `/status` - show runtime config
- `/set_notifications_chat` - set current chat as notifications target

