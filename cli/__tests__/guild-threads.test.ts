/**
 * Unit tests for standalone guild thread management (issue #13).
 *
 * Covers `cli/lib/guild/threads.ts`:
 *   - createThread: public (type 11) / private (type 12), name-cap at 100 chars
 *   - addThreadMember / removeThreadMember: 204 success + 403 → Manage-Threads map
 *   - setArchived: archive/unarchive PATCH body
 *   - listArchivedThreads: public vs private endpoint, has_more → hasMore
 *
 * ALL network calls are mocked via Bun's `spyOn(globalThis, "fetch")` — no live
 * Discord API. The bot token must NEVER appear in any error string (the same
 * security invariant the role + http suites enforce).
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  createThread,
  addThreadMember,
  removeThreadMember,
  setArchived,
  listArchivedThreads,
} from "../lib/guild/threads";

// ─── helpers ──────────────────────────────────────────────────────────────────

const CHANNEL = "100000000000000001";
const THREAD = "200000000000000002";
const USER = "123456789012345678";
const BOT_TOKEN = "Bot.secret-token-must-not-appear-in-errors";

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

// ─── createThread ───────────────────────────────────────────────────────────────

describe("createThread", () => {
  test("public thread (type 11) → POST /channels/{id}/threads, returns id", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: "555000111222333444" })
    );

    const result = await createThread(BOT_TOKEN, CHANNEL, { name: "smoke test", type: 11 });

    expect(result.success).toBe(true);
    expect(result.threadId).toBe("555000111222333444");

    const [url, init] = callArgs(fetchMock);
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/threads`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe(11);
    expect(body.name).toBe("smoke test");
    // Auth header carries the token; nothing else does.
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);

    fetchMock.mockRestore();
  });

  test("private thread → type 12 in body", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: "555000111222333444" })
    );

    const result = await createThread(BOT_TOKEN, CHANNEL, { name: "private test", type: 12 });

    expect(result.success).toBe(true);
    const [, init] = callArgs(fetchMock);
    expect(JSON.parse(init.body as string).type).toBe(12);

    fetchMock.mockRestore();
  });

  test("name is capped at 100 characters", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(201, { id: "1" })
    );

    const longName = "x".repeat(250);
    await createThread(BOT_TOKEN, CHANNEL, { name: longName, type: 11 });

    const [, init] = callArgs(fetchMock);
    expect(JSON.parse(init.body as string).name.length).toBe(100);

    fetchMock.mockRestore();
  });

  test("auto-archive + invitable are sent only when supplied", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fakeResponse(201, { id: "1" }))
      .mockResolvedValueOnce(fakeResponse(201, { id: "2" }));

    // Supplied
    await createThread(BOT_TOKEN, CHANNEL, {
      name: "n",
      type: 12,
      autoArchiveMinutes: 1440,
      invitable: false,
    });
    const withOpts = JSON.parse(callArgs(fetchMock, 0)[1].body as string);
    expect(withOpts.auto_archive_duration).toBe(1440);
    expect(withOpts.invitable).toBe(false);

    // Omitted → keys absent (Discord applies its own defaults)
    await createThread(BOT_TOKEN, CHANNEL, { name: "n", type: 11 });
    const bare = JSON.parse(callArgs(fetchMock, 1)[1].body as string);
    expect("auto_archive_duration" in bare).toBe(false);
    expect("invitable" in bare).toBe(false);

    fetchMock.mockRestore();
  });

  test("error → status surfaced, token never present", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await createThread(BOT_TOKEN, CHANNEL, { name: "n", type: 11 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/403/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── addThreadMember / removeThreadMember ────────────────────────────────────────

describe("addThreadMember", () => {
  test("204 → success, PUT /channels/{thread}/thread-members/{user}", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(204));

    const result = await addThreadMember(BOT_TOKEN, THREAD, USER);

    expect(result.success).toBe(true);
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe(`https://discord.com/api/v10/channels/${THREAD}/thread-members/${USER}`);
    expect(init.method).toBe("PUT");

    fetchMock.mockRestore();
  });

  test("403 → Manage Threads message (not the token)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await addThreadMember(BOT_TOKEN, THREAD, USER);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Manage Threads/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

describe("removeThreadMember", () => {
  test("204 → success, DELETE same path", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(204));

    const result = await removeThreadMember(BOT_TOKEN, THREAD, USER);

    expect(result.success).toBe(true);
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe(`https://discord.com/api/v10/channels/${THREAD}/thread-members/${USER}`);
    expect(init.method).toBe("DELETE");

    fetchMock.mockRestore();
  });

  test("403 → Manage Threads message (not the token)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await removeThreadMember(BOT_TOKEN, THREAD, USER);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Manage Threads/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });

  test("404 → thread or member not found", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(404, { message: "Unknown Member" })
    );

    const result = await removeThreadMember(BOT_TOKEN, THREAD, USER);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    fetchMock.mockRestore();
  });
});

// ─── setArchived ────────────────────────────────────────────────────────────────

describe("setArchived", () => {
  test("archive → PATCH /channels/{thread} body { archived: true }", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, { id: THREAD })
    );

    const result = await setArchived(BOT_TOKEN, THREAD, true);

    expect(result.success).toBe(true);
    const [url, init] = callArgs(fetchMock);
    expect(url).toBe(`https://discord.com/api/v10/channels/${THREAD}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ archived: true });

    fetchMock.mockRestore();
  });

  test("unarchive → body { archived: false }", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, { id: THREAD })
    );

    await setArchived(BOT_TOKEN, THREAD, false);

    const [, init] = callArgs(fetchMock);
    expect(JSON.parse(init.body as string)).toEqual({ archived: false });

    fetchMock.mockRestore();
  });

  test("error → status surfaced, token never present", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(500, { message: "Server Error" })
    );

    const result = await setArchived(BOT_TOKEN, THREAD, true);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── listArchivedThreads ─────────────────────────────────────────────────────────

describe("listArchivedThreads", () => {
  test("public → GET .../threads/archived/public, maps threads + hasMore", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, {
        threads: [
          { id: "1", name: "old-thread", thread_metadata: { archived: true } },
          { id: "2", name: "older-thread", thread_metadata: { archived: true } },
        ],
        has_more: false,
      })
    );

    const page = await listArchivedThreads(BOT_TOKEN, CHANNEL);

    const [url] = callArgs(fetchMock);
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/threads/archived/public`);
    expect(page.threads).toEqual([
      { id: "1", name: "old-thread", archived: true },
      { id: "2", name: "older-thread", archived: true },
    ]);
    expect(page.hasMore).toBe(false);

    fetchMock.mockRestore();
  });

  test("private flag → GET .../threads/archived/private", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, { threads: [], has_more: false })
    );

    await listArchivedThreads(BOT_TOKEN, CHANNEL, { private: true });

    const [url] = callArgs(fetchMock);
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/threads/archived/private`);

    fetchMock.mockRestore();
  });

  test("has_more: true → hasMore: true (pagination flag exposed)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, {
        threads: [{ id: "9", name: "recent", thread_metadata: { archived: true } }],
        has_more: true,
      })
    );

    const page = await listArchivedThreads(BOT_TOKEN, CHANNEL);

    expect(page.hasMore).toBe(true);

    fetchMock.mockRestore();
  });

  test("error → throws with status, token never present", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Access" })
    );

    let caught: Error | undefined;
    try {
      await listArchivedThreads(BOT_TOKEN, CHANNEL, { private: true });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/403/);
    expect(caught?.message).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});
