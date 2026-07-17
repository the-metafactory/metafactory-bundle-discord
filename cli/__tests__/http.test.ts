/**
 * Unit tests for the shared Discord REST transport (`cli/lib/http.ts`).
 *
 * ALL network calls are mocked via Bun's `spyOn(globalThis, "fetch")` — no live
 * Discord API. Retry / pacing delays are made deterministic by swapping the
 * module's sleeper for a spy (`__setSleeperForTest`) so no wall-clock time is
 * spent and the requested delays can be asserted exactly.
 *
 * Invariants covered:
 *   - happy path: auth header, JSON vs multipart body, parsed data
 *   - 429 retry: honours retry_after; caps at 3 attempts
 *   - X-RateLimit-Remaining: 0 → pause for Reset-After before returning
 *   - the bot token NEVER appears in returned error text
 */

import { describe, expect, test, afterEach, spyOn } from "bun:test";
import { discordRequest, __setSleeperForTest } from "../lib/http";

const TOKEN = "Bot.secret-token-must-not-appear-in-errors";

/** Build a `Response` with optional rate-limit headers. */
function res(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {}
): Response {
  const init: ResponseInit = { status, headers: { "Content-Type": "application/json", ...headers } };
  if (status === 204 || body === null) return new Response(null, init);
  return new Response(JSON.stringify(body), init);
}

/** Swap the module sleeper for a recording spy; returns { calls, restore }. */
function captureSleeper(): { calls: number[]; restore: () => void } {
  const calls: number[] = [];
  const prev = __setSleeperForTest(async (ms: number) => {
    calls.push(ms);
  });
  return { calls, restore: () => __setSleeperForTest(prev) };
}

let restoreSleeper: (() => void) | undefined;
afterEach(() => {
  restoreSleeper?.();
  restoreSleeper = undefined;
});

describe("discordRequest — happy path", () => {
  test("GET → parsed JSON data, bot auth header, no body", async () => {
    const s = captureSleeper();
    restoreSleeper = s.restore;
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { hello: "world" }, { "X-RateLimit-Remaining": "5" })
    );

    const out = await discordRequest<{ hello: string }>(TOKEN, "GET", "/guilds/1/channels");

    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.data).toEqual({ hello: "world" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/guilds/1/channels");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(s.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test("json body → Content-Type application/json + serialized body", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(res(200, { id: "9" }));

    await discordRequest(TOKEN, "POST", "/x", { json: { a: 1 } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));

    fetchMock.mockRestore();
  });

  test("form body → NO Content-Type (fetch derives the boundary)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(res(200, { id: "9" }));
    const form = new FormData();
    form.append("payload_json", "{}");

    await discordRequest(TOKEN, "POST", "/x", { form });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init.body).toBe(form);

    fetchMock.mockRestore();
  });

  test('expect "none" → success with undefined data (204)', async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(res(204));

    const out = await discordRequest(TOKEN, "PUT", "/x", { expect: "none" });

    expect(out.ok).toBe(true);
    expect(out.status).toBe(204);
    expect(out.data).toBeUndefined();

    fetchMock.mockRestore();
  });
});

describe("discordRequest — 429 retry", () => {
  test("429 then 200 → retries once, honours retry_after seconds", async () => {
    const s = captureSleeper();
    restoreSleeper = s.restore;
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(429, { retry_after: 0.5 }))
      .mockResolvedValueOnce(res(200, { done: true }));

    const out = await discordRequest<{ done: boolean }>(TOKEN, "GET", "/x");

    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.data).toEqual({ done: true });
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(s.calls).toEqual([500]); // 0.5s → 500ms

    fetchMock.mockRestore();
  });

  test("persistent 429 → caps at 3 attempts, returns the 429", async () => {
    const s = captureSleeper();
    restoreSleeper = s.restore;
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      res(429, { retry_after: 0.1, message: "Too Many Requests" })
    );

    const out = await discordRequest(TOKEN, "GET", "/x");

    expect(out.ok).toBe(false);
    expect(out.status).toBe(429);
    expect(out.errorText).toBeDefined();
    expect(fetchMock.mock.calls.length).toBe(3); // MAX_ATTEMPTS
    expect(s.calls).toEqual([100, 100]); // slept between attempts, not after the last

    fetchMock.mockRestore();
  });
});

describe("discordRequest — Remaining-0 pause", () => {
  test("Remaining 0 → pauses Reset-After seconds before returning", async () => {
    const s = captureSleeper();
    restoreSleeper = s.restore;
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { ok: true }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "1" })
    );

    const out = await discordRequest(TOKEN, "GET", "/x");

    expect(out.ok).toBe(true);
    expect(s.calls).toEqual([1000]); // 1s → 1000ms pause

    fetchMock.mockRestore();
  });

  test("Remaining > 0 → no pause", async () => {
    const s = captureSleeper();
    restoreSleeper = s.restore;
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(200, { ok: true }, { "X-RateLimit-Remaining": "4", "X-RateLimit-Reset-After": "1" })
    );

    await discordRequest(TOKEN, "GET", "/x");

    expect(s.calls.length).toBe(0);

    fetchMock.mockRestore();
  });
});

describe("discordRequest — token redaction", () => {
  test("error response → token never appears in errorText", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      res(403, { message: "Missing Permissions" })
    );

    const out = await discordRequest(TOKEN, "GET", "/x");

    expect(out.ok).toBe(false);
    expect(out.status).toBe(403);
    expect(out.errorText).not.toContain(TOKEN);
    // The token IS used — just only on the wire, in the Authorization header.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);

    fetchMock.mockRestore();
  });
});
