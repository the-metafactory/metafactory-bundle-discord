/**
 * Unit tests for the declarative guild-layout engine (issue #18).
 *
 * Fixture-based, NO network except the mid-apply test, where `fetch` is mocked via
 * Bun's `spyOn` (like the snapshot tests) to simulate one action failing partway.
 *
 * Coverage maps to the acceptance criteria:
 *   - parse errors name the offending key + location;
 *   - diff of an empty guild vs the shipped example = a full create plan, in
 *     dependency order (roles -> categories -> channels -> overwrites -> tags ->
 *     guild settings);
 *   - diff of a snapshot that already matches the layout = an empty plan;
 *   - a live resource absent from the layout is reported `unmanaged`, never deleted;
 *   - pruning needs BOTH a `prune:` block AND `{ prune: true }` (the double-gate);
 *   - a mid-apply failure reports "completed N of M" and the re-run (against a
 *     snapshot reflecting the completed work) plans only the remainder.
 */

import { describe, expect, test, spyOn } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseLayout,
  diffLayout,
  applyPlan,
  renderPlan,
  isEmptyPlan,
  LayoutError,
  type Action,
} from "../lib/guild/layout";
import type {
  GuildSnapshot,
  SnapshotRole,
  SnapshotCategory,
  SnapshotChannel,
  SnapshotOverwrite,
} from "../lib/guild/snapshot";

// ─── ids ────────────────────────────────────────────────────────────────────

const TOKEN = "Bot.secret-token-never-appears-in-output";
const GUILD = "900000000000000001";
const EVERYONE = GUILD; // @everyone's role id is the guild id
const NEWCOMER = "900000000000000010";
const MEMBER = "900000000000000011";
const BUILDER = "900000000000000012";
const LOBBY = "900000000000000020";
const WORKSHOP = "900000000000000021";
const INNER = "900000000000000022";
const WELCOME = "900000000000000030";
const FLOOR = "900000000000000031";
const BUILDLOGS = "900000000000000032";
const STRATEGY = "900000000000000033";

const EXAMPLE = join(import.meta.dir, "..", "..", "examples", "guild-layout.example.yaml");

// ─── snapshot fixtures ─────────────────────────────────────────────────────────

function everyoneRole(): SnapshotRole {
  return {
    id: EVERYONE,
    name: "@everyone",
    color: 0,
    hoist: false,
    mentionable: false,
    position: 0,
    managed: false,
    permissions: ["VIEW_CHANNEL"],
  };
}

/** A guild anchor with the given verification + rules channel. */
function guildMeta(verification: string, rulesChannel: { name: string; id: string } | null): GuildSnapshot["guild"] {
  return {
    id: GUILD,
    name: "Test Guild",
    features: [],
    verification_level: verification,
    rules_channel: rulesChannel,
    public_updates_channel: null,
    system_channel: null,
    premium_tier: 0,
  };
}

/** An empty (freshly created) guild: only @everyone, no categories/channels. */
function emptySnapshot(): GuildSnapshot {
  return {
    guild: guildMeta("none", null),
    roles: [everyoneRole()],
    categories: [],
    channels: [],
    events: [],
    webhooks: [],
    welcome_screen: { enabled: false, description: null, channels: [] },
  };
}

function role(id: string, name: string, color: number, extra: Partial<SnapshotRole> = {}): SnapshotRole {
  return {
    id,
    name,
    color,
    hoist: false,
    mentionable: false,
    position: 1,
    managed: false,
    permissions: [],
    ...extra,
  };
}

function ow(target: string, targetId: string, allow: string[], deny: string[]): SnapshotOverwrite {
  return { target, target_id: targetId, type: "role", allow, deny };
}

/** A snapshot built to EXACTLY match examples/guild-layout.example.yaml → empty diff. */
function matchingSnapshot(): GuildSnapshot {
  const roles: SnapshotRole[] = [
    everyoneRole(),
    role(NEWCOMER, "Newcomer", 0x95a5a6, {
      permissions: ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"],
    }),
    role(MEMBER, "Member", 0x3b82f6, {
      hoist: true,
      permissions: ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "ADD_REACTIONS", "EMBED_LINKS"],
    }),
    role(BUILDER, "Builder", 0xe67e22, {
      hoist: true,
      mentionable: true,
      permissions: [
        "VIEW_CHANNEL",
        "SEND_MESSAGES",
        "READ_MESSAGE_HISTORY",
        "ADD_REACTIONS",
        "EMBED_LINKS",
        "MANAGE_THREADS",
      ],
    }),
  ];

  const categories: SnapshotCategory[] = [
    { id: LOBBY, name: "Lobby", position: 0, overwrites: [ow("@everyone", EVERYONE, ["VIEW_CHANNEL"], [])] },
    {
      id: WORKSHOP,
      name: "Workshop",
      position: 1,
      overwrites: [ow("@everyone", EVERYONE, [], ["VIEW_CHANNEL"]), ow("Member", MEMBER, ["VIEW_CHANNEL"], [])],
    },
    {
      id: INNER,
      name: "Inner Ring",
      position: 2,
      overwrites: [ow("@everyone", EVERYONE, [], ["VIEW_CHANNEL"]), ow("Builder", BUILDER, ["VIEW_CHANNEL"], [])],
    },
  ];

  const channels: SnapshotChannel[] = [
    {
      id: WELCOME,
      name: "welcome",
      type: "text",
      parent: "Lobby",
      topic: "Start here. Read the rules, then say hi.",
      position: 0,
      slowmode: 10,
      overwrites: [],
    },
    {
      id: FLOOR,
      name: "workshop-floor",
      type: "text",
      parent: "Workshop",
      topic: "Members' working channel.",
      position: 1,
      slowmode: 0,
      overwrites: [],
    },
    {
      id: BUILDLOGS,
      name: "build-logs",
      type: "forum",
      parent: "Workshop",
      topic: "One thread per build. Tag it.",
      position: 2,
      slowmode: 0,
      overwrites: [ow("Builder", BUILDER, ["VIEW_CHANNEL", "MANAGE_THREADS"], [])],
      forum: {
        tags: [{ name: "wip" }, { name: "shipped", moderated: true }, { name: "help-wanted" }],
        default_sort_order: null,
        default_forum_layout: null,
      },
    },
    {
      id: STRATEGY,
      name: "strategy",
      type: "text",
      parent: "Inner Ring",
      topic: "Builders only — direction and planning.",
      position: 3,
      slowmode: 0,
      overwrites: [],
    },
  ];

  return {
    guild: guildMeta("low", { name: "welcome", id: WELCOME }),
    roles,
    categories,
    channels,
    events: [],
    webhooks: [],
    welcome_screen: { enabled: false, description: null, channels: [] },
  };
}

function loadExample() {
  return parseLayout(readFileSync(EXAMPLE, "utf8"));
}

// ═══ parse: schema validation ═══════════════════════════════════════════════════

describe("parseLayout", () => {
  test("parses the shipped example without error", () => {
    const layout = loadExample();
    expect(layout.roles.map((r) => r.name)).toEqual(["Newcomer", "Member", "Builder"]);
    expect(layout.categories.map((c) => c.name)).toEqual(["Lobby", "Workshop", "Inner Ring"]);
    expect(layout.channels.map((c) => c.name)).toEqual(["welcome", "workshop-floor", "build-logs", "strategy"]);
    const forum = layout.channels.find((c) => c.name === "build-logs")!;
    expect(forum.forum_tags?.map((t) => t.name)).toEqual(["wip", "shipped", "help-wanted"]);
    expect(layout.guild?.verification).toBe("low");
  });

  test("an unknown top-level key is refused, naming key + location", () => {
    expect(() => parseLayout("bogus: 1")).toThrow(LayoutError);
    expect(() => parseLayout("bogus: 1")).toThrow(/\(root\)\.bogus: unknown key/);
  });

  test("an unknown key inside a role names the role and the key", () => {
    const yaml = "roles:\n  Member:\n    colour: 0x1\n";
    expect(() => parseLayout(yaml)).toThrow(/roles\.Member\.colour: unknown key/);
  });

  test("an invalid permission name is rejected at its location", () => {
    const yaml = "roles:\n  Member:\n    permissions: [NOT_A_PERM]\n";
    expect(() => parseLayout(yaml)).toThrow(/roles\.Member\.permissions:.*Unknown permission/);
  });

  test("an invalid channel type is rejected naming the channel", () => {
    const yaml = "channels:\n  chat:\n    type: chatroom\n";
    expect(() => parseLayout(yaml)).toThrow(/channels\.chat\.type: "chatroom" is not a valid channel type/);
  });

  test("forum_tags on a non-forum channel is rejected", () => {
    const yaml = "channels:\n  chat:\n    type: text\n    forum_tags:\n      - name: x\n";
    expect(() => parseLayout(yaml)).toThrow(/channels\.chat\.forum_tags: forum_tags are only valid on a forum/);
  });

  test("an unknown verification level is rejected at guild.verification", () => {
    const yaml = "guild:\n  verification: paranoid\n";
    expect(() => parseLayout(yaml)).toThrow(/guild\.verification:.*Unknown verification/);
  });
});

// ═══ diff: empty guild → full create plan, in dependency order ═══════════════════

describe("diffLayout — empty guild", () => {
  test("produces a full create plan in dependency order", () => {
    const plan = diffLayout(loadExample(), emptySnapshot());
    const kinds = plan.actions.map((a) => a.kind);

    // Counts: 3 roles, 3 categories, 4 channels, 6 overwrites, 1 forum tags, 1 guild.
    expect(kinds.filter((k) => k === "create_role")).toHaveLength(3);
    expect(kinds.filter((k) => k === "create_category")).toHaveLength(3);
    expect(kinds.filter((k) => k === "create_channel")).toHaveLength(4);
    expect(kinds.filter((k) => k === "set_overwrite")).toHaveLength(6);
    expect(kinds.filter((k) => k === "set_forum_tags")).toHaveLength(1);
    expect(kinds.filter((k) => k === "modify_guild")).toHaveLength(1);

    // Dependency order: the last index of each phase precedes the first of the next.
    const lastOf = (k: Action["kind"]) => kinds.lastIndexOf(k);
    const firstOf = (k: Action["kind"]) => kinds.indexOf(k);
    expect(lastOf("create_role")).toBeLessThan(firstOf("create_category"));
    expect(lastOf("create_category")).toBeLessThan(firstOf("create_channel"));
    expect(lastOf("create_channel")).toBeLessThan(firstOf("set_overwrite"));
    expect(lastOf("set_overwrite")).toBeLessThan(firstOf("set_forum_tags"));
    expect(lastOf("set_forum_tags")).toBeLessThan(firstOf("modify_guild"));

    // Nothing to report as unmanaged on an empty guild.
    expect(plan.unmanaged).toEqual([]);
    expect(isEmptyPlan(plan)).toBe(false);
  });

  test("create_channel carries no overwrites/tags (those are later phases)", () => {
    const plan = diffLayout(loadExample(), emptySnapshot());
    const buildLogs = plan.actions.find(
      (a) => a.kind === "create_channel" && a.name === "build-logs"
    );
    expect(buildLogs?.kind).toBe("create_channel");
    // The forum's tags come as a separate set_forum_tags action, after overwrites.
    const tagAction = plan.actions.find((a) => a.kind === "set_forum_tags");
    expect(tagAction?.kind).toBe("set_forum_tags");
    if (tagAction?.kind === "set_forum_tags") {
      expect(tagAction.tags.map((t) => t.name)).toEqual(["wip", "shipped", "help-wanted"]);
      expect(tagAction.tags.find((t) => t.name === "shipped")?.moderated).toBe(true);
    }
  });
});

// ═══ diff: matching snapshot → empty plan ════════════════════════════════════════

describe("diffLayout — matching snapshot", () => {
  test("a guild that already matches the layout diffs to an empty plan", () => {
    const plan = diffLayout(loadExample(), matchingSnapshot());
    expect(plan.actions).toEqual([]);
    expect(isEmptyPlan(plan)).toBe(true);
    expect(plan.unmanaged).toEqual([]);
    expect(renderPlan(plan)[0]).toMatch(/already matches/);
  });

  test("changing one live topic yields exactly one modify_channel", () => {
    const snap = matchingSnapshot();
    const strategy = (snap.channels as SnapshotChannel[]).find((c) => c.name === "strategy")!;
    strategy.topic = "stale topic";
    const plan = diffLayout(loadExample(), snap);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.kind).toBe("modify_channel");
  });
});

// ═══ never destructive: unmanaged reporting ══════════════════════════════════════

describe("diffLayout — unmanaged (never destructive by default)", () => {
  test("a live channel absent from the layout is reported unmanaged, not deleted", () => {
    const snap = matchingSnapshot();
    (snap.channels as SnapshotChannel[]).push({
      id: "900000000000000099",
      name: "old-lounge",
      type: "text",
      parent: null,
      topic: null,
      position: 9,
      slowmode: 0,
      overwrites: [],
    });

    const plan = diffLayout(loadExample(), snap);
    expect(plan.actions).toEqual([]); // no delete action
    expect(plan.unmanaged).toContainEqual({ kind: "channel", name: "old-lounge", parent: null });

    const rendered = renderPlan(plan).join("\n");
    expect(rendered).toMatch(/Unmanaged/);
    expect(rendered).toMatch(/old-lounge/);
  });

  test("a live role absent from the layout is unmanaged; @everyone + managed roles are ignored", () => {
    const snap = matchingSnapshot();
    (snap.roles as SnapshotRole[]).push(role("900000000000000098", "Ancient", 0));
    (snap.roles as SnapshotRole[]).push(role("900000000000000097", "BotRole", 0, { managed: true }));

    const plan = diffLayout(loadExample(), snap);
    expect(plan.unmanaged).toContainEqual({ kind: "role", name: "Ancient" });
    // The integration-managed role and @everyone are never surfaced or touched.
    expect(plan.unmanaged.find((u) => u.name === "BotRole")).toBeUndefined();
    expect(plan.unmanaged.find((u) => u.name === "@everyone")).toBeUndefined();
  });
});

// ═══ prune double-gate: block AND flag ═══════════════════════════════════════════

describe("diffLayout — prune requires BOTH a prune block AND the --prune flag", () => {
  const layoutWithPrune = () =>
    parseLayout(
      "channels:\n  keep:\n    type: text\nprune:\n  channels: [old-lounge]\n"
    );

  /** A snapshot with `keep` (managed) + `old-lounge` (a prune candidate) live. */
  function snapWithStray(): GuildSnapshot {
    const snap = emptySnapshot();
    snap.channels = [
      { id: "900000000000000200", name: "keep", type: "text", parent: null, topic: null, position: 0, slowmode: 0, overwrites: [] },
      { id: "900000000000000201", name: "old-lounge", type: "text", parent: null, topic: null, position: 1, slowmode: 0, overwrites: [] },
    ];
    return snap;
  }

  test("block present, flag absent → pending, NOT deleted", () => {
    const plan = diffLayout(layoutWithPrune(), snapWithStray());
    expect(plan.actions.filter((a) => a.kind === "delete_channel")).toEqual([]);
    expect(plan.pendingPrune).toContainEqual({ kind: "channel", name: "old-lounge" });
    expect(plan.unmanaged).toEqual([]); // it's a prune candidate, not "unmanaged"
  });

  test("block present, flag present → a delete_channel action is planned", () => {
    const plan = diffLayout(layoutWithPrune(), snapWithStray(), { prune: true });
    const deletes = plan.actions.filter((a) => a.kind === "delete_channel");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.kind).toBe("delete_channel");
    if (deletes[0]!.kind === "delete_channel") expect(deletes[0]!.name).toBe("old-lounge");
  });

  test("flag present but NO prune block → still not deleted (both gates required)", () => {
    // Layout without a prune: block, same stray channel, --prune passed.
    const layout = parseLayout("channels:\n  keep:\n    type: text\n");
    const plan = diffLayout(layout, snapWithStray(), { prune: true });
    expect(plan.actions.filter((a) => a.kind === "delete_channel")).toEqual([]);
    expect(plan.unmanaged).toContainEqual({ kind: "channel", name: "old-lounge", parent: null });
  });
});

// ═══ apply: dry run + mid-apply failure + resumable remainder ═════════════════════

describe("applyPlan", () => {
  test("dry run (execute:false) mutates nothing and reports the plan size", async () => {
    const plan = diffLayout(loadExample(), emptySnapshot());
    // No fetch spy installed: any network call would throw and fail this test.
    const result = await applyPlan(TOKEN, GUILD, plan, emptySnapshot(), { execute: false });
    expect(result.executed).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.completed).toBe(0);
    expect(result.total).toBe(plan.actions.length);
  });

  test("mid-apply failure reports completed N of M; re-run plans only the remainder", async () => {
    const layout = parseLayout(
      "roles:\n" +
        "  Alpha: { permissions: [VIEW_CHANNEL] }\n" +
        "  Beta: { permissions: [VIEW_CHANNEL] }\n" +
        "  Gamma: { permissions: [VIEW_CHANNEL] }\n"
    );

    const snap1 = emptySnapshot();
    const plan1 = diffLayout(layout, snap1);
    expect(plan1.actions.map((a) => a.kind)).toEqual(["create_role", "create_role", "create_role"]);

    // Fetch mock: the 3rd role POST fails (500); the first two succeed.
    let created = 0;
    const roleResponse = (name: string, id: string) =>
      new Response(
        JSON.stringify({ id, name, color: 0, hoist: false, position: 1, permissions: "0", mentionable: false, managed: false }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    const mock = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith(`/guilds/${GUILD}/roles`)) {
        created += 1;
        if (created === 3) return Promise.resolve(new Response(JSON.stringify({ message: "Internal Server Error" }), { status: 500 }));
        const body = JSON.parse(init!.body as string) as { name: string };
        return Promise.resolve(roleResponse(body.name, `role-${created}`));
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch);

    const result1 = await applyPlan(TOKEN, GUILD, plan1, snap1, { execute: true });
    mock.mockRestore();

    expect(result1.ok).toBe(false);
    expect(result1.completed).toBe(2);
    expect(result1.total).toBe(3);
    expect(result1.failure?.action.kind).toBe("create_role");

    // ── the re-run: snapshot now reflects Alpha + Beta as created live ───────────
    const snap2 = emptySnapshot();
    snap2.roles = [
      everyoneRole(),
      role("role-1", "Alpha", 0, { permissions: ["VIEW_CHANNEL"] }),
      role("role-2", "Beta", 0, { permissions: ["VIEW_CHANNEL"] }),
    ];
    const plan2 = diffLayout(layout, snap2);
    // Only Gamma remains.
    expect(plan2.actions).toHaveLength(1);
    expect(plan2.actions[0]!.kind).toBe("create_role");
    if (plan2.actions[0]!.kind === "create_role") expect(plan2.actions[0]!.role.name).toBe("Gamma");

    let created2 = 0;
    const mock2 = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith(`/guilds/${GUILD}/roles`)) {
        created2 += 1;
        const body = JSON.parse(init!.body as string) as { name: string };
        return Promise.resolve(roleResponse(body.name, "role-3"));
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch);

    const result2 = await applyPlan(TOKEN, GUILD, plan2, snap2, { execute: true });
    mock2.mockRestore();

    expect(result2.ok).toBe(true);
    expect(result2.completed).toBe(1);
    expect(result2.total).toBe(1);
  });

  test("execute run creates roles/categories/channels and resolves ids across phases", async () => {
    // A minimal layout exercising cross-phase id resolution: a channel under a
    // category created the same run, plus an overwrite referencing a created role.
    const layout = parseLayout(
      "roles:\n" +
        "  Gate: { permissions: [VIEW_CHANNEL] }\n" +
        "categories:\n" +
        "  Zone:\n" +
        "    overwrites:\n" +
        "      Gate: { allow: [VIEW_CHANNEL] }\n" +
        "channels:\n" +
        "  room:\n" +
        "    type: text\n" +
        "    parent: Zone\n"
    );
    const snap = emptySnapshot();
    const plan = diffLayout(layout, snap);

    // Created-resource ids must be real snowflakes (the channels slice validates
    // parent_id/overwrite targets before interpolating them into a URL).
    const GATE_ID = "900000000000000502";
    const ZONE_ID = "900000000000000500";
    const ROOM_ID = "900000000000000501";

    const calls: string[] = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method ?? "GET";
      const path = url.replace(/^https:\/\/discord\.com\/api\/v\d+/, "");
      calls.push(`${method} ${path}`);
      if (method === "POST" && path === `/guilds/${GUILD}/roles`) {
        return Promise.resolve(new Response(JSON.stringify({ id: GATE_ID, name: "Gate", color: 0, hoist: false, position: 1, permissions: "0", mentionable: false, managed: false }), { status: 200 }));
      }
      if (method === "POST" && path === `/guilds/${GUILD}/channels`) {
        const body = JSON.parse(init!.body as string) as { type: number };
        // category (type 4) → zone id; text channel → room id.
        const id = body.type === 4 ? ZONE_ID : ROOM_ID;
        return Promise.resolve(new Response(JSON.stringify({ id, name: "x", type: body.type }), { status: 200 }));
      }
      if (method === "PUT" && path.startsWith("/channels/")) {
        return Promise.resolve(new Response("", { status: 204 }));
      }
      throw new Error(`unexpected ${method} ${path}`);
    }) as unknown as typeof fetch);

    const result = await applyPlan(TOKEN, GUILD, plan, snap, { execute: true });
    mock.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.completed).toBe(result.total);
    // The overwrite PUT targets the freshly-created category id with the created role id.
    expect(calls).toContain(`PUT /channels/${ZONE_ID}/permissions/${GATE_ID}`);
    // Two channel POSTs (category + channel); the overwrite PUT came last.
    const channelPosts = calls.filter((c) => c === `POST /guilds/${GUILD}/channels`);
    expect(channelPosts).toHaveLength(2);
    expect(calls[calls.length - 1]).toBe(`PUT /channels/${ZONE_ID}/permissions/${GATE_ID}`);
  });
});

// ═══ diff command semantics: drift exit signal ═══════════════════════════════════

describe("isEmptyPlan — the diff command's drift signal", () => {
  test("empty plan (in sync) vs non-empty plan (drift)", () => {
    expect(isEmptyPlan(diffLayout(loadExample(), matchingSnapshot()))).toBe(true);
    expect(isEmptyPlan(diffLayout(loadExample(), emptySnapshot()))).toBe(false);
  });
});
