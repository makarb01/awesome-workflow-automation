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
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const ENV_FILE = process.env.INCH_TASK_ENV_FILE || path.resolve(process.cwd(), ".env.inch_task_bot");
maybeLoadEnvFile(ENV_FILE);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const BOT_USERNAME = (process.env.BOT_USERNAME || "inch_task_bot").replace(/^@/, "").toLowerCase();
const TG_POLL_TIMEOUT_SEC = Math.max(5, parseInt(process.env.TG_POLL_TIMEOUT_SEC || "50", 10));
const TG_RETRY_MS = Math.max(500, parseInt(process.env.TG_RETRY_MS || "1500", 10));

const ASANA_ENABLED = (process.env.ENABLE_ASANA || "1") === "1";
const ASANA_ACCESS_TOKEN = process.env.ASANA_ACCESS_TOKEN || "";
const ASANA_API_BASE = process.env.ASANA_API_BASE || "https://app.asana.com/api/1.0";
const ASANA_WORKSPACE_GID = (process.env.ASANA_WORKSPACE_GID || "").trim();
const ASANA_PROJECT_GID = (process.env.ASANA_PROJECT_GID || "").trim();
const ASANA_PROJECT_NAME = (process.env.ASANA_PROJECT_NAME || "General Tasks").trim();
const ASANA_TASK_FETCH_LIMIT = Math.max(20, Math.min(100, parseInt(process.env.ASANA_TASK_FETCH_LIMIT || "100", 10)));

const TRACKED_USERS = new Set(
  (process.env.TRACKED_USERS ||
    "@makarbizyukin,@dshwwxzz,@yaroslavandreev00,@Mitali_1515")
    .split(",")
    .map((x) => x.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean),
);

const TG_ASANA_MAP_RAW =
  process.env.TG_ASANA_MAP ||
  "@makarbizyukin=makar@love-medo.com,@dshwwxzz=daspash.pro@gmail.com,@yaroslavandreev00=yaroslav@love-medo.com,@Mitali_1515=mitali0115@gmail.com";

const WORKING_CHAT_IDS = new Set(
  (process.env.WORKING_CHAT_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
const WORKING_CHAT_TITLES = (process.env.WORKING_CHAT_TITLES || "Melon 303 Shahin")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const DEBUG_CHAT_IDS = new Set(
  (process.env.DEBUG_CHAT_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
const DEBUG_CHAT_TITLES = (process.env.DEBUG_CHAT_TITLES || "tech notifs")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const STATE_FILE = process.env.STATE_FILE || path.resolve(process.cwd(), "inch-task-state.json");
const MAX_PROCESSED_KEYS = Math.max(1000, parseInt(process.env.MAX_PROCESSED_KEYS || "20000", 10));

const state = {
  processed: {},
  working_chat_ids: [],
  debug_chat_ids: [],
  created_at: Date.now(),
  updated_at: Date.now(),
};

const tgAsanaMap = parseKvMap(TG_ASANA_MAP_RAW);
let asanaWorkspaceCache = ASANA_WORKSPACE_GID;
let asanaProjectCache = ASANA_PROJECT_GID;
let asanaUsersCache = null;
let nextUpdateOffset = 0;

function parseKvMap(raw) {
  const map = new Map();
  for (const part of String(raw || "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const k = item.slice(0, eq).trim().replace(/^@/, "").toLowerCase();
    const v = item.slice(eq + 1).trim();
    if (k && v) map.set(k, v);
  }
  return map;
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function clipText(text, maxLen = 160) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1)).trim()}…`;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarityKey(text) {
  const words = normalizeText(text).split(" ").filter((w) => w.length >= 3);
  return words.slice(0, 10).join(" ");
}

function buildMessageLink(chat, messageId) {
  const mid = Number(messageId || 0);
  if (!mid) return "";
  const username = String(chat?.username || "").trim();
  if (username) return `https://t.me/${username}/${mid}`;
  const rawId = String(chat?.id || "");
  if (rawId.startsWith("-100")) return `https://t.me/c/${rawId.slice(4)}/${mid}`;
  return "";
}

function buildProcessedKey(chatId, messageId, assigneeUser) {
  return `${chatId}:${messageId}:${normalizeUsername(assigneeUser)}`;
}

function isWorkingChat(chat) {
  const id = String(chat?.id || "");
  const title = String(chat?.title || "").toLowerCase();
  if (!id) return false;
  if (WORKING_CHAT_IDS.has(id)) return true;
  if (state.working_chat_ids.includes(id)) return true;
  return WORKING_CHAT_TITLES.some((t) => t && title.includes(t));
}

function getDebugChatIds() {
  const merged = new Set([...DEBUG_CHAT_IDS, ...state.debug_chat_ids]);
  return [...merged].filter(Boolean);
}

function discoverChatsFromMessage(msg, text) {
  const chat = msg?.chat || {};
  const id = String(chat.id || "");
  const title = String(chat.title || "").toLowerCase();
  if (!id) return;

  if (!state.working_chat_ids.includes(id) && WORKING_CHAT_TITLES.some((t) => t && title.includes(t))) {
    state.working_chat_ids.push(id);
  }

  const textLc = String(text || "").toLowerCase();
  const asksDebug = textLc.includes(`@${BOT_USERNAME}`) && textLc.includes("debug");
  const titleLooksDebug = DEBUG_CHAT_TITLES.some((t) => t && title.includes(t));
  if (!state.debug_chat_ids.includes(id) && (titleLooksDebug || asksDebug)) {
    state.debug_chat_ids.push(id);
  }
}

async function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.processed && typeof parsed.processed === "object") state.processed = parsed.processed;
      if (Array.isArray(parsed.working_chat_ids)) state.working_chat_ids = parsed.working_chat_ids.map(String);
      if (Array.isArray(parsed.debug_chat_ids)) state.debug_chat_ids = parsed.debug_chat_ids.map(String);
      state.created_at = Number(parsed.created_at || state.created_at);
      state.updated_at = Date.now();
    }
  } catch (err) {
    console.log(`state load warning: ${err?.message || String(err)}`);
  }
}

async function saveState() {
  pruneProcessedKeys();
  state.updated_at = Date.now();
  const dir = path.dirname(STATE_FILE);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function pruneProcessedKeys() {
  const keys = Object.keys(state.processed);
  if (keys.length <= MAX_PROCESSED_KEYS) return;
  keys
    .sort((a, b) => Number(state.processed[a]?.ts || 0) - Number(state.processed[b]?.ts || 0))
    .slice(0, keys.length - MAX_PROCESSED_KEYS)
    .forEach((k) => delete state.processed[k]);
}

function ensureConfig() {
  const missing = [];
  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (ASANA_ENABLED && !ASANA_ACCESS_TOKEN) missing.push("ASANA_ACCESS_TOKEN");
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}`);
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

async function notifyDebug(text) {
  const ids = getDebugChatIds();
  if (!ids.length) return;
  for (const chatId of ids) {
    await tgSend(chatId, text);
  }
}

function extractMentions(msg, text) {
  const out = new Set();
  const entities = Array.isArray(msg?.entities) ? msg.entities : [];
  const raw = String(text || "");
  for (const entity of entities) {
    if (!entity || typeof entity.offset !== "number" || typeof entity.length !== "number") continue;
    if (entity.type === "mention") {
      const chunk = raw.slice(entity.offset, entity.offset + entity.length);
      const u = normalizeUsername(chunk);
      if (u) out.add(u);
    }
    if (entity.type === "text_mention" && entity.user?.username) {
      const u = normalizeUsername(entity.user.username);
      if (u) out.add(u);
    }
  }
  for (const match of raw.matchAll(/(^|\s)@([A-Za-z0-9_]{4,32})/g)) {
    const u = normalizeUsername(match[2]);
    if (u) out.add(u);
  }
  return out;
}

function buildTaskTitle(targetUsername, senderUsername, text) {
  const clean = String(text || "")
    .replace(/@[A-Za-z0-9_]{4,32}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const snippet = clipText(clean || "New request from Telegram", 90);
  const sender = senderUsername ? `from @${senderUsername}` : "from chat";
  return `[TG] @${targetUsername} — ${snippet} (${sender})`;
}

function chooseTargets({ mentions, senderUsername, botMentioned }) {
  const explicit = [...mentions].filter((u) => TRACKED_USERS.has(u));
  if (explicit.length) return explicit;
  if (botMentioned && senderUsername && TRACKED_USERS.has(senderUsername)) {
    return [senderUsername];
  }
  return [];
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
  return json.data;
}

async function resolveAsanaWorkspaceGid() {
  if (asanaWorkspaceCache) return asanaWorkspaceCache;
  const me = await asanaRequest("GET", "/users/me?opt_fields=workspaces.gid,workspaces.name");
  const ws = Array.isArray(me?.workspaces) ? me.workspaces[0] : null;
  if (!ws?.gid) throw new Error("Asana workspace not found");
  asanaWorkspaceCache = String(ws.gid);
  return asanaWorkspaceCache;
}

async function resolveAsanaProjectGid() {
  if (asanaProjectCache) return asanaProjectCache;
  const workspace = await resolveAsanaWorkspaceGid();
  const items = await asanaRequest(
    "GET",
    `/projects?workspace=${encodeURIComponent(workspace)}&archived=false&limit=100&opt_fields=gid,name`,
  );
  const hit = (Array.isArray(items) ? items : []).find(
    (p) => String(p?.name || "").trim().toLowerCase() === ASANA_PROJECT_NAME.toLowerCase(),
  );
  if (!hit?.gid) throw new Error(`Asana project "${ASANA_PROJECT_NAME}" not found`);
  asanaProjectCache = String(hit.gid);
  return asanaProjectCache;
}

async function loadAsanaUsersIndex() {
  if (asanaUsersCache) return asanaUsersCache;
  const workspace = await resolveAsanaWorkspaceGid();
  const map = new Map();
  let offset = "";
  let page = 0;
  while (page < 20) {
    page += 1;
    const query = new URLSearchParams({
      workspace,
      limit: "100",
      opt_fields: "gid,name,email",
    });
    if (offset) query.set("offset", offset);
    const url = `${ASANA_API_BASE}/users?${query.toString()}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${ASANA_ACCESS_TOKEN}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Asana users fetch failed: ${json?.errors?.[0]?.message || res.status}`);
    const users = Array.isArray(json?.data) ? json.data : [];
    for (const u of users) {
      const gid = String(u?.gid || "");
      if (!gid) continue;
      const keys = [u?.name, u?.email].map((x) => String(x || "").trim().toLowerCase()).filter(Boolean);
      for (const key of keys) map.set(key, gid);
    }
    offset = String(json?.next_page?.offset || "");
    if (!offset) break;
  }
  asanaUsersCache = map;
  return asanaUsersCache;
}

async function resolveAssigneeGid(targetUsername) {
  const key = normalizeUsername(targetUsername);
  const hint = tgAsanaMap.get(key) || "";
  if (!hint) return "";
  if (/^\d+$/.test(hint)) return hint;
  const users = await loadAsanaUsersIndex();
  return users.get(hint.toLowerCase()) || "";
}

async function listOpenProjectTasks(projectGid) {
  const endpoint =
    `/projects/${encodeURIComponent(projectGid)}` +
    `/tasks?completed_since=now&limit=${ASANA_TASK_FETCH_LIMIT}` +
    `&opt_fields=gid,name,notes,completed,assignee.gid,assignee.name,permalink_url`;
  const rows = await asanaRequest("GET", endpoint);
  return Array.isArray(rows) ? rows : [];
}

function findDuplicateTask(tasks, sourceMarker, title, assigneeGid) {
  const titleKey = titleSimilarityKey(title);
  for (const task of tasks) {
    const notes = String(task?.notes || "");
    if (sourceMarker && notes.includes(sourceMarker)) return task;
  }
  for (const task of tasks) {
    if (assigneeGid && String(task?.assignee?.gid || "") !== String(assigneeGid)) continue;
    const existingKey = titleSimilarityKey(task?.name || "");
    if (!existingKey || !titleKey) continue;
    if (existingKey.includes(titleKey) || titleKey.includes(existingKey)) {
      return task;
    }
  }
  return null;
}

async function createAsanaTask({ projectGid, title, notes, assigneeGid }) {
  const payload = {
    data: {
      name: title,
      notes,
      projects: [projectGid],
    },
  };
  if (assigneeGid) payload.data.assignee = assigneeGid;
  const created = await asanaRequest("POST", "/tasks", payload);
  return created;
}

async function handleStatusCommand(msg) {
  const chatId = String(msg?.chat?.id || "");
  const text =
    `inch_task_bot status\n` +
    `asana: ${ASANA_ENABLED ? "enabled" : "disabled"}\n` +
    `tracked users: ${[...TRACKED_USERS].map((u) => `@${u}`).join(", ")}\n` +
    `working chats: ${[...new Set([...WORKING_CHAT_IDS, ...state.working_chat_ids])].join(", ") || "(none)"}\n` +
    `debug chats: ${getDebugChatIds().join(", ") || "(none)"}`;
  await tgSend(chatId, text);
}

async function handleManualChatCommands(msg, text) {
  const chatId = String(msg?.chat?.id || "");
  const cmd = String(text || "").trim().toLowerCase();
  const statusCmd = /(?:^|\s)\/status(?:@\w+)?(?:\s|$)/.test(cmd);
  const workingCmd = /(?:^|\s)\/set_working_chat(?:@\w+)?(?:\s|$)/.test(cmd);
  const debugCmd = /(?:^|\s)\/set_debug_chat(?:@\w+)?(?:\s|$)/.test(cmd);

  if (statusCmd) {
    await handleStatusCommand(msg);
    return true;
  }
  if (workingCmd) {
    if (!state.working_chat_ids.includes(chatId)) state.working_chat_ids.push(chatId);
    await saveState();
    await tgSend(chatId, "✅ This chat was added as working chat.");
    return true;
  }
  if (debugCmd) {
    if (!state.debug_chat_ids.includes(chatId)) state.debug_chat_ids.push(chatId);
    await saveState();
    await tgSend(chatId, "✅ This chat was added as debug notifications chat.");
    return true;
  }
  return false;
}

async function processMessage(msg) {
  if (!msg || msg.from?.is_bot) return;
  const text = String(msg.text || msg.caption || "").trim();
  if (!text) return;

  discoverChatsFromMessage(msg, text);
  if (await handleManualChatCommands(msg, text)) return;

  const chat = msg.chat || {};
  const chatId = String(chat.id || "");
  if (!isWorkingChat(chat)) return;

  const mentions = extractMentions(msg, text);
  const botMentioned = mentions.has(BOT_USERNAME);
  const senderUsername = normalizeUsername(msg.from?.username || "");
  const targets = chooseTargets({ mentions, senderUsername, botMentioned });
  if (!targets.length) return;

  if (!ASANA_ENABLED) {
    await notifyDebug(`⚠️ skipped: Asana disabled. chat=${chatId} msg=${msg.message_id}`);
    return;
  }

  const projectGid = await resolveAsanaProjectGid();
  const openTasks = await listOpenProjectTasks(projectGid);

  for (const target of targets) {
    const processedKey = buildProcessedKey(chatId, msg.message_id, target);
    if (state.processed[processedKey]) continue;

    const sourceMarker = `[tg-source:${processedKey}]`;
    const title = buildTaskTitle(target, senderUsername, text);
    const assigneeGid = await resolveAssigneeGid(target);
    const duplicate = findDuplicateTask(openTasks, sourceMarker, title, assigneeGid);

    if (duplicate?.gid) {
      state.processed[processedKey] = {
        ts: Date.now(),
        status: "duplicate",
        task_gid: String(duplicate.gid),
      };
      await notifyDebug(
        `ℹ️ duplicate skipped\nchat=${chatId}\nmsg=${msg.message_id}\ntarget=@${target}\nexisting_task=${duplicate.gid}`,
      );
      continue;
    }

    const messageLink = buildMessageLink(chat, msg.message_id);
    const senderLine = senderUsername ? `@${senderUsername}` : `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim();
    const notes =
      `${sourceMarker}\n` +
      `Chat: ${chat.title || chatId}\n` +
      `Sender: ${senderLine || "(unknown)"}\n` +
      `Target: @${target}\n` +
      (messageLink ? `Message link: ${messageLink}\n` : "") +
      `\nMessage text:\n${text}`;

    const created = await createAsanaTask({
      projectGid,
      title,
      notes,
      assigneeGid,
    });
    openTasks.push(created);

    state.processed[processedKey] = {
      ts: Date.now(),
      status: "created",
      task_gid: String(created?.gid || ""),
    };

    await notifyDebug(
      `✅ task created\nchat=${chatId}\nmsg=${msg.message_id}\ntarget=@${target}\n` +
        `task=${created?.gid || "(unknown)"}\n` +
        `${created?.permalink_url || ""}`,
    );
  }

  await saveState();
}

async function processUpdate(update) {
  const msg = update?.message || update?.edited_message;
  if (!msg) return;
  try {
    await processMessage(msg);
  } catch (err) {
    const details = `❌ process error\nchat=${msg?.chat?.id || "?"}\nmsg=${msg?.message_id || "?"}\n${err?.message || String(err)}`;
    console.log(details);
    await notifyDebug(details);
  }
}

async function pollLoop() {
  while (true) {
    try {
      const updates = await tgApi("getUpdates", {
        timeout: TG_POLL_TIMEOUT_SEC,
        offset: nextUpdateOffset,
        allowed_updates: ["message", "edited_message"],
      });
      for (const upd of updates) {
        const id = Number(upd?.update_id || 0);
        if (id >= nextUpdateOffset) nextUpdateOffset = id + 1;
        await processUpdate(upd);
      }
    } catch (err) {
      console.log(`poll error: ${err?.message || String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, TG_RETRY_MS));
    }
  }
}

async function main() {
  ensureConfig();
  await loadState();
  const me = await tgApi("getMe");
  console.log(`inch_task_bot started as @${me?.username || BOT_USERNAME}`);
  await notifyDebug(`🤖 inch_task_bot started as @${me?.username || BOT_USERNAME}`);
  await pollLoop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
