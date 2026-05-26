import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const DEFAULT_TELEGRAM_BINDINGS_FILE = join(homedir(), ".openclaw", "telegram", "thread-bindings-default.json");
export const DEFAULT_SESSION_STORE_FILE = join(homedir(), ".openclaw", "agents", "main", "sessions", "sessions.json");
const SENDABLE_CHANNELS = new Set([
    "telegram",
    "whatsapp",
    "bluebubbles",
    "discord",
    "slack",
    "signal",
    "msteams",
    "matrix",
    "irc",
    "line",
    "zalo",
]);
function extractTarget(parts) {
    const directIdx = parts.indexOf("direct");
    const groupIdx = parts.indexOf("group");
    const targetIdx = directIdx >= 0
        ? directIdx + 1
        : groupIdx >= 0
            ? groupIdx + 1
            : -1;
    return targetIdx >= 0 ? parts[targetIdx] : undefined;
}
function extractTelegramThread(parts, target) {
    const threadIdx = parts.indexOf("thread");
    if (threadIdx < 0)
        return { kind: "none" };
    const afterThread = parts.slice(threadIdx + 1).filter(Boolean);
    if (afterThread.length === 1)
        return { kind: "found", threadId: afterThread[0] };
    if (afterThread.length === 2 && afterThread[0] === target) {
        return { kind: "found", threadId: afterThread[1] };
    }
    return { kind: "invalid", reason: "unrecognized Telegram thread session key" };
}
function lookupTelegramBinding(chatId, bindingPath) {
    if (!existsSync(bindingPath))
        return { kind: "not-found", storeExists: false };
    try {
        const raw = JSON.parse(readFileSync(bindingPath, "utf-8"));
        const matches = (raw.bindings ?? []).filter((binding) => binding.channel === "telegram" &&
            binding.chatId === chatId &&
            typeof binding.threadId === "string" &&
            binding.threadId.trim().length > 0);
        const uniqueThreadIds = [...new Set(matches.map((binding) => binding.threadId.trim()))];
        if (uniqueThreadIds.length === 1)
            return { kind: "found", threadId: uniqueThreadIds[0] };
        if (uniqueThreadIds.length > 1)
            return { kind: "ambiguous" };
        return { kind: "not-found", storeExists: true };
    }
    catch {
        return { kind: "ambiguous" };
    }
}
function normalizeTarget(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    const prefixed = trimmed.match(/^([a-z0-9_-]+):(.+)$/i);
    return prefixed?.[2] || trimmed;
}
function normalizeThreadId(value) {
    if (typeof value !== "string" && typeof value !== "number")
        return undefined;
    const threadId = String(value).trim();
    return threadId.length ? threadId : undefined;
}
function readSessionEntry(sessionKey, storePath) {
    if (!existsSync(storePath))
        return undefined;
    try {
        const raw = JSON.parse(readFileSync(storePath, "utf-8"));
        return raw[sessionKey];
    }
    catch {
        return undefined;
    }
}
function threadFromSessionEntry(entry, channel, target) {
    if (!entry)
        return undefined;
    const hintedChannel = entry.deliveryContext?.channel ??
        entry.route?.channel ??
        entry.origin?.provider ??
        entry.lastChannel;
    if (hintedChannel && hintedChannel !== channel)
        return undefined;
    const routeTarget = typeof entry.route?.target === "string"
        ? entry.route.target
        : entry.route?.target?.to;
    const hintedTarget = normalizeTarget(entry.deliveryContext?.to) ??
        normalizeTarget(routeTarget) ??
        normalizeTarget(entry.origin?.to) ??
        normalizeTarget(entry.lastTo);
    if (hintedTarget && hintedTarget !== target)
        return undefined;
    const routeThread = typeof entry.route?.thread === "object"
        ? entry.route.thread?.id
        : entry.route?.thread;
    return (normalizeThreadId(entry.deliveryContext?.threadId) ??
        normalizeThreadId(routeThread) ??
        normalizeThreadId(entry.origin?.threadId) ??
        normalizeThreadId(entry.lastThreadId));
}
export function resolveNotificationRoute(sessionKey, options = {}) {
    if (!sessionKey?.trim())
        return { kind: "unsupported", reason: "missing session key" };
    const parts = sessionKey.split(":").filter((part) => part.length > 0);
    if (parts.length < 3 || parts[0] !== "agent") {
        return { kind: "unsupported", reason: "unrecognized session key" };
    }
    const channel = parts[2];
    if (!channel || channel === "main" || channel === "explicit" || channel === "cron") {
        return { kind: "session-only", reason: `non-channel session: ${channel || "unknown"}` };
    }
    if (!SENDABLE_CHANNELS.has(channel)) {
        return { kind: "unsupported", reason: `unsupported channel: ${channel}` };
    }
    const target = extractTarget(parts);
    if (!target)
        return { kind: "unsupported", reason: `missing ${channel} target` };
    if (channel !== "telegram") {
        return { kind: "channel", channel, target };
    }
    const thread = extractTelegramThread(parts, target);
    if (thread.kind === "found") {
        return { kind: "channel", channel, target, threadId: thread.threadId };
    }
    if (thread.kind === "invalid") {
        return { kind: "unsupported", reason: thread.reason };
    }
    const providedSessionThreadId = threadFromSessionEntry(options.sessionEntry, channel, target);
    if (providedSessionThreadId) {
        return { kind: "channel", channel, target, threadId: providedSessionThreadId };
    }
    const sessionEntry = readSessionEntry(sessionKey, options.sessionStorePath ?? DEFAULT_SESSION_STORE_FILE);
    const sessionThreadId = threadFromSessionEntry(sessionEntry, channel, target);
    if (sessionThreadId) {
        return { kind: "channel", channel, target, threadId: sessionThreadId };
    }
    const bindingPath = options.telegramBindingPath ?? DEFAULT_TELEGRAM_BINDINGS_FILE;
    const binding = lookupTelegramBinding(target, bindingPath);
    if (!options.allowTelegramBindingFallback) {
        if (binding.kind === "found" || binding.kind === "ambiguous") {
            return {
                kind: "unsupported",
                reason: `Telegram thread binding exists for ${target}, but active thread was not resolved`,
            };
        }
        if (binding.storeExists) {
            return {
                kind: "unsupported",
                reason: `no active Telegram thread resolved for ${target}`,
            };
        }
        return { kind: "channel", channel, target };
    }
    if (binding.kind === "found") {
        return { kind: "channel", channel, target, threadId: binding.threadId };
    }
    if (binding.kind === "ambiguous") {
        return { kind: "unsupported", reason: `ambiguous Telegram thread binding for ${target}` };
    }
    if (binding.storeExists) {
        return { kind: "unsupported", reason: `no Telegram thread binding for ${target}` };
    }
    return { kind: "channel", channel, target };
}
