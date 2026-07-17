/**
 * Unit tests for guild webhook management (issue #15).
 *
 * Covered:
 *   - createWebhook: client-side name validation (no API call for a bad name),
 *     cap-error surfacing, success returns id + URL.
 *   - listWebhooks: the webhook `token` field is NEVER surfaced or serialized.
 *   - executeWebhook: identity-override payload shape, no bot Authorization
 *     header, token never leaks into an error.
 *   - execWebhookGated: the confidentiality gate is invoked BEFORE the sender,
 *     and a warn/block result is advisory (still sends — warn-only rollout).
 *
 * ALL network calls are mocked via Bun's `spyOn(globalThis, "fetch")`.
 * Redaction discipline: a webhook token is a posting credential and must never
 * appear in output, errors, or serialized data — several tests enforce this.
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  executeWebhook,
  validateWebhookName,
  parseWebhookUrl,
  type WebhookSummary,
} from "../lib/guild/webhooks";
import { execWebhookGated } from "../commands/webhook";
import type { GateResult } from "../lib/confidentiality-gate";
import type { DiscordCliConfig } from "../lib/config";

// ─── fixtures ───────────────────────────────────────────────────────────────

const BOT_TOKEN = "Bot.secret-bot-token-must-not-appear-in-any-output";
const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const WEBHOOK_ID = "300000000000000003";
// Synthetic webhook token — the credential that must NEVER leak into list/errors.
const WEBHOOK_TOKEN = "wh-secret-token-must-never-leak-AaBbCc123";
const WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;

/** Build a `Response`-like mock accepted by `fetch`. */
function fakeResponse(status: number, body: unknown = null): Response {
  const text = body === null ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

// ─── validateWebhookName ──────────────────────────────────────────────────────

describe("validateWebhookName", () => {
  test("plain name → valid (null)", () => {
    expect(validateWebhookName("town-crier")).toBeNull();
  });

  test('contains "discord" → rejected', () => {
    expect(validateWebhookName("discord-bot")).toMatch(/discord/);
  });

  test('contains "clyde" (any case) → rejected', () => {
    expect(validateWebhookName("Clyde The Herald")).toMatch(/clyde/);
  });

  test("empty/whitespace → rejected", () => {
    expect(validateWebhookName("   ")).toMatch(/required/i);
  });

  test("over 80 chars → rejected", () => {
    expect(validateWebhookName("x".repeat(81))).toMatch(/80/);
  });
});

// ─── createWebhook ────────────────────────────────────────────────────────────

describe("createWebhook", () => {
  test('name containing "discord" is rejected client-side — NO API call', async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createWebhook(BOT_TOKEN, CHANNEL, { name: "my-discord-hook" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/discord/);
    expect(fetchMock.mock.calls.length).toBe(0); // rejected before any network call

    fetchMock.mockRestore();
  });

  test('name containing "clyde" is rejected client-side — NO API call', async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createWebhook(BOT_TOKEN, CHANNEL, { name: "clyde2" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/clyde/);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test("valid name → POST channel webhooks, returns id + one-time URL", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, { id: WEBHOOK_ID, name: "town-crier", channel_id: CHANNEL, token: WEBHOOK_TOKEN })
    );

    const result = await createWebhook(BOT_TOKEN, CHANNEL, { name: "town-crier" });

    expect(result.success).toBe(true);
    expect(result.id).toBe(WEBHOOK_ID);
    expect(result.url).toBe(WEBHOOK_URL);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/webhooks`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "town-crier" });

    fetchMock.mockRestore();
  });

  test("Discord webhook cap error (code 30007) → surfaced plainly, token-free", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(400, { message: "Maximum number of webhooks reached (15)", code: 30007 })
    );

    const result = await createWebhook(BOT_TOKEN, CHANNEL, { name: "town-crier" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cap reached/i);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── listWebhooks — REDACTION ─────────────────────────────────────────────────

describe("listWebhooks", () => {
  test("projects id/name/channel/app and NEVER the token field", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, [
        // Discord returns the token field on Incoming webhooks — it must be dropped.
        { id: WEBHOOK_ID, name: "town-crier", channel_id: CHANNEL, application_id: null, token: WEBHOOK_TOKEN },
        { id: "300000000000000009", name: "bell", channel_id: CHANNEL, application_id: "500000000000000005", token: "another-secret-token" },
      ])
    );

    const result = await listWebhooks(BOT_TOKEN, GUILD);

    expect(result.success).toBe(true);
    const webhooks = result.webhooks as WebhookSummary[];
    expect(webhooks).toHaveLength(2);
    expect(webhooks[0]).toEqual({ id: WEBHOOK_ID, name: "town-crier", channelId: CHANNEL, applicationId: null });

    // No projected object carries a `token` property at all.
    for (const w of webhooks) {
      expect("token" in w).toBe(false);
    }

    // The token value never appears anywhere in the serialized result — the
    // exact discipline enforced for the bot token.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(WEBHOOK_TOKEN);
    expect(serialized).not.toContain("another-secret-token");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/webhooks`);

    fetchMock.mockRestore();
  });

  test("API error → surfaced without the bot token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await listWebhooks(BOT_TOKEN, GUILD);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/403/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── deleteWebhook ────────────────────────────────────────────────────────────

describe("deleteWebhook", () => {
  test("204 → success; DELETE /webhooks/{id}", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(204));

    const result = await deleteWebhook(BOT_TOKEN, WEBHOOK_ID);

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/webhooks/${WEBHOOK_ID}`);
    expect(init?.method).toBe("DELETE");

    fetchMock.mockRestore();
  });

  test("404 → error surfaced without the bot token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(404, { message: "Unknown Webhook" })
    );

    const result = await deleteWebhook(BOT_TOKEN, WEBHOOK_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/404/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── parseWebhookUrl ──────────────────────────────────────────────────────────

describe("parseWebhookUrl", () => {
  test("standard URL → { id, token }", () => {
    expect(parseWebhookUrl(WEBHOOK_URL)).toEqual({ id: WEBHOOK_ID, token: WEBHOOK_TOKEN });
  });

  test("/api/v10 variant → parsed", () => {
    expect(parseWebhookUrl(`https://discord.com/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`)).toEqual({
      id: WEBHOOK_ID,
      token: WEBHOOK_TOKEN,
    });
  });

  test("non-webhook URL → null", () => {
    expect(parseWebhookUrl("https://discord.com/api/v10/channels/123/messages")).toBeNull();
  });
});

// ─── executeWebhook — identity override + no bot auth + token redaction ───────

describe("executeWebhook", () => {
  test("identity override → POST /webhooks/{id}/{token} with content+username+avatar_url, no bot auth", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(204));

    const result = await executeWebhook(WEBHOOK_ID, WEBHOOK_TOKEN, {
      content: "ding",
      username: "Town Crier",
      avatar_url: "https://example.com/crier.png",
    });

    expect(result.success).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
    expect(init?.method).toBe("POST");
    // Identity override is the whole point — the payload must carry it.
    expect(JSON.parse(init?.body as string)).toEqual({
      content: "ding",
      username: "Town Crier",
      avatar_url: "https://example.com/crier.png",
    });
    // Webhook execution needs NO bot token — there must be no Authorization header.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();

    fetchMock.mockRestore();
  });

  test("no identity override → payload is content-only", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(204));

    await executeWebhook(WEBHOOK_ID, WEBHOOK_TOKEN, { content: "plain" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init?.body as string)).toEqual({ content: "plain" });

    fetchMock.mockRestore();
  });

  test("error body echoing the token → token is REDACTED out of the error", async () => {
    // Defensive: even if Discord echoed the token back, it must not survive into our error.
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(`{"message":"bad token ${WEBHOOK_TOKEN}"}`, { status: 401 })
    );

    const result = await executeWebhook(WEBHOOK_ID, WEBHOOK_TOKEN, { content: "x" });

    expect(result.success).toBe(false);
    expect(result.error).not.toContain(WEBHOOK_TOKEN);
    expect(result.error).toContain("[REDACTED]");

    fetchMock.mockRestore();
  });
});

// ─── execWebhookGated — gate is invoked BEFORE send (warn-only) ───────────────

describe("execWebhookGated", () => {
  const config: DiscordCliConfig = {};

  /** A clean gate result (nothing to warn about). */
  function cleanGate(): GateResult {
    return { ok: true, blocked: false, classification: "public", findings: [] };
  }

  test("gate is consulted with the exec content BEFORE the sender runs", async () => {
    let gateCalledAt = 0;
    let sendCalledAt = 0;
    let seq = 0;

    const gate = spyOn({ gate: (_: unknown) => cleanGate() }, "gate").mockImplementation(() => {
      gateCalledAt = ++seq;
      return cleanGate();
    });
    const send = spyOn({ send: async () => ({ success: true }) }, "send").mockImplementation(async () => {
      sendCalledAt = ++seq;
      return { success: true };
    });

    const result = await execWebhookGated(
      { url: WEBHOOK_URL, content: "ding", username: "Town Crier", avatarUrl: "https://example.com/c.png", guildId: GUILD, config },
      { gate: gate as never, send: send as never }
    );

    expect(result.ok).toBe(true);
    // Gate ran, and ran first.
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gateCalledAt).toBeLessThan(sendCalledAt);
    // Gate saw the actual content + resolved guild.
    const gateArg = gate.mock.calls[0]?.[0] as { content: string; guildId?: string };
    expect(gateArg.content).toBe("ding");
    expect(gateArg.guildId).toBe(GUILD);
    // Sender received the parsed id/token + the identity override.
    expect(send).toHaveBeenCalledWith(WEBHOOK_ID, WEBHOOK_TOKEN, {
      content: "ding",
      username: "Town Crier",
      avatar_url: "https://example.com/c.png",
    });
  });

  test("warn/block gate result is advisory — the message is STILL sent (warn-only)", async () => {
    const blockedGate: GateResult = {
      ok: false,
      blocked: true,
      classification: "public",
      findings: [{ source: "message", ruleId: "denylist", class: "denylist-term", action: "block", descriptor: "hit" }],
      reason: "blocked",
    };
    const gate = spyOn({ gate: (_: unknown) => blockedGate }, "gate").mockReturnValue(blockedGate);
    const send = spyOn({ send: async () => ({ success: true }) }, "send").mockResolvedValue({ success: true });

    const result = await execWebhookGated(
      { url: WEBHOOK_URL, content: "secret", guildId: GUILD, config },
      { gate: gate as never, send: send as never }
    );

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1); // advisory: block does not stop the send
    expect(result.gateWarnings.some((l) => l.includes("BLOCK"))).toBe(true);
  });

  test("unknown guild (undefined) is passed through — gate classifies it public", async () => {
    const gate = spyOn({ gate: (_: unknown) => cleanGate() }, "gate").mockReturnValue(cleanGate());
    const send = spyOn({ send: async () => ({ success: true }) }, "send").mockResolvedValue({ success: true });

    await execWebhookGated(
      { url: WEBHOOK_URL, content: "hi", guildId: undefined, config },
      { gate: gate as never, send: send as never }
    );

    const gateArg = gate.mock.calls[0]?.[0] as { guildId?: string };
    expect(gateArg.guildId).toBeUndefined();
  });

  test("invalid webhook URL → no gate, no send, clean error", async () => {
    const gate = spyOn({ gate: (_: unknown) => cleanGate() }, "gate").mockReturnValue(cleanGate());
    const send = spyOn({ send: async () => ({ success: true }) }, "send").mockResolvedValue({ success: true });

    const result = await execWebhookGated(
      { url: "https://example.com/not-a-webhook", content: "hi", guildId: GUILD, config },
      { gate: gate as never, send: send as never }
    );

    expect(result.ok).toBe(false);
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/invalid webhook url/i);
    expect(gate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
