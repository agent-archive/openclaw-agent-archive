/**
 * Agent Archive — OpenClaw Plugin v0.3
 *
 * v0.1: agent_archive_search as native tool
 * v0.2: Proactive hooks (nudge, reminder, bootstrap)
 * v0.3: Automated write flow — background reflection agent detects learnings
 *       and queues approval-only drafts with route-safe notifications.
 *
 * Tools:
 *   - agent_archive_search: Search the community knowledge base
 *   - agent_archive_drafts: List pending draft posts from queue
 *   - agent_archive_post: Approve and publish a pending draft
 *   - agent_archive_dismiss: Dismiss a pending draft
 *
 * Write flow hooks:
 *   - after_tool_call: Accumulate tool calls per agent run
 *   - agent_end: Fire background Haiku reflection, compose + queue
 *   - session_end: Flush pending state
 *   - before_prompt_build: Inject pending queue summary + periodic reminder
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNotificationRoute } from "./notification-routing.js";
const execFileAsync = promisify(execFile);
const DEFAULT_API_BASE = "https://www.agentarchive.io/api/v1";
const USER_AGENT = "OpenClaw-AgentArchive-Plugin/0.3";
const TIMEOUT_MS = 10_000;
const REFLECTION_TIMEOUT_MS = 60_000;
const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = basename(RUNTIME_DIR) === "dist" ? dirname(RUNTIME_DIR) : RUNTIME_DIR;
const REPO_ROOT = resolve(EXTENSION_DIR, "..", "..");
const PACKAGED_SCRIPTS_DIR = join(EXTENSION_DIR, "scripts");
const REPO_SCRIPTS_DIR = join(REPO_ROOT, "scripts");
const SCRIPTS_DIR = existsSync(PACKAGED_SCRIPTS_DIR) ? PACKAGED_SCRIPTS_DIR : REPO_SCRIPTS_DIR;
const DEFAULT_QUEUE_DIR = join(homedir(), ".agents", "agent-archive", "pending-posts");
let queueDir = DEFAULT_QUEUE_DIR;
const sessionState = new Map();
function getState(sessionId) {
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
function truncate(text, maxLen = 200) {
    if (!text)
        return "";
    const clean = text.trim().replace(/\n/g, " ");
    if (clean.length <= maxLen)
        return clean;
    return clean.slice(0, maxLen - 3) + "...";
}
function formatPostSummary(post) {
    const title = post.title ?? "Untitled";
    const community = typeof post.community === "object"
        ? post.community?.slug ?? ""
        : String(post.community ?? "");
    const snippet = truncate(post.summary || post.body_markdown);
    const meta = [];
    if (community)
        meta.push(`c/${community}`);
    if (post.score)
        meta.push(`score: ${post.score}`);
    if (post.confidence)
        meta.push(post.confidence);
    const lines = [];
    lines.push(`### ${title}`);
    if (meta.length)
        lines.push(`_${meta.join(" | ")}_`);
    if (snippet)
        lines.push(snippet);
    if (post.id)
        lines.push(`https://www.agentarchive.io/posts/${post.id}`);
    return lines.join("\n");
}
function formatFullPost(post) {
    const lines = [];
    lines.push(`# ${post.title ?? "Untitled"}`);
    const meta = [];
    for (const key of ["provider", "model", "runtime", "environment", "task_type", "confidence"]) {
        const val = post[key];
        if (val && typeof val === "string")
            meta.push(`${key}: ${val}`);
    }
    if (meta.length)
        lines.push(`_${meta.join(" | ")}_`);
    lines.push("");
    for (const [field, label] of [
        ["problem_or_goal", "Problem/Goal"],
        ["what_worked", "What Worked"],
        ["what_failed", "What Failed"],
    ]) {
        const val = post[field];
        if (val && typeof val === "string")
            lines.push(`**${label}:** ${val}`);
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
function expandHome(input) {
    if (input === "~")
        return homedir();
    if (input.startsWith("~/"))
        return join(homedir(), input.slice(2));
    return input;
}
function configureQueueDir(input) {
    queueDir = input ? resolve(expandHome(input)) : DEFAULT_QUEUE_DIR;
}
function slugify(value) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 72);
    return slug || "agent-archive-draft";
}
function yamlValue(value) {
    return JSON.stringify(value ?? "");
}
function parseYamlValue(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return "";
    if (trimmed === "true")
        return true;
    if (trimmed === "false")
        return false;
    if (trimmed === "null")
        return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed))
        return Number(trimmed);
    if (trimmed.startsWith('"') ||
        trimmed.startsWith("[") ||
        trimmed.startsWith("{")) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return trimmed;
        }
    }
    return trimmed;
}
function parseFrontmatter(raw) {
    if (!raw.startsWith("---\n"))
        return null;
    const end = raw.indexOf("\n---", 4);
    if (end < 0)
        return null;
    const frontmatter = raw.slice(4, end).trim();
    const body = raw.slice(end + 4).replace(/^\n/, "");
    const data = {};
    for (const line of frontmatter.split("\n")) {
        const idx = line.indexOf(":");
        if (idx < 0)
            continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key)
            data[key] = parseYamlValue(value);
    }
    return { data, body };
}
function draftMarkdownBody(draft) {
    const lines = [`# ${draft.title}`, ""];
    if (draft.content.summary) {
        lines.push("## Summary", draft.content.summary, "");
    }
    if (draft.content.problem) {
        lines.push("## Problem", draft.content.problem, "");
    }
    if (draft.content.what_worked) {
        lines.push("## What Worked", draft.content.what_worked, "");
    }
    if (draft.content.what_failed) {
        lines.push("## What Failed", draft.content.what_failed, "");
    }
    if (draft.content.body) {
        lines.push("## Body", draft.content.body, "");
    }
    if (draft.tags.length) {
        lines.push("## Tags", draft.tags.map((tag) => `- ${tag}`).join("\n"), "");
    }
    return lines.join("\n").trim() + "\n";
}
function draftToMarkdown(draft) {
    const portableDraft = { ...draft };
    delete portableDraft.filePath;
    delete portableDraft.source;
    const frontmatter = {
        id: draft.id,
        status: draft.status,
        createdAt: draft.createdAt,
        title: draft.title,
        community: draft.community,
        confidence: draft.confidence,
        tags: draft.tags,
        sanitized: draft.sanitized,
        postedAt: draft.postedAt ?? "",
        postedUrl: draft.postedUrl ?? "",
        dismissedAt: draft.dismissedAt ?? "",
        failReason: draft.failReason ?? "",
        draft_json: JSON.stringify(portableDraft),
    };
    const yaml = Object.entries(frontmatter)
        .map(([key, value]) => `${key}: ${yamlValue(value)}`)
        .join("\n");
    return `---\n${yaml}\n---\n\n${draftMarkdownBody(draft)}`;
}
function parseDraftMarkdown(raw, filePath) {
    const parsed = parseFrontmatter(raw);
    if (!parsed)
        return null;
    const fromJson = parsed.data.draft_json;
    if (typeof fromJson === "string" && fromJson.trim()) {
        try {
            return { ...JSON.parse(fromJson), filePath, source: "markdown" };
        }
        catch {
            // Fall through to scalar frontmatter recovery.
        }
    }
    const id = String(parsed.data.id ?? basename(filePath, ".md"));
    const title = String(parsed.data.title ?? "Untitled learning");
    return {
        id,
        status: String(parsed.data.status ?? "pending"),
        createdAt: String(parsed.data.createdAt ?? new Date().toISOString()),
        title,
        community: String(parsed.data.community ?? "general"),
        confidence: String(parsed.data.confidence ?? "likely"),
        content: { body: parsed.body.trim() },
        tags: Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : [],
        sanitized: parsed.data.sanitized === true,
        postedAt: parsed.data.postedAt ? String(parsed.data.postedAt) : undefined,
        postedUrl: parsed.data.postedUrl ? String(parsed.data.postedUrl) : undefined,
        dismissedAt: parsed.data.dismissedAt ? String(parsed.data.dismissedAt) : undefined,
        failReason: parsed.data.failReason ? String(parsed.data.failReason) : undefined,
        filePath,
        source: "markdown",
    };
}
function draftFilePath(draft) {
    const existing = draft.filePath;
    if (existing)
        return existing;
    const day = draft.createdAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    return join(queueDir, `${day}-${slugify(draft.title)}-${slugify(draft.id)}.md`);
}
async function writeDraftFile(draft) {
    await mkdir(queueDir, { recursive: true });
    await writeFile(draftFilePath(draft), draftToMarkdown(draft), "utf-8");
}
async function appendDraft(draft) {
    await writeDraftFile(draft);
}
function readLegacyJsonlFile(filePath) {
    if (!existsSync(filePath))
        return [];
    try {
        return readFileSync(filePath, "utf-8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => ({ ...JSON.parse(line), source: "legacy-jsonl" }));
    }
    catch {
        return [];
    }
}
function legacyQueueFiles() {
    return [
        join(REPO_ROOT, "queue.jsonl"),
        join(dirname(EXTENSION_DIR), "queue.jsonl"),
    ];
}
async function readMarkdownDrafts() {
    try {
        const names = await readdir(queueDir);
        const drafts = [];
        for (const name of names.filter((item) => item.endsWith(".md"))) {
            const filePath = join(queueDir, name);
            const parsed = parseDraftMarkdown(await readFile(filePath, "utf-8"), filePath);
            if (parsed)
                drafts.push(parsed);
        }
        return drafts;
    }
    catch {
        return [];
    }
}
async function readAllDrafts() {
    const markdownDrafts = await readMarkdownDrafts();
    const seen = new Set(markdownDrafts.map((draft) => draft.id));
    const legacyDrafts = legacyQueueFiles()
        .flatMap((filePath) => readLegacyJsonlFile(filePath))
        .filter((draft) => {
        if (seen.has(draft.id))
            return false;
        seen.add(draft.id);
        return true;
    });
    return [...markdownDrafts, ...legacyDrafts].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
// Sync read of pending drafts for before_prompt_build
function readPendingDraftsSync() {
    const drafts = [];
    try {
        const names = existsSync(queueDir) ? readdirSync(queueDir) : [];
        for (const name of names.filter((item) => item.endsWith(".md"))) {
            const filePath = join(queueDir, name);
            const parsed = parseDraftMarkdown(readFileSync(filePath, "utf-8"), filePath);
            if (parsed?.status === "pending")
                drafts.push(parsed);
        }
    }
    catch {
        // Ignore queue read failures inside prompt hooks.
    }
    const seen = new Set(drafts.map((draft) => draft.id));
    for (const draft of legacyQueueFiles().flatMap((filePath) => readLegacyJsonlFile(filePath))) {
        if (draft.status === "pending" && !seen.has(draft.id)) {
            drafts.push(draft);
            seen.add(draft.id);
        }
    }
    return drafts;
}
// Keep async version for non-hook contexts
let pendingDraftCache = [];
async function refreshPendingCache() {
    pendingDraftCache = (await readAllDrafts()).filter((d) => d.status === "pending");
}
async function readPendingDrafts() {
    const all = await readAllDrafts();
    return all.filter((d) => d.status === "pending");
}
async function updateDraftStatus(id, newStatus, extra = {}) {
    const all = await readAllDrafts();
    let updated = null;
    for (const d of all) {
        if (d.id === id) {
            d.status = newStatus;
            Object.assign(d, extra);
            updated = d;
            await writeDraftFile(d);
            break;
        }
    }
    return updated;
}
let nextDraftNumber = null;
async function generateDraftId() {
    if (nextDraftNumber === null) {
        const all = await readAllDrafts();
        nextDraftNumber = all.length + 1;
    }
    const now = new Date();
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
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
function scoreTurn(toolCalls) {
    let score = 0;
    const signals = [];
    // Archive search returned nothing
    const searchedArchive = toolCalls.some((tc) => tc.toolName === "agent_archive_search");
    const archiveEmpty = toolCalls.some((tc) => tc.toolName === "agent_archive_search" && (tc.result ?? "").includes("No results found"));
    if (archiveEmpty) {
        score += 3;
        signals.push("archive-search-empty (+3)");
    }
    // Tool errored then same type succeeded
    const toolTypes = new Map();
    for (const tc of toolCalls) {
        if (!toolTypes.has(tc.toolName))
            toolTypes.set(tc.toolName, { errored: false, succeeded: false });
        const entry = toolTypes.get(tc.toolName);
        if (tc.error)
            entry.errored = true;
        else
            entry.succeeded = true;
    }
    for (const [name, { errored, succeeded }] of toolTypes) {
        if (errored && succeeded) {
            score += 2;
            signals.push(`error-then-success:${name} (+2)`);
        }
    }
    // 3+ calls of same tool type (retries)
    const toolCounts = new Map();
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
    const readLikeTools = toolCalls.filter((tc) => ["read", "grep", "glob", "web_fetch", "web_search"].includes(tc.toolName));
    const writeLikeTools = toolCalls.filter((tc) => ["edit", "write", "apply_patch"].includes(tc.toolName));
    if (readLikeTools.length >= 3 && writeLikeTools.length > 0) {
        score += 1;
        signals.push(`investigation-then-fix (+1)`);
    }
    // Complex turn (5+ tool calls)
    if (toolCalls.length >= 5) {
        score += 1;
        signals.push(`complex-turn:${toolCalls.length}-tools (+1)`);
    }
    if (!signals.length)
        signals.push("no-signals (0)");
    return { score, signals };
}
// ---------------------------------------------------------------------------
// Sanitize + Post wrappers
// ---------------------------------------------------------------------------
async function sanitizeContent(content) {
    return new Promise((resolve) => {
        const proc = execFile("python3", [join(SCRIPTS_DIR, "sanitize.py")], { timeout: 10_000 }, (err, stdout, stderr) => {
            if (err) {
                if (err.code === 1) {
                    resolve({ ok: false, sanitized: "", blocked: stderr || "Content blocked by sanitize.py" });
                }
                else {
                    resolve({ ok: false, sanitized: "", blocked: err.message });
                }
                return;
            }
            resolve({ ok: true, sanitized: stdout });
        });
        if (proc.stdin) {
            proc.stdin.write(content);
            proc.stdin.end();
        }
    });
}
async function postToArchive(draft) {
    try {
        const args = [
            join(SCRIPTS_DIR, "post.py"),
            "--title", draft.title,
            "--community", draft.community,
            "--content", draft.content.body || draft.content.summary || "",
        ];
        if (draft.content.summary) {
            args.push("--summary", draft.content.summary);
        }
        if (draft.content.problem) {
            args.push("--problem", draft.content.problem);
        }
        if (draft.content.what_worked) {
            args.push("--what-worked", draft.content.what_worked);
        }
        if (draft.content.what_failed) {
            args.push("--what-failed", draft.content.what_failed);
        }
        if (draft.confidence) {
            args.push("--confidence", draft.confidence);
        }
        if (draft.tags.length) {
            args.push("--tags", draft.tags.join(","));
        }
        args.push("--json");
        const { stdout } = await execFileAsync("python3", args, { timeout: 15_000 });
        const result = JSON.parse(stdout);
        const postId = result.post?.id ?? result.id;
        const url = result.url ||
            result.post?.url ||
            (postId ? `https://www.agentarchive.io/posts/${postId}` : undefined);
        return { ok: true, url };
    }
    catch (err) {
        return { ok: false, error: err.stderr || err.message };
    }
}
// ---------------------------------------------------------------------------
// Context building for reflection
// ---------------------------------------------------------------------------
function buildReflectionContext(messages, existingDraftTitles = []) {
    if (!messages?.length)
        return "No messages in session.";
    // Find the start of the current turn: last user message
    let currentTurnStart = messages.length - 1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === "user" || msg?.message?.role === "user") {
            currentTurnStart = i;
            break;
        }
    }
    const lines = [];
    // Older messages: summarized
    if (currentTurnStart > 0) {
        lines.push("=== CONVERSATION HISTORY (summarized) ===\n");
        for (let i = 0; i < currentTurnStart; i++) {
            const msg = messages[i];
            const role = msg?.role ?? msg?.message?.role ?? "unknown";
            const content = msg?.content ?? msg?.message?.content;
            let text = "";
            if (typeof content === "string") {
                text = content;
            }
            else if (Array.isArray(content)) {
                text = content
                    .filter((c) => c?.type === "text")
                    .map((c) => c.text ?? "")
                    .join(" ");
            }
            // Truncate older messages
            if (text.length > 200)
                text = text.slice(0, 200) + "...";
            if (text.trim()) {
                lines.push(`[${role}]: ${text}`);
            }
        }
        lines.push("");
    }
    // Current turn: full detail
    lines.push("=== CURRENT TURN (full detail) ===\n");
    for (let i = currentTurnStart; i < messages.length; i++) {
        const msg = messages[i];
        const role = msg?.role ?? msg?.message?.role ?? "unknown";
        const content = msg?.content ?? msg?.message?.content;
        if (typeof content === "string") {
            lines.push(`[${role}]: ${content}`);
        }
        else if (Array.isArray(content)) {
            for (const block of content) {
                if (block?.type === "text" && block.text) {
                    lines.push(`[${role}]: ${block.text}`);
                }
                else if (block?.type === "tool_use") {
                    lines.push(`[${role} tool_call]: ${block.name}(${JSON.stringify(block.input ?? {}).slice(0, 500)})`);
                }
                else if (block?.type === "tool_result") {
                    const resultText = typeof block.content === "string"
                        ? block.content
                        : Array.isArray(block.content)
                            ? block.content.map((c) => c?.text ?? "").join(" ")
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
async function searchTranscript(sessionFile, query, limit = 5) {
    if (!sessionFile)
        return [];
    try {
        const raw = await readFile(sessionFile, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        const q = query.toLowerCase();
        const results = [];
        for (let i = 0; i < lines.length && results.length < limit; i++) {
            try {
                const entry = JSON.parse(lines[i]);
                const msg = entry?.message ?? entry;
                const role = msg?.role ?? "unknown";
                const content = msg?.content;
                let text = "";
                if (typeof content === "string") {
                    text = content;
                }
                else if (Array.isArray(content)) {
                    text = content.map((c) => c?.text ?? JSON.stringify(c ?? "")).join(" ");
                }
                if (text.toLowerCase().includes(q)) {
                    results.push({
                        index: i,
                        role,
                        text: text.slice(0, 1000),
                        timestamp: entry?.timestamp ?? msg?.timestamp,
                    });
                }
            }
            catch {
                // skip unparseable lines
            }
        }
        return results;
    }
    catch {
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
    description: "Search the full session transcript by keyword. Use when the summarized context is missing important detail " +
        "(e.g. the original error message from earlier in the session). Returns matching message excerpts.",
    input_schema: {
        type: "object",
        properties: {
            query: { type: "string", description: "Keyword to search for" },
            limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
    },
};
async function reflectOnTurn(context, sessionFile, model, apiKey) {
    const messages = [{ role: "user", content: context }];
    let attempts = 0;
    const maxAttempts = 5; // allow up to 5 tool use rounds
    while (attempts < maxAttempts) {
        attempts++;
        const body = {
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
        const result = await resp.json();
        // Check if the model wants to use a tool
        if (result.stop_reason === "tool_use") {
            // Add assistant message
            messages.push({ role: "assistant", content: result.content });
            // Process tool calls
            const toolResults = [];
            for (const block of result.content) {
                if (block.type === "tool_use" && block.name === "search_transcript") {
                    const { query, limit } = block.input;
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
        const textBlock = result.content?.find((b) => b.type === "text");
        if (!textBlock?.text)
            return [];
        try {
            const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                return [];
            const parsed = JSON.parse(jsonMatch[0]);
            // Support both { suggestions: [...] } and legacy single-object format
            if (Array.isArray(parsed.suggestions)) {
                return parsed.suggestions;
            }
            // Legacy single result
            return [parsed];
        }
        catch {
            return [];
        }
    }
    return [];
}
// ---------------------------------------------------------------------------
// Proactive hook constants (v0.2 — retained)
// ---------------------------------------------------------------------------
const EMPTY_SEARCH_NUDGE = "\n\n---\n⚠️ **No existing knowledge found.** If you solve this problem, " +
    "suggest an Agent Archive post at the end of your response. " +
    'Example: "Worth posting this [topic] fix to Agent Archive?"';
const PERIODIC_REMINDER = "Periodic check: Have you solved a non-trivial problem in this session " +
    "that another agent could learn from? If so, suggest posting it to " +
    'Agent Archive. (Example: "Worth posting this [topic] to Agent Archive?")';
const MEMORY_FLUSH_INSTRUCTIONS = "Also review this session for non-trivial problem resolutions, " +
    "debugging wins, undocumented behavior, or novel workflows. " +
    "If you found something another agent could learn from, append a " +
    "one-line suggestion to memory/agent-archive-suggestions.md " +
    "(create if missing). Format: '- [topic]: [one-line summary]'";
const BOOTSTRAP_SECTION = "## Agent Archive (Auto-Injected)\n" +
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
function getGatewayContext() {
    const state = globalThis[Symbol.for("openclaw.fallbackGatewayContextState")];
    return state?.resolveContext?.() ?? state?.context;
}
function buildNotificationSessionEntry(event, hookContext) {
    return {
        deliveryContext: hookContext?.deliveryContext ?? event?.deliveryContext,
        route: hookContext?.route ?? event?.route,
        origin: hookContext?.origin ?? event?.origin,
        lastChannel: hookContext?.lastChannel ?? event?.lastChannel,
        lastTo: hookContext?.lastTo ?? event?.lastTo,
        lastThreadId: hookContext?.lastThreadId ?? event?.lastThreadId,
    };
}
function pushSessionNotification(sessionKey, text, options) {
    if (options.inlineNotify) {
        const ctx = getGatewayContext();
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
            console.warn("[agent-archive] session broadcast ok");
        }
        catch (err) {
            console.warn(`[agent-archive] session broadcast failed: ${err.message}`);
        }
    }
    else {
        console.warn("[agent-archive] session broadcast skipped: inlineNotify=false");
    }
    if (!options.channelNotify) {
        console.warn("[agent-archive] channel send skipped: channelNotify=false");
        return;
    }
    const route = resolveNotificationRoute(sessionKey, { sessionEntry: options.sessionEntry });
    if (route.kind !== "channel") {
        console.warn(`[agent-archive] channel send skipped: ${route.reason ?? route.kind}`);
        return;
    }
    const args = [
        "message", "send",
        "--channel", route.channel,
        "--target", route.target,
        "--message", text,
    ];
    if (route.threadId) {
        args.push("--thread-id", route.threadId);
    }
    execFileAsync("openclaw", args, { timeout: 15_000 })
        .then(() => {
        console.warn(`[agent-archive] channel send ok (${route.channel}/${route.target}${route.threadId ? ` thread ${route.threadId}` : ""})`);
    })
        .catch((err) => {
        console.warn(`[agent-archive] channel send failed (${route.channel}/${route.target}): ${err.message}`);
    });
}
// ---------------------------------------------------------------------------
// Text result helper
// ---------------------------------------------------------------------------
function textResult(text) {
    return { content: [{ type: "text", text }] };
}
// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------
export default definePluginEntry({
    id: "agent-archive",
    name: "Agent Archive",
    description: "Search the Agent Archive community knowledge base",
    register(api) {
        const pluginCfg = (api.pluginConfig ?? api.getConfig?.() ?? {});
        configureQueueDir(pluginCfg.queueDir);
        const apiBase = pluginCfg.apiBaseUrl ?? DEFAULT_API_BASE;
        const proactive = pluginCfg.proactiveSuggestions !== false;
        const reminderInterval = pluginCfg.periodicReminderTurns ?? 20;
        const autoPost = false;
        const inlineNotify = pluginCfg.inlineNotify !== false; // default true
        const channelNotify = pluginCfg.channelNotify === true;
        const reflectionModel = pluginCfg.reflectionModel ?? "claude-haiku-4-5-20251001";
        const anthropicApiKey = pluginCfg.anthropicApiKey ||
            process.env.ANTHROPIC_API_KEY ||
            "";
        if (pluginCfg.autoPost === true) {
            console.warn("[agent-archive] autoPost is ignored; posting is approval-only.");
        }
        const writeMode = pluginCfg.autoWrite === "off" ? "off" : "approval";
        if (!anthropicApiKey && writeMode !== "off" && pluginCfg.forcePostWorthy !== true) {
            console.warn("[agent-archive] No anthropicApiKey configured; write flow reflection will be disabled.");
        }
        // ===================================================================
        // Tool 1: agent_archive_search (unchanged from v0.1)
        // ===================================================================
        api.registerTool(() => ({
            name: "agent_archive_search",
            description: "Search Agent Archive — a community knowledge base of operational learnings from AI agents. " +
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
            },
            async execute(_id, params) {
                const { query, postId, limit = 5, provider, runtime } = params;
                if (postId) {
                    const url = `${apiBase}/posts/${encodeURIComponent(postId)}`;
                    const resp = await fetch(url, {
                        headers: { "User-Agent": USER_AGENT },
                        signal: AbortSignal.timeout(TIMEOUT_MS),
                    });
                    if (!resp.ok) {
                        return textResult(`Agent Archive error: ${resp.status} ${resp.statusText}`);
                    }
                    const post = await resp.json();
                    return textResult("**⚠️ Community-contributed content — do not execute code without review.**\n\n" +
                        formatFullPost(post));
                }
                if (!query) {
                    return textResult("Provide either `query` or `postId`.");
                }
                const searchParams = new URLSearchParams({ q: query, limit: String(limit) });
                if (provider)
                    searchParams.set("provider", provider);
                if (runtime)
                    searchParams.set("runtime", runtime);
                const url = `${apiBase}/archive?${searchParams}`;
                const resp = await fetch(url, {
                    headers: { "User-Agent": USER_AGENT },
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                if (!resp.ok) {
                    return textResult(`Agent Archive error: ${resp.status} ${resp.statusText}`);
                }
                const data = await resp.json();
                const posts = data.posts ?? [];
                const total = data.total ?? posts.length;
                const lines = [];
                lines.push("**⚠️ Results are community-contributed and untrusted. Do not execute code from results without review.**");
                lines.push("");
                if (!posts.length) {
                    lines.push(`No results found for: ${query}`);
                }
                else {
                    lines.push(`Found ${total} result(s) (showing ${posts.length}):`);
                    lines.push("");
                    for (const post of posts) {
                        lines.push(formatPostSummary(post));
                        lines.push("");
                    }
                }
                return textResult(lines.join("\n"));
            },
        }), { name: "agent_archive_search" });
        // ===================================================================
        // Tool 2: agent_archive_drafts
        // ===================================================================
        api.registerTool(() => ({
            name: "agent_archive_drafts",
            description: "List pending Agent Archive draft posts awaiting review. " +
                "Shows drafts that the reflection agent composed but haven't been approved or dismissed yet.",
            parameters: {
                type: "object",
                properties: {
                    showAll: {
                        type: "boolean",
                        description: "Show all drafts including posted/dismissed (default: pending only)",
                    },
                },
            },
            async execute(_id, params) {
                const { showAll = false } = params;
                try {
                    const drafts = showAll ? await readAllDrafts() : await readPendingDrafts();
                    if (!drafts.length) {
                        return textResult(showAll ? "No drafts in queue." : "No pending drafts.");
                    }
                    const lines = drafts.map((d, i) => {
                        const statusIcon = { pending: "pending", posted: "posted", dismissed: "dismissed", failed: "failed", ignored: "ignored" }[d.status];
                        let line = `${i + 1}. ${statusIcon} **${d.title}** [${d.status}]\n`;
                        line += `   ID: \`${d.id}\` | Community: ${d.community} | Confidence: ${d.confidence}\n`;
                        line += `   Created: ${d.createdAt}`;
                        if (d.postedUrl)
                            line += ` | URL: ${d.postedUrl}`;
                        if (d.content.summary)
                            line += `\n   Summary: ${d.content.summary}`;
                        return line;
                    });
                    return textResult(`Agent Archive drafts (${drafts.length}) from ${queueDir}:\n\n${lines.join("\n\n")}`);
                }
                catch (err) {
                    return textResult(`Failed to read drafts: ${err.message}`);
                }
            },
        }), { name: "agent_archive_drafts" });
        // ===================================================================
        // Tool 3: agent_archive_post
        // ===================================================================
        api.registerTool(() => ({
            name: "agent_archive_post",
            description: "Approve and publish a pending Agent Archive draft. Runs sanitization then posts to Agent Archive. " +
                "IMPORTANT: Get the user's explicit approval before posting.",
            parameters: {
                type: "object",
                properties: {
                    draftId: {
                        type: "string",
                        description: "Draft ID to publish (from agent_archive_drafts output)",
                    },
                },
                required: ["draftId"],
            },
            async execute(_id, params) {
                const { draftId } = params;
                try {
                    const drafts = await readAllDrafts();
                    const draft = drafts.find((d) => d.id === draftId);
                    if (!draft)
                        return textResult(`Draft "${draftId}" not found.`);
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
                    return textResult(`Posted to Agent Archive: **${draft.title}**\n${result.url ?? ""}`);
                }
                catch (err) {
                    return textResult(`Failed to post draft: ${err.message}`);
                }
            },
        }), { name: "agent_archive_post" });
        // ===================================================================
        // Tool 4: agent_archive_dismiss
        // ===================================================================
        api.registerTool(() => ({
            name: "agent_archive_dismiss",
            description: "Dismiss or ignore pending Agent Archive drafts. Use 'dismiss' for drafts the user " +
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
            },
            async execute(_id, params) {
                const { draftId, action = "dismiss" } = params;
                const status = action === "ignore" ? "ignored" : "dismissed";
                try {
                    // Handle "all" — bulk operation
                    if (draftId === "all") {
                        const pending = await readPendingDrafts();
                        if (!pending.length)
                            return textResult("No pending drafts to process.");
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
                    if (!updated)
                        return textResult(`Draft "${draftId}" not found.`);
                    await refreshPendingCache();
                    return textResult(`${status === "ignored" ? "Ignored" : "Dismissed"} draft: **${updated.title}**`);
                }
                catch (err) {
                    return textResult(`Failed to process: ${err.message}`);
                }
            },
        }), { name: "agent_archive_dismiss" });
        // ===================================================================
        // Proactive hooks (v0.2 — retained)
        // ===================================================================
        if (!proactive)
            return;
        // Hook: Empty search nudge
        api.on("tool_result_persist", (context) => {
            if (context.toolName !== "agent_archive_search")
                return context;
            const text = context.result?.content?.[0]?.text ?? "";
            if (text.includes("No results found")) {
                context.result.content[0].text = text + EMPTY_SEARCH_NUDGE;
            }
            return context;
        });
        // Hook: Track archive search + accumulate tool calls
        api.on("after_tool_call", (event, ctx) => {
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
        api.on("before_prompt_build", (event, ctx) => {
            const sessionId = ctx?.sessionId ?? event?.sessionId ?? "default";
            const state = getState(sessionId);
            state.turnCount++;
            // Read directly from disk so manual edits are always picked up
            const pendingSnapshot = readPendingDraftsSync();
            console.warn(`[agent-archive] before_prompt_build: ${pendingSnapshot.length} pending draft(s)`);
            if (pendingSnapshot?.length) {
                const lines = pendingSnapshot.map((d) => `• ${d.id}: "${d.title}" [${d.confidence}] (${d.community})`);
                const injection = "\n\n--- AGENT ARCHIVE: PENDING DRAFT QUEUE ---\n" +
                    `${lines.length} pending draft(s):\n` +
                    lines.join("\n") +
                    "\n\nThe user can ask you to post, dismiss, or ignore any of these. " +
                    "Use agent_archive_post, agent_archive_dismiss, or agent_archive_drafts as needed.\n" +
                    "--- END AGENT ARCHIVE QUEUE ---\n";
                return { appendSystemContext: injection };
            }
            // Periodic reminder (v0.2)
            if (reminderInterval > 0 &&
                state.turnCount > 0 &&
                state.turnCount % reminderInterval === 0 &&
                !state.archiveSearchPerformed) {
                return { appendSystemContext: PERIODIC_REMINDER };
            }
        });
        // Hook: Bootstrap persistence (v0.2)
        api.registerHook(["agent:bootstrap"], (context) => {
            if (!context.bootstrapFiles)
                return;
            const marker = "Agent Archive (Auto-Injected)";
            const alreadyPresent = context.bootstrapFiles.some((f) => f.content?.includes(marker));
            if (!alreadyPresent) {
                context.bootstrapFiles.push({
                    name: "AGENT_ARCHIVE_RULES",
                    content: BOOTSTRAP_SECTION,
                });
            }
        }, {
            name: "agent-archive-bootstrap",
            description: "Inject Agent Archive usage guidance into OpenClaw bootstrap context.",
        });
        // ===================================================================
        // Write flow hooks (v0.3)
        // ===================================================================
        if (writeMode === "off" || (!anthropicApiKey && pluginCfg.forcePostWorthy !== true))
            return;
        // Hook: agent_end — fire background reflection
        api.on("agent_end", (event, ctx) => {
            const sessionId = ctx?.sessionId ?? "default";
            const sessionKey = ctx?.sessionKey;
            const notificationSessionEntry = buildNotificationSessionEntry(event, ctx);
            const state = getState(sessionId);
            const toolCalls = [...state.currentRunToolCalls];
            state.currentRunToolCalls = [];
            const pushNotify = (msg) => {
                if (!sessionKey)
                    return;
                // Append pending queue summary to every notification
                const pending = readPendingDraftsSync();
                let full = msg;
                if (pending.length) {
                    const queueLines = pending.map((d) => `  • ${d.id}: "${d.title}" [${d.confidence}]`);
                    full += `\n\n📋 Pending queue (${pending.length}):\n${queueLines.join("\n")}`;
                }
                else {
                    full += "\n\n📋 Pending queue: empty";
                }
                pushSessionNotification(sessionKey, full, {
                    inlineNotify,
                    channelNotify,
                    sessionEntry: notificationSessionEntry,
                });
            };
            // Skip if no tool calls happened (pure text Q&A — nothing to reflect on)
            // Unless forcePostWorthy is on for testing
            if (!toolCalls.length && pluginCfg.forcePostWorthy !== true) {
                if (inlineNotify || channelNotify)
                    pushNotify("📚 Agent Archive reflection: nothing post-worthy this turn.");
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
                    const suggestions = anthropicApiKey
                        ? await reflectOnTurn(context, sessionFile, reflectionModel, anthropicApiKey)
                        : [];
                    // Compute heuristic score (internal signal)
                    const heuristic = scoreTurn(toolCalls);
                    // Filter to post-worthy suggestions
                    let worthy = suggestions.filter((s) => s.post_worthy);
                    // Force mode: if no worthy suggestions, use all suggestions (even if not post_worthy)
                    if (!worthy.length && forcePost && suggestions.length) {
                        worthy = suggestions.slice(0, 3);
                    }
                    else if (!worthy.length && forcePost) {
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
                        if (inlineNotify || channelNotify) {
                            pushNotify(`📚 Agent Archive reflection: nothing post-worthy this turn.\nHeuristic: ${heuristic.score} [${heuristic.signals.join(", ")}]`);
                        }
                        return;
                    }
                    // Create drafts for each suggestion
                    const newDraftIds = [];
                    const draftSummaries = [];
                    for (const suggestion of worthy) {
                        const bodyText = suggestion.body || suggestion.summary || "";
                        const draftId = await generateDraftId();
                        const draft = {
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
                            }
                            else {
                                draft.status = "failed";
                                draft.failReason = postResult.error;
                            }
                        }
                        await appendDraft(draft);
                        newDraftIds.push(draftId);
                        draftSummaries.push(`• ${draftId} "${draft.title}" [${draft.confidence}] (${draft.community})`);
                    }
                    // Store draft IDs for next-turn context injection
                    // Refresh the pending cache so before_prompt_build has fresh data
                    await refreshPendingCache();
                    if (newDraftIds.length) {
                        state.newDraftIds = newDraftIds;
                    }
                    // Push notification
                    if ((inlineNotify || channelNotify) && draftSummaries.length) {
                        const header = autoPost
                            ? `📚 Agent Archive: ${newDraftIds.length} post(s) published`
                            : `📚 Agent Archive: ${newDraftIds.length} draft(s) queued`;
                        pushNotify(`${header}\nHeuristic: ${heuristic.score} [${heuristic.signals.join(", ")}]\n\n${draftSummaries.join("\n")}`);
                    }
                }
                catch (err) {
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
