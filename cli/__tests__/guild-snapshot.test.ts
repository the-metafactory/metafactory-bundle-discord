/**
 * Unit tests for the guild snapshot (issue #17).
 *
 * Covered:
 *   - full composition shape: guild + roles + categories + channels + events +
 *     webhooks + welcome_screen, all present.
 *   - name resolution: channel parents, overwrite targets, webhook/event channels
 *     and guild channel pointers resolve to names with ids alongside.
 *   - permission decode: overwrite allow/deny and role bitmasks become sorted
 *     PERMISSION_NAME arrays; unknown bits survive as `bit:N`.
 *   - 403-section skip: a webhooks 403 renders `unavailable(403 missing
 *     MANAGE_WEBHOOKS)`, the section is reported, and every other section is intact.
 *   - webhook-token-never-serialized: a token present on the upstream fixture is
 *     absent from the rendered YAML (redaction is test-enforced).
 *   - deterministic ordering: two runs serialize byte-identically (header aside).
 *
 * ALL network calls are mocked via Bun's `spyOn(globalThis, "fetch")`, routed by
 * URL so `snapshotGuild`'s many reads each get the right fixture.
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  snapshotGuild,
  serializeSnapshot,
  renderSnapshot,
  snapshotHeader,
  unavailableSections,
  isUnavailable,
  type GuildSnapshot,
  type SnapshotRole,
  type SnapshotChannel,
  type SnapshotCategory,
  type SnapshotOverwrite,
} from "../lib/guild/snapshot";

// ─── ids ────────────────────────────────────────────────────────────────────

const BOT_TOKEN = "Bot.secret-bot-token-must-not-appear-in-any-output";
const GUILD = "100000000000000001";
const ROLE_MODS = "100000000000000010";
const CAT = "200000000000000001";
const GEN = "200000000000000002";
const VOICE = "200000000000000003";
const FORUM = "200000000000000004";
const WEBHOOK_ID = "300000000000000001";
// Synthetic webhook token — the credential that must NEVER reach the YAML.
const WEBHOOK_TOKEN = "wh-secret-token-must-never-leak-AaBbCc123";

// ─── permission bit constants (mirror cli/lib/guild/permissions.ts) ─────────────

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const MANAGE_ROLES = 1n << 28n;
const UNKNOWN_BIT = 1n << 45n; // not in the PERMISSIONS map → decodes to `bit:45`

// ─── fixtures ───────────────────────────────────────────────────────────────

interface Fixtures {
  webhookStatus?: number; // override to 403 for the skip test
}

function guildBody() {
  return {
    id: GUILD,
    name: "Builders Guild",
    features: ["NEWS", "COMMUNITY"], // intentionally unsorted → snapshot sorts
    verification_level: 2,
    system_channel_id: GEN,
    rules_channel_id: GEN,
    public_updates_channel_id: null,
    description: "the workshop",
    premium_tier: 3,
  };
}

function rolesBody() {
  return [
    { id: GUILD, name: "@everyone", color: 0, hoist: false, position: 0, permissions: VIEW_CHANNEL.toString(), mentionable: false, managed: false },
    { id: ROLE_MODS, name: "mods", color: 3447003, hoist: true, position: 5, permissions: (MANAGE_ROLES | VIEW_CHANNEL).toString(), mentionable: true, managed: false },
  ];
}

/** The guild channel list (`listAllChannels`) — enumeration + ordering only. */
function channelListBody() {
  return [
    { id: CAT, name: "text-channels", type: 4, parent_id: null, position: 0, topic: null },
    { id: GEN, name: "general", type: 0, parent_id: CAT, position: 1, topic: "general chat" },
    { id: VOICE, name: "Lounge", type: 2, parent_id: CAT, position: 2, topic: null },
    { id: FORUM, name: "help", type: 15, parent_id: CAT, position: 3, topic: "ask here" },
  ];
}

/** Per-channel detail (`getChannel`) — overwrites + slowmode + forum fields. */
function channelDetail(channelId: string) {
  switch (channelId) {
    case CAT:
      return { id: CAT, name: "text-channels", type: 4, permission_overwrites: [] };
    case GEN:
      return {
        id: GEN,
        name: "general",
        type: 0,
        parent_id: CAT,
        topic: "general chat",
        rate_limit_per_user: 5,
        permission_overwrites: [
          { id: ROLE_MODS, type: 0, allow: (VIEW_CHANNEL | SEND_MESSAGES).toString(), deny: "0" },
        ],
      };
    case VOICE:
      return { id: VOICE, name: "Lounge", type: 2, parent_id: CAT, permission_overwrites: [] };
    case FORUM:
      return {
        id: FORUM,
        name: "help",
        type: 15,
        parent_id: CAT,
        topic: "ask here",
        rate_limit_per_user: 10,
        default_sort_order: 1,
        default_forum_layout: 2,
        available_tags: [{ id: "999", name: "bug", moderated: true, emoji_name: "🐛" }],
        // An overwrite carrying an unknown permission bit — must decode to bit:45.
        permission_overwrites: [
          { id: ROLE_MODS, type: 0, allow: (VIEW_CHANNEL | UNKNOWN_BIT).toString(), deny: "0" },
        ],
      };
    default:
      throw new Error(`no channel detail fixture for ${channelId}`);
  }
}

function eventsBody() {
  return [
    // Deliberately out of start-time order → snapshot must sort by start.
    { id: "400000000000000002", name: "Voice Standup", scheduled_start_time: "2026-08-05T09:00:00.000Z", scheduled_end_time: null, entity_type: 2, channel_id: VOICE, entity_metadata: null },
    { id: "400000000000000001", name: "Launch Party", scheduled_start_time: "2026-08-01T19:00:00.000Z", scheduled_end_time: "2026-08-01T21:00:00.000Z", entity_type: 3, channel_id: null, entity_metadata: { location: "The Internet" } },
  ];
}

function webhooksBody() {
  // Discord returns `token` on incoming webhooks — it must be dropped everywhere.
  return [{ id: WEBHOOK_ID, name: "town-crier", channel_id: GEN, application_id: null, token: WEBHOOK_TOKEN }];
}

function welcomeBody() {
  return {
    enabled: true,
    description: "Welcome!",
    welcome_channels: [{ channel_id: GEN, description: "start here", emoji_name: "👋", emoji_id: null }],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  const text = body === null ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

/** Install a URL-routed fetch spy covering every read `snapshotGuild` makes. */
function installFetch(fx: Fixtures = {}) {
  return spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

    // Order matters: match the specific guild sub-paths before the bare channel GET.
    if (url.endsWith(`/guilds/${GUILD}/roles`)) return Promise.resolve(jsonResponse(200, rolesBody()));
    if (url.endsWith(`/guilds/${GUILD}/channels`)) return Promise.resolve(jsonResponse(200, channelListBody()));
    if (url.includes(`/guilds/${GUILD}/scheduled-events`)) return Promise.resolve(jsonResponse(200, eventsBody()));
    if (url.endsWith(`/guilds/${GUILD}/webhooks`)) {
      const status = fx.webhookStatus ?? 200;
      if (status !== 200) return Promise.resolve(jsonResponse(status, { message: "Missing Permissions", code: 50013 }));
      return Promise.resolve(jsonResponse(200, webhooksBody()));
    }
    if (url.endsWith(`/guilds/${GUILD}/welcome-screen`)) return Promise.resolve(jsonResponse(200, welcomeBody()));
    if (url.endsWith(`/guilds/${GUILD}`)) return Promise.resolve(jsonResponse(200, guildBody()));

    const chan = url.match(/\/channels\/(\d+)$/);
    if (chan) return Promise.resolve(jsonResponse(200, channelDetail(chan[1]!)));

    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch);
}

/** Narrow a section to its data form (fails the test if it's an `unavailable` marker). */
function data<T>(value: T | string): T {
  if (isUnavailable(value)) throw new Error(`expected data, got ${value}`);
  return value as T;
}

// ─── composition shape ────────────────────────────────────────────────────────

describe("snapshotGuild — composition shape", () => {
  test("every section is present and populated", async () => {
    const fetchMock = installFetch();
    const snap = await snapshotGuild(BOT_TOKEN, GUILD);
    fetchMock.mockRestore();

    expect(snap.guild.id).toBe(GUILD);
    expect(snap.guild.name).toBe("Builders Guild");
    expect(snap.guild.verification_level).toBe("medium");
    expect(snap.guild.premium_tier).toBe(3);
    expect(snap.guild.features).toEqual(["COMMUNITY", "NEWS"]); // sorted

    expect(data<SnapshotRole[]>(snap.roles)).toHaveLength(2);
    expect(data<SnapshotCategory[]>(snap.categories)).toHaveLength(1);
    expect(data<SnapshotChannel[]>(snap.channels)).toHaveLength(3); // text + voice + forum
    expect(data(snap.events)).toHaveLength(2);
    expect(data(snap.webhooks)).toHaveLength(1);
    expect(isUnavailable(snap.welcome_screen)).toBe(false);
  });

  test("forum channel carries tags + sort/layout; text channel carries slowmode", async () => {
    const fetchMock = installFetch();
    const snap = await snapshotGuild(BOT_TOKEN, GUILD);
    fetchMock.mockRestore();

    const channels = data<SnapshotChannel[]>(snap.channels);
    const general = channels.find((c) => c.name === "general")!;
    expect(general.type).toBe("text");
    expect(general.slowmode).toBe(5);
    expect(general.forum).toBeUndefined();

    const forum = channels.find((c) => c.name === "help")!;
    expect(forum.type).toBe("forum");
    expect(forum.slowmode).toBe(10);
    expect(forum.forum).toEqual({
      tags: [{ name: "bug", moderated: true, emoji_name: "🐛" }],
      default_sort_order: 1,
      default_forum_layout: 2,
    });
  });
});

// ─── name resolution ──────────────────────────────────────────────────────────

describe("snapshotGuild — name resolution", () => {
  test("channel parent, overwrite target, webhook + event channels resolve to names", async () => {
    const fetchMock = installFetch();
    const snap = await snapshotGuild(BOT_TOKEN, GUILD);
    fetchMock.mockRestore();

    const channels = data<SnapshotChannel[]>(snap.channels);
    const general = channels.find((c) => c.name === "general")!;
    expect(general.parent).toBe("text-channels");

    const ow = (general.overwrites as SnapshotOverwrite[])[0]!;
    expect(ow.target).toBe("mods");
    expect(ow.target_id).toBe(ROLE_MODS);
    expect(ow.type).toBe("role");

    const webhook = data(snap.webhooks)[0]!;
    expect(webhook.channel).toEqual({ name: "general", id: GEN });

    const events = data(snap.events);
    // Sorted by start time: Launch Party (Aug 1) before Voice Standup (Aug 5).
    expect(events[0]!.name).toBe("Launch Party");
    expect(events[0]!.entity_type).toBe("external");
    expect(events[0]!.location).toBe("The Internet");
    expect(events[1]!.name).toBe("Voice Standup");
    expect(events[1]!.channel).toEqual({ name: "Lounge", id: VOICE });

    // Guild channel pointers resolve; the unset one is null.
    expect(snap.guild.rules_channel).toEqual({ name: "general", id: GEN });
    expect(snap.guild.public_updates_channel).toBeNull();
  });
});

// ─── permission decode ─────────────────────────────────────────────────────────

describe("snapshotGuild — permission decode", () => {
  test("role + overwrite bitmasks decode to sorted names; unknown bits survive", async () => {
    const fetchMock = installFetch();
    const snap = await snapshotGuild(BOT_TOKEN, GUILD);
    fetchMock.mockRestore();

    const mods = data<SnapshotRole[]>(snap.roles).find((r) => r.name === "mods")!;
    expect(mods.permissions).toEqual(["MANAGE_ROLES", "VIEW_CHANNEL"]); // sorted

    const channels = data<SnapshotChannel[]>(snap.channels);
    const general = channels.find((c) => c.name === "general")!;
    const genOw = (general.overwrites as SnapshotOverwrite[])[0]!;
    expect(genOw.allow).toEqual(["SEND_MESSAGES", "VIEW_CHANNEL"]);
    expect(genOw.deny).toEqual([]);

    const forum = channels.find((c) => c.name === "help")!;
    const forumOw = (forum.overwrites as SnapshotOverwrite[])[0]!;
    expect(forumOw.allow).toContain("VIEW_CHANNEL");
    expect(forumOw.allow).toContain("bit:45"); // unknown bit kept visible
  });
});

// ─── 403-section skip ──────────────────────────────────────────────────────────

describe("snapshotGuild — skip gracefully on 403", () => {
  test("a webhooks 403 becomes unavailable(...), every other section intact", async () => {
    const fetchMock = installFetch({ webhookStatus: 403 });
    const snap = await snapshotGuild(BOT_TOKEN, GUILD);
    fetchMock.mockRestore();

    expect(snap.webhooks).toBe("unavailable(403 missing MANAGE_WEBHOOKS)");
    expect(isUnavailable(snap.webhooks)).toBe(true);

    // Nothing else degraded.
    expect(isUnavailable(snap.roles)).toBe(false);
    expect(isUnavailable(snap.channels)).toBe(false);
    expect(isUnavailable(snap.events)).toBe(false);

    const sections = unavailableSections(snap);
    expect(sections).toEqual([{ section: "webhooks", marker: "unavailable(403 missing MANAGE_WEBHOOKS)" }]);
  });
});

// ─── redaction: webhook token never serialized ─────────────────────────────────

describe("serializeSnapshot — redaction", () => {
  test("webhook token from the upstream fixture never reaches the YAML", async () => {
    const fetchMock = installFetch();
    const snap = await snapshotGuild(BOT_TOKEN, GUILD);
    fetchMock.mockRestore();

    const yaml = serializeSnapshot(snap);
    expect(yaml).not.toContain(WEBHOOK_TOKEN);
    expect(yaml).not.toMatch(/token/i);
    // The webhook is still there, just credential-free.
    expect(yaml).toContain("town-crier");
  });

  test("a credential-shaped field injected into the snapshot is refused", () => {
    const poisoned = {
      guild: { id: GUILD, name: "x", features: [], verification_level: "none", rules_channel: null, public_updates_channel: null, system_channel: null, premium_tier: 0, token: "leak" },
    } as unknown as GuildSnapshot;
    expect(() => serializeSnapshot(poisoned)).toThrow(/credential/i);
  });
});

// ─── determinism ──────────────────────────────────────────────────────────────

describe("snapshot determinism", () => {
  test("two independent runs serialize byte-identically", async () => {
    const m1 = installFetch();
    const a = serializeSnapshot(await snapshotGuild(BOT_TOKEN, GUILD));
    m1.mockRestore();

    const m2 = installFetch();
    const b = serializeSnapshot(await snapshotGuild(BOT_TOKEN, GUILD));
    m2.mockRestore();

    expect(a).toBe(b);
  });

  test("renderSnapshot bodies match; only the header line differs by timestamp", async () => {
    const fetchMock = installFetch();
    const snap = await snapshotGuild(BOT_TOKEN, GUILD);
    fetchMock.mockRestore();

    const doc1 = renderSnapshot(snap, GUILD, new Date("2026-07-17T00:00:00.000Z"));
    const doc2 = renderSnapshot(snap, GUILD, new Date("2026-07-17T11:11:11.000Z"));
    expect(doc1).not.toBe(doc2); // headers differ
    // Bodies (everything after line 1) are identical — the determinism contract.
    expect(doc1.split("\n").slice(1).join("\n")).toBe(doc2.split("\n").slice(1).join("\n"));
  });

  test("header is exactly one line and carries the guild id + ISO timestamp", () => {
    const header = snapshotHeader(GUILD, new Date("2026-07-17T00:00:00.000Z"));
    expect(header.split("\n")).toHaveLength(1);
    expect(header).toContain(GUILD);
    expect(header).toContain("2026-07-17T00:00:00.000Z");
  });
});
