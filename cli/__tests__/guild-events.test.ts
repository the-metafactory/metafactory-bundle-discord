/**
 * Unit tests for guild scheduled events (issue #14).
 *
 * ALL network calls are mocked via Bun's `spyOn(globalThis, "fetch")` — no live
 * Discord API. Covered:
 *   - create per entity type (VOICE, STAGE, EXTERNAL) → correct wire payload
 *   - client-side validation: EXTERNAL requires end + location; past dates and
 *     malformed ISO are rejected BEFORE any fetch
 *   - modify (rename) and delete (204)
 *   - listEvents (with_user_count=true) and RSVP pagination
 *   - 403 permission mapping
 *   - the bot token NEVER appears in any error string
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  createEvent,
  modifyEvent,
  deleteEvent,
  listEvents,
  getEventUsers,
  collectEventUsers,
  validateEventSpec,
  eventTypeName,
  EntityType,
  type EventSpec,
} from "../lib/guild/events";

const GUILD = "100000000000000001";
const EVENT = "200000000000000002";
const VOICE_CHANNEL = "300000000000000003";
const BOT_TOKEN = "Bot.secret-token-must-not-appear-in-errors";

/** A far-future ISO time so `Date.now()` past-checks never flake. */
const FUTURE_START = "2999-08-01T19:00:00+12:00";
const FUTURE_END = "2999-08-01T21:00:00+12:00";
const PAST_START = "2000-01-01T00:00:00Z";

/** Build a JSON `Response` with the given status/body. */
function res(status: number, body: unknown = null): Response {
  const text = status === 204 || body === null ? null : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

/** Read the parsed JSON body from the first recorded fetch call. */
function bodyOf(fetchMock: ReturnType<typeof spyOn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// ─── createEvent — per entity type ────────────────────────────────────────────

describe("createEvent — EXTERNAL", () => {
  test("builds the EXTERNAL payload: type 3, channel_id null, location, end, privacy 2", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { id: EVENT, name: "Team meetup", entity_type: 3, scheduled_start_time: FUTURE_START })
    );

    const spec: EventSpec = {
      name: "Team meetup",
      scheduledStartTime: FUTURE_START,
      scheduledEndTime: FUTURE_END,
      entityType: EntityType.EXTERNAL,
      location: "guild voice",
    };
    const result = await createEvent(BOT_TOKEN, GUILD, spec);

    expect(result.success).toBe(true);
    expect(result.event?.id).toBe(EVENT);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/scheduled-events`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);

    const body = bodyOf(fetchMock);
    expect(body.entity_type).toBe(3);
    expect(body.channel_id).toBeNull();
    expect(body.entity_metadata).toEqual({ location: "guild voice" });
    expect(body.scheduled_end_time).toBe(FUTURE_END);
    expect(body.privacy_level).toBe(2);
    expect(body.scheduled_start_time).toBe(FUTURE_START);

    fetchMock.mockRestore();
  });

  test("EXTERNAL without end → client-side error, NO fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Team meetup",
      scheduledStartTime: FUTURE_START,
      entityType: EntityType.EXTERNAL,
      location: "guild voice",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/end time/i);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test("EXTERNAL without location → client-side error, NO fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Team meetup",
      scheduledStartTime: FUTURE_START,
      scheduledEndTime: FUTURE_END,
      entityType: EntityType.EXTERNAL,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/location/i);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });
});

describe("createEvent — VOICE / STAGE", () => {
  test("VOICE → type 2 with channel_id, no entity_metadata", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { id: EVENT, name: "Standup", entity_type: 2, scheduled_start_time: FUTURE_START })
    );

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Standup",
      scheduledStartTime: FUTURE_START,
      entityType: EntityType.VOICE,
      channelId: VOICE_CHANNEL,
    });

    expect(result.success).toBe(true);
    const body = bodyOf(fetchMock);
    expect(body.entity_type).toBe(2);
    expect(body.channel_id).toBe(VOICE_CHANNEL);
    expect(body.entity_metadata).toBeUndefined();

    fetchMock.mockRestore();
  });

  test("STAGE → type 1 with channel_id", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { id: EVENT, name: "Town Hall", entity_type: 1, scheduled_start_time: FUTURE_START })
    );

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Town Hall",
      scheduledStartTime: FUTURE_START,
      entityType: EntityType.STAGE_INSTANCE,
      channelId: VOICE_CHANNEL,
    });

    expect(result.success).toBe(true);
    expect(bodyOf(fetchMock).entity_type).toBe(1);
    expect(bodyOf(fetchMock).channel_id).toBe(VOICE_CHANNEL);

    fetchMock.mockRestore();
  });

  test("VOICE without channel → client-side error, NO fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Standup",
      scheduledStartTime: FUTURE_START,
      entityType: EntityType.VOICE,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/channel/i);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });
});

// ─── createEvent — date validation ────────────────────────────────────────────

describe("createEvent — ISO8601 validation", () => {
  test("past start time → rejected client-side, NO fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Old meetup",
      scheduledStartTime: PAST_START,
      entityType: EntityType.VOICE,
      channelId: VOICE_CHANNEL,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/past/i);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test("malformed ISO start → rejected client-side, NO fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Bad",
      scheduledStartTime: "next friday",
      entityType: EntityType.VOICE,
      channelId: VOICE_CHANNEL,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ISO8601/);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test("end before start → rejected", async () => {
    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Backwards",
      scheduledStartTime: FUTURE_END,
      scheduledEndTime: FUTURE_START,
      entityType: EntityType.EXTERNAL,
      location: "somewhere",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/after the start/i);
  });

  test("validateEventSpec returns null for a well-formed EXTERNAL spec", () => {
    expect(
      validateEventSpec({
        name: "OK",
        scheduledStartTime: FUTURE_START,
        scheduledEndTime: FUTURE_END,
        entityType: EntityType.EXTERNAL,
        location: "guild voice",
      })
    ).toBeNull();
  });
});

// ─── modifyEvent / deleteEvent ────────────────────────────────────────────────

describe("modifyEvent", () => {
  test("rename → PATCH with only { name }", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { id: EVENT, name: "Team sync", entity_type: 3, scheduled_start_time: FUTURE_START })
    );

    const result = await modifyEvent(BOT_TOKEN, GUILD, EVENT, { name: "Team sync" });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/scheduled-events/${EVENT}`);
    expect(init.method).toBe("PATCH");
    expect(bodyOf(fetchMock)).toEqual({ name: "Team sync" });

    fetchMock.mockRestore();
  });

  test("empty name → rejected client-side, NO fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const result = await modifyEvent(BOT_TOKEN, GUILD, EVENT, { name: "   " });
    expect(result.success).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(0);
    fetchMock.mockRestore();
  });
});

describe("deleteEvent", () => {
  test("204 → success", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(res(204));

    const result = await deleteEvent(BOT_TOKEN, GUILD, EVENT);

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/scheduled-events/${EVENT}`);
    expect(init.method).toBe("DELETE");

    fetchMock.mockRestore();
  });
});

// ─── listEvents ───────────────────────────────────────────────────────────────

describe("listEvents", () => {
  test("requests with_user_count=true and returns the events", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, [
        { id: EVENT, name: "Team meetup", entity_type: 3, scheduled_start_time: FUTURE_START, user_count: 7 },
      ])
    );

    const events = await listEvents(BOT_TOKEN, GUILD);

    expect(events.length).toBe(1);
    expect(events[0]?.user_count).toBe(7);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/scheduled-events?with_user_count=true`
    );

    fetchMock.mockRestore();
  });

  test("non-2xx → throws without the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(403, { message: "Missing Access" })
    );

    try {
      await listEvents(BOT_TOKEN, GUILD);
      throw new Error("expected listEvents to throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/403/);
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });
});

// ─── getEventUsers / collectEventUsers — RSVP pagination ──────────────────────

/** Build a page of N synthetic RSVP users with sequential ids from `base`. */
function usersPage(count: number, base: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    guild_scheduled_event_id: EVENT,
    user: { id: String(base + i), username: `user${base + i}` },
  }));
}

describe("getEventUsers", () => {
  test("single page → limit=100, maps user id + name (global_name preferred)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, [
        { guild_scheduled_event_id: EVENT, user: { id: "5", username: "raw", global_name: "Display" } },
      ])
    );

    const users = await getEventUsers(BOT_TOKEN, GUILD, EVENT);

    expect(users).toEqual([{ id: "5", username: "Display" }]);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/scheduled-events/${EVENT}/users?limit=100`
    );

    fetchMock.mockRestore();
  });

  test("limit clamped to 100 even if a larger value is passed", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(res(200, []));
    await getEventUsers(BOT_TOKEN, GUILD, EVENT, { limit: 500 });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("limit=100");
    fetchMock.mockRestore();
  });
});

describe("collectEventUsers — pagination", () => {
  test("full page then short page → two fetches, cursor after last id", async () => {
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(200, usersPage(100, 1))) // ids 1..100
      .mockResolvedValueOnce(res(200, usersPage(3, 101))); // ids 101..103

    const all = await collectEventUsers(BOT_TOKEN, GUILD, EVENT);

    expect(all.length).toBe(103);
    expect(fetchMock.mock.calls.length).toBe(2);
    // Second call carries after=<last id of first page> = 100
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(secondUrl).toContain("after=100");

    fetchMock.mockRestore();
  });

  test("single short page → one fetch, no cursor", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(res(200, usersPage(2, 1)));

    const all = await collectEventUsers(BOT_TOKEN, GUILD, EVENT);

    expect(all.length).toBe(2);
    expect(fetchMock.mock.calls.length).toBe(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("after=");

    fetchMock.mockRestore();
  });
});

// ─── error mapping + token redaction ──────────────────────────────────────────

describe("403 mapping + token redaction", () => {
  test("createEvent 403 → permission message, token never present", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(403, { message: "Missing Permissions" })
    );

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Team meetup",
      scheduledStartTime: FUTURE_START,
      scheduledEndTime: FUTURE_END,
      entityType: EntityType.EXTERNAL,
      location: "guild voice",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/permission/i);
    expect(result.error).toMatch(GUILD);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });

  test("deleteEvent 404 → not-found message", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(404, { message: "Unknown Guild Scheduled Event" })
    );

    const result = await deleteEvent(BOT_TOKEN, GUILD, EVENT);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });

  test("createEvent 400 → surfaces body, token never present", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(400, { message: "Invalid Form Body" })
    );

    const result = await createEvent(BOT_TOKEN, GUILD, {
      name: "Team meetup",
      scheduledStartTime: FUTURE_START,
      entityType: EntityType.VOICE,
      channelId: VOICE_CHANNEL,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/400/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── eventTypeName ────────────────────────────────────────────────────────────

describe("eventTypeName", () => {
  test("known types", () => {
    expect(eventTypeName(1)).toBe("stage");
    expect(eventTypeName(2)).toBe("voice");
    expect(eventTypeName(3)).toBe("external");
  });
  test("unknown type stays visible", () => {
    expect(eventTypeName(99)).toBe("other(99)");
  });
});
