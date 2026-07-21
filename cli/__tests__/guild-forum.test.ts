/**
 * Unit tests for forum-post support.
 *
 * Covers `cli/lib/guild/forum.ts`:
 *   - resolveForumTagIds: case-insensitive name→id, empty-entry skip, unknown
 *     tag → error listing the valid set (permissions-map pattern)
 *   - createForumPost: payload shape ({ name, message: { content },
 *     applied_tags }), title cap at 100, applied_tags omitted when untagged,
 *     tag-count cap, error surfaced without the token
 *   - listForumPosts: guild active-threads filtered to the forum parent,
 *     archived-public merge (+dedupe), includeArchived: false skips the 2nd GET
 *
 * Plus the forum resolver seam: `resolveChannelIdByName` with the forum type
 * filter (CHANNEL_TYPE.forum) picks the forum over a same-named text channel.
 *
 * ALL network calls are mocked via Bun's `spyOn(globalThis, "fetch")` — no live
 * Discord API. The bot token must NEVER appear in any error string (the same
 * security invariant the role + http + threads suites enforce).
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  createForumPost,
  listForumPosts,
  resolveForumTagIds,
  MAX_APPLIED_TAGS,
} from "../lib/guild/forum";
import { CHANNEL_TYPE } from "../lib/guild/channels";
import { resolveChannelIdByName } from "../commands/channel";

// ─── helpers ──────────────────────────────────────────────────────────────────

const GUILD = "900000000000000009";
const FORUM = "100000000000000001";
const THREAD = "200000000000000002";
const BOT_TOKEN = "Bot.secret-token-must-not-appear-in-errors";

const TAGS = [
  { id: "300000000000000003", name: "quest:open", moderated: false },
  { id: "400000000000000004", name: "quest:claimed", moderated: false },
  { id: "500000000000000005", name: "help-wanted", moderated: false },
];

/** Build a `Response`-like mock accepted by `fetch`. 204 / null → empty body. */
function fakeResponse(status: number, body: unknown = null): Response {
  const init: ResponseInit = { status, headers: { "Content-Type": "application/json" } };
  if (status === 204 || body === null) return new Response(null, init);
  return new Response(JSON.stringify(body), init);
}

/** Read the [url, init] tuple of the Nth (default first) recorded fetch call. */
function callArgs(fetchMock: ReturnType<typeof spyOn>, n = 0): [string, RequestInit] {
  return fetchMock.mock.calls[n] as [string, RequestInit];
}

// ─── resolveForumTagIds ─────────────────────────────────────────────────────────

describe("resolveForumTagIds", () => {
  test("resolves names to ids case-insensitively", () => {
    const ids = resolveForumTagIds(TAGS, ["QUEST:OPEN", "Help-Wanted"]);
    expect(ids).toEqual(["300000000000000003", "500000000000000005"]);
  });

  test("skips empty entries (trailing comma shape)", () => {
    const ids = resolveForumTagIds(TAGS, ["quest:open", "", " "]);
    expect(ids).toEqual(["300000000000000003"]);
  });

  test("unknown tag → error listing the offending name AND the valid set", () => {
    expect(() => resolveForumTagIds(TAGS, ["quest:open", "nope"])).toThrow(
      /Unknown forum tag\(s\): nope\. Valid tags: quest:open, quest:claimed, help-wanted/
    );
  });

  test("no available tags → error says the forum has none", () => {
    expect(() => resolveForumTagIds([], ["anything"])).toThrow(/has no tags/);
  });
});

// ─── createForumPost ────────────────────────────────────────────────────────────

describe("createForumPost", () => {
  test("POST /channels/{forum}/threads with { name, message.content, applied_tags }", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: THREAD })
    );

    const result = await createForumPost(BOT_TOKEN, FORUM, {
      title: "Quest: fix the boiler",
      content: "Reward: 3 favor. Claim below.",
      appliedTagIds: ["300000000000000003"],
    });

    expect(result.success).toBe(true);
    expect(result.threadId).toBe(THREAD);

    const [url, init] = callArgs(fetchMock);
    expect(url).toBe(`https://discord.com/api/v10/channels/${FORUM}/threads`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("Quest: fix the boiler");
    expect(body.message).toEqual({ content: "Reward: 3 favor. Claim below." });
    expect(body.applied_tags).toEqual(["300000000000000003"]);
    // Auth header carries the token; nothing else does.
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);

    fetchMock.mockRestore();
  });

  test("untagged post → applied_tags key absent from the payload", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: THREAD })
    );

    await createForumPost(BOT_TOKEN, FORUM, { title: "t", content: "c", appliedTagIds: [] });

    const body = JSON.parse(callArgs(fetchMock)[1].body as string);
    expect("applied_tags" in body).toBe(false);

    fetchMock.mockRestore();
  });

  test("title is capped at 100 characters", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: "1" })
    );

    await createForumPost(BOT_TOKEN, FORUM, { title: "x".repeat(250), content: "c" });

    const body = JSON.parse(callArgs(fetchMock)[1].body as string);
    expect(body.name.length).toBe(100);

    fetchMock.mockRestore();
  });

  test(`more than ${MAX_APPLIED_TAGS} tags → local error, no network call`, async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createForumPost(BOT_TOKEN, FORUM, {
      title: "t",
      content: "c",
      appliedTagIds: ["1", "2", "3", "4", "5", "6"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at most 5 tags/);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test("error → status surfaced, token never present", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await createForumPost(BOT_TOKEN, FORUM, { title: "t", content: "c" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/403/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── listForumPosts ─────────────────────────────────────────────────────────────

const ACTIVE_RESPONSE = {
  threads: [
    {
      id: "600000000000000006",
      name: "open quest",
      parent_id: FORUM,
      applied_tags: ["300000000000000003"],
      message_count: 4,
      thread_metadata: { archived: false },
    },
    {
      id: "700000000000000007",
      name: "thread elsewhere",
      parent_id: "800000000000000008", // different parent — filtered out
      applied_tags: [],
      message_count: 1,
      thread_metadata: { archived: false },
    },
  ],
};

const ARCHIVED_RESPONSE = {
  threads: [
    {
      id: "610000000000000006",
      name: "done quest",
      parent_id: FORUM,
      applied_tags: ["400000000000000004"],
      message_count: 9,
      thread_metadata: { archived: true },
    },
  ],
  has_more: false,
};

describe("listForumPosts", () => {
  test("filters guild active threads to the forum parent, merges archived-public", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fakeResponse(200, ACTIVE_RESPONSE))
      .mockResolvedValueOnce(fakeResponse(200, ARCHIVED_RESPONSE));

    const posts = await listForumPosts(BOT_TOKEN, GUILD, FORUM);

    const [activeUrl] = callArgs(fetchMock, 0);
    const [archivedUrl] = callArgs(fetchMock, 1);
    expect(activeUrl).toBe(`https://discord.com/api/v10/guilds/${GUILD}/threads/active`);
    expect(archivedUrl).toBe(
      `https://discord.com/api/v10/channels/${FORUM}/threads/archived/public`
    );

    expect(posts).toEqual([
      {
        id: "600000000000000006",
        name: "open quest",
        appliedTagIds: ["300000000000000003"],
        archived: false,
        messageCount: 4,
      },
      {
        id: "610000000000000006",
        name: "done quest",
        appliedTagIds: ["400000000000000004"],
        archived: true,
        messageCount: 9,
      },
    ]);

    fetchMock.mockRestore();
  });

  test("includeArchived: false → active only, single GET", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, ACTIVE_RESPONSE)
    );

    const posts = await listForumPosts(BOT_TOKEN, GUILD, FORUM, { includeArchived: false });

    expect(fetchMock.mock.calls.length).toBe(1);
    expect(posts.map((p) => p.id)).toEqual(["600000000000000006"]);

    fetchMock.mockRestore();
  });

  test("a thread in both lists is not duplicated", async () => {
    const both = {
      threads: [{ ...ACTIVE_RESPONSE.threads[0], thread_metadata: { archived: true } }],
      has_more: false,
    };
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fakeResponse(200, ACTIVE_RESPONSE))
      .mockResolvedValueOnce(fakeResponse(200, both));

    const posts = await listForumPosts(BOT_TOKEN, GUILD, FORUM);

    expect(posts.filter((p) => p.id === "600000000000000006").length).toBe(1);

    fetchMock.mockRestore();
  });

  test("error → throws with status, token never present", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Access" })
    );

    let caught: Error | undefined;
    try {
      await listForumPosts(BOT_TOKEN, GUILD, FORUM);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/403/);
    expect(caught?.message).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── forum channel resolver (type filter) ───────────────────────────────────────

describe("resolveChannelIdByName with the forum type filter", () => {
  const SAME_NAME_CHANNELS = [
    { id: "110000000000000001", name: "quest-board", type: CHANNEL_TYPE.text, position: 0 },
    { id: "120000000000000002", name: "quest-board", type: CHANNEL_TYPE.forum, position: 1 },
  ];

  test("picks the forum over a same-named text channel", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, SAME_NAME_CHANNELS)
    );

    const id = await resolveChannelIdByName(
      BOT_TOKEN,
      GUILD,
      "quest-board",
      "Forum channel",
      CHANNEL_TYPE.forum
    );

    expect(id).toBe("120000000000000002");

    fetchMock.mockRestore();
  });

  test("no forum with that name → not found (text-only match excluded)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, [SAME_NAME_CHANNELS[0]])
    );

    await expect(
      resolveChannelIdByName(BOT_TOKEN, GUILD, "quest-board", "Forum channel", CHANNEL_TYPE.forum)
    ).rejects.toThrow(/not found/i);

    fetchMock.mockRestore();
  });
});
