import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function maybeLoadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const ENV_FILE = process.env.INCH_ASANA_NOTIF_ENV_FILE || path.resolve(process.cwd(), ".env.inch_asana_notificaitons_bot");
maybeLoadEnvFile(ENV_FILE);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const BOT_USERNAME = (process.env.BOT_USERNAME || "inch_asana_notificaitons_bot").replace(/^@/, "").toLowerCase();
const TG_POLL_TIMEOUT_SEC = Math.max(5, parseInt(process.env.TG_POLL_TIMEOUT_SEC || "45", 10));
const TG_RETRY_MS = Math.max(500, parseInt(process.env.TG_RETRY_MS || "1500", 10));

const ASANA_ACCESS_TOKEN = process.env.ASANA_ACCESS_TOKEN || "";
const ASANA_API_BASE = process.env.ASANA_API_BASE || "https://app.asana.com/api/1.0";
const ASANA_PROJECT_GID = (process.env.ASANA_PROJECT_GID || "").trim();
const ASANA_POLL_INTERVAL_SEC = Math.max(20, parseInt(process.env.ASANA_POLL_INTERVAL_SEC || "90", 10));
const ASANA_COMPLETED_LOOKBACK_DAYS = Math.max(1, parseInt(process.env.ASANA_COMPLETED_LOOKBACK_DAYS || "180", 10));
const ASANA_FETCH_LIMIT = Math.max(1, Math.min(100, parseInt(process.env.ASANA_FETCH_LIMIT || "100", 10)));
const MAX_EVENTS_PER_POLL = Math.max(1, Math.min(100, parseInt(process.env.MAX_EVENTS_PER_POLL || "20", 10)));

const NOTIFY_CHAT_IDS = new Set(
  (process.env.NOTIFY_CHAT_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
const NOTIFY_CHAT_TITLES = (process.env.NOTIFY_CHAT_TITLES || "Digital Nudge - Finance")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const STATE_FILE = process.env.STATE_FILE || path.resolve(process.cwd(), "inch-asana-notificaitons-state.json");
const MAX_TASKS_IN_STATE = Math.max(1000, parseInt(process.env.MAX_TASKS_IN_STATE || "20000", 10));

const state = {
  initialized: false,
  notify_chat_ids: [],
  tasks: {},
  last_sync_at: 0,
  created_at: Date.now(),
  updated_at: Date.now(),
};

let nextUpdateOffset = 0;
let saveQueue = Promise.resolve();
let lastErrorNotifyTs = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clipText(text, maxLen = 3500) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1)).trim()}…`;
}

function normalizeCommandText(text) {
  let t = String(text || "").trim();
  if (new RegExp(`^@${BOT_USERNAME}\\s+`, "i").test(t)) {
    t = t.replace(new RegExp(`^@${BOT_USERNAME}\\s+`, "i"), "");
  }
  return t.trim();
}

function ensureConfig() {
  const missing = [];
  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!ASANA_ACCESS_TOKEN) missing.push("ASANA_ACCESS_TOKEN");
  if (!ASANA_PROJECT_GID) missing.push("ASANA_PROJECT_GID");
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}`);
}

function getNotifyChatIds() {
  const merged = new Set([...NOTIFY_CHAT_IDS, ...state.notify_chat_ids]);
  return [...merged].filter(Boolean);
}

function taskStatusLabel(task) {
  if (!task) return "Unknown";
  if (task.completed) return "Completed";
  return task.section_name || "No section";
}

function findMembershipForProject(task) {
  const memberships = Array.isArray(task?.memberships) ? task.memberships : [];
  return memberships.find((m) => String(m?.project?.gid || "") === ASANA_PROJECT_GID) || memberships[0] || null;
}

function shapeTask(task) {
  const membership = findMembershipForProject(task);
  const sectionName = String(membership?.section?.name || "").trim();
  const sectionGid = String(membership?.section?.gid || "").trim();
  return {
    gid: String(task?.gid || ""),
    name: String(task?.name || "(untitled)"),
    completed: Boolean(task?.completed),
    section_gid: sectionGid,
    section_name: sectionName,
    assignee_name: String(task?.assignee?.name || ""),
    permalink_url: String(task?.permalink_url || ""),
    created_at: String(task?.created_at || ""),
    modified_at: String(task?.modified_at || ""),
  };
}

function pruneTasksMap() {
  const keys = Object.keys(state.tasks);
  if (keys.length <= MAX_TASKS_IN_STATE) return;
  keys
    .sort((a, b) => {
      const ta = Number(new Date(state.tasks[a]?.modified_at || 0).getTime()) || 0;
      const tb = Number(new Date(state.tasks[b]?.modified_at || 0).getTime()) || 0;
      return ta - tb;
    })
    .slice(0, keys.length - MAX_TASKS_IN_STATE)
    .forEach((k) => delete state.tasks[k]);
}

async function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    if (typeof parsed.initialized === "boolean") state.initialized = parsed.initialized;
    if (Array.isArray(parsed.notify_chat_ids)) state.notify_chat_ids = parsed.notify_chat_ids.map(String);
    if (parsed.tasks && typeof parsed.tasks === "object") state.tasks = parsed.tasks;
    state.last_sync_at = Number(parsed.last_sync_at || 0);
    state.created_at = Number(parsed.created_at || state.created_at);
    state.updated_at = Date.now();
  } catch (err) {
    console.log(`state load warning: ${err?.message || String(err)}`);
  }
}

async function saveStateNow() {
  pruneTasksMap();
  state.updated_at = Date.now();
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function saveState() {
  saveQueue = saveQueue.then(() => saveStateNow()).catch((err) => {
    console.log(`save state error: ${err?.message || String(err)}`);
  });
  return saveQueue;
}

async function tgApi(method, payload = {}) {
  const url = `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram ${method} failed: ${json?.description || `${res.status}`}`);
  }
  return json.result;
}

async function tgSend(chatId, text) {
  try {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: clipText(text, 3900),
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.log(`notify error chat=${chatId}: ${err?.message || String(err)}`);
  }
}

async function notifyAll(text) {
  const chatIds = getNotifyChatIds();
  for (const chatId of chatIds) {
    await tgSend(chatId, text);
  }
}

function maybeRegisterChat(chat) {
  const id = String(chat?.id || "");
  const title = String(chat?.title || "").toLowerCase();
  if (!id) return false;
  if (state.notify_chat_ids.includes(id)) return false;
  if (NOTIFY_CHAT_TITLES.some((t) => t && title.includes(t))) {
    state.notify_chat_ids.push(id);
    return true;
  }
  return false;
}

function getMessageFromUpdate(update) {
  return update?.message || update?.edited_message || update?.channel_post || update?.edited_channel_post || null;
}

function getChatFromUpdate(update) {
  const msg = getMessageFromUpdate(update);
  if (msg?.chat) return msg.chat;
  if (update?.my_chat_member?.chat) return update.my_chat_member.chat;
  if (update?.chat_member?.chat) return update.chat_member.chat;
  return null;
}

async function handleCommandsFromMessage(msg) {
  const chatId = String(msg?.chat?.id || "");
  if (!chatId) return false;
  const rawText = String(msg?.text || msg?.caption || "").trim();
  if (!rawText) return false;
  const txt = normalizeCommandText(rawText);
  const lower = txt.toLowerCase();

  if (/^\/set_notify_chat(?:@\w+)?(?:\s|$)/.test(lower)) {
    if (!state.notify_chat_ids.includes(chatId)) state.notify_chat_ids.push(chatId);
    await saveState();
    await tgSend(chatId, "✅ This chat is now configured for Asana notifications.");
    return true;
  }

  if (/^\/status(?:@\w+)?(?:\s|$)/.test(lower)) {
    const statusText =
      `inch_asana_notificaitons_bot status\n` +
      `project_gid: ${ASANA_PROJECT_GID}\n` +
      `notify_chats: ${getNotifyChatIds().join(", ") || "(none)"}\n` +
      `initialized: ${state.initialized ? "yes" : "no"}\n` +
      `tracked_tasks: ${Object.keys(state.tasks).length}\n` +
      `last_sync_at: ${state.last_sync_at ? new Date(state.last_sync_at).toISOString() : "(never)"}`;
    await tgSend(chatId, statusText);
    return true;
  }

  if (/^\/poll_now(?:@\w+)?(?:\s|$)/.test(lower)) {
    await tgSend(chatId, "⏳ Polling Asana now...");
    await syncAsanaAndNotify({ forceSummary: true });
    await tgSend(chatId, "✅ Poll complete.");
    return true;
  }

  return false;
}

async function asanaRequest(method, endpoint, body = null) {
  const url = `${ASANA_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${ASANA_ACCESS_TOKEN}`,
  };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Asana ${method} ${endpoint} failed: ${json?.errors?.[0]?.message || res.status}`);
  }
  return json;
}

function completedSinceIso() {
  const ms = Date.now() - ASANA_COMPLETED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

async function fetchProjectTasksSnapshot() {
  const fields = [
    "gid",
    "name",
    "completed",
    "created_at",
    "modified_at",
    "permalink_url",
    "assignee.gid",
    "assignee.name",
    "memberships.project.gid",
    "memberships.section.gid",
    "memberships.section.name",
  ].join(",");
  let offset = "";
  const tasks = [];
  let pages = 0;
  while (pages < 200) {
    pages += 1;
    const params = new URLSearchParams({
      limit: String(ASANA_FETCH_LIMIT),
      completed_since: completedSinceIso(),
      opt_fields: fields,
    });
    if (offset) params.set("offset", offset);
    const endpoint = `/projects/${encodeURIComponent(ASANA_PROJECT_GID)}/tasks?${params.toString()}`;
    const json = await asanaRequest("GET", endpoint);
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const shaped = shapeTask(row);
      if (shaped.gid) tasks.push(shaped);
    }
    offset = String(json?.next_page?.offset || "");
    if (!offset) break;
  }
  return tasks;
}

function buildCurrentMap(tasks) {
  const map = {};
  for (const t of tasks) {
    map[t.gid] = t;
  }
  return map;
}

function compareSnapshots(prevMap, currMap) {
  const events = [];
  for (const [gid, curr] of Object.entries(currMap)) {
    const prev = prevMap[gid];
    if (!prev) {
      events.push({ type: "new", curr });
      continue;
    }
    const sectionChanged = String(prev.section_gid || "") !== String(curr.section_gid || "");
    const completionChanged = Boolean(prev.completed) !== Boolean(curr.completed);
    if (sectionChanged || completionChanged) {
      events.push({ type: "status", prev, curr });
    }
  }
  return events;
}

function formatEvent(event) {
  if (event.type === "new") {
    const t = event.curr;
    return (
      `🆕 New task\n` +
      `${t.name}\n` +
      `Status: ${taskStatusLabel(t)}\n` +
      `Assignee: ${t.assignee_name || "Unassigned"}\n` +
      `${t.permalink_url || ""}`
    );
  }
  if (event.type === "status") {
    const prevLabel = taskStatusLabel(event.prev);
    const currLabel = taskStatusLabel(event.curr);
    return (
      `🔁 Status changed\n` +
      `${event.curr.name}\n` +
      `${prevLabel} -> ${currLabel}\n` +
      `Assignee: ${event.curr.assignee_name || "Unassigned"}\n` +
      `${event.curr.permalink_url || ""}`
    );
  }
  return "";
}

async function syncAsanaAndNotify({ forceSummary = false } = {}) {
  const tasks = await fetchProjectTasksSnapshot();
  const currMap = buildCurrentMap(tasks);

  if (!state.initialized) {
    state.tasks = currMap;
    state.initialized = true;
    state.last_sync_at = Date.now();
    await saveState();
    await notifyAll(
      `✅ inch_asana_notificaitons_bot connected\n` +
        `Project: ${ASANA_PROJECT_GID}\n` +
        `Baseline loaded: ${Object.keys(currMap).length} tasks`,
    );
    return;
  }

  const prevMap = state.tasks || {};
  const events = compareSnapshots(prevMap, currMap);
  state.tasks = currMap;
  state.last_sync_at = Date.now();
  await saveState();

  if (!events.length) {
    if (forceSummary) {
      await notifyAll(`No updates found. Current tracked tasks: ${Object.keys(currMap).length}`);
    }
    return;
  }

  const limited = events.slice(0, MAX_EVENTS_PER_POLL);
  for (const event of limited) {
    const msg = formatEvent(event);
    if (msg) await notifyAll(msg);
  }
  if (events.length > limited.length) {
    await notifyAll(`ℹ️ ${events.length - limited.length} more updates were detected (truncated in this poll).`);
  }
}

async function processUpdate(update) {
  const chat = getChatFromUpdate(update);
  if (chat && maybeRegisterChat(chat)) {
    await saveState();
    await notifyAll(`✅ Registered notify chat: ${chat.title || chat.id}`);
  }
  const msg = getMessageFromUpdate(update);
  if (msg) {
    await handleCommandsFromMessage(msg);
  }
}

async function pollTelegramLoop() {
  while (true) {
    try {
      const updates = await tgApi("getUpdates", {
        timeout: TG_POLL_TIMEOUT_SEC,
        offset: nextUpdateOffset,
        allowed_updates: ["message", "edited_message", "my_chat_member", "chat_member", "channel_post"],
      });
      for (const upd of updates) {
        const id = Number(upd?.update_id || 0);
        if (id >= nextUpdateOffset) nextUpdateOffset = id + 1;
        try {
          await processUpdate(upd);
        } catch (err) {
          console.log(`update process error: ${err?.message || String(err)}`);
        }
      }
    } catch (err) {
      console.log(`telegram poll error: ${err?.message || String(err)}`);
      await sleep(TG_RETRY_MS);
    }
  }
}

async function asanaPollLoop() {
  await sleep(2000);
  while (true) {
    try {
      await syncAsanaAndNotify({ forceSummary: false });
    } catch (err) {
      const text = `❌ asana poll error: ${err?.message || String(err)}`;
      console.log(text);
      const now = Date.now();
      if (now - lastErrorNotifyTs > 10 * 60 * 1000) {
        await notifyAll(text);
        lastErrorNotifyTs = now;
      }
    }
    await sleep(ASANA_POLL_INTERVAL_SEC * 1000);
  }
}

async function main() {
  ensureConfig();
  await loadState();
  const me = await tgApi("getMe");
  console.log(`inch_asana_notificaitons_bot started as @${me?.username || BOT_USERNAME}`);
  await Promise.all([pollTelegramLoop(), asanaPollLoop()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
