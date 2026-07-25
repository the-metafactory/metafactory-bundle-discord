/**
 * Unit tests for `__NAME__` placeholder resolution in the guild-layout pipeline.
 *
 * The motivating case: a channel topic must carry a live bot id for the mention to
 * render, but that id must not be committed. So the layout writes
 * `<@__ESCORT_BOT_ID__>` and the value arrives at apply time.
 *
 * Coverage maps to the behaviours that make that safe:
 *   - a placeholder resolves from the environment;
 *   - `--var NAME=VALUE` overrides the environment;
 *   - several placeholders in ONE string all resolve;
 *   - placeholders resolve in keys and nested values, not just topics;
 *   - an unresolved placeholder THROWS, naming every missing variable — and the
 *     CLI refuses on BOTH `guild diff` and `guild apply`, before any network call;
 *   - a set-but-empty variable counts as unset (an empty value would ship `<@>`);
 *   - a layout with no placeholders parses exactly as before (no regression);
 *   - resolution happens BEFORE the diff: a resolved layout that matches the live
 *     guild still plans nothing.
 *
 * NOTE ON IDS: every id here is a short synthetic string, never a real Discord
 * snowflake. Nothing in this file is a live platform id.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findPlaceholders,
  varLookup,
  parseVarFlags,
  resolvePlaceholders,
  PlaceholderError,
  VarFlagError,
  NO_VARS,
} from "../lib/guild/placeholders";
import { parseLayout, diffLayout, isEmptyPlan, LayoutError } from "../lib/guild/layout";
import type { GuildSnapshot, SnapshotRole, SnapshotChannel } from "../lib/guild/snapshot";

// ─── synthetic ids (never real snowflakes) ─────────────────────────────────────

const GUILD = "g-1";
const BOT = "bot-7";
const HELPER_BOT = "bot-8";

// ─── fixtures ──────────────────────────────────────────────────────────────────

/** A layout whose only channel topic mentions a bot via a placeholder. */
const LAYOUT_WITH_PLACEHOLDER = `
channels:
  arrivals:
    type: text
    parent: null
    topic: "Say hello by mentioning <@__ESCORT_BOT_ID__> — it opens you a thread."
`;

/** The same layout with the mention already literal — the no-placeholder control. */
const LAYOUT_WITHOUT_PLACEHOLDER = `
channels:
  arrivals:
    type: text
    parent: null
    topic: "Say hello by mentioning <@${BOT}> — it opens you a thread."
`;

function everyoneRole(): SnapshotRole {
  return {
    id: GUILD,
    name: "@everyone",
    color: 0,
    hoist: false,
    mentionable: false,
    position: 0,
    managed: false,
    permissions: ["VIEW_CHANNEL"],
  };
}

function channel(name: string, topic: string | null): SnapshotChannel {
  return {
    id: "c-1",
    name,
    type: "text",
    parent: null,
    topic,
    position: 0,
    slowmode: 0,
    overwrites: [],
  };
}

/** A guild carrying exactly `channels`, and nothing else the layouts manage. */
function snapshotWith(channels: SnapshotChannel[]): GuildSnapshot {
  return {
    guild: {
      id: GUILD,
      name: "Test Guild",
      features: [],
      verification_level: "none",
      rules_channel: null,
      public_updates_channel: null,
      system_channel: null,
      premium_tier: 0,
    },
    roles: [everyoneRole()],
    categories: [],
    channels,
    events: [],
    webhooks: [],
    welcome_screen: { enabled: false, description: null, channels: [] },
  };
}

/** Write `text` to a throwaway file and return its path (for the CLI spawn tests). */
function tempLayout(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "discord-layout-"));
  const file = join(dir, "guild-layout.yaml");
  writeFileSync(file, text);
  return file;
}

const CLI = join(import.meta.dir, "..", "discord.ts");

/**
 * Run the real CLI hermetically: `CORTEX_CONFIG_DIR` points at an empty temp tree
 * (so no real `cli.yaml`, no token, and therefore NO possibility of a Discord
 * call), and `ESCORT_BOT_ID` is scrubbed from the inherited environment unless a
 * test sets it deliberately.
 */
async function runCli(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ code: number; stderr: string; stdout: string }> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete childEnv.ESCORT_BOT_ID;
  childEnv.CORTEX_CONFIG_DIR = mkdtempSync(join(tmpdir(), "discord-cfg-"));
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...childEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr, stdout };
}

// ─── the token ─────────────────────────────────────────────────────────────────

describe("findPlaceholders", () => {
  test("finds a placeholder embedded in surrounding text", () => {
    expect(findPlaceholders("mention <@__ESCORT_BOT_ID__> here")).toEqual(["ESCORT_BOT_ID"]);
  });

  test("finds several placeholders in one string, in order", () => {
    expect(findPlaceholders("<@__A_BOT__> and <@__B_BOT__> and <@__A_BOT__>")).toEqual([
      "A_BOT",
      "B_BOT",
      "A_BOT",
    ]);
  });

  test("ordinary prose with underscores is not a placeholder", () => {
    expect(findPlaceholders("snake_case and __lower__ and _ _ __")).toEqual([]);
  });
});

// ─── resolution sources + precedence ───────────────────────────────────────────

describe("varLookup", () => {
  test("resolves from the environment", () => {
    expect(varLookup({ ESCORT_BOT_ID: BOT })("ESCORT_BOT_ID")).toEqual({
      status: "resolved",
      value: BOT,
    });
  });

  test("an override beats the environment", () => {
    const lookup = varLookup({ ESCORT_BOT_ID: BOT }, { ESCORT_BOT_ID: HELPER_BOT });
    expect(lookup("ESCORT_BOT_ID")).toEqual({ status: "resolved", value: HELPER_BOT });
  });

  test("an unset name is missing, and a set-but-empty name is blank", () => {
    const lookup = varLookup({ BLANK: "   " });
    expect(lookup("NOPE")).toEqual({ status: "missing" });
    expect(lookup("BLANK")).toEqual({ status: "blank" });
  });
});

describe("parseVarFlags", () => {
  test("parses NAME=VALUE, splitting on the first = only", () => {
    expect(parseVarFlags(["ESCORT_BOT_ID=" + BOT, "MOTD=a=b=c"])).toEqual({
      ESCORT_BOT_ID: BOT,
      MOTD: "a=b=c",
    });
  });

  test("a later occurrence of a name wins", () => {
    expect(parseVarFlags(["X_ID=one", "X_ID=two"])).toEqual({ X_ID: "two" });
  });

  test("rejects a spec with no =", () => {
    expect(() => parseVarFlags(["ESCORT_BOT_ID"])).toThrow(VarFlagError);
    expect(() => parseVarFlags(["ESCORT_BOT_ID"])).toThrow(/expected NAME=VALUE/);
  });

  test("rejects a name that could never match a __NAME__ token", () => {
    expect(() => parseVarFlags(["escort_bot_id=x"])).toThrow(/not a valid placeholder name/);
  });
});

// ─── whole-document resolution ─────────────────────────────────────────────────

describe("resolvePlaceholders", () => {
  test("substitutes in nested values and in mapping keys alike", () => {
    const doc: unknown = { channels: { "__CHAN__": { topic: "for <@__ESCORT_BOT_ID__>" } } };
    const resolved = resolvePlaceholders(doc, varLookup({ CHAN: "arrivals", ESCORT_BOT_ID: BOT }));
    expect(resolved).toEqual({ channels: { arrivals: { topic: `for <@${BOT}>` } } });
  });

  test("leaves the input document untouched", () => {
    const doc = { topic: "<@__ESCORT_BOT_ID__>" };
    resolvePlaceholders(doc, varLookup({ ESCORT_BOT_ID: BOT }));
    expect(doc.topic).toBe("<@__ESCORT_BOT_ID__>");
  });

  test("non-string scalars pass through unchanged", () => {
    const doc = { color: 0x3b82f6, hoist: true, parent: null, tags: [1, 2] };
    expect(resolvePlaceholders(doc, NO_VARS)).toEqual(doc);
  });

  test("names EVERY unresolved variable at once, not just the first", () => {
    let caught: PlaceholderError | undefined;
    try {
      resolvePlaceholders({ a: "<@__B_BOT__>", b: "<@__A_BOT__>" }, NO_VARS);
    } catch (err) {
      caught = err as PlaceholderError;
    }
    expect(caught).toBeInstanceOf(PlaceholderError);
    expect(caught!.missing).toEqual(["A_BOT", "B_BOT"]); // sorted, deduped
    expect(caught!.message).toContain("__A_BOT__");
    expect(caught!.message).toContain("__B_BOT__");
  });

  test("a set-but-empty variable is reported separately from a missing one", () => {
    let caught: PlaceholderError | undefined;
    try {
      resolvePlaceholders(
        { a: "<@__EMPTY_ID__>", b: "<@__GONE_ID__>" },
        varLookup({ EMPTY_ID: "" })
      );
    } catch (err) {
      caught = err as PlaceholderError;
    }
    expect(caught!.blank).toEqual(["EMPTY_ID"]);
    expect(caught!.missing).toEqual(["GONE_ID"]);
    expect(caught!.message).toContain("set but empty");
  });
});

// ─── parseLayout integration ───────────────────────────────────────────────────

describe("parseLayout with placeholders", () => {
  test("resolves a topic placeholder from the environment", () => {
    const layout = parseLayout(LAYOUT_WITH_PLACEHOLDER, varLookup({ ESCORT_BOT_ID: BOT }));
    expect(layout.channels[0]!.topic).toBe(
      `Say hello by mentioning <@${BOT}> — it opens you a thread.`
    );
  });

  test("--var (an override) beats the environment", () => {
    const layout = parseLayout(
      LAYOUT_WITH_PLACEHOLDER,
      varLookup({ ESCORT_BOT_ID: BOT }, { ESCORT_BOT_ID: HELPER_BOT })
    );
    expect(layout.channels[0]!.topic).toContain(`<@${HELPER_BOT}>`);
    expect(layout.channels[0]!.topic).not.toContain(BOT);
  });

  test("several placeholders in one topic all resolve", () => {
    const text = `
channels:
  arrivals:
    type: text
    topic: "Ping <@__ESCORT_BOT_ID__> or <@__STEWARD_BOT_ID__>, not <@__ESCORT_BOT_ID__> twice."
`;
    const layout = parseLayout(
      text,
      varLookup({ ESCORT_BOT_ID: BOT, STEWARD_BOT_ID: HELPER_BOT })
    );
    expect(layout.channels[0]!.topic).toBe(
      `Ping <@${BOT}> or <@${HELPER_BOT}>, not <@${BOT}> twice.`
    );
  });

  test("placeholders are general — a role name resolves too", () => {
    const text = `
roles:
  __RUNG_NAME__:
    color: 0x3B82F6
`;
    const layout = parseLayout(text, varLookup({ RUNG_NAME: "Adventurer" }));
    expect(layout.roles[0]!.name).toBe("Adventurer");
  });

  test("an unresolved placeholder throws, naming the variable", () => {
    expect(() => parseLayout(LAYOUT_WITH_PLACEHOLDER, varLookup({}))).toThrow(PlaceholderError);
    expect(() => parseLayout(LAYOUT_WITH_PLACEHOLDER, varLookup({}))).toThrow(
      /__ESCORT_BOT_ID__/
    );
  });

  test("with no vars argument at all, a placeholder still refuses (fails closed)", () => {
    expect(() => parseLayout(LAYOUT_WITH_PLACEHOLDER)).toThrow(PlaceholderError);
  });

  test("the literal __NAME__ never survives into a parsed layout", () => {
    let topic: string | undefined;
    try {
      topic = parseLayout(LAYOUT_WITH_PLACEHOLDER).channels[0]!.topic;
    } catch {
      topic = undefined;
    }
    expect(topic).toBeUndefined();
  });

  test("a layout with NO placeholders parses exactly as before (no vars needed)", () => {
    const layout = parseLayout(LAYOUT_WITHOUT_PLACEHOLDER);
    expect(layout.channels[0]!.topic).toBe(
      `Say hello by mentioning <@${BOT}> — it opens you a thread.`
    );
    // And feeding it vars changes nothing.
    expect(parseLayout(LAYOUT_WITHOUT_PLACEHOLDER, varLookup({ ESCORT_BOT_ID: HELPER_BOT }))).toEqual(
      layout
    );
  });

  test("the shipped example layout still parses with no vars", () => {
    const example = join(import.meta.dir, "..", "..", "examples", "guild-layout.example.yaml");
    expect(() => parseLayout(readFileSync(example, "utf8"))).not.toThrow();
  });

  test("schema validation still reports its own errors, not placeholder ones", () => {
    expect(() => parseLayout("channels:\n  x:\n    type: telepathy\n")).toThrow(LayoutError);
  });
});

// ─── resolution happens BEFORE the diff ────────────────────────────────────────

describe("diff over a resolved layout", () => {
  test("a resolved layout matching the live guild plans nothing", () => {
    const resolvedTopic = `Say hello by mentioning <@${BOT}> — it opens you a thread.`;
    const layout = parseLayout(LAYOUT_WITH_PLACEHOLDER, varLookup({ ESCORT_BOT_ID: BOT }));
    const plan = diffLayout(layout, snapshotWith([channel("arrivals", resolvedTopic)]));
    expect(isEmptyPlan(plan)).toBe(true);
  });

  test("the diff compares the RESOLVED value — a stale live topic is drift", () => {
    const staleTopic = `Say hello by mentioning <@${HELPER_BOT}> — it opens you a thread.`;
    const layout = parseLayout(LAYOUT_WITH_PLACEHOLDER, varLookup({ ESCORT_BOT_ID: BOT }));
    const plan = diffLayout(layout, snapshotWith([channel("arrivals", staleTopic)]));
    expect(plan.actions.map((a) => a.kind)).toEqual(["modify_channel"]);
    // The plan carries the resolved id, never the token.
    expect(JSON.stringify(plan)).toContain(BOT);
    expect(JSON.stringify(plan)).not.toContain("__ESCORT_BOT_ID__");
  });
});

// ─── the CLI refuses, on both verbs, before any network call ───────────────────

describe("guild diff/apply refuse an unresolved layout", () => {
  test("diff exits 1 with a message naming the variable and how to supply it", async () => {
    const file = tempLayout(LAYOUT_WITH_PLACEHOLDER);
    const { code, stderr } = await runCli(["guild", "diff", "--layout", file]);
    expect(code).toBe(1);
    expect(stderr).toContain("unresolved placeholders");
    expect(stderr).toContain("__ESCORT_BOT_ID__");
    expect(stderr).toContain("--var ESCORT_BOT_ID=");
    expect(stderr).toContain("Nothing was read from or written to Discord.");
  });

  test("apply exits 1 with the same refusal — no plan, no dry run", async () => {
    const file = tempLayout(LAYOUT_WITH_PLACEHOLDER);
    const { code, stderr, stdout } = await runCli(["guild", "apply", "--layout", file]);
    expect(code).toBe(1);
    expect(stderr).toContain("__ESCORT_BOT_ID__");
    expect(stdout).not.toContain("Dry run");
  });

  test("a set-but-empty environment variable is refused, not shipped as <@>", async () => {
    const file = tempLayout(LAYOUT_WITH_PLACEHOLDER);
    const { code, stderr } = await runCli(["guild", "apply", "--layout", file], {
      ESCORT_BOT_ID: "",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("Set but empty");
  });

  test("a malformed --var is rejected by name", async () => {
    const file = tempLayout(LAYOUT_WITH_PLACEHOLDER);
    const { code, stderr } = await runCli([
      "guild",
      "apply",
      "--layout",
      file,
      "--var",
      "ESCORT_BOT_ID",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--var: expected NAME=VALUE");
  });

  test("with the variable supplied, the run gets PAST the layout gate", async () => {
    const file = tempLayout(LAYOUT_WITH_PLACEHOLDER);
    const { stderr } = await runCli([
      "guild",
      "apply",
      "--layout",
      file,
      "--var",
      `ESCORT_BOT_ID=${BOT}`,
    ]);
    // The layout resolved; the next gate (no token in the hermetic config tree)
    // is what stops it — so nothing here ever reaches Discord.
    expect(stderr).not.toContain("unresolved placeholders");
    expect(stderr).toContain("Bot token required");
  });

  test("the environment resolves it too — --var is not the only path", async () => {
    const file = tempLayout(LAYOUT_WITH_PLACEHOLDER);
    const { stderr } = await runCli(["guild", "diff", "--layout", file], { ESCORT_BOT_ID: BOT });
    expect(stderr).not.toContain("unresolved placeholders");
    expect(stderr).toContain("Bot token required");
  });
});
