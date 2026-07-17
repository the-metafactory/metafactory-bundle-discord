/**
 * Unit tests for guild-level settings (`cli/lib/guild/settings.ts`, issue #16).
 *
 * ALL network calls are mocked via Bun's `spyOn(globalThis, "fetch")` — no live
 * Discord API. The transport's sleeper is swapped for a no-op so the
 * rate-limit-pacing path in `discordRequest` never spends wall-clock time.
 *
 * Invariants covered:
 *   - modifyGuild refuses any key outside the writable whitelist
 *   - enableCommunity orchestration ORDER: GET → PATCH(prereqs) → PATCH(features)
 *   - enableCommunity surfaces Discord's 400 body verbatim, and a 403 as the
 *     ADMINISTRATOR requirement (naming the guild, never the token)
 *   - welcome screen enforces the 5-channel cap client-side (no API call)
 *   - onboarding shape validation refuses malformed/unknown fields
 *   - the bot token NEVER appears in any surfaced error
 */

import { describe, expect, test, afterEach, spyOn } from "bun:test";
import { __setSleeperForTest } from "../lib/http";
import {
  getGuild,
  modifyGuild,
  enableCommunity,
  getWelcomeScreen,
  modifyWelcomeScreen,
  getOnboarding,
  modifyOnboarding,
  verificationLevelName,
  verificationLevelValue,
  VERIFICATION_LEVELS,
  WRITABLE_GUILD_FIELDS,
  MAX_WELCOME_CHANNELS,
} from "../lib/guild/settings";
import { parseWelcomeChannelSpec } from "../commands/guild";

const GUILD = "100000000000000001";
const TOKEN = "Bot.secret-token-must-not-appear-in-errors";

/** Build a JSON `Response` with a given status. */
function res(status: number, body: unknown = null, headers: Record<string, string> = {}): Response {
  const init: ResponseInit = { status, headers: { "Content-Type": "application/json", ...headers } };
  if (status === 204 || body === null) return new Response(null, init);
  return new Response(JSON.stringify(body), init);
}

// Neutralise the transport sleeper for the whole file (no wall-clock pacing).
const restoreSleeper = __setSleeperForTest(async () => {});
afterEach(() => {
  // Re-assert the no-op sleeper in case a test swapped it; restored at process exit.
  __setSleeperForTest(async () => {});
});
// Keep the original around so a future teardown could restore it.
void restoreSleeper;

// ─── verification level helpers ─────────────────────────────────────────────

describe("verification levels", () => {
  test("name ⇄ value round-trip", () => {
    expect(verificationLevelValue("low")).toBe(1);
    expect(verificationLevelValue("HIGHEST")).toBe(4);
    expect(verificationLevelName(1)).toBe("low");
    expect(verificationLevelName(0)).toBe("none");
  });

  test("unknown name throws listing the valid set", () => {
    expect(() => verificationLevelValue("ultra")).toThrow(/Valid: none, low, medium, high, highest/);
  });

  test("out-of-range value renders unknown(n) rather than throwing", () => {
    expect(verificationLevelName(9)).toBe("unknown(9)");
  });
});

// ─── getGuild ───────────────────────────────────────────────────────────────

describe("getGuild", () => {
  test("projects exactly the fields the CLI reads", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, {
        id: GUILD,
        name: "Grove",
        features: ["NEWS"],
        verification_level: 2,
        system_channel_id: "1",
        rules_channel_id: "2",
        public_updates_channel_id: "3",
        description: "hi",
        premium_tier: 1,
        // extraneous fields must be dropped by the projection
        owner_id: "999",
      })
    );

    const g = await getGuild(TOKEN, GUILD);

    expect(g).toEqual({
      id: GUILD,
      name: "Grove",
      features: ["NEWS"],
      verification_level: 2,
      system_channel_id: "1",
      rules_channel_id: "2",
      public_updates_channel_id: "3",
      description: "hi",
      premium_tier: 1,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}`);
    expect(init.method).toBe("GET");

    fetchMock.mockRestore();
  });

  test("non-2xx throws with status + body, never the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(403, { message: "Missing Access" })
    );
    let error: Error | undefined;
    try {
      await getGuild(TOKEN, GUILD);
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(/403/);
    expect(error?.message).not.toContain(TOKEN);
    fetchMock.mockRestore();
  });
});

// ─── modifyGuild — field whitelist ──────────────────────────────────────────

describe("modifyGuild — writable field whitelist", () => {
  test("accepts the whitelisted fields and PATCHes exactly them", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { id: GUILD, name: "Grove", verification_level: 1, rules_channel_id: "2" })
    );

    await modifyGuild(TOKEN, GUILD, { verification_level: 1, rules_channel_id: "2" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ verification_level: 1, rules_channel_id: "2" });

    fetchMock.mockRestore();
  });

  test("refuses unknown keys client-side — no API call made", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    await expect(
      // @ts-expect-error — intentionally passing a non-writable key
      modifyGuild(TOKEN, GUILD, { name: "hijack", verification_level: 1 })
    ).rejects.toThrow(/Unknown guild field\(s\): name/);
    expect(fetchMock.mock.calls.length).toBe(0);
    fetchMock.mockRestore();
  });

  test("the whitelist is exactly the six documented writable fields", () => {
    expect(([...WRITABLE_GUILD_FIELDS] as string[]).sort()).toEqual(
      ([
        "description",
        "features",
        "public_updates_channel_id",
        "rules_channel_id",
        "system_channel_id",
        "verification_level",
      ] as string[]).sort()
    );
  });
});

// ─── enableCommunity — orchestration order + error surfacing ─────────────────

describe("enableCommunity — orchestration", () => {
  test("order: GET guild → PATCH prereqs → PATCH features; features deduped", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      // 1. GET current guild (below LOW, no COMMUNITY yet)
      .mockResolvedValueOnce(
        res(200, { id: GUILD, name: "Grove", features: ["NEWS"], verification_level: 0 })
      )
      // 2. PATCH prereqs
      .mockResolvedValueOnce(res(200, { id: GUILD, name: "Grove", features: ["NEWS"], verification_level: 1 }))
      // 3. PATCH features
      .mockResolvedValueOnce(
        res(200, { id: GUILD, name: "Grove", features: ["NEWS", "COMMUNITY"], verification_level: 1 })
      );

    const result = await enableCommunity(TOKEN, GUILD, {
      rulesChannelId: "111",
      updatesChannelId: "222",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(3);

    // Call 1 — GET.
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe("GET");

    // Call 2 — PATCH prereqs: both channels + verification raised to LOW.
    const [, patch1] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(patch1.method).toBe("PATCH");
    expect(JSON.parse(patch1.body as string)).toEqual({
      rules_channel_id: "111",
      public_updates_channel_id: "222",
      verification_level: VERIFICATION_LEVELS.low,
    });

    // Call 3 — PATCH features = existing + COMMUNITY (deduped, order preserved).
    const [, patch2] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(patch2.method).toBe("PATCH");
    expect(JSON.parse(patch2.body as string)).toEqual({ features: ["NEWS", "COMMUNITY"] });

    expect(result.guild?.features).toContain("COMMUNITY");
    fetchMock.mockRestore();
  });

  test("verification already >= LOW → prereq PATCH omits verification_level", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(200, { id: GUILD, name: "Grove", features: [], verification_level: 3 }))
      .mockResolvedValueOnce(res(200, { id: GUILD, name: "Grove", features: [], verification_level: 3 }))
      .mockResolvedValueOnce(
        res(200, { id: GUILD, name: "Grove", features: ["COMMUNITY"], verification_level: 3 })
      );

    await enableCommunity(TOKEN, GUILD, { rulesChannelId: "111", updatesChannelId: "222" });

    const [, patch1] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(patch1.body as string)).toEqual({
      rules_channel_id: "111",
      public_updates_channel_id: "222",
    });
    fetchMock.mockRestore();
  });

  test("already COMMUNITY → short-circuits after the GET (no PATCH)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { id: GUILD, name: "Grove", features: ["COMMUNITY"], verification_level: 1 })
    );
    const result = await enableCommunity(TOKEN, GUILD, { rulesChannelId: "1", updatesChannelId: "2" });
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(result.steps.join("\n")).toMatch(/already enabled/i);
    fetchMock.mockRestore();
  });

  test("400 on prereq PATCH → Discord body surfaced verbatim, token absent", async () => {
    const discordBody = { message: "Community requires: rules_channel_id, public_updates_channel_id", code: 50035 };
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(200, { id: GUILD, name: "Grove", features: [], verification_level: 0 }))
      .mockResolvedValueOnce(res(400, discordBody));

    const result = await enableCommunity(TOKEN, GUILD, { rulesChannelId: "1", updatesChannelId: "2" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(JSON.stringify(discordBody));
    expect(result.error).not.toContain(TOKEN);
    // Failed before the features PATCH — only GET + one PATCH happened.
    expect(fetchMock.mock.calls.length).toBe(2);
    fetchMock.mockRestore();
  });

  test("403 on features PATCH → ADMINISTRATOR requirement, naming the guild, not the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(200, { id: GUILD, name: "Grove", features: [], verification_level: 0 }))
      .mockResolvedValueOnce(res(200, { id: GUILD, name: "Grove", features: [], verification_level: 1 }))
      .mockResolvedValueOnce(res(403, { message: "Missing Permissions" }));

    const result = await enableCommunity(TOKEN, GUILD, { rulesChannelId: "1", updatesChannelId: "2" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ADMINISTRATOR/);
    expect(result.error).toContain(GUILD);
    expect(result.error).not.toContain(TOKEN);
    fetchMock.mockRestore();
  });
});

// ─── welcome screen — 5-channel cap ─────────────────────────────────────────

describe("welcome screen", () => {
  test("modifyWelcomeScreen refuses > 5 channels client-side — no API call", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const six = Array.from({ length: 6 }, (_, i) => ({
      channel_id: String(i),
      description: `c${i}`,
    }));
    await expect(modifyWelcomeScreen(TOKEN, GUILD, { welcome_channels: six })).rejects.toThrow(
      new RegExp(`max ${MAX_WELCOME_CHANNELS}`)
    );
    expect(fetchMock.mock.calls.length).toBe(0);
    fetchMock.mockRestore();
  });

  test("exactly 5 channels is accepted and PATCHed", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ channel_id: String(i), description: `c${i}` }));
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { enabled: true, description: "d", welcome_channels: five })
    );
    const ws = await modifyWelcomeScreen(TOKEN, GUILD, { welcome_channels: five });
    expect(ws.welcome_channels.length).toBe(5);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/welcome-screen`);
    expect(init.method).toBe("PATCH");
    fetchMock.mockRestore();
  });

  test("getWelcomeScreen projects enabled/description/channels", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { enabled: false, description: null, welcome_channels: [] })
    );
    const ws = await getWelcomeScreen(TOKEN, GUILD);
    expect(ws).toEqual({ enabled: false, description: null, welcome_channels: [] });
    fetchMock.mockRestore();
  });
});

// ─── onboarding — shape validation ──────────────────────────────────────────

describe("onboarding shape validation", () => {
  test("valid spec PATCHes the onboarding endpoint", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { guild_id: GUILD, enabled: true, mode: 1, prompts: [], default_channel_ids: ["1"] })
    );
    await modifyOnboarding(TOKEN, GUILD, { enabled: true, mode: 1, prompts: [], default_channel_ids: ["1"] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/onboarding`);
    expect(init.method).toBe("PATCH");
    fetchMock.mockRestore();
  });

  test("unknown key refused client-side — no API call", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    await expect(
      // @ts-expect-error — intentionally passing an unknown key
      modifyOnboarding(TOKEN, GUILD, { enabled: true, bogus: 1 })
    ).rejects.toThrow(/Unknown onboarding field\(s\): bogus/);
    expect(fetchMock.mock.calls.length).toBe(0);
    fetchMock.mockRestore();
  });

  test("prompts must be an array; default_channel_ids must be string[]", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    // @ts-expect-error — wrong prompts type
    await expect(modifyOnboarding(TOKEN, GUILD, { prompts: "nope" })).rejects.toThrow(/prompts must be an array/);
    await expect(
      // @ts-expect-error — wrong default_channel_ids element type
      modifyOnboarding(TOKEN, GUILD, { default_channel_ids: [1, 2] })
    ).rejects.toThrow(/array of channel id strings/);
    expect(fetchMock.mock.calls.length).toBe(0);
    fetchMock.mockRestore();
  });

  test("getOnboarding passes the object through", async () => {
    const payload = { guild_id: GUILD, enabled: false, mode: 0, prompts: [], default_channel_ids: [] };
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(res(200, payload));
    const ob = await getOnboarding(TOKEN, GUILD);
    expect(ob).toEqual(payload);
    fetchMock.mockRestore();
  });
});

// ─── welcome-channel spec parsing (command-layer helper) ────────────────────

describe("parseWelcomeChannelSpec", () => {
  test("splits on the first two colons; text may contain colons", () => {
    expect(parseWelcomeChannelSpec("rules:👋:Read the rules: really")).toEqual({
      channel: "rules",
      emoji: "👋",
      text: "Read the rules: really",
    });
  });

  test("empty emoji segment is allowed (id::text)", () => {
    expect(parseWelcomeChannelSpec("123::Welcome")).toEqual({ channel: "123", emoji: "", text: "Welcome" });
  });

  test("missing colons → null", () => {
    expect(parseWelcomeChannelSpec("rules")).toBeNull();
    expect(parseWelcomeChannelSpec("rules:only-one")).toBeNull();
  });

  test("empty channel segment → null", () => {
    expect(parseWelcomeChannelSpec(":👋:text")).toBeNull();
  });
});
