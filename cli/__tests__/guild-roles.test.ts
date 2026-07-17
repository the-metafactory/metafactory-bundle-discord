/**
 * Unit tests for guild role lifecycle (issue #10):
 *   - lib (cli/lib/guild/roles.ts): create / modify / delete / reorder / list
 *   - command (cli/commands/role.ts): the `delete` guard rails (managed-refusal,
 *     --yes confirmation) that live in the CLI glue, driven through commander.
 *
 * ALL network is mocked via `spyOn(globalThis, "fetch")` — no live Discord API.
 * `../lib/config` is mocked so the command's context resolution yields a token +
 * guild without touching the real config file.
 *
 * Security invariant (mirrors role.test.ts / http.test.ts): the bot token is
 * NEVER echoed in any error string.
 */

import { describe, expect, test, afterEach, mock, spyOn } from "bun:test";
import { Command } from "commander";
import {
  createRole,
  modifyRole,
  deleteRole,
  reorderRoles,
  listRoles,
  type RoleSpec,
} from "../lib/guild/roles";

// ─── config mock (for the command-level tests) ─────────────────────────────────
//
// Placed before any dynamic import of `../commands/role` so role.ts's
// `loadConfig` resolves to this stub. The lib-level tests below don't import
// config, so they are unaffected.

const GUILD = "100000000000000001";
const ROLE_ID = "999000111222333444";
const MANAGED_ID = "555000111222333444";
const BOT_TOKEN = "Bot.secret-token-must-not-appear-in-errors";

mock.module("../lib/config", () => ({
  loadConfig: () => ({ guildId: GUILD, botToken: BOT_TOKEN }),
  saveConfig: () => {},
}));

// ─── helpers ───────────────────────────────────────────────────────────────────

/** Build a `Response`-like mock; 204 / null bodies use a null body (204 rule). */
function fakeResponse(
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

// Restore every spy after each test so the shared global `fetch` spy never
// leaks calls (or a stubbed implementation) into a sibling test file.
afterEach(() => {
  mock.restore();
});

/** A full Discord API role fixture with overridable fields. */
function apiRole(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ROLE_ID,
    name: "test-role",
    color: 0x3b82f6,
    hoist: true,
    position: 3,
    permissions: "0",
    mentionable: false,
    managed: false,
    icon: null,
    unicode_emoji: null,
    ...over,
  };
}

// ═══ createRole ════════════════════════════════════════════════════════════════

describe("createRole", () => {
  test("happy path → POST /guilds/{id}/roles, returns projected role", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, apiRole())
    );

    const spec: RoleSpec = { name: "test-role", color: 0x3b82f6, hoist: true };
    const result = await createRole(BOT_TOKEN, GUILD, spec);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.role.id).toBe(ROLE_ID);
      expect(result.role.name).toBe("test-role");
      expect(result.role.color).toBe(0x3b82f6);
      // null icon / emoji project to undefined, never null.
      expect(result.role.icon).toBeUndefined();
      expect(result.role.unicode_emoji).toBeUndefined();
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/roles`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);
    // Body carries only the fields the spec set.
    expect(JSON.parse(init.body as string)).toEqual({
      name: "test-role",
      color: 0x3b82f6,
      hoist: true,
    });

    fetchMock.mockRestore();
  });

  test("403 → Manage Roles / hierarchy message (not the token)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await createRole(BOT_TOKEN, GUILD, { name: "x" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Manage Roles/);
      expect(result.error).toMatch(GUILD);
      expect(result.error).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });

  test("icon on a non-boosted guild → one-line Boost Level 2 error, no stack trace", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(400, { message: "Unknown feature: ROLE_ICONS" })
    );

    const result = await createRole(BOT_TOKEN, GUILD, {
      name: "iconic",
      icon: "data:image/png;base64,AAAA",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Boost Level 2/);
      expect(result.error).not.toContain(BOT_TOKEN);
      // Single line — degrades cleanly rather than a multi-line stack.
      expect(result.error.split("\n").length).toBe(1);
    }

    fetchMock.mockRestore();
  });

  test("invalid (non-snowflake) guild id → rejected locally, no fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await createRole(BOT_TOKEN, "not-a-guild", { name: "x" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid guild id/);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });
});

// ═══ modifyRole ══════════════════════════════════════════════════════════════

describe("modifyRole", () => {
  test("happy path → PATCH /guilds/{id}/roles/{roleId}", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, apiRole({ name: "renamed" }))
    );

    const result = await modifyRole(BOT_TOKEN, GUILD, ROLE_ID, { name: "renamed" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.role.name).toBe("renamed");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/roles/${ROLE_ID}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ name: "renamed" });

    fetchMock.mockRestore();
  });

  test("403 → mapped message without the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await modifyRole(BOT_TOKEN, GUILD, ROLE_ID, { name: "x" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Manage Roles/);
      expect(result.error).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });

  test("invalid role id → rejected locally, no fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await modifyRole(BOT_TOKEN, GUILD, "bad-role", { name: "x" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid role id/);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });
});

// ═══ deleteRole ══════════════════════════════════════════════════════════════

describe("deleteRole", () => {
  test("204 → success, DELETE /guilds/{id}/roles/{roleId}", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(204)
    );

    const result = await deleteRole(BOT_TOKEN, GUILD, ROLE_ID);

    expect(result.success).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/roles/${ROLE_ID}`);
    expect(init.method).toBe("DELETE");

    fetchMock.mockRestore();
  });

  test("403 → mapped message without the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await deleteRole(BOT_TOKEN, GUILD, ROLE_ID);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Manage Roles/);
      expect(result.error).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });
});

// ═══ reorderRoles ════════════════════════════════════════════════════════════

describe("reorderRoles", () => {
  test("happy path → PATCH /guilds/{id}/roles with positions, sorts highest-first", async () => {
    const returned = [
      apiRole({ id: "111111111111111111", name: "low", position: 1 }),
      apiRole({ id: "222222222222222222", name: "high", position: 5 }),
      apiRole({ id: "333333333333333333", name: "mid", position: 3 }),
    ];
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, returned)
    );

    const positions = [{ id: "222222222222222222", position: 5 }];
    const result = await reorderRoles(BOT_TOKEN, GUILD, positions);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.roles.map((r) => r.name)).toEqual(["high", "mid", "low"]);
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/roles`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual(positions);

    fetchMock.mockRestore();
  });

  test("403 → mapped message without the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await reorderRoles(BOT_TOKEN, GUILD, [{ id: ROLE_ID, position: 2 }]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Manage Roles/);
      expect(result.error).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });

  test("invalid role id in payload → rejected locally, no fetch", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await reorderRoles(BOT_TOKEN, GUILD, [{ id: "nope", position: 1 }]);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid role id/);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });
});

// ═══ listRoles ═══════════════════════════════════════════════════════════════

describe("listRoles", () => {
  test("happy path → GET, projects managed flag, sorts highest-first", async () => {
    const returned = [
      apiRole({ id: "111111111111111111", name: "everyone", position: 0, managed: false }),
      apiRole({ id: MANAGED_ID, name: "booster", position: 4, managed: true }),
      apiRole({ id: "333333333333333333", name: "member", position: 2, managed: false }),
    ];
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, returned)
    );

    const result = await listRoles(BOT_TOKEN, GUILD);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.roles.map((r) => r.name)).toEqual(["booster", "member", "everyone"]);
      const booster = result.roles.find((r) => r.id === MANAGED_ID)!;
      expect(booster.managed).toBe(true);
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/roles`);
    expect(init.method).toBe("GET");

    fetchMock.mockRestore();
  });

  test("403 → mapped message without the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Access" })
    );

    const result = await listRoles(BOT_TOKEN, GUILD);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Manage Roles/);
      expect(result.error).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });
});

// ═══ token-never-in-errors (representative sweep) ════════════════════════════

describe("token never appears in any error string", () => {
  // The token lives only in the Authorization header (see cli/lib/http.ts); a
  // Discord error body never echoes it. This proves every verb's mapper builds
  // its error from the status + body alone, so the token can never surface.
  test("every verb's mapped error omits the token", async () => {
    const cases: Array<() => Promise<{ success: boolean; error?: string }>> = [
      () => createRole(BOT_TOKEN, GUILD, { name: "x" }),
      () => modifyRole(BOT_TOKEN, GUILD, ROLE_ID, { name: "x" }),
      () => deleteRole(BOT_TOKEN, GUILD, ROLE_ID),
      () => reorderRoles(BOT_TOKEN, GUILD, [{ id: ROLE_ID, position: 1 }]),
      () => listRoles(BOT_TOKEN, GUILD),
    ];

    for (const call of cases) {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
        fakeResponse(500, { message: "Internal Server Error" })
      );
      const result = await call();
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toMatch(/500/);
      expect((result as { error: string }).error).not.toContain(BOT_TOKEN);
      fetchMock.mockRestore();
    }
  });
});

// ═══ command: `role delete` guard rails (commander-driven) ════════════════════

/** Thrown by the spied `process.exit` so a CLI abort is catchable in a test. */
class ExitSignal extends Error {}

async function runRole(argv: string[]): Promise<void> {
  const { registerRole } = await import("../commands/role");
  const program = new Command().name("discord");
  program.exitOverride();
  registerRole(program);
  await program.parseAsync(["node", "discord", ...argv]);
}

describe("role delete (command guard rails)", () => {
  /** Methods of the fetch calls whose URL targets the guild roles endpoint. */
  function roleCallMethods(
    fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
  ): string[] {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).includes(`/guilds/${GUILD}/roles`))
      .map((c) => (c[1] as RequestInit)?.method ?? "");
  }

  test("without --yes → aborts before any network call", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    fetchMock.mockClear(); // hermetic: drop any calls the shared fetch spy accrued
    const exitMock = spyOn(process, "exit").mockImplementation((() => {
      throw new ExitSignal();
    }) as never);
    const errMock = spyOn(console, "error").mockImplementation(() => {});

    await expect(runRole(["role", "delete", "--role", ROLE_ID])).rejects.toBeInstanceOf(
      ExitSignal
    );

    expect(roleCallMethods(fetchMock)).toEqual([]);
    expect(errMock.mock.calls.flat().join(" ")).toMatch(/--yes|confirm/i);

    exitMock.mockRestore();
    errMock.mockRestore();
  });

  test("managed role → refused after list, DELETE never issued", async () => {
    const roles = [apiRole({ id: MANAGED_ID, name: "booster", managed: true })];
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(fakeResponse(200, roles));
    fetchMock.mockClear();
    const exitMock = spyOn(process, "exit").mockImplementation((() => {
      throw new ExitSignal();
    }) as never);
    const errMock = spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runRole(["role", "delete", "--role", MANAGED_ID, "--yes"])
    ).rejects.toBeInstanceOf(ExitSignal);

    // Only the GET (listRoles) fired; the DELETE was refused.
    expect(roleCallMethods(fetchMock)).toEqual(["GET"]);
    expect(errMock.mock.calls.flat().join(" ")).toMatch(/managed/i);

    exitMock.mockRestore();
    errMock.mockRestore();
  });

  test("non-managed role with --yes → GET then DELETE 204", async () => {
    const roles = [apiRole({ id: ROLE_ID, name: "temp", managed: false })];
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fakeResponse(200, roles)) // GET listRoles
      .mockResolvedValueOnce(fakeResponse(204)); // DELETE
    fetchMock.mockClear();
    const exitMock = spyOn(process, "exit").mockImplementation((() => {
      throw new ExitSignal();
    }) as never);
    const logMock = spyOn(console, "log").mockImplementation(() => {});

    await runRole(["role", "delete", "--role", ROLE_ID, "--yes"]);

    expect(roleCallMethods(fetchMock)).toEqual(["GET", "DELETE"]);
    expect(logMock.mock.calls.flat().join(" ")).toMatch(/Deleted role/);
    expect(exitMock).not.toHaveBeenCalled();

    exitMock.mockRestore();
    logMock.mockRestore();
  });
});
