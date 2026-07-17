/**
 * Unit tests for channel permission overwrites (`cli/lib/guild/permissions.ts`).
 *
 * ALL network calls are mocked via Bun's `spyOn(globalThis, "fetch")` — no live
 * Discord API. Coverage:
 *   - bitmask composition round-trip (names → decimal string → names)
 *   - BigInt serialization beyond 2^31 (MANAGE_THREADS = 1 << 34)
 *   - set / clear 204 handling (correct endpoint, method, body)
 *   - sync copy logic (parent overwrites replicated, channel extras removed)
 *   - unknown permission name error (lists valid names)
 *   - the bot token NEVER appears in a thrown error message
 */

import { describe, expect, test, spyOn, afterEach } from "bun:test";
import {
  PERMISSIONS,
  permissionNamesToBits,
  parsePermissionList,
  bitsToPermissionNames,
  bitsToWire,
  setOverwrite,
  deleteOverwrite,
  syncFromCategory,
} from "../lib/guild/permissions";

const TOKEN = "Bot.secret-token-must-not-appear-in-errors";
const CHILD = "200000000000000001";
const PARENT = "200000000000000009";

/** Build a JSON `Response` (204 → empty body). */
function jsonRes(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {}
): Response {
  const init: ResponseInit = {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (status === 204 || body === null) return new Response(null, init);
  return new Response(JSON.stringify(body), init);
}

let fetchMock: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchMock?.mockRestore();
  fetchMock = undefined;
});

// ─── bitmask composition ────────────────────────────────────────────────────

describe("bitmask composition", () => {
  test("names → string → names round-trips", () => {
    const names = ["VIEW_CHANNEL", "SEND_MESSAGES", "MANAGE_THREADS"];
    const wire = bitsToWire(permissionNamesToBits(names));
    const back = bitsToPermissionNames(BigInt(wire));
    expect([...back].sort()).toEqual([...names].sort());
  });

  test("BigInt flags beyond 2^31 serialize correctly (MANAGE_THREADS = 1<<34)", () => {
    const expected = (1n << 34n).toString(); // 17179869184
    expect(expected).toBe("17179869184");
    expect(bitsToWire(parsePermissionList("MANAGE_THREADS"))).toBe(expected);
    // and past a JS-number-safe boundary too (CREATE_EVENTS = 1<<44)
    expect(bitsToWire(parsePermissionList("CREATE_EVENTS"))).toBe(
      (1n << 44n).toString()
    );
    // decode is lossless
    expect(bitsToPermissionNames(1n << 34n)).toEqual(["MANAGE_THREADS"]);
  });

  test("composition ORs low and high bits without collision", () => {
    const bits = parsePermissionList("ADD_REACTIONS,MANAGE_THREADS");
    expect(bits).toBe(PERMISSIONS.ADD_REACTIONS! | PERMISSIONS.MANAGE_THREADS!);
    expect([...bitsToPermissionNames(bits)].sort()).toEqual(
      ["ADD_REACTIONS", "MANAGE_THREADS"].sort()
    );
  });

  test("unknown bits decode to bit:N rather than being dropped", () => {
    // bit 2 is not a mapped flag
    expect(bitsToPermissionNames(1n << 2n)).toEqual(["bit:2"]);
    // a mapped flag plus an unknown bit surfaces both
    expect([...bitsToPermissionNames((1n << 10n) | (1n << 2n))].sort()).toEqual(
      ["VIEW_CHANNEL", "bit:2"].sort()
    );
  });

  test("unknown permission name errors listing valid names", () => {
    expect(() => parsePermissionList("VIEW_CHANNEL,NOT_A_PERM")).toThrow(
      /Unknown permission name\(s\): NOT_A_PERM/
    );
    // the valid set is included so the caller can self-correct
    try {
      parsePermissionList("NOPE");
    } catch (err) {
      expect((err as Error).message).toContain("VIEW_CHANNEL");
      expect((err as Error).message).toContain("MANAGE_THREADS");
    }
  });
});

// ─── setOverwrite / deleteOverwrite ─────────────────────────────────────────

describe("setOverwrite", () => {
  test("204 → resolves; PUTs correct endpoint, method, and JSON body", async () => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonRes(204));

    await setOverwrite(TOKEN, CHILD, "999", {
      type: 0,
      allow: bitsToWire(parsePermissionList("VIEW_CHANNEL")),
      deny: "0",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/channels/${CHILD}/permissions/999`
    );
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bot ${TOKEN}`
    );
    expect(JSON.parse(init.body as string)).toEqual({
      type: 0,
      allow: (1n << 10n).toString(),
      deny: "0",
    });
  });

  test("403 → throws the 'bot can only grant what it holds' guidance, no token", async () => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonRes(403, { message: "Missing Permissions", code: 50013 })
    );

    let message = "";
    try {
      await setOverwrite(TOKEN, CHILD, "999", { type: 0, allow: "0", deny: "0" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("can only grant");
    expect(message).toContain(CHILD);
    expect(message).not.toContain(TOKEN);
  });
});

describe("deleteOverwrite", () => {
  test("204 → resolves; DELETEs correct endpoint", async () => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonRes(204));

    await deleteOverwrite(TOKEN, CHILD, "999");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/channels/${CHILD}/permissions/999`
    );
    expect(init.method).toBe("DELETE");
  });

  test("non-2xx error text never contains the token", async () => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonRes(500, { message: "Internal Server Error" })
    );

    let message = "";
    try {
      await deleteOverwrite(TOKEN, CHILD, "999");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("500");
    expect(message).not.toContain(TOKEN);
  });
});

// ─── syncFromCategory ───────────────────────────────────────────────────────

describe("syncFromCategory", () => {
  test("copies every parent overwrite and removes channel-only extras", async () => {
    const SHARED = "300000000000000001"; // present on both parent and child
    const ROLEB = "300000000000000002"; // parent-only → must be copied
    const EXTRA = "300000000000000003"; // child-only → must be removed

    const calls: Array<{ method: string; url: string }> = [];
    const impl = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url });

        if (method === "GET" && url.endsWith(`/channels/${CHILD}`)) {
          return jsonRes(200, {
            parent_id: PARENT,
            permission_overwrites: [
              { id: SHARED, type: 0, allow: "0", deny: "1024" },
              { id: EXTRA, type: 0, allow: "0", deny: "0" },
            ],
          });
        }
        if (method === "GET" && url.endsWith(`/channels/${PARENT}`)) {
          return jsonRes(200, {
            permission_overwrites: [
              { id: SHARED, type: 0, allow: "0", deny: "1024" },
              { id: ROLEB, type: 0, allow: "2048", deny: "0" },
            ],
          });
        }
        // PUT copies and DELETE removals all succeed
        return jsonRes(204);
    };
    fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      impl as unknown as typeof fetch
    );

    const result = await syncFromCategory(TOKEN, CHILD);

    expect(result).toEqual({ parentId: PARENT, copied: 2, removed: 1 });

    // Both parent overwrites were PUT onto the child.
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          c.url.endsWith(`/channels/${CHILD}/permissions/${SHARED}`)
      )
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          c.url.endsWith(`/channels/${CHILD}/permissions/${ROLEB}`)
      )
    ).toBe(true);

    // The child-only extra was deleted...
    expect(
      calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.url.endsWith(`/channels/${CHILD}/permissions/${EXTRA}`)
      )
    ).toBe(true);
    // ...and the shared overwrite was NOT deleted.
    expect(
      calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.url.endsWith(`/channels/${CHILD}/permissions/${SHARED}`)
      )
    ).toBe(false);
  });

  test("channel with no parent category throws without any write", async () => {
    const calls: string[] = [];
    const impl = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonRes(200, { parent_id: null, permission_overwrites: [] });
    };
    fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      impl as unknown as typeof fetch
    );

    await expect(syncFromCategory(TOKEN, CHILD)).rejects.toThrow(
      /no parent category/
    );
    // Only the single channel GET happened — no PUT/DELETE.
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("GET");
  });
});
