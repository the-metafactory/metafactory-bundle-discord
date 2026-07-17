/**
 * Unit tests for full channel listing (issue #9): `channelTypeName` label
 * mapping and `listAllChannels` returning EVERY channel type (the gap that the
 * text/announcement-only `listChannels` filter left).
 *
 * Network is mocked via `spyOn(globalThis, "fetch")` — no live Discord API.
 */

import { describe, expect, test, spyOn } from "bun:test";
import { channelTypeName, listAllChannels } from "../lib/discord";

const GUILD = "100000000000000001";
const BOT_TOKEN = "Bot.secret-token";

function fakeResponse(status: number, body: unknown = null): Response {
  const text = body === null ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

describe("channelTypeName", () => {
  test("known Discord types → short labels", () => {
    expect(channelTypeName(0)).toBe("text");
    expect(channelTypeName(2)).toBe("voice");
    expect(channelTypeName(4)).toBe("category");
    expect(channelTypeName(5)).toBe("announcement");
    expect(channelTypeName(13)).toBe("stage");
    expect(channelTypeName(15)).toBe("forum");
  });

  test("unknown type → other(n), never dropped silently", () => {
    expect(channelTypeName(99)).toBe("other(99)");
    expect(channelTypeName(16)).toBe("other(16)"); // media — not yet labelled
  });
});

describe("listAllChannels", () => {
  // One channel of every type the label map covers, plus an unknown type.
  const RAW = [
    { id: "1", name: "general", type: 0, position: 1, topic: "chatter", parent_id: "10" },
    { id: "2", name: "voice-lounge", type: 2, position: 2, parent_id: "10" },
    { id: "10", name: "TEXT CHANNELS", type: 4, position: 0 },
    { id: "3", name: "news", type: 5, position: 3, parent_id: null },
    { id: "4", name: "help-forum", type: 15, position: 4 },
    { id: "5", name: "stage", type: 13, position: 5 },
    { id: "6", name: "media", type: 16, position: 6 },
  ];

  test("returns ALL types (not just text + announcement)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(200, RAW));

    const channels = await listAllChannels(BOT_TOKEN, GUILD);

    expect(channels.length).toBe(RAW.length);
    const typesSeen = new Set(channels.map((c) => c.type));
    expect(typesSeen).toEqual(new Set([0, 2, 4, 5, 15, 13, 16]));

    // Correct endpoint + auth.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/channels`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);

    fetchMock.mockRestore();
  });

  test("projects fields: id, name, type, parentId, position, topic", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(200, RAW));

    const channels = await listAllChannels(BOT_TOKEN, GUILD);
    const byId = new Map(channels.map((c) => [c.id, c]));

    const general = byId.get("1")!;
    expect(general).toEqual({
      id: "1",
      name: "general",
      type: 0,
      parentId: "10",
      position: 1,
      topic: "chatter",
    });
    // null parent_id / absent topic → undefined (not null).
    const news = byId.get("3")!;
    expect(news.parentId).toBeUndefined();
    expect(news.topic).toBeUndefined();

    fetchMock.mockRestore();
  });

  test("sorted by position then name", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(200, RAW));

    const channels = await listAllChannels(BOT_TOKEN, GUILD);
    const positions = channels.map((c) => c.position);
    const sorted = [...positions].sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual(sorted);

    fetchMock.mockRestore();
  });

  test("non-ok status → throws without echoing the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Access" })
    );

    try {
      await listAllChannels(BOT_TOKEN, GUILD);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/403/);
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });
});
