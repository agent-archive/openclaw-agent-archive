import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveNotificationRoute } from "../dist/notification-routing.js";

function tempBindingFile(bindings) {
  const dir = mkdtempSync(join(tmpdir(), "aa-route-"));
  const file = join(dir, "thread-bindings-default.json");
  writeFileSync(file, JSON.stringify({ version: 1, bindings }, null, 2));
  return file;
}

function missingFile() {
  return join(tmpdir(), `missing-aa-route-${Date.now()}-${Math.random()}.json`);
}

test("browser/main session routes to session-only", () => {
  assert.deepEqual(resolveNotificationRoute("agent:main:main"), {
    kind: "session-only",
    reason: "non-channel session: main",
  });
});

test("telegram direct session without binding store routes as DM", () => {
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789", {
      telegramBindingPath: missingFile(),
      sessionStorePath: missingFile(),
    }),
    { kind: "channel", channel: "telegram", target: "123456789" },
  );
});

test("telegram direct session uses active session entry thread before binding store", () => {
  const bindingPath = tempBindingFile([
    { channel: "telegram", chatId: "123456789", threadId: "1001" },
  ]);
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789", {
      telegramBindingPath: bindingPath,
      sessionEntry: {
        deliveryContext: {
          channel: "telegram",
          to: "telegram:123456789",
          threadId: 2002,
        },
      },
    }),
    { kind: "channel", channel: "telegram", target: "123456789", threadId: "2002" },
  );
});

test("telegram short thread session routes to target and thread", () => {
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789:thread:3003"),
    { kind: "channel", channel: "telegram", target: "123456789", threadId: "3003" },
  );
});

test("telegram long thread session routes to target and thread", () => {
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789:thread:123456789:1001"),
    { kind: "channel", channel: "telegram", target: "123456789", threadId: "1001" },
  );
});

test("whatsapp group session routes to group target", () => {
  assert.deepEqual(
    resolveNotificationRoute("agent:main:whatsapp:group:120000000000000000@g.us"),
    { kind: "channel", channel: "whatsapp", target: "120000000000000000@g.us" },
  );
});

test("malformed session key skips external send", () => {
  assert.deepEqual(resolveNotificationRoute("not-a-real-session-key"), {
    kind: "unsupported",
    reason: "unrecognized session key",
  });
});

test("malformed telegram thread session skips external send", () => {
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789:thread:other:3003"),
    {
      kind: "unsupported",
      reason: "unrecognized Telegram thread session key",
    },
  );
});

test("telegram direct session skips binding fallback by default", () => {
  const bindingPath = tempBindingFile([
    {
      channel: "telegram",
      accountId: "default",
      chatId: "123456789",
      threadId: "1001",
      sessionKey: "agent:main:telegram:direct:123456789:thread:123456789:1001",
    },
  ]);
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789", {
      telegramBindingPath: bindingPath,
      sessionStorePath: missingFile(),
    }),
    {
      kind: "unsupported",
      reason: "Telegram thread binding exists for 123456789, but active thread was not resolved",
    },
  );
});

test("telegram direct session can opt into exactly one matching binding fallback", () => {
  const bindingPath = tempBindingFile([
    {
      channel: "telegram",
      accountId: "default",
      chatId: "123456789",
      threadId: "1001",
      sessionKey: "agent:main:telegram:direct:123456789:thread:123456789:1001",
    },
  ]);
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789", {
      telegramBindingPath: bindingPath,
      sessionStorePath: missingFile(),
      allowTelegramBindingFallback: true,
    }),
    { kind: "channel", channel: "telegram", target: "123456789", threadId: "1001" },
  );
});

test("telegram direct session with existing store but no matching binding skips external send", () => {
  const bindingPath = tempBindingFile([]);
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789", {
      telegramBindingPath: bindingPath,
      sessionStorePath: missingFile(),
    }),
    { kind: "unsupported", reason: "no active Telegram thread resolved for 123456789" },
  );
});

test("telegram direct session with conflicting bindings skips external send", () => {
  const bindingPath = tempBindingFile([
    { channel: "telegram", chatId: "123456789", threadId: "1001" },
    { channel: "telegram", chatId: "123456789", threadId: "3003" },
  ]);
  assert.deepEqual(
    resolveNotificationRoute("agent:main:telegram:direct:123456789", {
      telegramBindingPath: bindingPath,
      sessionStorePath: missingFile(),
    }),
    {
      kind: "unsupported",
      reason: "Telegram thread binding exists for 123456789, but active thread was not resolved",
    },
  );
});
