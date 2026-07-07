/**
 * Unit tests for the public-post confidentiality gate (compass#91, design doc
 * §4 L6 "Discord", OD-5).
 *
 * Redaction discipline (compass#91 brief): this file carries NO real
 * guild/channel snowflakes and NO real emails. Every fixture "term"/id below
 * is synthetic and assembled at RUNTIME by concatenation — the same
 * discipline metafactory-actions' own engine.test.ts uses — so nothing
 * shape-matches a real identifier even by accident.
 *
 * These tests stand in a hermetic STUB scan engine (a tiny bun script,
 * written to a temp dir per test) rather than shelling to the real installed
 * metafactory-actions engine: `confidentiality-gate.ts`'s own job is
 * classification + orchestration (spawn the engine, parse its JSON, apply
 * the OD-5 platform-id-shape downgrade, pre-redact allowlisted snowflakes,
 * fail closed when the engine is missing, write the ack-log) — none of
 * which requires the real engine's pattern set to be installed on the
 * machine running the tests. The real engine's own detection logic is
 * covered by metafactory-actions' engine.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordCliConfig } from "../lib/config";
import { classifyGuild, gatePublicPost, type AttachmentLike } from "../lib/confidentiality-gate";

// --- synthetic-only fixtures, assembled at runtime -------------------------
const PUBLIC_GUILD = ["551", "122", "334", "401", "0101"].join(""); // 18-digit synthetic id
const INTERNAL_GUILD = ["998", "877", "660", "101", "0101"].join(""); // 18-digit synthetic id
const UNRELATED_GUILD = ["222", "333", "444", "555", "6060"].join(""); // 18-digit synthetic id, never marked
const ALLOWLISTED_CHANNEL = ["120", "345", "678", "9012", "3"].join(""); // 17-digit synthetic id
const WARN_SNOWFLAKE = ["102", "030", "405", "0607", "1"].join(""); // 17-digit synthetic id, NOT allowlisted
const FIXTURE_BLOCK_TERM = ["FIXTURE", "DENYLIST", "TERM"].join("-"); // never a real client term

let workdir: string;
let ackLogPath: string;
let receivedInputsPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "conf-gate-test-"));
  ackLogPath = join(workdir, "ack-log.jsonl");
  receivedInputsPath = join(workdir, "received.jsonl");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * Write a hermetic stand-in for the installed scan engine's `text --json`
 * contract: reads stdin, appends the raw text it received to
 * `receivedInputsPath` (so a test can assert what the gate actually sent —
 * in particular, that allowlisted snowflakes were redacted BEFORE reaching
 * this point), and returns canned findings keyed off fixture markers.
 * Exit code follows the real engine's contract (0 clean, 1 block).
 */
function stubEngine(): string {
  const path = join(workdir, "stub-engine.ts");
  const script = [
    "#!/usr/bin/env bun",
    "const chunks = [];",
    "for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);",
    'const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");',
    `require("node:fs").appendFileSync(${JSON.stringify(receivedInputsPath)}, JSON.stringify(text) + "\\n");`,
    "const findings = [];",
    `if (text.includes(${JSON.stringify(FIXTURE_BLOCK_TERM)})) {`,
    '  findings.push({ tier: 3, ruleId: "denylist-fixture", class: "denylist-term", action: "block", file: "text", line: 0, descriptor: "fixture denylist hit" });',
    "}",
    `if (text.includes(${JSON.stringify(WARN_SNOWFLAKE)})) {`,
    '  findings.push({ tier: 2, ruleId: "platform-snowflake", class: "platform-id-shape", action: "block", file: "text", line: 0, descriptor: "17-20 digit platform id" });',
    "}",
    `if (text.includes(${JSON.stringify(ALLOWLISTED_CHANNEL)})) {`,
    '  findings.push({ tier: 2, ruleId: "platform-snowflake", class: "platform-id-shape", action: "block", file: "text", line: 0, descriptor: "allowlist redaction FAILED — raw id reached the engine" });',
    "}",
    'process.stdout.write(JSON.stringify({ findings }));',
    'process.exit(findings.some((f) => f.action === "block") ? 1 : 0);',
  ].join("\n");
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

function missingEnginePath(): string {
  return join(workdir, "does-not-exist.ts");
}

function receivedInputs(): string[] {
  if (!existsSync(receivedInputsPath)) return [];
  return readFileSync(receivedInputsPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string);
}

function ackLogEntries(): Array<{ surface: string; findings: unknown[]; reason: string; ts: string }> {
  if (!existsSync(ackLogPath)) return [];
  return readFileSync(ackLogPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function baseConfig(overrides: Partial<DiscordCliConfig> = {}): DiscordCliConfig {
  return { botToken: "t", guildId: PUBLIC_GUILD, ...overrides };
}

// ---------------------------------------------------------------------------
// classifyGuild — fail-closed default
// ---------------------------------------------------------------------------

describe("classifyGuild", () => {
  test("a guild with no config entries at all is public (fail-closed default)", () => {
    expect(classifyGuild({ guildId: UNRELATED_GUILD }, {})).toBe("public");
  });

  test("top-level guildId explicitly marked internal:true is internal", () => {
    const config: DiscordCliConfig = { guildId: INTERNAL_GUILD, internal: true };
    expect(classifyGuild({ guildId: INTERNAL_GUILD }, config)).toBe("internal");
  });

  test("a server profile marked internal:true is internal for ITS guild id", () => {
    const config: DiscordCliConfig = {
      guildId: PUBLIC_GUILD,
      servers: { "back-office": { guildId: INTERNAL_GUILD, internal: true } },
    };
    expect(classifyGuild({ guildId: INTERNAL_GUILD }, config)).toBe("internal");
  });

  test("a DIFFERENT guild id stays public even when other guilds in the same config are internal", () => {
    const config: DiscordCliConfig = {
      guildId: INTERNAL_GUILD,
      internal: true,
      servers: { other: { guildId: UNRELATED_GUILD } },
    };
    expect(classifyGuild({ guildId: UNRELATED_GUILD }, config)).toBe("public");
  });

  test("no resolved guildId at all is public", () => {
    expect(classifyGuild({}, { guildId: INTERNAL_GUILD, internal: true })).toBe("public");
  });
});

// ---------------------------------------------------------------------------
// gatePublicPost
// ---------------------------------------------------------------------------

describe("gatePublicPost", () => {
  test("internal:true guild is skipped entirely — no engine invocation", () => {
    const config: DiscordCliConfig = { guildId: INTERNAL_GUILD, internal: true };
    // A guaranteed-nonexistent engine path proves the engine was never invoked:
    // if the gate tried to scan, this would fail closed (blocked:true) instead.
    const result = gatePublicPost({
      guildId: INTERNAL_GUILD,
      content: FIXTURE_BLOCK_TERM,
      config,
      enginePath: missingEnginePath(),
      ackLogPath,
    });
    expect(result).toEqual({ ok: true, blocked: false, classification: "internal", findings: [] });
    expect(ackLogEntries()).toEqual([]);
  });

  test("unmarked (public) guild with clean content is scanned and comes back clean", () => {
    const result = gatePublicPost({
      guildId: UNRELATED_GUILD,
      content: "just a normal status update",
      config: baseConfig(),
      enginePath: stubEngine(),
      ackLogPath,
    });
    expect(result.classification).toBe("public");
    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.findings).toEqual([]);
    // Proves the engine actually ran (not skipped like the internal case).
    expect(receivedInputs()).toEqual(["just a normal status update"]);
    expect(ackLogEntries()).toEqual([]);
  });

  test("public guild + runtime fixture BLOCK term → blocked, zero network calls, ack-log entry", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetchCalls++;
      throw new Error("gatePublicPost must never itself touch the network");
    }) as unknown as typeof fetch;

    let result;
    try {
      result = gatePublicPost({
        guildId: PUBLIC_GUILD,
        content: `status update ${FIXTURE_BLOCK_TERM} more text`,
        config: baseConfig(),
        enginePath: stubEngine(),
        ackLogPath,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0); // zero API writes — the gate makes no network calls of its own
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.findings).toEqual([
      { source: "message", ruleId: "denylist-fixture", class: "denylist-term", action: "block", descriptor: "fixture denylist hit" },
    ]);
    const log = ackLogEntries();
    expect(log).toHaveLength(1);
    expect(log[0].surface).toBe("discord-public");
    expect(typeof log[0].ts).toBe("string");
    expect(log[0].findings).toEqual(result.findings);
  });

  test("OD-5: a platform-id-shape finding is downgraded to warn (not blocked) on this surface", () => {
    const result = gatePublicPost({
      guildId: PUBLIC_GUILD,
      content: `channel id ${WARN_SNOWFLAKE} shared`,
      config: baseConfig(),
      enginePath: stubEngine(),
      ackLogPath,
    });
    expect(result.ok).toBe(false); // there IS a finding — not clean
    expect(result.blocked).toBe(false); // but not block-tier
    expect(result.findings).toEqual([
      { source: "message", ruleId: "platform-snowflake", class: "platform-id-shape", action: "warn", descriptor: "17-20 digit platform id" },
    ]);
    expect(ackLogEntries()).toHaveLength(1); // warn-ack still logged
  });

  test("OD-5: a known-public allowlisted channel id is redacted before scanning and produces no finding", () => {
    const config = baseConfig({ publicChannelAllowlist: [ALLOWLISTED_CHANNEL] });
    const result = gatePublicPost({
      guildId: PUBLIC_GUILD,
      content: `channel id ${ALLOWLISTED_CHANNEL} shared`,
      config,
      enginePath: stubEngine(),
      ackLogPath,
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    // The engine never saw the raw id — only the zero-redacted placeholder.
    expect(receivedInputs()[0]).not.toContain(ALLOWLISTED_CHANNEL);
    expect(receivedInputs()[0]).toContain("0".repeat(ALLOWLISTED_CHANNEL.length));
  });

  test("OD-5 allowlist also applies per server profile, scoped to that profile's guild", () => {
    const config: DiscordCliConfig = {
      guildId: UNRELATED_GUILD,
      servers: { community: { guildId: PUBLIC_GUILD, publicChannelAllowlist: [ALLOWLISTED_CHANNEL] } },
    };
    const result = gatePublicPost({
      guildId: PUBLIC_GUILD,
      content: `channel id ${ALLOWLISTED_CHANNEL} shared`,
      config,
      enginePath: stubEngine(),
      ackLogPath,
    });
    expect(result.findings).toEqual([]);
  });

  test("undecodable/binary attachment to a public guild BLOCKs directly, without needing the engine to run", () => {
    const attachments: AttachmentLike[] = [{ filename: "payload.bin", bytes: new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0xff]) }];
    const result = gatePublicPost({
      guildId: PUBLIC_GUILD,
      content: "",
      attachments,
      config: baseConfig(),
      enginePath: missingEnginePath(), // proves the engine is never invoked for this attachment
      ackLogPath,
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.findings).toEqual([
      {
        source: "payload.bin",
        ruleId: "binary-attachment",
        class: "undecodable-attachment",
        action: "block",
        descriptor: "attachment bytes are not decodable UTF-8 text — undecodable/binary attachments to a public surface are blocked, not scanned",
      },
    ]);
  });

  test("a decodable text attachment is scanned like message content", () => {
    const attachments: AttachmentLike[] = [
      { filename: "notes.txt", bytes: new TextEncoder().encode(`see ${FIXTURE_BLOCK_TERM} for details`) },
    ];
    const result = gatePublicPost({
      guildId: PUBLIC_GUILD,
      content: "",
      attachments,
      config: baseConfig(),
      enginePath: stubEngine(),
      ackLogPath,
    });
    expect(result.blocked).toBe(true);
    expect(result.findings[0]?.source).toBe("notes.txt");
  });

  test("missing scan engine on a public post fails closed with an arc-upgrade hint", () => {
    const result = gatePublicPost({
      guildId: PUBLIC_GUILD,
      content: "anything at all",
      config: baseConfig(),
      enginePath: missingEnginePath(),
      ackLogPath,
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("arc upgrade compass");
    expect(ackLogEntries()).toHaveLength(1);
  });
});
