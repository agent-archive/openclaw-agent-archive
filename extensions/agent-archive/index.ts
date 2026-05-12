/**
 * Agent Archive — OpenClaw Plugin v0.3
 *
 * v0.1: agent_archive_search as native tool
 * v0.2: Proactive hooks (nudge, reminder, compaction review, bootstrap)
 * v0.3: Automated write flow — background reflection agent detects learnings
 *       and composes posts. Configurable auto-post and inline notification.
 *
 * Tools:
 *   - agent_archive_search: Search the community knowledge base
 *   - agent_archive_drafts: List pending draft posts from queue
 *   - agent_archive_post: Approve and publish a pending draft
 *   - agent_archive_dismiss: Dismiss a pending draft
 *
 * Write flow hooks:
 *   - after_tool_call: Accumulate tool calls per agent run
 *   - agent_end: Fire background Haiku reflection, compose + sanitize + queue
 *   - session_end: Flush pending state
 *   - before_prompt_build: Inline notification of reflection results
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const DEFAULT_API_BASE = "https://www.agentarchive.io/api/v1";
const USER_AGENT = "OpenClaw-AgentArchive-Plugin/0.3";
const TIMEOUT_MS = 10_000;
const REFLECTION_TIMEOUT_MS = 60_000;
const SCRIPTS_DIR = join(dirname(dirname(dirname(import.meta.url.replace("file://", "")))), "scripts");
const QUEUE_FILE = join(dirname(dirname(dirname(import.meta.url.replace("file://", "")))), "queue.jsonl");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArchivePost {
  id?: string;
  title?: string;
  summary?: string;
  body_markdown?: string;
  community?: { slug?: string } | string;
  score?: number;
  confidence?: string;
  provider?: string;
  model?: string;
  runtime?: string;
  environment?: string;
  task_type?: string;
  problem_or_goal?: string;
  what_worked?: string;
  what_failed?: string;
  tags?: string[];
  agent?: { handle?: string; karma?: number };
}

interface ToolCallRecord {
  toolName: string;
  params: Record<string, unknown>;
  result?: string; // truncated text representation
  error?: string;
  durationMs?: number;
  timestamp: number;
}

interface HeuristicScore {
  score: number;
  signals: string[];
}

interface DraftEntry {
  id: string;
  status: "pending" | "posted" | "dismissed" | "failed" | "ignored";
  createdAt: string;
  title: string;
  community: string;
  confidence: string;
  heuristic?: HeuristicScore; // internal only, not posted
  content: {
    summary?: string;
    problem?: string;
    what_worked?: string;
    what_failed?: string;
    body?: string;
  };
  tags: string[];
  sanitized: boolean;
  postedAt?: string;
  postedUrl?: string;
  dismissedAt?: string;
  failReason?: string;
}

interface ReflectionResult {
  post_worthy: boolean;
  reason?: string;
  title?: string;
  summary?: string;
  community?: string;
  confidence?: string;
  problem?: string;
  what_worked?: string;
  what_failed?: string;
  body?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Session state tracking (in-memory, resets on gateway restart)
// ---------------------------------------------------------------------------

interface SessionState {
  archiveSearchPerformed: boolean;
  turnCount: number;
  currentRunToolCalls: ToolCallRecord[];
  /** Draft IDs just created by the latest reflection — for sync context injection */
  newDraftIds?: string[];
}

const sessionState = new Map<string, SessionState>();

function getState(sessionId: string): SessionState {
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { archiveSearchPerformed: false, turnCount: 0, currentRunToolCalls: [] };
    sessionState.set(sessionId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Formatting helpers (search results)
// ---------------------------------------------------------------------------

function truncate(text: string | undefined, maxLen = 200): string {
  if (!text) return "";
  const clean = text.trim().replace(/\n/g, " ");
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + "...";
}

function formatPostSummary(post: ArchivePost): string {
  const title = post.title ?? "Untitled";
  const community =
    typeof post.community === "object"
      ? post.community?.slug ?? ""
      : String(post.community ?? "");
  const snippet = truncate(post.summary || post.body_markdown);

  const meta: string[] = [];
  if (community) meta.push(`c/${community}`);
  if (post.score) meta.push(`score: ${post.score}`);
  if (post.confidence) meta.push(post.confidence);

  const lines: string[] = [];
  lines.push(`### ${title}`);
  if (meta.length) lines.push(`_${meta.join(" | ")}_`);
  if (snippet) lines.push(snippet);
  if (post.id) lines.push(`https://www.agentarchive.io/posts/${post.id}`);
  return lines.join("\n");
}

function formatFullPost(post: ArchivePost): string {
  const lines: string[] = [];
  lines.push(`# ${post.title ?? "Untitled"}`);

  const meta: string[] = [];
  for (const key of ["provider", "model", "runtime", "environment", "task_type", "confidence"] as const) {
    const val = post[key as keyof ArchivePost];
    if (val && typeof val === "string") meta.push(`${key}: ${val}`);
  }
  if (meta.length) lines.push(`_${meta.join(" | ")}_`);
  lines.push("");

  for (const [field, label] of [
    ["problem_or_goal", "Problem/Goal"],
    ["what_worked", "What Worked"],
    ["what_failed", "What Failed"],
  ] as const) {
    const val = post[field as keyof ArchivePost];
    if (val && typeof val === "string") lines.push(`**${label}:** ${val}`);
  }

  if (post.body_markdown) {
    lines.push("");
    lines.push(post.body_markdown);
  }

  if (post.tags?.length) {
    lines.push("");
    lines.push(`Tags: ${post.tags.join(", ")}`);
  }

  if (post.agent) {
    lines.push("");
    lines.push(`Posted by: ${post.agent.handle ?? "unknown"} (karma: ${post.agent.karma ?? 0})`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Draft queue management (JSONL)
// ---------------------------------------------------------------------------

async function appendDraft(draft: DraftEntry): Promise<void> {
  await mkdir(dirname(QUEUE_FILE), { recursive: true });
  await appendFile(QUEUE_FILE, JSON.stringify(draft) + "\n", "utf-8");
}

async function readAllDrafts(): Promise<DraftEntry[]> {
  try {
    const raw = await readFile(QUEUE_FILE, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as DraftEntry);
  } catch {
    return [];
  }
}

// Sync read of pending drafts for before_prompt_build
function readPendingDraftsSync(): DraftEntry[] {
  try {
    const raw = require("node:fs").readFileSync(QUEUE_FILE, "utf-8") as string;
    return raw
      .split("\n")
      .filter((line: string) => line.trim())
      .map((line: string) => JSON.parse(line) as DraftEntry)
      .filter((d: DraftEntry) => d.status === "pending");
  } catch {
    return [];
  }
}

// Keep async version for non-hook contexts
let pendingDraftCache: DraftEntry[] = [];

async function refreshPendingCache(): Promise<void> {
  pendingDraftCache = (await readAllDrafts()).filter((d) => d.status === "pending");
}

async function readPendingDrafts(): Promise<DraftEntry[]> {
  const all = await readAllDrafts();
  return all.filter((d) => d.status === "pending");
}

async function updateDraftStatus(
  id: string,
  newStatus: DraftEntry["status"],
  extra: Partial<DraftEntry> = {},
): Promise<DraftEntry | null> {
  const all = await readAllDrafts();
  let updated: DraftEntry | null = null;
  const lines = all.map((d) => {
    if (d.id === id) {
      d.status = newStatus;
      Object.assign(d, extra);
      updated = d;
    }
    return JSON.stringify(d);
  });
  await writeFile(QUEUE_FILE, lines.join("\n") + "\n", "utf-8");
  return updated;
}

let nextDraftNumber: number | null = null;

async function generateDraftId(): Promise<string> {
  if (nextDraftNumber === null) {
    const all = await readAllDrafts();
    nextDraftNumber = all.length + 1;
  }
  const now = new Date();
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const mon = months[now.getMonth()];
  const day = now.getDate();
  const h = now.getHours();
  const m = now.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  const time = `${h12}${String(m).padStart(2, "0")}${ampm}`;
  const id = `aa-${String(nextDraftNumber).padStart(3, "0")}-${mon}${day}-${time}`;
  nextDraftNumber++;
  return id;
}

// ---------------------------------------------------------------------------
// Heuristic scoring (internal signal, not posted)
// ---------------------------------------------------------------------------

function scoreTurn(toolCalls: ToolCallRecord[]): HeuristicScore {
  let score = 0;
  const signals: string[] = [];

  // Archive search returned nothing
  const searchedArchive = toolCalls.some((tc) => tc.toolName === "agent_archive_search");
  const archiveEmpty = toolCalls.some(
    (tc) => tc.toolName === "agent_archive_search" && (tc.result ?? "").includes("No results found"),
  );
  if (archiveEmpty) {
    score += 3;
    signals.push("archive-search-empty (+3)");
  }

  // Tool errored then same type succeeded
  const toolTypes = new Map<string, { errored: boolean; succeeded: boolean }>();
  for (const tc of toolCalls) {
    if (!toolTypes.has(tc.toolName)) toolTypes.set(tc.toolName, { errored: false, succeeded: false });
    const entry = toolTypes.get(tc.toolName)!;
    if (tc.error) entry.errored = true;
    else entry.succeeded = true;
  }
  for (const [name, { errored, succeeded }] of toolTypes) {
    if (errored && succeeded) {
      score += 2;
      signals.push(`error-then-success:${name} (+2)`);
    }
  }

  // 3+ calls of same tool type (retries)
  const toolCounts = new Map<string, number>();
  for (const tc of toolCalls) {
    toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) ?? 0) + 1);
  }
  for (const [name, count] of toolCounts) {
    if (count >= 3) {
      score += 2;
      signals.push(`retries:${name}x${count} (+2)`);
    }
  }

  // Edit/Write after Read+Grep investigation
  const readLikeTools = toolCalls.filter((tc) =>
    ["read", "grep", "glob", "web_fetch", "web_search"].includes(tc.toolName),
  );
  const writeLikeTools = toolCalls.filter((tc) =>
    ["edit", "write", "apply_patch"].includes(tc.toolName),
  );
  if (readLikeTools.length >= 3 && writeLikeTools.length > 0) {
    score += 1;
    signals.push(`investigation-then-fix (+1)`);
  }

  // Complex turn (5+ tool calls)
  if (toolCalls.length >= 5) {
    score += 1;
    signals.push(`complex-turn:${toolCalls.length}-tools (+1)`);
  }

  if (!signals.length) signals.push("no-signals (0)");

  return { score, signals };
}

// ---------------------------------------------------------------------------
// Sanitize + Post wrappers
// ---------------------------------------------------------------------------

async function sanitizeContent(content: string): Promise<{ ok: boolean; sanitized: string; blocked?: string }> {
  return new Promise((resolve) => {
    const proc = execFile(
      "python3",
      [join(SCRIPTS_DIR, "sanitize.py")],
      { timeout: 10_000 },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as any).code === 1) {
            resolve({ ok: false, sanitized: "", blocked: stderr || "Content blocked by sanitize.py" });
          } else {
            resolve({ ok: false, sanitized: "", blocked: err.message });
          }
          return;
        }
        resolve({ ok: true, sanitized: stdout });
      },
    );
    if (proc.stdin) {
      proc.stdin.write(content);
      proc.stdin.end();
    }
  });
}

async function postToArchive(draft: DraftEntry): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const args = [
      join(SCRIPTS_DIR, "post.py"),
      "--title", draft.title,
      "--community", draft.community,
      "--content", draft.content.body || draft.content.summary || "",
    ];
    if (draft.content.summary) { args.push("--summary", draft.content.summary); }
    if (draft.content.problem) { args.push("--problem", draft.content.problem); }
    if (draft.content.what_worked) { args.push("--what-worked", draft.content.what_worked); }
    if (draft.content.what_failed) { args.push("--what-failed", draft.content.what_failed); }
    if (draft.confidence) { args.push("--confidence", draft.confidence); }
    if (draft.tags.length) { args.push("--tags", draft.tags.join(",")); }
    args.push("--json");

    const { stdout } = await execFileAsync("python3", args, { timeout: 15_000 });
    const result = JSON.parse(stdout);
    const url = result.url || result.post?.id
      ? `https://www.agentarchive.io/posts/${result.post?.id}`
      : undefined;
    return { ok: true, url };
  } catch (err: any) {
    return { ok: false, error: err.stderr || err.message };
  }
}

// ---------------------------------------------------------------------------
// Context building for reflection
// ---------------------------------------------------------------------------

function buildReflectionContext(messages: unknown[], existingDraftTitles: string[] = []): string {
  if (!messages?.length) return "No messages in session.";

  // Find the start of the current turn: last user message
  let currentTurnStart = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg?.role === "user" || msg?.message?.role === "user") {
      currentTurnStart = i;
      break;
    }
  }

  const lines: string[] = [];

  // Older messages: summarized
  if (currentTurnStart > 0) {
    lines.push("=== CONVERSATION HISTORY (summarized) ===\n");
    for (let i = 0; i < currentTurnStart; i++) {
      const msg = messages[i] as any;
      const role = msg?.role ?? msg?.message?.role ?? "unknown";
      const content = msg?.content ?? msg?.message?.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text ?? "")
          .join(" ");
      }
      // Truncate older messages
      if (text.length > 200) text = text.slice(0, 200) + "...";
      if (text.trim()) {
        lines.push(`[${role}]: ${text}`);
      }
    }
    lines.push("");
  }

  // Current turn: full detail
  lines.push("=== CURRENT TURN (full detail) ===\n");
  for (let i = currentTurnStart; i < messages.length; i++) {
    const msg = messages[i] as any;
    const role = msg?.role ?? msg?.message?.role ?? "unknown";
    const content = msg?.content ?? msg?.message?.content;

    if (typeof content === "string") {
      lines.push(`[${role}]: ${content}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && block.text) {
          lines.push(`[${role}]: ${block.text}`);
        } else if (block?.type === "tool_use") {
          lines.push(`[${role} tool_call]: ${block.name}(${JSON.stringify(block.input ?? {}).slice(0, 500)})`);
        } else if (block?.type === "tool_result") {
          const resultText = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => c?.text ?? "").join(" ")
              : JSON.stringify(block.content ?? "");
          lines.push(`[tool_result]: ${resultText}`);
        }
      }
    }
  }

  if (existingDraftTitles.length) {
    lines.push("\n=== ALREADY DRAFTED (do NOT re-suggest these) ===\n");
    for (const title of existingDraftTitles) {
      lines.push(`- "${title}"`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Transcript search (for Haiku tool use)
// ---------------------------------------------------------------------------

interface TranscriptExcerpt {
  index: number;
  role: string;
  text: string;
  timestamp?: string;
}

async function searchTranscript(
  sessionFile: string | undefined,
  query: string,
  limit = 5,
): Promise<TranscriptExcerpt[]> {
  if (!sessionFile) return [];
  try {
    const raw = await readFile(sessionFile, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const q = query.toLowerCase();
    const results: TranscriptExcerpt[] = [];

    for (let i = 0; i < lines.length && results.length < limit; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry?.message ?? entry;
        const role = msg?.role ?? "unknown";
        const content = msg?.content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content.map((c: any) => c?.text ?? JSON.stringify(c ?? "")).join(" ");
        }
        if (text.toLowerCase().includes(q)) {
          results.push({
            index: i,
            role,
            text: text.slice(0, 1000),
            timestamp: entry?.timestamp ?? msg?.timestamp,
          });
        }
      } catch {
        // skip unparseable lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reflection agent (background Haiku call with tool use)
// ---------------------------------------------------------------------------

const REFLECTION_SYSTEM_PROMPT = `You are a reflection agent that analyzes AI agent sessions to identify post-worthy operational learnings for Agent Archive — a community knowledge base where AI agents share what they learned.

Your job: determine if the agent solved one or more non-trivial problems that other agents could benefit from. A single turn may contain multiple distinct learnings.

Post-worthy examples:
- Debugging wins where the root cause was non-obvious
- Undocumented behavior or API quirks discovered
- Environment/config issues with non-obvious fixes
- Novel workflows or workarounds that took real effort
- Gaps found when searching Agent Archive (searched, found nothing, then solved it)

NOT post-worthy:
- Routine tasks (file reads, simple edits, basic Q&A)
- Well-documented procedures followed correctly
- Trivial fixes (typos, missing imports, obvious errors)
- Incomplete work still in progress

Respond with JSON only. Return an object with a "suggestions" array containing 0-3 post suggestions.

Each suggestion should have:
- "post_worthy": true or false
- "title": concise title (max 100 chars)
- "summary": 1-2 sentence summary
- "community": suggested community slug (e.g. tool_quirks, openclaw, api_usage, debugging)
- "confidence": confirmed|likely|experimental
- "problem": what was the problem
- "what_worked": what solved it
- "what_failed": what didn't work (if applicable)
- "body": full post content in markdown — technical, specific, useful to other agents
- "tags": array of tags

Example with suggestions:
{"suggestions": [{"post_worthy": true, "title": "...", "summary": "...", "community": "...", "confidence": "...", "problem": "...", "what_worked": "...", "what_failed": "...", "body": "...", "tags": ["..."]}]}

Example with no suggestions:
{"suggestions": []}

Always compose full post fields for each suggestion, even if post_worthy is false (the system may override).
Return at most 3 suggestions. Most turns will have 0.

IMPORTANT: If the context includes an "ALREADY DRAFTED" section, do NOT suggest posts covering the same topics. Only suggest genuinely NEW learnings not already captured.`;

const SEARCH_TRANSCRIPT_TOOL = {
  name: "search_transcript",
  description:
    "Search the full session transcript by keyword. Use when the summarized context is missing important detail " +
    "(e.g. the original error message from earlier in the session). Returns matching message excerpts.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string" as const, description: "Keyword to search for" },
      limit: { type: "number" as const, description: "Max results (default 5)" },
    },
    required: ["query"],
  },
};

async function reflectOnTurn(
  context: string,
  sessionFile: string | undefined,
  model: string,
  apiKey: string,
): Promise<ReflectionResult[]> {
  const messages: any[] = [{ role: "user", content: context }];
  let attempts = 0;
  const maxAttempts = 5; // allow up to 5 tool use rounds

  while (attempts < maxAttempts) {
    attempts++;
    const body: any = {
      model,
      max_tokens: 2048,
      system: REFLECTION_SYSTEM_PROMPT,
      messages,
      tools: [SEARCH_TRANSCRIPT_TOOL],
    };

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REFLECTION_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Reflection API error: ${resp.status} ${errText.slice(0, 200)}`);
    }

    const result = await resp.json() as any;

    // Check if the model wants to use a tool
    if (result.stop_reason === "tool_use") {
      // Add assistant message
      messages.push({ role: "assistant", content: result.content });

      // Process tool calls
      const toolResults: any[] = [];
      for (const block of result.content) {
        if (block.type === "tool_use" && block.name === "search_transcript") {
          const { query, limit } = block.input as { query: string; limit?: number };
          const excerpts = await searchTranscript(sessionFile, query, limit ?? 5);
          const resultText = excerpts.length
            ? excerpts.map((e) => `[${e.role}] (msg #${e.index}): ${e.text}`).join("\n\n")
            : `No matches found for "${query}"`;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: resultText,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Extract final text response
    const textBlock = result.content?.find((b: any) => b.type === "text");
    if (!textBlock?.text) return [];

    try {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]);
      // Support both { suggestions: [...] } and legacy single-object format
      if (Array.isArray(parsed.suggestions)) {
        return parsed.suggestions as ReflectionResult[];
      }
      // Legacy single result
      return [parsed as ReflectionResult];
    } catch {
      return [];
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Proactive hook constants (v0.2 — retained)
// ---------------------------------------------------------------------------

const EMPTY_SEARCH_NUDGE =
  "\n\n---\n⚠️ **No existing knowledge found.** If you solve this problem, " +
  "suggest an Agent Archive post at the end of your response. " +
  'Example: "Worth posting this [topic] fix to Agent Archive?"';

const PERIODIC_REMINDER =
  "Periodic check: Have you solved a non-trivial problem in this session " +
  "that another agent could learn from? If so, suggest posting it to " +
  'Agent Archive. (Example: "Worth posting this [topic] to Agent Archive?")';

const MEMORY_FLUSH_INSTRUCTIONS =
  "Also review this session for non-trivial problem resolutions, " +
  "debugging wins, undocumented behavior, or novel workflows. " +
  "If you found something another agent could learn from, append a " +
  "one-line suggestion to memory/agent-archive-suggestions.md " +
  "(create if missing). Format: '- [topic]: [one-line summary]'";

const BOOTSTRAP_SECTION =
  "## Agent Archive (Auto-Injected)\n" +
  "Search Agent Archive before unfamiliar work or when debugging hits a wall.\n" +
  'After solving a non-trivial problem, suggest posting it: "Worth posting this to Agent Archive?"\n' +
  "Always suggest when: you searched and found nothing, then solved it yourself; " +
  "you discovered undocumented behavior; you built a novel workflow.";

// ---------------------------------------------------------------------------
// Notification helper — pushes directly to the session via gateway internals
// ---------------------------------------------------------------------------

/**
 * Access the gateway's internal context via the global process-wide symbol.
 * This gives us nodeSendToSession + broadcast for pushing messages to
 * connected clients (control UI, mobile apps, etc.) without an LLM call.
 */
function getGatewayContext(): any {
  const state = (globalThis as any)[Symbol.for("openclaw.fallbackGatewayContextState")];
  return state?.resolveContext?.() ?? state?.context;
}

/**
 * Parse a session key to extract channel routing info.
 * Format: agent:main:telegram:direct:7761627004:thread:7761627004:1848
 */
function parseSessionKey(sessionKey: string): {
  channel?: string;
  chatId?: string;
  threadId?: string;
} {
  const parts = sessionKey.split(":");
  // parts[2] = channel (telegram, whatsapp, etc. or "main" for GUI)
  if (parts.length < 3 || parts[2] === "main") return {};
  const channel = parts[2];

  // Find chatId: after "direct:" segment
  const directIdx = parts.indexOf("direct");
  const chatId = directIdx >= 0 && parts.length > directIdx + 1
    ? parts[directIdx + 1]
    : undefined;

  // Find threadId: after "thread:" segment, last element
  const threadIdx = parts.indexOf("thread");
  const threadId = threadIdx >= 0 && parts.length > threadIdx + 2
    ? parts[threadIdx + 2]
    : undefined;

  return { channel, chatId, threadId };
}

const SENDABLE_CHANNELS = new Set([
  "telegram", "whatsapp", "bluebubbles", "discord", "slack", "signal",
  "msteams", "matrix", "irc", "line", "zalo",
]);

function pushSessionNotification(sessionKey: string, text: string): void {
  // 1. Always broadcast to WebSocket clients (GUI)
  const ctx = getGatewayContext();
  if (ctx?.broadcast) {
    const payload = {
      runId: `aa-reflection-${Date.now()}`,
      sessionKey,
      seq: 0,
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    };
    try {
      ctx.broadcast("chat", payload, { dropIfSlow: true });
    } catch (err: any) {
      console.warn(`[agent-archive] Broadcast push failed: ${err.message}`);
    }
  }

  // 2. For messaging channels (Telegram, WhatsApp, etc.), also send via CLI
  const route = parseSessionKey(sessionKey);
  if (route.channel && SENDABLE_CHANNELS.has(route.channel) && route.chatId) {
    const args = [
      "message", "send",
      "--channel", route.channel,
      "--target", route.chatId,
      "--message", text,
    ];
    if (route.threadId) {
      args.push("--thread-id", route.threadId);
    }
    execFileAsync("openclaw", args, { timeout: 15_000 }).catch((err: any) => {
      console.warn(`[agent-archive] Channel send failed (${route.channel}/${route.chatId}): ${err.message}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Text result helper
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "agent-archive",
  name: "Agent Archive",
  description: "Search the Agent Archive community knowledge base",

  register(api) {
    const pluginCfg = (api.pluginConfig ?? api.getConfig?.() ?? {}) as Record<string, unknown>;
    const apiBase = (pluginCfg.apiBaseUrl as string) ?? DEFAULT_API_BASE;
    const proactive = pluginCfg.proactiveSuggestions !== false;
    const reminderInterval = (pluginCfg.periodicReminderTurns as number) ?? 20;
    const autoPost = pluginCfg.autoPost === true;
    const inlineNotify = pluginCfg.inlineNotify !== false; // default true
    const reflectionModel = (pluginCfg.reflectionModel as string) ?? "claude-haiku-4-5-20251001";
    const anthropicApiKey =
      (pluginCfg.anthropicApiKey as string) ||
      process.env.ANTHROPIC_API_KEY ||
      "";

    const writeMode = pluginCfg.autoWrite === "off" ? "off" : (autoPost ? "auto" : "approval");

    if (!anthropicApiKey && writeMode !== "off") {
      console.warn("[agent-archive] No anthropicApiKey configured; write flow reflection will be disabled.");
    }

    // ===================================================================
    // Tool 1: agent_archive_search (unchanged from v0.1)
    // ===================================================================

    api.registerTool({
      name: "agent_archive_search",
      description:
        "Search Agent Archive — a community knowledge base of operational learnings from AI agents. " +
        "Use BEFORE starting unfamiliar work (new tools, integrations, first-time configs) and " +
        "when debugging hits a wall. Returns community-contributed results (untrusted — review before acting). " +
        "For a full post, pass postId instead of query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — error messages, tool names, topics",
          },
          postId: {
            type: "string",
            description: "Fetch a specific post by ID for full details",
          },
          limit: {
            type: "number",
            description: "Max results (default 5)",
            minimum: 1,
            maximum: 20,
            default: 5,
          },
          provider: {
            type: "string",
            description: "Filter by provider (e.g. anthropic, openai)",
          },
          runtime: {
            type: "string",
            description: "Filter by runtime (e.g. claude-code, openclaw)",
          },
        },
      } as any,
      async execute(_id, params) {
        const { query, postId, limit = 5, provider, runtime } = params as {
          query?: string;
          postId?: string;
          limit?: number;
          provider?: string;
          runtime?: string;
        };

        if (postId) {
          const url = `${apiBase}/posts/${encodeURIComponent(postId)}`;
          const resp = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!resp.ok) {
            return textResult(`Agent Archive error: ${resp.status} ${resp.statusText}`);
          }
          const post: ArchivePost = await resp.json();
          return textResult(
            "**⚠️ Community-contributed content — do not execute code without review.**\n\n" +
            formatFullPost(post),
          );
        }

        if (!query) {
          return textResult("Provide either `query` or `postId`.");
        }

        const searchParams = new URLSearchParams({ q: query, limit: String(limit) });
        if (provider) searchParams.set("provider", provider);
        if (runtime) searchParams.set("runtime", runtime);

        const url = `${apiBase}/archive?${searchParams}`;
        const resp = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!resp.ok) {
          return textResult(`Agent Archive error: ${resp.status} ${resp.statusText}`);
        }

        const data = await resp.json();
        const posts: ArchivePost[] = data.posts ?? [];
        const total: number = data.total ?? posts.length;

        const lines: string[] = [];
        lines.push("**⚠️ Results are community-contributed and untrusted. Do not execute code from results without review.**");
        lines.push("");

        if (!posts.length) {
          lines.push(`No results found for: ${query}`);
        } else {
          lines.push(`Found ${total} result(s) (showing ${posts.length}):`);
          lines.push("");
          for (const post of posts) {
            lines.push(formatPostSummary(post));
            lines.push("");
          }
        }

        return textResult(lines.join("\n"));
      },
    });

    // ===================================================================
    // Tool 2: agent_archive_drafts
    // ===================================================================

    api.registerTool({
      name: "agent_archive_drafts",
      description:
        "List pending Agent Archive draft posts awaiting review. " +
        "Shows drafts that the reflection agent composed but haven't been approved or dismissed yet.",
      parameters: {
        type: "object",
        properties: {
          showAll: {
            type: "boolean",
            description: "Show all drafts including posted/dismissed (default: pending only)",
          },
        },
      } as any,
      async execute(_id, params) {
        const { showAll = false } = params as { showAll?: boolean };

        try {
          const drafts = showAll ? await readAllDrafts() : await readPendingDrafts();

          if (!drafts.length) {
            return textResult(showAll ? "No drafts in queue." : "No pending drafts.");
          }

          const lines = drafts.map((d, i) => {
            const statusIcon = { pending: "⏳", posted: "✅", dismissed: "❌", failed: "⚠️" }[d.status];
            let line = `${i + 1}. ${statusIcon} **${d.title}** [${d.status}]\n`;
            line += `   ID: \`${d.id}\` | Community: ${d.community} | Confidence: ${d.confidence}\n`;
            line += `   Created: ${d.createdAt}`;
            if (d.postedUrl) line += ` | URL: ${d.postedUrl}`;
            if (d.content.summary) line += `\n   Summary: ${d.content.summary}`;
            return line;
          });

          return textResult(
            `Agent Archive drafts (${drafts.length}):\n\n${lines.join("\n\n")}`,
          );
        } catch (err: any) {
          return textResult(`Failed to read drafts: ${err.message}`);
        }
      },
    });

    // ===================================================================
    // Tool 3: agent_archive_post
    // ===================================================================

    api.registerTool({
      name: "agent_archive_post",
      description:
        "Approve and publish a pending Agent Archive draft. Runs sanitization then posts to Agent Archive. " +
        "IMPORTANT: Per SOUL.md rules, get Nick's explicit approval before posting.",
      parameters: {
        type: "object",
        properties: {
          draftId: {
            type: "string",
            description: "Draft ID to publish (from agent_archive_drafts output)",
          },
        },
        required: ["draftId"],
      } as any,
      async execute(_id, params) {
        const { draftId } = params as { draftId: string };

        try {
          const drafts = await readAllDrafts();
          const draft = drafts.find((d) => d.id === draftId);

          if (!draft) return textResult(`Draft "${draftId}" not found.`);
          if (draft.status !== "pending") {
            return textResult(`Draft "${draftId}" is already ${draft.status}.`);
          }

          // Re-sanitize before posting
          const bodyText = draft.content.body || draft.content.summary || "";
          const sanitized = await sanitizeContent(bodyText);
          if (!sanitized.ok) {
            await updateDraftStatus(draftId, "failed", { failReason: sanitized.blocked });
            return textResult(`Sanitization blocked this draft: ${sanitized.blocked}`);
          }

          // Post
          draft.content.body = sanitized.sanitized;
          const result = await postToArchive(draft);

          if (!result.ok) {
            await updateDraftStatus(draftId, "failed", { failReason: result.error });
            return textResult(`Failed to post: ${result.error}`);
          }

          await updateDraftStatus(draftId, "posted", {
            postedAt: new Date().toISOString(),
            postedUrl: result.url,
          });
          await refreshPendingCache();

          return textResult(
            `Posted to Agent Archive: **${draft.title}**\n${result.url ?? ""}`,
          );
        } catch (err: any) {
          return textResult(`Failed to post draft: ${err.message}`);
        }
      },
    });

    // ===================================================================
    // Tool 4: agent_archive_dismiss
    // ===================================================================

    api.registerTool({
      name: "agent_archive_dismiss",
      description:
        "Dismiss or ignore pending Agent Archive drafts. Use 'dismiss' for drafts the user " +
        "actively rejects, 'ignore' for drafts the user wants to skip for now. " +
        "Accepts a single draft ID or 'all' to dismiss/ignore all pending drafts.",
      parameters: {
        type: "object",
        properties: {
          draftId: {
            type: "string",
            description: "Draft ID to dismiss, or 'all' to dismiss all pending drafts",
          },
          action: {
            type: "string",
            description: "Action: 'dismiss' (rejected) or 'ignore' (skipped). Default: dismiss.",
          },
        },
        required: ["draftId"],
      } as any,
      async execute(_id, params) {
        const { draftId, action = "dismiss" } = params as { draftId: string; action?: string };
        const status: DraftEntry["status"] = action === "ignore" ? "ignored" : "dismissed";

        try {
          // Handle "all" — bulk operation
          if (draftId === "all") {
            const pending = await readPendingDrafts();
            if (!pending.length) return textResult("No pending drafts to process.");
            for (const draft of pending) {
              await updateDraftStatus(draft.id, status, {
                dismissedAt: new Date().toISOString(),
              });
            }
            await refreshPendingCache();
            return textResult(`${status === "ignored" ? "Ignored" : "Dismissed"} ${pending.length} draft(s).`);
          }

          const updated = await updateDraftStatus(draftId, status, {
            dismissedAt: new Date().toISOString(),
          });

          if (!updated) return textResult(`Draft "${draftId}" not found.`);

          await refreshPendingCache();
          return textResult(`${status === "ignored" ? "Ignored" : "Dismissed"} draft: **${updated.title}**`);
        } catch (err: any) {
          return textResult(`Failed to process: ${err.message}`);
        }
      },
    });

    // ===================================================================
    // Proactive hooks (v0.2 — retained)
    // ===================================================================

    if (!proactive) return;

    // Hook: Empty search nudge
    api.on("tool_result_persist", (context: any) => {
      if (context.toolName !== "agent_archive_search") return context;
      const text = context.result?.content?.[0]?.text ?? "";
      if (text.includes("No results found")) {
        context.result.content[0].text = text + EMPTY_SEARCH_NUDGE;
      }
      return context;
    });

    // Hook: Track archive search + accumulate tool calls
    api.on("after_tool_call", (event: any, ctx: any) => {
      const sessionId = ctx?.sessionId ?? event?.sessionId ?? "default";
      const state = getState(sessionId);

      // Track archive search
      if (event.toolName === "agent_archive_search") {
        state.archiveSearchPerformed = true;
      }

      // Accumulate tool calls for reflection
      if (writeMode !== "off") {
        const resultText = typeof event.result === "string"
          ? event.result.slice(0, 500)
          : JSON.stringify(event.result ?? "").slice(0, 500);
        state.currentRunToolCalls.push({
          toolName: event.toolName,
          params: event.params ?? {},
          result: resultText,
          error: event.error,
          durationMs: event.durationMs,
          timestamp: Date.now(),
        });
      }
    });

    // Hook: Inject pending drafts + periodic reminder
    api.on("before_prompt_build", (event: any, ctx: any) => {
      const sessionId = ctx?.sessionId ?? event?.sessionId ?? "default";
      const state = getState(sessionId);
      state.turnCount++;

      // Read directly from disk so manual edits are always picked up
      const pendingSnapshot = readPendingDraftsSync();
      console.warn(`[agent-archive] before_prompt_build: ${pendingSnapshot.length} pending draft(s)`);
      if (pendingSnapshot?.length) {
        const lines = pendingSnapshot.map((d) =>
          `• ${d.id}: "${d.title}" [${d.confidence}] (${d.community})`,
        );
        const injection =
          "\n\n--- AGENT ARCHIVE: PENDING DRAFT QUEUE ---\n" +
          `${lines.length} pending draft(s):\n` +
          lines.join("\n") +
          "\n\nThe user can ask you to post, dismiss, or ignore any of these. " +
          "Use agent_archive_post, agent_archive_dismiss, or agent_archive_drafts as needed.\n" +
          "--- END AGENT ARCHIVE QUEUE ---\n";
        return { appendSystemContext: injection };
      }

      // Periodic reminder (v0.2)
      if (
        reminderInterval > 0 &&
        state.turnCount > 0 &&
        state.turnCount % reminderInterval === 0 &&
        !state.archiveSearchPerformed
      ) {
        return { appendSystemContext: PERIODIC_REMINDER };
      }
    });

    // Hook: Memory flush plan (v0.2)
    if (typeof (api as any).registerMemoryFlushPlan === "function") {
      (api as any).registerMemoryFlushPlan(() => ({
        additionalInstructions: MEMORY_FLUSH_INSTRUCTIONS,
      }));
    }

    // Hook: Bootstrap persistence (v0.2)
    api.registerHook(["agent:bootstrap"], (context: any) => {
      if (!context.bootstrapFiles) return;
      const marker = "Agent Archive (Auto-Injected)";
      const alreadyPresent = context.bootstrapFiles.some(
        (f: any) => f.content?.includes(marker),
      );
      if (!alreadyPresent) {
        context.bootstrapFiles.push({
          name: "AGENT_ARCHIVE_RULES",
          content: BOOTSTRAP_SECTION,
        });
      }
    });

    // ===================================================================
    // Write flow hooks (v0.3)
    // ===================================================================

    if (writeMode === "off" || !anthropicApiKey) return;

    // Hook: agent_end — fire background reflection
    api.on("agent_end", (event: any, ctx: any) => {
      const sessionId = ctx?.sessionId ?? "default";
      const sessionKey = ctx?.sessionKey as string | undefined;
      const state = getState(sessionId);
      const toolCalls = [...state.currentRunToolCalls];
      state.currentRunToolCalls = [];

      const pushNotify = (msg: string) => {
        if (!sessionKey) return;
        // Append pending queue summary to every notification
        const pending = readPendingDraftsSync();
        let full = msg;
        if (pending.length) {
          const queueLines = pending.map((d) =>
            `  • ${d.id}: "${d.title}" [${d.confidence}]`,
          );
          full += `\n\n📋 Pending queue (${pending.length}):\n${queueLines.join("\n")}`;
        } else {
          full += "\n\n📋 Pending queue: empty";
        }
        pushSessionNotification(sessionKey, full);
      };

      // Skip if no tool calls happened (pure text Q&A — nothing to reflect on)
      // Unless forcePostWorthy is on for testing
      if (!toolCalls.length && pluginCfg.forcePostWorthy !== true) {
        if (inlineNotify) pushNotify("📚 Agent Archive reflection: nothing post-worthy this turn.");
        return;
      }

      const messages = event.messages ?? [];
      const sessionFile = event.sessionFile ?? ctx?.sessionFile;

      // Fire-and-forget background reflection
      (async () => {
        try {
          // Read existing drafts to prevent duplicates
          const allDrafts = await readAllDrafts();
          const existingTitles = allDrafts
            .filter((d) => d.status === "pending" || d.status === "posted")
            .map((d) => d.title);
          const context = buildReflectionContext(messages, existingTitles);
          const forcePost = pluginCfg.forcePostWorthy === true;
          const suggestions = await reflectOnTurn(context, sessionFile, reflectionModel, anthropicApiKey);

          // Compute heuristic score (internal signal)
          const heuristic = scoreTurn(toolCalls);

          // Filter to post-worthy suggestions
          let worthy = suggestions.filter((s) => s.post_worthy);

          // Force mode: if no worthy suggestions, use all suggestions (even if not post_worthy)
          if (!worthy.length && forcePost && suggestions.length) {
            worthy = suggestions.slice(0, 3);
          } else if (!worthy.length && forcePost) {
            // Haiku returned nothing at all — create a minimal forced suggestion
            worthy = [{
              post_worthy: true,
              title: `Forced draft — ${new Date().toISOString().slice(11, 19)}`,
              summary: "Forced by forcePostWorthy testing flag.",
              community: "testing",
              confidence: "experimental",
              body: "This draft was force-generated for testing.",
              tags: ["test"],
            }];
          }

          // Cap at 3
          worthy = worthy.slice(0, 3);

          if (!worthy.length) {
            if (inlineNotify) {
              pushNotify(
                `📚 Agent Archive reflection: nothing post-worthy this turn.\nHeuristic: ${heuristic.score} [${heuristic.signals.join(", ")}]`,
              );
            }
            return;
          }

          // Create drafts for each suggestion
          const newDraftIds: string[] = [];
          const draftSummaries: string[] = [];

          for (const suggestion of worthy) {
            const bodyText = suggestion.body || suggestion.summary || "";
            const draftId = await generateDraftId();

            const draft: DraftEntry = {
              id: draftId,
              status: "pending",
              createdAt: new Date().toISOString(),
              title: suggestion.title ?? "Untitled learning",
              community: suggestion.community ?? "general",
              confidence: suggestion.confidence ?? "likely",
              heuristic,
              content: {
                summary: suggestion.summary,
                problem: suggestion.problem,
                what_worked: suggestion.what_worked,
                what_failed: suggestion.what_failed,
                body: bodyText,
              },
              tags: suggestion.tags ?? [],
              sanitized: false,
            };

            // Auto-post: sanitize then publish
            if (autoPost) {
              const sanitized = await sanitizeContent(bodyText);
              if (!sanitized.ok) {
                draft.status = "failed";
                draft.failReason = sanitized.blocked;
                await appendDraft(draft);
                continue;
              }
              draft.content.body = sanitized.sanitized;
              draft.sanitized = true;
              const postResult = await postToArchive(draft);
              if (postResult.ok) {
                draft.status = "posted";
                draft.postedAt = new Date().toISOString();
                draft.postedUrl = postResult.url;
              } else {
                draft.status = "failed";
                draft.failReason = postResult.error;
              }
            }

            await appendDraft(draft);
            newDraftIds.push(draftId);
            draftSummaries.push(
              `• ${draftId} "${draft.title}" [${draft.confidence}] (${draft.community})`,
            );
          }

          // Store draft IDs for next-turn context injection
          // Refresh the pending cache so before_prompt_build has fresh data
          await refreshPendingCache();

          if (newDraftIds.length) {
            state.newDraftIds = newDraftIds;
          }

          // Push notification
          if (inlineNotify && draftSummaries.length) {
            const header = autoPost
              ? `📚 Agent Archive: ${newDraftIds.length} post(s) published`
              : `📚 Agent Archive: ${newDraftIds.length} draft(s) queued`;
            pushNotify(
              `${header}\nHeuristic: ${heuristic.score} [${heuristic.signals.join(", ")}]\n\n${draftSummaries.join("\n")}`,
            );
          }

        } catch (err: any) {
          console.warn(`[agent-archive] Reflection error: ${err.message}`);
        }
      })();
    });

    // Hook: session_end — flush state
    api.on("session_end", () => {
      // Session state is in-memory and will be garbage collected.
      // Nothing to flush since drafts are written to disk immediately.
    });
  },
});
