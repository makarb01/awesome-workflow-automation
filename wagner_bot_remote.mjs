import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { promises as fs } from "fs";
import path from "path";

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const FELLOW_API_KEY = process.env.FELLOW_API_KEY || "";
const FELLOW_SUBDOMAIN = process.env.FELLOW_SUBDOMAIN || "wagner";
const FELLOW_MODE = (process.env.FELLOW_MODE || "stdio").toLowerCase();
const FELLOW_MCP_URL = process.env.FELLOW_MCP_URL || "https://fellow.app/mcp";
const MAX_REPLY_LEN = parseInt(process.env.MAX_REPLY_LEN || "3600", 10);
const DRY_RUN = process.env.DRY_RUN === "1";
const ALLOWED_CHAT_IDS = new Set(
  (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const ENABLE_LLM_SYNTHESIS = (process.env.ENABLE_LLM_SYNTHESIS || "1") === "1";
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || "14000", 10);
const CHAT_MEMORY_TTL_MS = parseInt(process.env.CHAT_MEMORY_TTL_MS || "21600000", 10);
const CHAT_MEMORY = new Map();
const ENABLE_MEMORY_BANK = (process.env.ENABLE_MEMORY_BANK || "1") === "1";
const MEMORY_BANK_DIR = process.env.MEMORY_BANK_DIR || "/root/fellow-telegram-bot/memory-bank";
const MEMORY_BANK_JSON = path.join(MEMORY_BANK_DIR, "meetings.json");
const MEMORY_BANK_MD = path.join(MEMORY_BANK_DIR, "meetings.md");
const MEMORY_BANK_MAX_ITEMS = parseInt(process.env.MEMORY_BANK_MAX_ITEMS || "120", 10);
const MEMORY_BANK_CONTEXT_ITEMS = parseInt(process.env.MEMORY_BANK_CONTEXT_ITEMS || "8", 10);
const ENABLE_FELLOW_NATIVE_AI = (process.env.ENABLE_FELLOW_NATIVE_AI || "1") === "1";
const ENABLE_CHAT_HISTORY = (process.env.ENABLE_CHAT_HISTORY || "1") === "1";
const CHAT_HISTORY_MAX_MESSAGES = parseInt(process.env.CHAT_HISTORY_MAX_MESSAGES || "300", 10);
const CHAT_HISTORY_CONTEXT_CHARS = parseInt(process.env.CHAT_HISTORY_CONTEXT_CHARS || "5000", 10);
const CHAT_HISTORY_MAX_TEXT = parseInt(process.env.CHAT_HISTORY_MAX_TEXT || "700", 10);
const CHAT_HISTORY_FILE = process.env.CHAT_HISTORY_FILE || path.join(MEMORY_BANK_DIR, "chat-history.json");
const CHAT_HISTORY_RELEVANT_LINES = parseInt(process.env.CHAT_HISTORY_RELEVANT_LINES || "40", 10);
const ENABLE_ASANA = (process.env.ENABLE_ASANA || "1") === "1";
const ASANA_API_BASE = process.env.ASANA_API_BASE || "https://app.asana.com/api/1.0";
const ASANA_ACCESS_TOKEN = process.env.ASANA_ACCESS_TOKEN || process.env.ASANA_TOKEN || "";
const ASANA_WORKSPACE_GID = process.env.ASANA_WORKSPACE_GID || "";
const ASANA_PROJECT_NAME = process.env.ASANA_PROJECT_NAME || "General Tasks";
const ASANA_TASK_LIST_LIMIT = parseInt(process.env.ASANA_TASK_LIST_LIMIT || "20", 10);

const MCP_TOOL_CACHE = {
  names: null,
  fetchedAt: 0,
};
const MCP_TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

let CHAT_HISTORY_LOADED = false;
const CHAT_HISTORY_BY_CHAT = new Map();
let ASANA_PROJECT_GID_CACHE = (process.env.ASANA_PROJECT_GID || "").trim();

const ACCOUNT_PROFILE_HINT_TERMS = [
  "meta",
  "facebook",
  "ad account",
  "ad accounts",
  "account",
  "accounts",
  "profile",
  "profiles",
  "business manager",
  "bm",
  "pixel",
  "page",
  "pages",
  "asset",
  "assets",
  "restricted",
  "disabled",
  "suspended",
  "ban",
];


function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function ensureConfig() {
  const missing = [];
  if (!FELLOW_API_KEY) missing.push("FELLOW_API_KEY");
  if (!DRY_RUN && !TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

function isAllowedChat(ctx) {
  if (!ALLOWED_CHAT_IDS.size) return true;
  return ALLOWED_CHAT_IDS.has(String(ctx.chat?.id || ""));
}

function trimOut(text) {
  if (!text) return "(empty response)";
  return text.length > MAX_REPLY_LEN
    ? `${text.slice(0, MAX_REPLY_LEN)}\n\n…[truncated]`
    : text;
}

function extractTextFromToolResult(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    const chunks = result.content
      .map((item) => {
        if (!item) return "";
        if (item.type === "text") return item.text || "";
        return JSON.stringify(item);
      })
      .filter(Boolean);
    return chunks.join("\n\n");
  }
  return JSON.stringify(result, null, 2);
}

async function withMcpClient(fn) {
  const client = new Client({ name: "wagner-fellow-bot", version: "1.0.0" });
  let transport;

  if (FELLOW_MODE === "http") {
    transport = new StreamableHTTPClientTransport(new URL(FELLOW_MCP_URL), {
      requestInit: {
        headers: {
          "x-api-key": FELLOW_API_KEY,
          Authorization: `Bearer ${FELLOW_API_KEY}`,
          Accept: "application/json, text/event-stream",
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        },
      },
    });
  } else {
    transport = new StdioClientTransport({
      command: "/root/fellow-telegram-bot/node_modules/.bin/fellow-mcp",
      args: ["--subdomain", FELLOW_SUBDOMAIN],
      env: {
        ...process.env,
        FELLOW_API_KEY,
        FELLOW_SUBDOMAIN,
      },
    });
  }

  try {
    await withTimeout(client.connect(transport), 15000, "MCP connect");
    return await withTimeout(fn(client), 45000, "MCP operation");
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close failures
    }
  }
}

async function callTool(name, args = {}) {
  return withMcpClient(async (client) => {
    return withTimeout(
      client.callTool({ name, arguments: args }),
      40000,
      `tool:${name}`,
    );
  });
}

async function listMcpToolNames() {
  const now = Date.now();
  if (MCP_TOOL_CACHE.names && now - MCP_TOOL_CACHE.fetchedAt < MCP_TOOL_CACHE_TTL_MS) {
    return MCP_TOOL_CACHE.names;
  }
  const names = await withMcpClient(async (client) => {
    const tools = await withTimeout(client.listTools(), 15000, "MCP listTools");
    return (tools?.tools || []).map((t) => String(t?.name || "")).filter(Boolean);
  });
  MCP_TOOL_CACHE.names = names;
  MCP_TOOL_CACHE.fetchedAt = now;
  return names;
}

function detectFellowAskToolName(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames : [];
  const preferred = [
    "ask_ai",
    "ask_fellow_ai",
    "ask",
    "chat_with_ai",
    "chat",
    "ask_question",
  ];
  for (const p of preferred) {
    if (names.includes(p)) return p;
  }
  const fuzzy = names.find((n) => /(ask|chat).*(ai)?/i.test(n));
  return fuzzy || "";
}

async function tryNativeFellowAi(question, options = {}) {
  if (!ENABLE_FELLOW_NATIVE_AI) return "";
  const toolNames = await listMcpToolNames();
  const askTool = detectFellowAskToolName(toolNames);
  if (!askTool) return "";

  const requestedCalls = Number.isInteger(options.requestedCalls) ? options.requestedCalls : null;
  const focusTerms = Array.isArray(options.focusTerms) ? options.focusTerms : [];
  const chatHistoryContext = String(options.chatHistoryContext || "").trim();
  const mode = String(options.mode || "concise");

  const scopeHint = [
    requestedCalls ? `Limit analysis to last ${requestedCalls} calls.` : "",
    focusTerms.length ? `Focus strictly on: ${focusTerms.join(", ")}.` : "",
    mode === "detailed_summary"
      ? "Provide a full detailed summary with sections: discussion points, decisions, action items, blockers, next steps."
      : "",
    mode === "coordinator"
      ? "Answer as an operational coordinator: include current tasks, open issues, blockers, actions."
      : "",
    chatHistoryContext ? `Use this recent chat history context when relevant:\n${chatHistoryContext}` : "",
  ].filter(Boolean).join(" ");
  const fullQuestion = scopeHint ? `${question}\n\nContext instructions: ${scopeHint}` : question;

  const candidates = [
    { question: fullQuestion },
    { query: fullQuestion },
    { prompt: fullQuestion },
    { input: fullQuestion },
    { text: fullQuestion },
  ];

  for (const args of candidates) {
    try {
      const res = await callTool(askTool, args);
      const txt = extractTextFromToolResult(res).trim();
      if (txt) return txt;
    } catch {
      // try next argument shape
    }
  }
  return "";
}

function isAsanaConfigured() {
  return ENABLE_ASANA && !!ASANA_ACCESS_TOKEN;
}

function asanaConfigHint() {
  if (!ENABLE_ASANA) {
    return "Asana integration is disabled (ENABLE_ASANA=0).";
  }
  if (!ASANA_ACCESS_TOKEN) {
    return "Missing ASANA_ACCESS_TOKEN in .env.";
  }
  if (!ASANA_PROJECT_GID_CACHE && !ASANA_WORKSPACE_GID) {
    return "Missing ASANA_PROJECT_GID (or ASANA_WORKSPACE_GID to resolve by project name).";
  }
  return "";
}

function asanaApiUrl(pathname, query = {}) {
  const base = ASANA_API_BASE.endsWith("/") ? ASANA_API_BASE.slice(0, -1) : ASANA_API_BASE;
  const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const url = new URL(`${base}${cleanPath}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url;
}

async function asanaRequest(method, pathname, { query = {}, body = null } = {}) {
  const hint = asanaConfigHint();
  if (hint) throw new Error(hint);
  const url = asanaApiUrl(pathname, query);
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${ASANA_ACCESS_TOKEN}`,
      Accept: "application/json",
    },
  };
  if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await withTimeout(fetch(url, init), 25000, `Asana ${method} ${pathname}`);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!res.ok) {
    const errMsg =
      (data?.errors || []).map((e) => e?.message).filter(Boolean).join("; ") ||
      `${res.status} ${res.statusText}`;
    throw new Error(`Asana API error: ${errMsg}`);
  }
  if (Array.isArray(data?.errors) && data.errors.length) {
    const errMsg = data.errors.map((e) => e?.message).filter(Boolean).join("; ");
    throw new Error(`Asana API error: ${errMsg}`);
  }
  return data;
}

async function resolveAsanaProjectGid() {
  if (ASANA_PROJECT_GID_CACHE) return ASANA_PROJECT_GID_CACHE;
  if (!ASANA_WORKSPACE_GID) {
    throw new Error("ASANA_PROJECT_GID is not set and ASANA_WORKSPACE_GID is unavailable.");
  }

  const data = await asanaRequest("GET", `/workspaces/${ASANA_WORKSPACE_GID}/projects`, {
    query: {
      limit: 100,
      archived: "false",
      opt_fields: "gid,name",
    },
  });

  const projects = Array.isArray(data?.data) ? data.data : [];
  const match = projects.find((p) => String(p?.name || "").trim().toLowerCase() === ASANA_PROJECT_NAME.toLowerCase());
  if (!match?.gid) {
    throw new Error(`Project '${ASANA_PROJECT_NAME}' not found in workspace ${ASANA_WORKSPACE_GID}.`);
  }
  ASANA_PROJECT_GID_CACHE = String(match.gid);
  return ASANA_PROJECT_GID_CACHE;
}

async function listAsanaTasks(status = "current", limit = ASANA_TASK_LIST_LIMIT) {
  const projectGid = await resolveAsanaProjectGid();
  const maxItems = Math.max(1, Math.min(100, parseInt(String(limit || ASANA_TASK_LIST_LIMIT), 10) || ASANA_TASK_LIST_LIMIT));
  const includeCompleted = status === "done" || status === "all";

  const tasks = [];
  let offset = "";
  let page = 0;
  while (tasks.length < maxItems && page < 6) {
    page += 1;
    const query = {
      project: projectGid,
      limit: 50,
      offset,
      completed_since: includeCompleted ? "1970-01-01T00:00:00.000Z" : "now",
      opt_fields: "gid,name,completed,completed_at,due_on,due_at,created_at,permalink_url,assignee.name,memberships.section.name",
    };
    const data = await asanaRequest("GET", "/tasks", { query });
    const chunk = Array.isArray(data?.data) ? data.data : [];
    tasks.push(...chunk);
    const nextOffset = data?.next_page?.offset;
    if (!nextOffset) break;
    offset = nextOffset;
  }

  let filtered = tasks;
  if (status === "current") {
    filtered = tasks.filter((t) => !t?.completed);
  } else if (status === "done") {
    filtered = tasks.filter((t) => !!t?.completed);
  }

  if (status === "done") {
    filtered.sort((a, b) => Date.parse(b?.completed_at || 0) - Date.parse(a?.completed_at || 0));
  } else {
    filtered.sort((a, b) => {
      const ad = Date.parse(a?.due_on || a?.due_at || "9999-12-31");
      const bd = Date.parse(b?.due_on || b?.due_at || "9999-12-31");
      if (ad !== bd) return ad - bd;
      return Date.parse(a?.created_at || 0) - Date.parse(b?.created_at || 0);
    });
  }
  return filtered.slice(0, maxItems);
}

function formatAsanaTaskLine(task, idx) {
  const title = task?.name || "(untitled)";
  const gid = task?.gid || "n/a";
  const due = task?.due_on || (task?.due_at ? String(task.due_at).slice(0, 10) : "");
  const assignee = task?.assignee?.name || "";
  const section = task?.memberships?.[0]?.section?.name || "";
  const suffix = [
    due ? `due ${due}` : "",
    assignee ? `@${assignee}` : "",
    section ? `#${section}` : "",
  ].filter(Boolean).join(" · ");
  return `${idx + 1}. ${title}${suffix ? ` — ${suffix}` : ""} (id: ${gid})`;
}

function formatAsanaTaskList(tasks, heading) {
  if (!tasks.length) return `${heading}\nNo tasks found.`;
  const lines = tasks.map((t, i) => formatAsanaTaskLine(t, i));
  return `${heading}\n${lines.join("\n")}`;
}

async function buildAsanaSnapshotContext(question, mode = "concise") {
  if (!ENABLE_ASANA) return "";
  const q = String(question || "").toLowerCase();
  const needed =
    mode === "coordinator" ||
    /\b(asana|task|tasks|board|open issues|blocker|action items|current tasks|done tasks)\b/.test(q);
  if (!needed) return "";

  if (!isAsanaConfigured()) {
    return `Asana snapshot: unavailable (${asanaConfigHint()})`;
  }

  try {
    const currentLimit = mode === "coordinator" ? 12 : 8;
    const doneLimit = mode === "coordinator" ? 8 : 5;
    const [current, done] = await Promise.all([
      listAsanaTasks("current", currentLimit),
      listAsanaTasks("done", doneLimit),
    ]);

    const currentLines = current.length
      ? current.map((t, i) => formatAsanaTaskLine(t, i)).join("\n")
      : "No current tasks.";
    const doneLines = done.length
      ? done.map((t, i) => formatAsanaTaskLine(t, i)).join("\n")
      : "No recently completed tasks.";

    return (
      `Asana board snapshot (${ASANA_PROJECT_NAME}):\n` +
      `Current tasks:\n${currentLines}\n\n` +
      `Recently done tasks:\n${doneLines}`
    );
  } catch (e) {
    return `Asana snapshot: unavailable (${e?.message || String(e)})`;
  }
}

async function createAsanaTask(rawText) {
  const projectGid = await resolveAsanaProjectGid();
  const text = String(rawText || "").trim();
  if (!text) throw new Error("Task title is empty.");

  const dueMatch = text.match(/\s+due:(\d{4}-\d{2}-\d{2})\s*$/i);
  const dueOn = dueMatch ? dueMatch[1] : "";
  const title = dueMatch ? text.replace(/\s+due:\d{4}-\d{2}-\d{2}\s*$/i, "").trim() : text;
  if (!title) throw new Error("Task title is empty.");

  const payload = {
    data: {
      name: title,
      projects: [projectGid],
      ...(dueOn ? { due_on: dueOn } : {}),
    },
  };
  const res = await asanaRequest("POST", "/tasks", { body: payload });
  return res?.data || null;
}

async function markAsanaTaskDone(taskGid) {
  const gid = String(taskGid || "").trim();
  if (!gid) throw new Error("Task id is empty.");
  const res = await asanaRequest("PUT", `/tasks/${gid}`, {
    body: { data: { completed: true } },
  });
  return res?.data || null;
}

function normalizeQuestionText(raw) {
  let q = (raw || "").trim();
  q = q.replace(/^@\w+\s*/i, "");
  q = q.replace(/^[,:;\-\.\s]+/, "");
  return q.trim();
}

function detectNoResults(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("no meetings found") ||
    t.includes("no results") ||
    t.includes("0 results")
  );
}

function clipText(text, maxChars = 2000) {
  if (!text) return "";
  const s = String(text);
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n...[truncated]` : s;
}

function stripTranscriptSection(text) {
  if (!text) return "";
  const s = String(text);
  const headingTrimmed = s.replace(/\n#{1,6}\s*Transcript[\s\S]*$/i, "");
  if (headingTrimmed !== s) return headingTrimmed.trim();

  const plainTranscriptMatch = /\nTranscript\s*[\r\n]+[\s\S]*$/i;
  if (plainTranscriptMatch.test(s)) {
    return s.replace(plainTranscriptMatch, "").trim();
  }
  return s.trim();
}

function summaryToHighlights(text, maxLines = 12) {
  const base = stripTranscriptSection(text);
  if (!base) return "";
  const lines = base
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^#{1,6}\s*/.test(l))
    .filter((l) => !/^(Note ID|Recording ID|Event Start|Fellow URL|Language):/i.test(l))
    .filter((l) => !/^\[\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\]/.test(l));
  return clipText(lines.slice(0, maxLines).join("\n"), 1300);
}

function getChatMemoryContext(chatId) {
  if (!chatId) return "";
  const key = String(chatId);
  const item = CHAT_MEMORY.get(key);
  if (!item) return "";
  if (Date.now() - item.ts > CHAT_MEMORY_TTL_MS) {
    CHAT_MEMORY.delete(key);
    return "";
  }
  return (
    `Previous user question: ${item.q}\n` +
    `Previous bot answer (short): ${clipText(item.a, 1200)}`
  );
}

function rememberChatTurn(chatId, question, answer) {
  if (!chatId) return;
  CHAT_MEMORY.set(String(chatId), {
    q: clipText(question, 400),
    a: clipText(answer, 1800),
    ts: Date.now(),
  });
}

async function ensureChatHistoryLoaded() {
  if (!ENABLE_CHAT_HISTORY || CHAT_HISTORY_LOADED) return;
  try {
    const raw = await fs.readFile(CHAT_HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [chatId, entries] of Object.entries(parsed)) {
        if (!Array.isArray(entries)) continue;
        CHAT_HISTORY_BY_CHAT.set(
          String(chatId),
          entries
            .filter((e) => e && typeof e === "object")
            .map((e) => ({
              role: e.role === "assistant" ? "assistant" : "user",
              text: clipText(String(e.text || ""), CHAT_HISTORY_MAX_TEXT),
              ts: Number(e.ts) || Date.now(),
            }))
            .slice(-CHAT_HISTORY_MAX_MESSAGES),
        );
      }
    }
  } catch {
    // no persisted history yet
  }
  CHAT_HISTORY_LOADED = true;
}

async function persistChatHistory() {
  if (!ENABLE_CHAT_HISTORY) return;
  await fs.mkdir(path.dirname(CHAT_HISTORY_FILE), { recursive: true });
  const obj = {};
  for (const [chatId, entries] of CHAT_HISTORY_BY_CHAT.entries()) {
    obj[chatId] = (entries || []).slice(-CHAT_HISTORY_MAX_MESSAGES);
  }
  await fs.writeFile(CHAT_HISTORY_FILE, JSON.stringify(obj, null, 2), "utf8");
}

async function appendChatHistory(chatId, role, text) {
  if (!ENABLE_CHAT_HISTORY || !chatId || !text) return;
  await ensureChatHistoryLoaded();
  const key = String(chatId);
  const arr = CHAT_HISTORY_BY_CHAT.get(key) || [];
  arr.push({
    role: role === "assistant" ? "assistant" : "user",
    text: clipText(String(text), CHAT_HISTORY_MAX_TEXT),
    ts: Date.now(),
  });
  CHAT_HISTORY_BY_CHAT.set(key, arr.slice(-CHAT_HISTORY_MAX_MESSAGES));
  try {
    await persistChatHistory();
  } catch (e) {
    console.log(`chat history persist failed: ${e?.message || String(e)}`);
  }
}

function formatHistoryLine(entry) {
  const d = new Date(entry.ts || Date.now()).toISOString();
  const role = entry.role === "assistant" ? "assistant" : "user";
  return `[${d}] ${role}: ${entry.text || ""}`;
}

function buildChatHistoryContextFromEntries(entries, question) {
  const all = Array.isArray(entries) ? entries : [];
  if (!all.length) return "";
  const focusTerms = buildFocusTerms(question);
  const scored = all.map((e, idx) => ({
    e,
    idx,
    score: lineMatchScore(String(e?.text || ""), focusTerms),
  }));
  const relevant = scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.idx - a.idx)
    .slice(0, CHAT_HISTORY_RELEVANT_LINES)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => formatHistoryLine(x.e));

  const latest = all.slice(-Math.min(20, all.length)).map((e) => formatHistoryLine(e));
  const merged = [];
  const seen = new Set();
  for (const line of [...relevant, ...latest]) {
    if (seen.has(line)) continue;
    seen.add(line);
    merged.push(line);
  }
  return clipText(merged.join("\n"), CHAT_HISTORY_CONTEXT_CHARS);
}

async function getChatHistoryContext(chatId, question) {
  if (!ENABLE_CHAT_HISTORY || !chatId) return "";
  await ensureChatHistoryLoaded();
  const entries = CHAT_HISTORY_BY_CHAT.get(String(chatId)) || [];
  return buildChatHistoryContextFromEntries(entries, question);
}

function parseMeetingTime(meeting) {
  const raw =
    meeting?.event_start_local ||
    meeting?.event_start ||
    meeting?.when ||
    meeting?.updated_at ||
    "";
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

function sortMeetingsByDateDesc(meetings) {
  return [...(Array.isArray(meetings) ? meetings : [])].sort(
    (a, b) => parseMeetingTime(b) - parseMeetingTime(a),
  );
}

function parseRequestedCallCount(question) {
  const q = String(question || "");
  const patterns = [
    /\blast\s+(\d{1,2})\s+(?:calls?|meetings?)\b/i,
    /\bpast\s+(\d{1,2})\s+(?:calls?|meetings?)\b/i,
    /\bпоследн(?:их|ие)\s+(\d{1,2})\s+(?:звонк\w*|встреч\w*)\b/i,
  ];

  for (const re of patterns) {
    const m = q.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n)) continue;
    return Math.max(1, Math.min(20, n));
  }
  return null;
}

function asksForRecentCalls(question) {
  const q = String(question || "").toLowerCase();
  return (
    /\b(last|latest|recent|past)\s+(calls?|meetings?)\b/.test(q) ||
    /\b(последние|последних|недавние)\s+(звонк\w*|встреч\w*)\b/.test(q)
  );
}

function splitIntoEvidenceLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length >= 8)
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^(Note ID|Recording ID|Event Start|Fellow URL|Language):/i.test(line))
    .filter((line) => !/^\[\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\]/.test(line))
    .filter((line) => !/^\((The things to talk about|What came out of this meeting)/i.test(line));
}

function buildFocusTerms(question) {
  const q = String(question || "").toLowerCase();
  const terms = new Set(tokenizeQueryTerms(q));
  const accountRelated = ACCOUNT_PROFILE_HINT_TERMS.some((t) => q.includes(t));
  if (accountRelated) {
    for (const t of ACCOUNT_PROFILE_HINT_TERMS) terms.add(t);
  }
  if (q.includes("meta ad")) {
    terms.add("meta");
    terms.add("ad account");
  }
  return [...terms];
}

function lineMatchScore(line, focusTerms) {
  const text = String(line || "").toLowerCase();
  if (!text) return 0;
  let score = 0;
  let termHits = 0;
  for (const t of focusTerms || []) {
    if (!t) continue;
    if (text.includes(t)) {
      score += t.includes(" ") ? 3 : 2;
      termHits += 1;
    }
  }
  if (/\b(account|profile|meta|business manager|bm|pixel|page|ad account)\b/i.test(text)) {
    score += 2;
    termHits += 1;
  }
  if (
    termHits > 0 &&
    /\b(issue|problem|blocked|cannot|can't|failed|error|rejected|restricted|disabled|suspended)\b/i.test(text)
  ) {
    score += 2;
  }
  if ((focusTerms || []).length > 0 && termHits === 0) {
    return 0;
  }
  return score;
}

function pickFocusedLines(text, focusTerms, maxLines = 6) {
  const lines = splitIntoEvidenceLines(text);
  if (!lines.length) return [];
  if (!focusTerms?.length) return lines.slice(0, maxLines);

  const scored = lines.map((line, idx) => ({ line, idx, score: lineMatchScore(line, focusTerms) }));
  const positive = scored.filter((x) => x.score > 0);
  if (!positive.length) return [];

  positive.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const uniq = [];
  const seen = new Set();
  for (const item of positive) {
    const key = item.line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(item.line);
    if (uniq.length >= maxLines) break;
  }
  return uniq;
}

function pickTranscriptMatches(transcript, focusTerms, maxLines = 4) {
  if (!transcript || !focusTerms?.length) return [];
  const lines = String(transcript)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length >= 8);

  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const score = lineMatchScore(line, focusTerms);
    if (score <= 0) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}

function meetingSnapshotToMd(item) {
  const when = item.when || "N/A";
  const issues = Array.isArray(item.issues) && item.issues.length
    ? item.issues.map((x) => `- ${x}`).join("\n")
    : "- (no focused issues captured yet)";
  return (
    `## ${item.title || "(untitled)"}\n` +
    `- id: ${item.id || "n/a"}\n` +
    `- when: ${when}\n` +
    `- updated: ${item.updated_at || "n/a"}\n\n` +
    `### Focused issues\n${issues}\n\n`
  );
}

async function loadMemoryBank() {
  if (!ENABLE_MEMORY_BANK) return [];
  try {
    const raw = await fs.readFile(MEMORY_BANK_JSON, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveMemoryBank(items) {
  if (!ENABLE_MEMORY_BANK) return;
  await fs.mkdir(MEMORY_BANK_DIR, { recursive: true });
  const normalized = sortMeetingsByDateDesc(items).slice(0, MEMORY_BANK_MAX_ITEMS);
  await fs.writeFile(MEMORY_BANK_JSON, JSON.stringify(normalized, null, 2), "utf8");

  const md =
    "# Fellow meeting memory bank\n\n" +
    `Generated: ${new Date().toISOString()}\n\n` +
    normalized.map((x) => meetingSnapshotToMd(x)).join("\n");
  await fs.writeFile(MEMORY_BANK_MD, md, "utf8");
}

async function upsertMemoryBankItems(newItems) {
  if (!ENABLE_MEMORY_BANK) return;
  const incoming = (newItems || []).filter(Boolean);
  if (!incoming.length) return;

  const existing = await loadMemoryBank();
  const byId = new Map();
  for (const item of existing) {
    if (item?.id) byId.set(String(item.id), item);
  }
  for (const item of incoming) {
    if (!item?.id) continue;
    byId.set(String(item.id), item);
  }
  await saveMemoryBank([...byId.values()]);
}

async function buildMemoryBankContext(question, focusTerms, desiredItems = MEMORY_BANK_CONTEXT_ITEMS) {
  const items = await loadMemoryBank();
  if (!items.length) return "";

  const count = Math.max(1, Math.min(MEMORY_BANK_CONTEXT_ITEMS, desiredItems || MEMORY_BANK_CONTEXT_ITEMS));
  const scored = items.map((item, idx) => {
    const hay = [
      item?.title || "",
      ...(Array.isArray(item?.issues) ? item.issues : []),
    ].join(" ").toLowerCase();
    let score = 0;
    for (const t of focusTerms || []) {
      if (!t) continue;
      if (hay.includes(t.toLowerCase())) score += t.includes(" ") ? 3 : 2;
    }
    if (!score && lineMatchScore(hay, focusTerms || [])) score += 1;
    return { item, idx, score };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const selected = scored
    .filter((x) => x.score > 0)
    .slice(0, count)
    .map((x) => x.item);

  const fallback = selected.length ? selected : sortMeetingsByDateDesc(items).slice(0, count);
  if (!fallback.length) return "";

  const lines = fallback.map((item, i) => {
    const when = item.when || "N/A";
    const issues = (item.issues || []).slice(0, 2).join(" | ");
    return `${i + 1}. ${item.title || "(untitled)"} — ${when}${issues ? ` — ${issues}` : ""}`;
  });
  return `Memory bank matches:\n${lines.join("\n")}`;
}


function formatIsoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseJsonObject(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function looksLikeWeeklyTrendsQuestion(q) {
  const t = (q || "").toLowerCase();
  return (
    t.includes("trend") ||
    t.includes("theme") ||
    t.includes("last week") ||
    t.includes("this week") ||
    t.includes("past week") ||
    t.includes("weekly") ||
    t.includes("за неделю") ||
    t.includes("тренд") ||
    t.includes("тем")
  );
}

function topKeywords(text, limit = 8) {
  const stop = new Set([
    "the","and","for","with","that","this","from","into","about","your","have","been","were","what",
    "when","where","which","who","will","would","could","should","there","their","them","they","our",
    "you","are","was","is","to","of","in","on","at","as","it","or","an","a","by","we","be",
    "meeting","meetings","call","weekly","notes","note","action","items","item"
  ]);
  const words = (text || "").toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
  const freq = new Map();
  for (const w of words) {
    if (stop.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w, n]) => ({ word: w, count: n }));
}

async function summarizeRecentThemes(days = 7) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const startDate = formatIsoDateOnly(start);

  const meetingsRes = await callTool("search_meetings", {
    created_at_start: startDate,
    limit: 30,
  });
  const meetingsText = extractTextFromToolResult(meetingsRes);
  const meetingsJson = parseJsonObject(meetingsText);
  const meetings = Array.isArray(meetingsJson?.meetings) ? meetingsJson.meetings : [];

  if (!meetings.length) {
    return `I couldn't find meetings for the last ${days} days. Run /sync and try again.`;
  }

  const summaries = [];
  for (const m of meetings.slice(0, 8)) {
    if (!m.note_id) continue;
    try {
      const s = await callTool("get_meeting_summary", { note_id: m.note_id });
      const txt = extractTextFromToolResult(s);
      if (txt) summaries.push(txt);
    } catch {
      // ignore one-off summary failures
    }
  }

  let actionItemsText = "";
  try {
    const ai = await callTool("get_all_action_items", {
      since: startDate,
      show_completed: false,
    });
    actionItemsText = extractTextFromToolResult(ai);
  } catch {
    actionItemsText = "";
  }

  const corpus = [
    meetings.map((m) => m.title || "").join(" "),
    summaries.join(" "),
    actionItemsText,
  ].join(" ");

  const kws = topKeywords(corpus, 8);
  const themes = kws.length
    ? kws.map((k, i) => `${i + 1}. ${k.word} (${k.count})`).join("\n")
    : "No clear repeated keywords yet.";

  const meetingLines = meetings
    .slice(0, 8)
    .map((m, i) => {
      const when = m.event_start_local || m.event_start || "N/A";
      return `${i + 1}. ${m.title || "(untitled)"} — ${when}`;
    })
    .join("\n");

  const aiPreview = actionItemsText
    ? actionItemsText.slice(0, 900)
    : "No open action-items summary returned.";

  return trimOut(
    `📈 Weekly themes (${days}d)\n` +
      `Meetings analyzed: ${meetings.length}\n\n` +
      `Top themes:\n${themes}\n\n` +
      `Recent meetings:\n${meetingLines}\n\n` +
      `Open action-items snapshot:\n${aiPreview}`,
  );
}

function tokenizeQueryTerms(q) {
  const stop = new Set([
    "what", "changed", "change", "current", "status", "update", "latest", "last", "calls", "call",
    "with", "about", "from", "this", "week", "meeting", "meetings", "show", "give", "please", "tell",
    "the", "and", "for", "are", "was", "were", "how", "where", "when", "why", "who",
    "main", "related", "issue", "issues"
  ]);
  return (q || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !stop.has(w));
}

function buildKeywordQuery(q) {
  const terms = tokenizeQueryTerms(q);
  if (!terms.length) return "";
  return terms.slice(0, 5).join(" ");
}

function rankMeetingsByQuery(meetings, q) {
  const terms = tokenizeQueryTerms(q);
  if (!Array.isArray(meetings) || !meetings.length) return [];
  if (!terms.length) return meetings;

  const scored = meetings.map((m, idx) => {
    const title = String(m?.title || "").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
    }
    return { m, idx, score };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  if (scored[0]?.score <= 0) return [];
  return scored.map((x) => x.m);
}

function looksLikeTranscriptRequest(q) {
  const t = (q || "").toLowerCase();
  return (
    t.includes("transcript") ||
    t.includes("meeting transcript") ||
    t.includes("give transcript") ||
    t.includes("last meeting")
  );
}

function looksLikeStatusQuestion(q) {
  const t = (q || "").toLowerCase();
  return (
    t.includes("what changed") ||
    t.includes("current situation") ||
    t.includes("current sitation") ||
    t.includes("status") ||
    t.includes("latest") ||
    t.includes("update")
  );
}

function looksLikeSummaryQuestion(q) {
  const t = (q || "").toLowerCase();
  return (
    t.includes("summarize") ||
    t.includes("summary") ||
    t.includes("recap") ||
    t.includes("minutes") ||
    t.includes("meeting notes") ||
    t.includes("what happened")
  );
}

function looksLikeDetailedSummaryRequest(q) {
  const t = (q || "").toLowerCase();
  return (
    looksLikeSummaryQuestion(t) ||
    t.includes("full") ||
    t.includes("detailed") ||
    t.includes("complete") ||
    t.includes("everything") ||
    t.includes("all details")
  );
}

function looksLikeOperationalCoordinatorQuestion(q) {
  const t = (q || "").toLowerCase();
  return (
    t.includes("open issues") ||
    t.includes("issues") ||
    t.includes("blocker") ||
    t.includes("action items") ||
    t.includes("actions") ||
    t.includes("current tasks") ||
    t.includes("done tasks") ||
    t.includes("asana") ||
    t.includes("board") ||
    t.includes("operational coordinator") ||
    t.includes("ops")
  );
}

function mentionsToday(q) {
  const t = (q || "").toLowerCase();
  return t.includes("today") || t.includes("сегодня");
}

function isTodayMeeting(meeting) {
  const ts = parseMeetingTime(meeting);
  if (!ts) return false;
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

function formatMeetingsList(meetings, limit = 5) {
  return meetings.slice(0, limit).map((m, i) => {
    const when = m?.event_start_local || m?.event_start || "N/A";
    return `${i + 1}. ${m?.title || "(untitled)"} — ${when}`;
  }).join("\n");
}

async function tryGetMeetingSummary(meeting) {
  if (!meeting) return "";
  try {
    if (meeting.note_id) {
      const r = await callTool("get_meeting_summary", { note_id: meeting.note_id });
      return extractTextFromToolResult(r);
    }
    if (meeting.id) {
      const r = await callTool("get_meeting_summary", { recording_id: meeting.id });
      return extractTextFromToolResult(r);
    }
  } catch {}
  return "";
}

async function tryGetActionItems(meeting) {
  if (!meeting) return "";
  try {
    if (meeting.note_id) {
      const r = await callTool("get_action_items", { note_id: meeting.note_id });
      return extractTextFromToolResult(r);
    }
    if (meeting.title) {
      const r = await callTool("get_action_items", { meeting_title: meeting.title });
      return extractTextFromToolResult(r);
    }
  } catch {}
  return "";
}

async function buildMeetingEvidence(meeting, options = {}) {
  if (!meeting) return { text: "", snapshot: null, matchCount: 0 };
  const includeTranscript = !!options.includeTranscript;
  const focusTerms = Array.isArray(options.focusTerms) ? options.focusTerms : [];
  const detailedMode = !!options.detailedMode;
  const title = meeting?.title || "(untitled)";
  const when = meeting?.event_start_local || meeting?.event_start || "N/A";
  const stableId = String(meeting?.id || meeting?.note_id || `${title}|${when}`);

  const [summary, actions] = await Promise.all([
    tryGetMeetingSummary(meeting),
    tryGetActionItems(meeting),
  ]);

  let transcript = "";
  if (includeTranscript && meeting?.id) {
    try {
      const tr = await callTool("get_meeting_transcript", { recording_id: meeting.id });
      transcript = extractTextFromToolResult(tr);
    } catch {
      transcript = "";
    }
  }

  const summaryForLlm = summaryToHighlights(summary, detailedMode ? 28 : 12);
  const summaryFocused = pickFocusedLines(summaryForLlm, focusTerms, 5);
  const actionsFocused = pickFocusedLines(actions, focusTerms, 5);
  const transcriptFocused = pickTranscriptMatches(transcript, focusTerms, 3);
  const mergedIssues = [...summaryFocused, ...actionsFocused, ...transcriptFocused];

  const parts = [`Meeting: ${title} — ${when}`];
  if (focusTerms.length) {
    if (summaryFocused.length) {
      parts.push(`Focused summary points:\n${summaryFocused.map((x) => `- ${x}`).join("\n")}`);
    }
    if (actionsFocused.length) {
      parts.push(`Focused action-item points:\n${actionsFocused.map((x) => `- ${x}`).join("\n")}`);
    }
    if (transcriptFocused.length) {
      parts.push(`Focused transcript points:\n${transcriptFocused.map((x) => `- ${x}`).join("\n")}`);
    }
    if (!summaryFocused.length && !actionsFocused.length && !transcriptFocused.length) {
      parts.push("No explicit focus-term mentions found in this meeting evidence.");
      if (summaryForLlm) {
        const fallback = pickFocusedLines(summaryForLlm, [], 2);
        if (fallback.length) {
          parts.push(`Closest context:\n${fallback.map((x) => `- ${x}`).join("\n")}`);
        }
      }
    }
  } else {
    if (summaryForLlm) parts.push(`Summary:\n${clipText(summaryForLlm, detailedMode ? 3600 : 2200)}`);
    if (actions) parts.push(`Action items:\n${clipText(actions, detailedMode ? 2600 : 1800)}`);
    if (transcript) parts.push(`Transcript excerpt:\n${clipText(transcript, detailedMode ? 3200 : 2500)}`);
  }

  return {
    text: parts.join("\n\n"),
    snapshot: {
      id: stableId,
      title,
      when,
      issues: mergedIssues.slice(0, 8),
      updated_at: new Date().toISOString(),
    },
    matchCount: mergedIssues.length,
  };
}

async function synthesizeAnswerWithGemini(
  question,
  contextBlocks,
  chatMemoryContext = "",
  chatHistoryContext = "",
  options = {},
) {
  if (!ENABLE_LLM_SYNTHESIS || !GEMINI_API_KEY) return "";
  const focusTerms = Array.isArray(options.focusTerms) ? options.focusTerms : [];
  const requestedCalls = Number.isInteger(options.requestedCalls) ? options.requestedCalls : null;
  const mode = String(options.mode || "concise");
  const contextCap = mode === "concise" ? MAX_CONTEXT_CHARS : Math.max(MAX_CONTEXT_CHARS, 22000);
  const context = clipText(
    (contextBlocks || []).filter(Boolean).join("\n\n--------------------\n\n"),
    contextCap,
  );
  if (!context) return "";

  const modeInstruction =
    mode === "detailed_summary"
      ? (
          "You are an operational meeting coordinator. " +
          "Provide a full, detailed summary. " +
          "Format with sections: Scope, Key discussion points, Decisions, Action items, Open issues/blockers, Next steps. " +
          "Do not omit meaningful details if they are present in context.\n"
        )
      : mode === "coordinator"
        ? (
            "You are an operational coordinator. " +
            "Combine meeting notes, chat history and Asana snapshot into one execution-focused report. " +
            "Format with sections: Current tasks, Open issues, Blockers, Action items, Risks/dependencies, Recommended next actions.\n"
          )
        : (
            "Provide a concise analytical answer focused on the question.\n"
          );

  const prompt =
    "You are an expert meeting analyst for business calls.\n" +
    "Answer ONLY in English.\n" +
    "Use ONLY the provided context from Fellow data.\n" +
    "Paraphrase information; do NOT quote source text verbatim.\n" +
    "Do not output long copied passages from notes or transcripts.\n" +
    "If the user asks what changed, compare recent calls and list concrete changes.\n" +
    (requestedCalls
      ? `Treat scope as exactly the latest ${requestedCalls} calls if available.\n`
      : "") +
    (focusTerms.length
      ? `Focus terms (strict): ${focusTerms.join(", ")}.\nIf evidence does not mention these terms, explicitly say so.\n`
      : "") +
    "Always anchor statements with meeting title/date when possible.\n" +
    "If data is insufficient, explicitly say what is missing.\n" +
    modeInstruction +
    (
      mode === "concise"
        ? "Output format: 3-5 short bullets (each <= 22 words), then one short conclusion sentence.\nPrefer concrete issues over generic themes.\n\n"
        : "Be specific and concrete. Include owners and due dates if present. Add a short final executive takeaway.\n\n"
    ) +
    `User question:\n${question}\n\n` +
    (chatMemoryContext ? `Recent chat memory:\n${chatMemoryContext}\n\n` : "") +
    (chatHistoryContext ? `Recent chat history (last messages):\n${chatHistoryContext}\n\n` : "") +
    `Context:\n${context}`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: mode === "concise" ? 700 : 1300,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  };

  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    30000,
    "Gemini request",
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${clipText(body, 400)}`);
  }

  const data = await res.json();
  const firstCandidate = (data?.candidates || [])[0] || {};
  const answer = (data?.candidates || [])
    .flatMap((c) => c?.content?.parts || [])
    .map((p) => p?.text || "")
    .join("\n")
    .trim();

  const finishReason = String(firstCandidate?.finishReason || "").toUpperCase();
  const looksIncomplete = /[,:;\-\(\[]$/.test(answer) || !/[.!?]$/.test(answer);
  const needsRepair = finishReason === "MAX_TOKENS" || finishReason === "RECITATION" || looksIncomplete;
  if (!answer || !needsRepair) return answer || "";

  const repairPrompt =
    "Rewrite the draft into a complete answer in English.\n" +
    (
      mode === "concise"
        ? "Rules: 3-5 short bullets + 1 short conclusion sentence.\n"
        : "Rules: keep full detail and preserve structure. Use clear sections and complete sentences.\n"
    ) +
    "Do not quote notes verbatim. Do not add new facts.\n\n" +
    `User question:\n${question}\n\n` +
    `Draft answer:\n${answer}`;

  const repairPayload = {
    contents: [{ role: "user", parts: [{ text: repairPrompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: mode === "concise" ? 320 : 700,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  };

  const repairRes = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(repairPayload),
    }),
    18000,
    "Gemini repair request",
  );
  if (!repairRes.ok) return answer;

  const repairData = await repairRes.json();
  const repaired = (repairData?.candidates || [])
    .flatMap((c) => c?.content?.parts || [])
    .map((p) => p?.text || "")
    .join("\n")
    .trim();

  return repaired || answer;
}

async function answerQuestion(question, chatId = "") {
  const safeQuestion = question.trim();
  if (!safeQuestion) {
    return "Empty query. Ask a question about Fellow meetings.";
  }

  const detailedSummaryRequested = looksLikeDetailedSummaryRequest(safeQuestion);
  const coordinatorRequested = looksLikeOperationalCoordinatorQuestion(safeQuestion);
  const todayRequested = mentionsToday(safeQuestion);
  const responseMode = coordinatorRequested
    ? "coordinator"
    : (detailedSummaryRequested ? "detailed_summary" : "concise");
  const requestedCalls = parseRequestedCallCount(safeQuestion) || (asksForRecentCalls(safeQuestion) ? 5 : null);
  const focusTerms = buildFocusTerms(safeQuestion);
  const transcriptRequested = looksLikeTranscriptRequest(safeQuestion);
  const wantsQuotedEvidence = /\b(quote|quoted|verbatim|exact|where was|who said)\b/i.test(safeQuestion);
  const meetingFetchLimit = Math.max(40, (requestedCalls || 6) + 20);
  const chatHistoryContext = await getChatHistoryContext(chatId, safeQuestion);

  try {
    const nativeAnswer = await tryNativeFellowAi(safeQuestion, {
      requestedCalls,
      focusTerms,
      chatHistoryContext,
      mode: responseMode,
    });
    if (nativeAnswer) return trimOut(nativeAnswer);
  } catch (e) {
    console.log(`Native Fellow AI path failed: ${e?.message || String(e)}`);
  }

  const meetingsRes = await callTool("search_meetings", { limit: meetingFetchLimit });
  const meetingsText = extractTextFromToolResult(meetingsRes);
  const meetingsJson = parseJsonObject(meetingsText);
  const allMeetings = sortMeetingsByDateDesc(
    Array.isArray(meetingsJson?.meetings) ? meetingsJson.meetings : [],
  );
  const rankedMeetings = rankMeetingsByQuery(allMeetings, safeQuestion);

  let selectedMeetings = [];
  if (requestedCalls) {
    const base = rankedMeetings.length ? sortMeetingsByDateDesc(rankedMeetings) : allMeetings;
    selectedMeetings = base.slice(0, requestedCalls);
  } else if (detailedSummaryRequested) {
    const rankedBase = rankedMeetings.length ? sortMeetingsByDateDesc(rankedMeetings) : allMeetings;
    const todaySubset = todayRequested ? rankedBase.filter((m) => isTodayMeeting(m)) : [];
    const source = todaySubset.length ? todaySubset : rankedBase;
    selectedMeetings = source.slice(0, todayRequested ? 1 : 2);
  } else if (coordinatorRequested) {
    const base = rankedMeetings.length ? sortMeetingsByDateDesc(rankedMeetings) : allMeetings;
    selectedMeetings = base.slice(0, 6);
  } else if (focusTerms.length) {
    const base = rankedMeetings.length ? rankedMeetings : allMeetings;
    selectedMeetings = sortMeetingsByDateDesc(base).slice(0, 5);
  } else {
    selectedMeetings = (rankedMeetings.length ? rankedMeetings : allMeetings).slice(0, 3);
  }

  const cachedPrimary = await callTool("search_cached_notes", { query: safeQuestion });
  let cachedText = extractTextFromToolResult(cachedPrimary);

  if (detectNoResults(cachedText)) {
    const keywordQuery = buildKeywordQuery(safeQuestion);
    if (keywordQuery && keywordQuery !== safeQuestion.toLowerCase()) {
      const cachedFallback = await callTool("search_cached_notes", { query: keywordQuery });
      const fallbackText = extractTextFromToolResult(cachedFallback);
      if (!detectNoResults(fallbackText) && fallbackText) {
        cachedText = fallbackText;
      }
    }
  }

  if (transcriptRequested) {
    const target = selectedMeetings[0] || rankedMeetings[0] || allMeetings[0];
    if (!target) {
      return "No meetings found to pull transcript from. Run /sync and try again.";
    }
    try {
      const tr = await callTool("get_meeting_transcript", { recording_id: target.id });
      const trText = extractTextFromToolResult(tr);
      return trimOut(
        `📝 Transcript for: ${target.title || "latest meeting"}\n\n` + trText,
      );
    } catch (e) {
      return `Could not fetch transcript for the latest relevant meeting: ${e?.message || String(e)}`;
    }
  }

  const contextBlocks = [];
  if (looksLikeWeeklyTrendsQuestion(safeQuestion)) {
    const weekly = await summarizeRecentThemes(7);
    contextBlocks.push(`Weekly trends snapshot:\n${weekly}`);
  }
  if (selectedMeetings.length) {
    const label = requestedCalls
      ? `Latest ${requestedCalls} calls in scope`
      : "Relevant meetings";
    contextBlocks.push(`${label}:\n${formatMeetingsList(selectedMeetings, Math.max(3, selectedMeetings.length))}`);
  }
  if (!detectNoResults(cachedText) && cachedText) {
    contextBlocks.push(`Related cached notes:\n${clipText(cachedText, 3500)}`);
  }
  if (chatHistoryContext) {
    contextBlocks.push(`Recent chat history context:\n${clipText(chatHistoryContext, 2200)}`);
  }
  const asanaSnapshot = await buildAsanaSnapshotContext(safeQuestion, responseMode);
  if (asanaSnapshot) {
    contextBlocks.push(asanaSnapshot);
  }

  try {
    const bankCtx = await buildMemoryBankContext(
      safeQuestion,
      focusTerms,
      requestedCalls || MEMORY_BANK_CONTEXT_ITEMS,
    );
    if (bankCtx) contextBlocks.push(bankCtx);
  } catch (e) {
    console.log(`Memory bank read failed: ${e?.message || String(e)}`);
  }

  const shouldPullTranscriptEvidence =
    (
      (focusTerms.length > 0 &&
        /(account|profile|meta|business manager|bm|ad account|pixel|page)/i.test(safeQuestion) &&
        wantsQuotedEvidence) ||
      detailedSummaryRequested
    );
  const transcriptEvidenceLimit = shouldPullTranscriptEvidence
    ? Math.max(1, Math.min(detailedSummaryRequested ? 2 : 2, selectedMeetings.length))
    : 0;

  const freshSnapshots = [];
  let focusedHits = 0;
  for (let i = 0; i < selectedMeetings.length; i += 1) {
    const m = selectedMeetings[i];
    const evidence = await buildMeetingEvidence(m, {
      includeTranscript: i < transcriptEvidenceLimit,
      focusTerms,
      detailedMode: detailedSummaryRequested || coordinatorRequested,
    });
    if (evidence?.text) contextBlocks.push(evidence.text);
    if (evidence?.snapshot) freshSnapshots.push(evidence.snapshot);
    focusedHits += evidence?.matchCount || 0;
  }

  try {
    await upsertMemoryBankItems(freshSnapshots);
  } catch (e) {
    console.log(`Memory bank write failed: ${e?.message || String(e)}`);
  }

  if (focusTerms.length && selectedMeetings.length && focusedHits === 0) {
    contextBlocks.push(
      `Focus-note: No direct mentions found for focus terms (${focusTerms.join(", ")}) in selected meeting evidence.`,
    );
  }

  const memoryContext = getChatMemoryContext(chatId);
  if (contextBlocks.length) {
    try {
      const synthesized = await synthesizeAnswerWithGemini(
        safeQuestion,
        contextBlocks,
        memoryContext,
        chatHistoryContext,
        { focusTerms, requestedCalls, mode: responseMode },
      );
      if (synthesized) return trimOut(synthesized);
    } catch (e) {
      console.log(`Gemini synthesis failed: ${e?.message || String(e)}`);
    }
  }

  const blocks = [];
  if (!detectNoResults(cachedText) && cachedText) {
    blocks.push(`📚 Related notes:
${cachedText}`);
  }
  if (asanaSnapshot) {
    blocks.push(`🗂 Asana:\n${clipText(asanaSnapshot, 1800)}`);
  }

  if (rankedMeetings.length) {
    blocks.push(`🗓 Relevant meetings:
${formatMeetingsList(rankedMeetings, 8)}`);
  } else if (allMeetings.length) {
    blocks.push(`🗓 Recent meetings:
${formatMeetingsList(allMeetings, 5)}`);
  }

  if (focusTerms.length) {
    blocks.push(
      `Focus terms used: ${focusTerms.slice(0, 12).join(", ") || "(none)"}.\n` +
      "Tip: try `/ask list exact account/profile issues in last 5 calls with meeting/date`.",
    );
  }

  if (!blocks.length) {
    return "I couldn't find a direct match. Try `/ask weekly trends`, `/ask what changed this week`, or `/transcript <meeting title>`.";
  }

  return trimOut(blocks.join("\n\n--------------------\n\n"));
}

async function handleIncomingText(ctx, text) {
  if (!isAllowedChat(ctx)) {
    await ctx.reply("Access is not allowed in this chat.");
    return;
  }

  const q = normalizeQuestionText(text || "");
  if (!q) {
    await ctx.reply("Ask a question about Fellow transcripts/meetings.");
    return;
  }

  await ctx.telegram.sendChatAction(ctx.chat.id, "typing");

  try {
    const chatId = String(ctx.chat?.id || "");
    const result = await withTimeout(answerQuestion(q, chatId), 85000, "answer generation");
    rememberChatTurn(chatId, q, result);
    const out = trimOut(result);
    await ctx.reply(out, { disable_web_page_preview: true });
    await appendChatHistory(chatId, "assistant", out);
  } catch (err) {
    const msg = err?.message || String(err);
    const out = trimOut(
      `Error while querying Fellow MCP: ${msg}\n\n` +
        "Check FELLOW_API_KEY and FELLOW_SUBDOMAIN (stdio mode), or auth for FELLOW_MCP_URL (http mode).",
    );
    await ctx.reply(out);
    const chatId = String(ctx.chat?.id || "");
    await appendChatHistory(chatId, "assistant", out);
  }
}

async function refreshMemoryBankFromRecentMeetings(limit = 20) {
  if (!ENABLE_MEMORY_BANK) {
    return "Memory bank is disabled by config.";
  }
  const safeLimit = Math.max(5, Math.min(60, parseInt(String(limit || 20), 10) || 20));
  const meetingsRes = await callTool("search_meetings", { limit: safeLimit });
  const meetingsText = extractTextFromToolResult(meetingsRes);
  const meetingsJson = parseJsonObject(meetingsText);
  const meetings = sortMeetingsByDateDesc(
    Array.isArray(meetingsJson?.meetings) ? meetingsJson.meetings : [],
  ).slice(0, safeLimit);

  const snapshots = [];
  for (const m of meetings) {
    const evidence = await buildMeetingEvidence(m, { includeTranscript: false, focusTerms: [] });
    if (evidence?.snapshot) snapshots.push(evidence.snapshot);
  }
  await upsertMemoryBankItems(snapshots);
  return `Memory bank refreshed with ${snapshots.length} meetings. Files: ${MEMORY_BANK_JSON}, ${MEMORY_BANK_MD}`;
}

function parseTasksMode(rawText = "") {
  const t = String(rawText || "").toLowerCase();
  if (/\bdone|completed|closed|finished\b/.test(t)) return "done";
  if (/\ball\b/.test(t)) return "all";
  return "current";
}

async function handleAsanaTasksCommand(ctx, rawText = "") {
  const mode = parseTasksMode(rawText);
  const headingByMode = {
    current: `📋 Asana: current tasks (${ASANA_PROJECT_NAME})`,
    done: `✅ Asana: done tasks (${ASANA_PROJECT_NAME})`,
    all: `🗂 Asana: all tasks (${ASANA_PROJECT_NAME})`,
  };
  const tasks = await listAsanaTasks(mode, ASANA_TASK_LIST_LIMIT);
  await ctx.reply(trimOut(formatAsanaTaskList(tasks, headingByMode[mode] || headingByMode.current)));
}

async function handleAsanaTaskAddCommand(ctx, rawText = "") {
  const payload = String(rawText || "").trim();
  if (!payload) {
    await ctx.reply("Usage: /task_add <title> [due:YYYY-MM-DD]");
    return;
  }
  const created = await createAsanaTask(payload);
  const title = created?.name || "(untitled)";
  const gid = created?.gid || "n/a";
  const due = created?.due_on ? `, due ${created.due_on}` : "";
  await ctx.reply(trimOut(`✅ Task created: ${title}${due} (id: ${gid})`));
}

async function handleAsanaTaskDoneCommand(ctx, rawText = "") {
  const gid = String(rawText || "").trim();
  if (!gid) {
    await ctx.reply("Usage: /task_done <task_id>");
    return;
  }
  const updated = await markAsanaTaskDone(gid);
  await ctx.reply(trimOut(`✅ Task marked done: ${updated?.name || gid} (id: ${updated?.gid || gid})`));
}

async function runDryRun() {
  console.log("DRY_RUN=1: validating MCP connectivity...");
  const tools = await withMcpClient(async (client) => client.listTools());
  const names = (tools?.tools || []).map((t) => t.name);
  console.log("MCP tools:", names.join(", "));

  try {
    const st = await callTool("get_sync_status", {});
    console.log(
      "Sync status preview:",
      trimOut(extractTextFromToolResult(st)).slice(0, 500),
    );
  } catch (e) {
    console.log("get_sync_status failed:", e?.message || String(e));
  }

  console.log("Dry run complete.");
}

async function main() {
  ensureConfig();

  if (DRY_RUN) {
    await runDryRun();
    return;
  }

  if (process.env.ASK_TEST) {
    console.log(await answerQuestion(process.env.ASK_TEST));
    return;
  }

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.use(async (ctx, next) => {
    try {
      const msg = ctx.message || ctx.editedMessage || ctx.channelPost || ctx.editedChannelPost;
      if (msg) {
        const chat = msg.chat || {};
        const entities = Array.isArray(msg.entities)
          ? msg.entities.map((e) => e.type).join(",")
          : "";
        const thread = msg.message_thread_id || "-";
        const textPreview = (msg.text || msg.caption || "").slice(0, 180);
        console.log(
          `update chat_id=${chat.id} type=${chat.type} thread=${thread} entities=${entities} text=${textPreview}`,
        );
        const rawText = (msg.text || msg.caption || "").trim();
        if (rawText && msg.from?.is_bot !== true && isAllowedChat(ctx)) {
          await appendChatHistory(String(chat.id || ""), "user", rawText);
        }
      } else {
        const keys = Object.keys(ctx.update || {}).join(",");
        console.log(`update non-message keys=${keys}`);
      }
    } catch {}
    return next();
  });

  bot.start(async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) {
      await ctx.reply("Access is not allowed in this chat.");
      return;
    }
    await ctx.reply(
      "Hi! I'm a bot for questions about Fellow transcripts.\n\n" +
        "Commands:\n" +
        "/status — show Fellow sync status\n" +
        "/sync — sync meetings/transcripts cache\n" +
        "/memory [N] — refresh local memory bank from last N meetings\n" +
        "/tasks [current|done|all] — list Asana tasks from General Tasks\n" +
        "/task_add <title> [due:YYYY-MM-DD] — create Asana task\n" +
        "/task_done <task_id> — mark Asana task as completed\n" +
        "/transcript <title> — get meeting transcript\n" +
        "/ask <question> — ask in groups (works even with privacy mode)\n" +
        "Tip: ask 'weekly trends' for a 7-day summary.\n" +
        "Or just send a free-form question.",
    );
  });

  bot.command("ping", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    await ctx.reply("pong ✅");
  });

  bot.command("status", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    try {
      const res = await callTool("get_sync_status", {});
      await ctx.reply(trimOut(extractTextFromToolResult(res)));
    } catch (e) {
      await ctx.reply(`Status error: ${e?.message || String(e)}`);
    }
  });

  bot.command("sync", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    await ctx.reply("Running sync_meetings (including transcripts)...");
    try {
      const res = await callTool("sync_meetings", {
        force: false,
        include_transcripts: true,
        page_size: 20,
      });
      const syncText = trimOut(extractTextFromToolResult(res));
      let memoryText = "";
      try {
        memoryText = await refreshMemoryBankFromRecentMeetings(24);
      } catch (e) {
        memoryText = `Memory refresh warning: ${e?.message || String(e)}`;
      }
      await ctx.reply(trimOut(`${syncText}\n\n${memoryText}`));
    } catch (e) {
      await ctx.reply(`Sync error: ${e?.message || String(e)}`);
    }
  });

  bot.command("memory", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    const txt = (ctx.message?.text || "").trim();
    const m = txt.match(/^\/memory(?:@\w+)?\s+(\d{1,2})\s*$/i);
    const count = m ? parseInt(m[1], 10) : 24;
    await ctx.reply(`Refreshing memory bank from last ${count} meetings...`);
    try {
      const info = await refreshMemoryBankFromRecentMeetings(count);
      await ctx.reply(trimOut(info));
    } catch (e) {
      await ctx.reply(`Memory refresh error: ${e?.message || String(e)}`);
    }
  });

  bot.command("tasks", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    const txt = (ctx.message?.text || "").trim();
    try {
      await handleAsanaTasksCommand(ctx, txt.replace(/^\/tasks(?:@\w+)?\s*/i, ""));
    } catch (e) {
      await ctx.reply(`Asana tasks error: ${e?.message || String(e)}`);
    }
  });

  bot.command("task_add", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    const txt = (ctx.message?.text || "").trim();
    try {
      await handleAsanaTaskAddCommand(ctx, txt.replace(/^\/task_add(?:@\w+)?\s*/i, ""));
    } catch (e) {
      await ctx.reply(`Asana create error: ${e?.message || String(e)}`);
    }
  });

  bot.command("task_done", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    const txt = (ctx.message?.text || "").trim();
    try {
      await handleAsanaTaskDoneCommand(ctx, txt.replace(/^\/task_done(?:@\w+)?\s*/i, ""));
    } catch (e) {
      await ctx.reply(`Asana complete error: ${e?.message || String(e)}`);
    }
  });

  bot.command("ask", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    const txt = (ctx.message?.text || "").trim();
    const q = normalizeQuestionText(txt.replace(/^\/ask(?:@\w+)?\s*/i, ""));
    if (!q) {
      await ctx.reply("Usage: /ask <your Fellow question>");
      return;
    }
    await handleIncomingText(ctx, q);
  });

  bot.command("transcript", async (ctx) => {
    ctx.state.handledCommand = true;
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    const txt = (ctx.message?.text || "").trim();
    const title = txt.replace(/^\/transcript\s*/i, "").trim();
    if (!title) {
      await ctx.reply("Usage: /transcript <meeting title>");
      return;
    }
    try {
      const res = await callTool("get_meeting_transcript", { meeting_title: title });
      await ctx.reply(trimOut(extractTextFromToolResult(res)), {
        disable_web_page_preview: true,
      });
    } catch (e) {
      await ctx.reply(`Transcript error: ${e?.message || String(e)}`);
    }
  });

  bot.on("text", async (ctx) => {
    if (ctx.state?.handledCommand) return;
    const txt = (ctx.message?.text || "").trim();
    if (!txt) return;

    const lower = txt.toLowerCase();
    const runtimeUsername = (ctx.botInfo?.username || "").toLowerCase();
    const configuredUsername = (process.env.BOT_USERNAME || "wagner_fellow_bot")
      .replace(/^@/, "")
      .toLowerCase();
    const botUsername = runtimeUsername || configuredUsername;
    const mentionTag = botUsername ? `@${botUsername}` : "";
    const chatType = ctx.chat?.type || "";
    const inGroup = chatType === "group" || chatType === "supergroup";

    // Fallback parser for group commands with @mentions, e.g. /start@wagner_fellow_bot
    if (txt.startsWith("/")) {
      if (/^\/start(?:@\w+)?(?:\s|$)/i.test(lower)) {
        await ctx.reply(
          "Hi! I'm a bot for questions about Fellow transcripts.\n\n" +
            "Commands:\n" +
            "/status — show Fellow sync status\n" +
            "/sync — sync meetings/transcripts cache\n" +
            "/memory [N] — refresh local memory bank from last N meetings\n" +
            "/tasks [current|done|all] — list Asana tasks from General Tasks\n" +
            "/task_add <title> [due:YYYY-MM-DD] — create Asana task\n" +
            "/task_done <task_id> — mark Asana task as completed\n" +
            "/transcript <title> — get meeting transcript\n" +
            "/ask <question> — ask in groups (works even with privacy mode)\n" +
            "Tip: ask 'weekly trends' for a 7-day summary.\n" +
            "Or just send a free-form question.",
        );
        return;
      }

      if (/^\/ping(?:@\w+)?(?:\s|$)/i.test(lower)) {
        await ctx.reply("pong ✅");
        return;
      }

      if (/^\/status(?:@\w+)?(?:\s|$)/i.test(lower)) {
        try {
          const res = await callTool("get_sync_status", {});
          await ctx.reply(trimOut(extractTextFromToolResult(res)));
        } catch (e) {
          await ctx.reply(`Status error: ${e?.message || String(e)}`);
        }
        return;
      }

      if (/^\/sync(?:@\w+)?(?:\s|$)/i.test(lower)) {
        await ctx.reply("Running sync_meetings (including transcripts)...");
        try {
          const res = await callTool("sync_meetings", {
            force: false,
            include_transcripts: true,
            page_size: 20,
          });
          const syncText = trimOut(extractTextFromToolResult(res));
          let memoryText = "";
          try {
            memoryText = await refreshMemoryBankFromRecentMeetings(24);
          } catch (e) {
            memoryText = `Memory refresh warning: ${e?.message || String(e)}`;
          }
          await ctx.reply(trimOut(`${syncText}\n\n${memoryText}`));
        } catch (e) {
          await ctx.reply(`Sync error: ${e?.message || String(e)}`);
        }
        return;
      }

      if (/^\/memory(?:@\w+)?(?:\s|$)/i.test(lower)) {
        const m = txt.match(/^\/memory(?:@\w+)?\s+(\d{1,2})\s*$/i);
        const count = m ? parseInt(m[1], 10) : 24;
        await ctx.reply(`Refreshing memory bank from last ${count} meetings...`);
        try {
          const info = await refreshMemoryBankFromRecentMeetings(count);
          await ctx.reply(trimOut(info));
        } catch (e) {
          await ctx.reply(`Memory refresh error: ${e?.message || String(e)}`);
        }
        return;
      }

      if (/^\/tasks(?:@\w+)?(?:\s|$)/i.test(lower)) {
        try {
          await handleAsanaTasksCommand(ctx, txt.replace(/^\/tasks(?:@\w+)?\s*/i, ""));
        } catch (e) {
          await ctx.reply(`Asana tasks error: ${e?.message || String(e)}`);
        }
        return;
      }

      if (/^\/task_add(?:@\w+)?(?:\s|$)/i.test(lower)) {
        try {
          await handleAsanaTaskAddCommand(ctx, txt.replace(/^\/task_add(?:@\w+)?\s*/i, ""));
        } catch (e) {
          await ctx.reply(`Asana create error: ${e?.message || String(e)}`);
        }
        return;
      }

      if (/^\/task_done(?:@\w+)?(?:\s|$)/i.test(lower)) {
        try {
          await handleAsanaTaskDoneCommand(ctx, txt.replace(/^\/task_done(?:@\w+)?\s*/i, ""));
        } catch (e) {
          await ctx.reply(`Asana complete error: ${e?.message || String(e)}`);
        }
        return;
      }

      if (/^\/ask(?:@\w+)?(?:\s|$)/i.test(lower)) {
        const q = normalizeQuestionText(txt.replace(/^\/ask(?:@\w+)?\s*/i, ""));
        if (!q) {
          await ctx.reply("Usage: /ask <your Fellow question>");
          return;
        }
        await handleIncomingText(ctx, q);
        return;
      }

      if (/^\/transcript(?:@\w+)?(?:\s|$)/i.test(lower)) {
        const title = txt.replace(/^\/transcript(?:@\w+)?\s*/i, "").trim();
        if (!title) {
          await ctx.reply("Usage: /transcript <meeting title>");
          return;
        }
        try {
          const res = await callTool("get_meeting_transcript", { meeting_title: title });
          await ctx.reply(trimOut(extractTextFromToolResult(res)), { disable_web_page_preview: true });
        } catch (e) {
          await ctx.reply(`Transcript error: ${e?.message || String(e)}`);
        }
        return;
      }

      return;
    }

    const repliedToBot =
      !!ctx.message?.reply_to_message &&
      (((ctx.message.reply_to_message.from?.username || "").toLowerCase() === botUsername) ||
        ctx.message.reply_to_message.from?.id === ctx.botInfo?.id);

    const mentioned = !!(mentionTag && lower.includes(mentionTag));
    const processAllGroupText = (process.env.PROCESS_ALL_GROUP_TEXT || "0") === "1";
    const shouldProcess = !inGroup || processAllGroupText || mentioned || repliedToBot;
    if (!shouldProcess) {
      console.log(`skip chat_id=${ctx.chat?.id} reason=no-mention text=${txt.slice(0, 120)}`);
      return;
    }

    let q = txt;
    if (mentioned && mentionTag) {
      const esc = mentionTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      q = q.replace(new RegExp(esc, "ig"), " ");
    }
    q = normalizeQuestionText(q);
    if (!q) return;

    await handleIncomingText(ctx, q);
  });

  bot.catch((err, ctx) => {
    console.error("Bot error:", err);
    if (ctx?.reply) {
      ctx.reply("Internal bot error.").catch(() => {});
    }
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  await bot.launch({ dropPendingUpdates: true });
  console.log("wagner-fellow-bot started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
