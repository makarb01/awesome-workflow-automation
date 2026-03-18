import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
    t.includes("summary") ||
    t.includes("summarize") ||
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
    "the", "and", "for", "are", "was", "were", "how", "where", "when", "why", "who"
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

async function buildMeetingEvidence(meeting, includeTranscript = false) {
  if (!meeting) return "";
  const title = meeting?.title || "(untitled)";
  const when = meeting?.event_start_local || meeting?.event_start || "N/A";

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

  const summaryForLlm = summaryToHighlights(summary);

  const parts = [`Meeting: ${title} — ${when}`];
  if (summaryForLlm) parts.push(`Summary:\n${clipText(summaryForLlm, 2200)}`);
  if (actions) parts.push(`Action items:\n${clipText(actions, 1800)}`);
  if (transcript) parts.push(`Transcript excerpt:\n${clipText(transcript, 2500)}`);
  return parts.join("\n\n");
}

async function synthesizeAnswerWithGemini(question, contextBlocks, chatMemoryContext = "") {
  if (!ENABLE_LLM_SYNTHESIS || !GEMINI_API_KEY) return "";
  const context = clipText(
    (contextBlocks || []).filter(Boolean).join("\n\n--------------------\n\n"),
    MAX_CONTEXT_CHARS,
  );
  if (!context) return "";

  const prompt =
    "You are an expert meeting analyst for business calls.\n" +
    "Answer ONLY in English.\n" +
    "Use ONLY the provided context from Fellow data.\n" +
    "Paraphrase information; do NOT quote source text verbatim.\n" +
    "Do not output long copied passages from notes or transcripts.\n" +
    "If the user asks what changed, compare recent calls and list concrete changes.\n" +
    "Always anchor statements with meeting title/date when possible.\n" +
    "If data is insufficient, explicitly say what is missing.\n" +
    "Keep response concise and useful (4-8 bullets + short conclusion).\n\n" +
    `User question:\n${question}\n\n` +
    (chatMemoryContext ? `Recent chat memory:\n${chatMemoryContext}\n\n` : "") +
    `Context:\n${context}`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 900,
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
  const answer = (data?.candidates || [])
    .flatMap((c) => c?.content?.parts || [])
    .map((p) => p?.text || "")
    .join("\n")
    .trim();

  return answer || "";
}

async function answerQuestion(question, chatId = "") {
  const safeQuestion = question.trim();
  if (!safeQuestion) {
    return "Empty query. Ask a question about Fellow meetings.";
  }

  const meetingsRes = await callTool("search_meetings", { limit: 30 });
  const meetingsText = extractTextFromToolResult(meetingsRes);
  const meetingsJson = parseJsonObject(meetingsText);
  const allMeetings = Array.isArray(meetingsJson?.meetings) ? meetingsJson.meetings : [];
  const rankedMeetings = rankMeetingsByQuery(allMeetings, safeQuestion);

  if (looksLikeTranscriptRequest(safeQuestion)) {
    const target = rankedMeetings[0] || allMeetings[0];
    if (!target) {
      return "No meetings found to pull transcript from. Run /sync and try again.";
    }
    try {
      const tr = await callTool("get_meeting_transcript", { recording_id: target.id });
      const trText = extractTextFromToolResult(tr);
      return trimOut(
        `📝 Transcript for: ${target.title || "latest meeting"}\n\n` + trText
      );
    } catch (e) {
      return `Could not fetch transcript for the latest relevant meeting: ${e?.message || String(e)}`;
    }
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

  const transcriptRequested = looksLikeTranscriptRequest(safeQuestion);
  const selectedMeetings = (rankedMeetings.length ? rankedMeetings : allMeetings).slice(0, 3);

  const contextBlocks = [];
  if (looksLikeWeeklyTrendsQuestion(safeQuestion)) {
    const weekly = await summarizeRecentThemes(7);
    contextBlocks.push(`Weekly trends snapshot:\n${weekly}`);
  }
  if (selectedMeetings.length) {
    contextBlocks.push(`Relevant meetings:\n${formatMeetingsList(selectedMeetings, 6)}`);
  }
  if (!detectNoResults(cachedText) && cachedText) {
    contextBlocks.push(`Related cached notes:\n${clipText(cachedText, 3500)}`);
  }

  for (const m of selectedMeetings) {
    const evidence = await buildMeetingEvidence(m, transcriptRequested);
    if (evidence) contextBlocks.push(evidence);
  }

  const memoryContext = getChatMemoryContext(chatId);
  if (contextBlocks.length) {
    try {
      const synthesized = await synthesizeAnswerWithGemini(
        safeQuestion,
        contextBlocks,
        memoryContext,
      );
      if (synthesized) return trimOut(synthesized);
    } catch (e) {
      console.log(`Gemini synthesis failed: ${e?.message || String(e)}`);
    }
  }

  if (transcriptRequested) {
    const target = selectedMeetings[0];
    if (!target) {
      return "No meetings found to pull transcript from. Run /sync and try again.";
    }
    try {
      const tr = await callTool("get_meeting_transcript", { recording_id: target.id });
      const trText = extractTextFromToolResult(tr);
      return trimOut(
        `📝 Transcript for: ${target.title || "latest meeting"}\n\n` + trText
      );
    } catch (e) {
      return `Could not fetch transcript for the latest relevant meeting: ${e?.message || String(e)}`;
    }
  }

  const blocks = [];
  if (!detectNoResults(cachedText) && cachedText) {
    blocks.push(`📚 Related notes:
${cachedText}`);
  }

  if (rankedMeetings.length) {
    blocks.push(`🗓 Relevant meetings:
${formatMeetingsList(rankedMeetings, 8)}`);
  } else if (allMeetings.length) {
    blocks.push(`🗓 Recent meetings:
${formatMeetingsList(allMeetings, 5)}`);
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
    await ctx.reply(trimOut(result), { disable_web_page_preview: true });
  } catch (err) {
    const msg = err?.message || String(err);
    await ctx.reply(
      trimOut(
        `Error while querying Fellow MCP: ${msg}\n\n` +
          "Check FELLOW_API_KEY and FELLOW_SUBDOMAIN (stdio mode), or auth for FELLOW_MCP_URL (http mode).",
      ),
    );
  }
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
      } else {
        const keys = Object.keys(ctx.update || {}).join(",");
        console.log(`update non-message keys=${keys}`);
      }
    } catch {}
    return next();
  });

  bot.start(async (ctx) => {
    if (!isAllowedChat(ctx)) {
      await ctx.reply("Access is not allowed in this chat.");
      return;
    }
    await ctx.reply(
      "Hi! I'm a bot for questions about Fellow transcripts.\n\n" +
        "Commands:\n" +
        "/status — show Fellow sync status\n" +
        "/sync — sync meetings/transcripts cache\n" +
        "/transcript <title> — get meeting transcript\n" +
        "/ask <question> — ask in groups (works even with privacy mode)\n" +
        "Tip: ask 'weekly trends' for a 7-day summary.\n" +
        "Or just send a free-form question.",
    );
  });

  bot.command("ping", async (ctx) => {
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    await ctx.reply("pong ✅");
  });

  bot.command("status", async (ctx) => {
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    try {
      const res = await callTool("get_sync_status", {});
      await ctx.reply(trimOut(extractTextFromToolResult(res)));
    } catch (e) {
      await ctx.reply(`Status error: ${e?.message || String(e)}`);
    }
  });

  bot.command("sync", async (ctx) => {
    if (!isAllowedChat(ctx)) return ctx.reply("Access is not allowed in this chat.");
    await ctx.reply("Running sync_meetings (including transcripts)...");
    try {
      const res = await callTool("sync_meetings", {
        force: false,
        include_transcripts: true,
        page_size: 20,
      });
      await ctx.reply(trimOut(extractTextFromToolResult(res)));
    } catch (e) {
      await ctx.reply(`Sync error: ${e?.message || String(e)}`);
    }
  });

  bot.command("ask", async (ctx) => {
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
          await ctx.reply(trimOut(extractTextFromToolResult(res)));
        } catch (e) {
          await ctx.reply(`Sync error: ${e?.message || String(e)}`);
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
