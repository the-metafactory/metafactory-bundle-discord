/**
 * Unit tests for guild channel lifecycle (issue #11).
 *
 * Covers the `cli/lib/guild/channels` mutation helpers and the `channel.ts`
 * command's name→id resolver. ALL network calls are mocked via
 * `spyOn(globalThis, "fetch")` — no live Discord API.
 *
 * Invariants asserted:
 *   - create per type (text/voice/category/announcement/forum incl. tags)
 *   - forum tag set > 20 is rejected client-side, before any fetch
 *   - a 400 on an announcement/forum create surfaces the COMMUNITY hint
 *   - parent name resolution, and the ambiguity error for a colliding name
 *   - the bot token NEVER appears in a thrown error message
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  createChannel,
  modifyChannel,
  deleteChannel,
  getChannel,
  CHANNEL_TYPE,
  MAX_FORUM_TAGS,
} from "../lib/guild/channels";
import { resolveChannelIdByName } from "../commands/channel";

// ─── helpers ──────────────────────────────────────────────────────────────────

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const PARENT = "300000000000000003";
const BOT_TOKEN = "Bot.secret-token-must-not-appear-in-errors";

/** Build a `Response`-like value accepted by `fetch`. */
function fakeResponse(status: number, body: unknown = null): Response {
  const text = body === null ? "" : JSON.stringify(body);
  return new Response(status === 204 ? null : text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Body of the first fetch call, parsed back to an object. */
function firstRequestBody(fetchMock: ReturnType<typeof spyOn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// ─── createChannel — per type ──────────────────────────────────────────────────

describe("createChannel", () => {
  test("text channel → POST /guilds/{id}/channels with type 0", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: CHANNEL, name: "general", type: CHANNEL_TYPE.text })
    );

    const ch = await createChannel(BOT_TOKEN, GUILD, { name: "general", type: CHANNEL_TYPE.text });

    expect(ch.id).toBe(CHANNEL);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/channels`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(firstRequestBody(fetchMock)).toEqual({ name: "general", type: 0 });

    fetchMock.mockRestore();
  });

  test("voice channel → type 2", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: CHANNEL, name: "vc", type: CHANNEL_TYPE.voice })
    );
    await createChannel(BOT_TOKEN, GUILD, { name: "vc", type: CHANNEL_TYPE.voice });
    expect(firstRequestBody(fetchMock).type).toBe(2);
    fetchMock.mockRestore();
  });

  test("category → type 4", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: CHANNEL, name: "lounge", type: CHANNEL_TYPE.category })
    );
    await createChannel(BOT_TOKEN, GUILD, { name: "lounge", type: CHANNEL_TYPE.category });
    expect(firstRequestBody(fetchMock).type).toBe(4);
    fetchMock.mockRestore();
  });

  test("announcement → type 5", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: CHANNEL, name: "news", type: CHANNEL_TYPE.announcement })
    );
    await createChannel(BOT_TOKEN, GUILD, { name: "news", type: CHANNEL_TYPE.announcement });
    expect(firstRequestBody(fetchMock).type).toBe(5);
    fetchMock.mockRestore();
  });

  test("forum with tags → type 15, available_tags passed through", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, {
        id: CHANNEL,
        name: "task-board",
        type: CHANNEL_TYPE.forum,
        available_tags: [
          { id: "1", name: "type:main", moderated: false },
          { id: "2", name: "size:starter", moderated: false },
        ],
      })
    );

    const ch = await createChannel(BOT_TOKEN, GUILD, {
      name: "task-board",
      type: CHANNEL_TYPE.forum,
      available_tags: [
        { name: "type:main", moderated: false },
        { name: "size:starter", moderated: false },
      ],
      default_sort_order: 0,
      default_forum_layout: 1,
    });

    expect(ch.available_tags).toHaveLength(2);
    const body = firstRequestBody(fetchMock);
    expect(body.type).toBe(15);
    expect(body.available_tags).toEqual([
      { name: "type:main", moderated: false },
      { name: "size:starter", moderated: false },
    ]);
    expect(body.default_sort_order).toBe(0);
    expect(body.default_forum_layout).toBe(1);

    fetchMock.mockRestore();
  });

  test("parent_id passed through and snowflake-validated", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: CHANNEL, name: "child", type: 0 })
    );
    await createChannel(BOT_TOKEN, GUILD, { name: "child", type: 0, parent_id: PARENT });
    expect(firstRequestBody(fetchMock).parent_id).toBe(PARENT);
    fetchMock.mockRestore();
  });

  test("non-snowflake parent_id → rejected locally, no fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    await expect(
      createChannel(BOT_TOKEN, GUILD, { name: "child", type: 0, parent_id: "not-a-snowflake" })
    ).rejects.toThrow(/snowflake/i);
    expect(fetchMock.mock.calls.length).toBe(0);
    fetchMock.mockRestore();
  });

  test("non-snowflake guildId → rejected locally, no fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    await expect(createChannel(BOT_TOKEN, "bad", { name: "x" })).rejects.toThrow(/snowflake/i);
    expect(fetchMock.mock.calls.length).toBe(0);
    fetchMock.mockRestore();
  });
});

// ─── forum tag limit (client-side) ──────────────────────────────────────────────

describe("forum tag limit", () => {
  test(`create with ${MAX_FORUM_TAGS + 1} tags → rejected before any fetch`, async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const tags = Array.from({ length: MAX_FORUM_TAGS + 1 }, (_, i) => ({ name: `t${i}` }));

    await expect(
      createChannel(BOT_TOKEN, GUILD, { name: "forum", type: CHANNEL_TYPE.forum, available_tags: tags })
    ).rejects.toThrow(new RegExp(`at most ${MAX_FORUM_TAGS}`));
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test(`modify with ${MAX_FORUM_TAGS + 1} tags → rejected before any fetch`, async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const tags = Array.from({ length: MAX_FORUM_TAGS + 1 }, (_, i) => ({ name: `t${i}` }));

    await expect(
      modifyChannel(BOT_TOKEN, CHANNEL, { available_tags: tags })
    ).rejects.toThrow(new RegExp(`at most ${MAX_FORUM_TAGS}`));
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test(`exactly ${MAX_FORUM_TAGS} tags → allowed`, async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, { id: CHANNEL, name: "forum", type: 15 })
    );
    const tags = Array.from({ length: MAX_FORUM_TAGS }, (_, i) => ({ name: `t${i}` }));
    await modifyChannel(BOT_TOKEN, CHANNEL, { available_tags: tags });
    expect(fetchMock.mock.calls.length).toBe(1);
    fetchMock.mockRestore();
  });
});

// ─── COMMUNITY-missing 400 hint ─────────────────────────────────────────────────

describe("COMMUNITY hint on 400", () => {
  test("forum create 400 → error names COMMUNITY, not the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(400, { message: "Guild is not COMMUNITY enabled" })
    );

    let thrown: Error | undefined;
    try {
      await createChannel(BOT_TOKEN, GUILD, { name: "forum", type: CHANNEL_TYPE.forum });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/COMMUNITY/);
    expect(thrown!.message).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });

  test("announcement create 400 → COMMUNITY hint", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(400, { message: "bad" })
    );
    await expect(
      createChannel(BOT_TOKEN, GUILD, { name: "news", type: CHANNEL_TYPE.announcement })
    ).rejects.toThrow(/COMMUNITY/);
    fetchMock.mockRestore();
  });

  test("text create 400 → NO COMMUNITY hint (type does not need it)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(400, { message: "bad name" })
    );
    let thrown: Error | undefined;
    try {
      await createChannel(BOT_TOKEN, GUILD, { name: "x", type: CHANNEL_TYPE.text });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).not.toMatch(/COMMUNITY/);
    expect(thrown!.message).not.toContain(BOT_TOKEN);
    fetchMock.mockRestore();
  });
});

// ─── modifyChannel / deleteChannel / getChannel ─────────────────────────────────

describe("modifyChannel", () => {
  test("PATCH /channels/{id} with the spec body", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, { id: CHANNEL, name: "renamed", type: 0 })
    );

    const ch = await modifyChannel(BOT_TOKEN, CHANNEL, { topic: "hello" });

    expect(ch.name).toBe("renamed");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}`);
    expect(init.method).toBe("PATCH");
    expect(firstRequestBody(fetchMock)).toEqual({ topic: "hello" });

    fetchMock.mockRestore();
  });
});

describe("deleteChannel", () => {
  test("204 → resolves", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(204));
    await deleteChannel(BOT_TOKEN, CHANNEL);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}`);
    expect(init.method).toBe("DELETE");
    fetchMock.mockRestore();
  });

  test("200 (deleted object body) → also resolves", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, { id: CHANNEL, name: "gone", type: 0 })
    );
    await deleteChannel(BOT_TOKEN, CHANNEL);
    fetchMock.mockRestore();
  });

  test("403 → throws with status, not the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Access" })
    );
    let thrown: Error | undefined;
    try {
      await deleteChannel(BOT_TOKEN, CHANNEL);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toMatch(/403/);
    expect(thrown!.message).not.toContain(BOT_TOKEN);
    fetchMock.mockRestore();
  });
});

describe("getChannel", () => {
  test("GET /channels/{id} → returns available_tags", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, {
        id: CHANNEL,
        name: "task-board",
        type: 15,
        available_tags: [{ id: "1", name: "type:main", moderated: false }],
      })
    );
    const ch = await getChannel(BOT_TOKEN, CHANNEL);
    expect(ch.available_tags?.[0]?.name).toBe("type:main");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}`);
    expect(init.method).toBe("GET");
    fetchMock.mockRestore();
  });
});

// ─── resolveChannelIdByName (command helper) ────────────────────────────────────

const CHANNELS_UNIQUE = [
  { id: PARENT, name: "Zone One", type: CHANNEL_TYPE.category, position: 0 },
  { id: CHANNEL, name: "general", type: CHANNEL_TYPE.text, position: 1 },
];

/** Two channels whose names collide case-insensitively with different ids. */
const CHANNELS_AMBIGUOUS = [
  { id: "400000000000000004", name: "general", type: CHANNEL_TYPE.text, position: 0 },
  { id: "500000000000000005", name: "General", type: CHANNEL_TYPE.text, position: 1 },
];

describe("resolveChannelIdByName", () => {
  test("snowflake passthrough → no API call", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const id = await resolveChannelIdByName(BOT_TOKEN, GUILD, CHANNEL, "Channel");
    expect(id).toBe(CHANNEL);
    expect(fetchMock.mock.calls.length).toBe(0);
    fetchMock.mockRestore();
  });

  test("name → id (case-insensitive)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, CHANNELS_UNIQUE)
    );
    const id = await resolveChannelIdByName(BOT_TOKEN, GUILD, "GENERAL", "Channel");
    expect(id).toBe(CHANNEL);
    fetchMock.mockRestore();
  });

  test("parent name with category typeFilter → resolves the category", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, CHANNELS_UNIQUE)
    );
    const id = await resolveChannelIdByName(
      BOT_TOKEN,
      GUILD,
      "Zone One",
      "Parent category",
      CHANNEL_TYPE.category
    );
    expect(id).toBe(PARENT);
    fetchMock.mockRestore();
  });

  test("typeFilter excludes a same-named non-category → not found", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, CHANNELS_UNIQUE)
    );
    // "general" exists as a text channel but not as a category.
    await expect(
      resolveChannelIdByName(BOT_TOKEN, GUILD, "general", "Parent category", CHANNEL_TYPE.category)
    ).rejects.toThrow(/not found/i);
    fetchMock.mockRestore();
  });

  test("ambiguous name (two ids) → throws listing the matches", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, CHANNELS_AMBIGUOUS)
    );
    await expect(
      resolveChannelIdByName(BOT_TOKEN, GUILD, "general", "Channel")
    ).rejects.toThrow(/ambiguous/i);
    fetchMock.mockRestore();
  });

  test("unknown name → not found, token never in the message", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, CHANNELS_UNIQUE)
    );
    try {
      await resolveChannelIdByName(BOT_TOKEN, GUILD, "nope", "Channel");
    } catch (err) {
      expect((err as Error).message).toMatch(/not found/i);
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }
    fetchMock.mockRestore();
  });
});
