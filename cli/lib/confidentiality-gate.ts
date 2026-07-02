/**
 * Public-post confidentiality gate — design doc §4 L6 ("Discord"), OD-5,
 * compass#91 (PR 13, `feat/conf-public-post-gate`).
 *
 * Gates a Discord post BEFORE `postMessage*` is called: classifies the
 * resolved destination guild as internal/public, and — for public guilds —
 * scans the message text and every attachment's bytes through the shared
 * confidentiality scan engine (metafactory-actions `scan/confidentiality-scan.ts`,
 * `text` mode, tiers 2+3). This module shells out to the INSTALLED engine
 * (`~/.config/metafactory/pkg/repos/metafactory-actions/scan/confidentiality-scan.ts`)
 * rather than importing metafactory-actions as a dependency — the same
 * consumption pattern as the git hooks (L5) and every other surface gate.
 *
 * WARN-ONLY ROLLOUT (compass#91 scope). This module computes the full,
 * correct signal — classification, real content findings, the OD-5
 * snowflake-at-warn-tier downgrade, the known-public-channel allowlist, and
 * fail-closed behavior when the scanner itself is missing. What it does
 * NOT do is stop anything: the CLI wiring in `discord.ts` treats the result
 * as ADVISORY (logs + acks, still posts). Flipping the live `discord post`
 * hot path to actually respect `blocked` is a principal-owned follow-up —
 * see the design doc §6 PR 13 row and "PARKED: the DEFAULT flip to
 * fail-closed BLOCK on public guilds" (every teammate/agent's production
 * egress runs through this path, and the denylist isn't populated yet).
 *
 * Redaction discipline: this module never logs, returns, or persists a raw
 * matched literal — only masked engine finding metadata (tier/ruleId/class/
 * action/descriptor/file-or-source-label), exactly as the engine's own
 * output discipline requires.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DiscordCliConfig } from "./config";

/** Guild classification result — see `classifyGuild`. */
export type GuildClassification = "internal" | "public";

/** Minimal context `classifyGuild`/`gatePublicPost` need from a resolved server context. */
export interface GuildContext {
  guildId?: string;
}

/** An in-memory attachment about to be posted — same shape as `AttachmentInput` in `lib/discord.ts`. */
export interface AttachmentLike {
  filename: string;
  bytes: Uint8Array;
}

/** One masked finding surfaced by the gate — a message-text hit or an attachment hit. */
export interface GateFinding {
  /** "message" for the post body, else the attachment's filename. */
  source: string;
  ruleId: string;
  class: string;
  action: "block" | "warn";
  descriptor: string;
}

export interface GatePublicPostParams {
  guildId?: string;
  content: string;
  attachments?: AttachmentLike[];
  config: DiscordCliConfig;
  /** Test/override seam — defaults to the installed engine path (env `MF_SCAN_ENGINE`, else the conventional path). */
  enginePath?: string;
  /** Test/override seam — defaults to `~/.config/metafactory/confidentiality/ack-log.jsonl`. */
  ackLogPath?: string;
}

export interface GateResult {
  /** True only when the post is clean — nothing to log, nothing to ack. */
  ok: boolean;
  /**
   * True when a BLOCK-tier condition was found (a real content finding, an
   * undecodable/binary attachment, or the scanner itself being missing).
   * Advisory in this rollout — see module doc. Callers that want to actually
   * enforce check this field.
   */
  blocked: boolean;
  classification: GuildClassification;
  findings: GateFinding[];
  reason?: string;
}

const SURFACE = "discord-public";
const ARC_UPGRADE_HINT = "run `arc upgrade compass` to install the confidentiality scan engine";
const DEFAULT_ENGINE_PATH = join(
  homedir(),
  ".config",
  "metafactory",
  "pkg",
  "repos",
  "metafactory-actions",
  "scan",
  "confidentiality-scan.ts"
);
const DEFAULT_ACK_LOG_PATH = join(homedir(), ".config", "metafactory", "confidentiality", "ack-log.jsonl");

/**
 * Classify a resolved guild id as "internal" (skip scanning) or "public"
 * (scan). FAIL-CLOSED default: a guild id is "internal" ONLY when some
 * config entry (top-level or a `servers` profile) explicitly marks it
 * `internal: true`. Every other guild id — including one config has never
 * heard of — is "public".
 *
 * Classification keys off the RESOLVED numeric guildId, never the `--server`
 * profile NAME used to reach it. This matters because a cached channel/guild
 * mapping can drift from what a profile name is believed to point at (see
 * reference_discord-cortex-dualpost: an installed CLI's cache silently
 * resolved a "grove" profile to the community guild) — keying on the
 * resolved id means a poisoned name→guild mapping still gets scanned
 * correctly instead of silently inheriting an internal marker meant for a
 * different guild.
 */
export function classifyGuild(ctx: GuildContext, config: DiscordCliConfig): GuildClassification {
  if (!ctx.guildId) return "public";
  const internalGuildIds = new Set<string>();
  if (config.internal === true && config.guildId) internalGuildIds.add(config.guildId);
  for (const profile of Object.values(config.servers ?? {})) {
    if (profile.internal === true && profile.guildId) internalGuildIds.add(profile.guildId);
  }
  return internalGuildIds.has(ctx.guildId) ? "internal" : "public";
}

/** Collect every known-public snowflake allowlisted for the resolved guild (top-level + the matching profile(s)). */
function collectAllowlist(ctx: GuildContext, config: DiscordCliConfig): string[] {
  const allow = new Set<string>();
  for (const id of config.publicChannelAllowlist ?? []) allow.add(id);
  for (const profile of Object.values(config.servers ?? {})) {
    if (profile.guildId !== ctx.guildId) continue;
    for (const id of profile.publicChannelAllowlist ?? []) allow.add(id);
  }
  return [...allow];
}

/**
 * Replace every allowlisted snowflake with an all-zero run of the same
 * length before the content ever reaches the scan engine. The engine's own
 * platform-id-shape rule already carves out all-zero/all-same-digit runs as
 * placeholders (`public-patterns.yaml`), so this makes a known-public
 * channel/guild ID invisible to the scanner without this module ever having
 * to inspect (or re-emit) a raw finding literal.
 */
function redactAllowlisted(content: string, allowlist: string[]): string {
  let out = content;
  for (const id of allowlist) {
    if (!id) continue;
    out = out.split(id).join("0".repeat(id.length));
  }
  return out;
}

/** Decode attachment bytes as strict UTF-8; null means "not decodable text" (a binary/undecodable attachment). */
function decodeAsText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface EngineFinding {
  tier: number;
  ruleId: string;
  class: string;
  action: "block" | "warn";
  file: string;
  line: number;
  descriptor: string;
}

interface EngineRunResult {
  findings: EngineFinding[];
  /** Set when the engine could not be run at all or failed closed (exit 3) — a fail-closed condition, distinct from "ran cleanly with findings". */
  error?: string;
}

/**
 * Shell out to the installed scan engine's `text` mode (tiers 2+3 only —
 * gitleaks is git-only and never runs here). `--json` gives us structured,
 * still-masked finding metadata (ruleId/class/action/descriptor) with no raw
 * matched literal, which is exactly what OD-5's per-class action downgrade
 * needs.
 */
function runEngineText(text: string, enginePath: string): EngineRunResult {
  if (!existsSync(enginePath)) {
    return { findings: [], error: `confidentiality scan engine not found at ${enginePath} — ${ARC_UPGRADE_HINT}` };
  }
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["bun", enginePath, "text", "--json"], {
      stdin: new TextEncoder().encode(text),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { findings: [], error: `confidentiality scan engine failed to run: ${(err as Error).message} — ${ARC_UPGRADE_HINT}` };
  }
  const code = proc.exitCode ?? 3;
  const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
  if (code === 3) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    return { findings: [], error: (stderr.trim() || "confidentiality scan engine failed closed") + ` — ${ARC_UPGRADE_HINT}` };
  }
  try {
    const parsed = JSON.parse(stdout) as { findings?: EngineFinding[] };
    return { findings: parsed.findings ?? [] };
  } catch {
    return { findings: [], error: `confidentiality scan engine returned unparseable output — ${ARC_UPGRADE_HINT}` };
  }
}

/**
 * OD-5: "snowflake rule on the discord-public surface — ON at warn-tier with
 * the known-public grove/community channel IDs allowlisted." The shared
 * engine's own `platform-id-shape` rule is `action: block` unconditionally
 * (design doc L1's default, tuned for git content); this surface downgrades
 * that ONE class to warn. Every other tier-2/tier-3 class keeps whatever
 * action the engine assigned it.
 */
function effectiveAction(finding: EngineFinding): "block" | "warn" {
  return finding.class === "platform-id-shape" ? "warn" : finding.action;
}

function appendAckLog(path: string, entry: { surface: string; findings: GateFinding[]; reason: string; ts: string }): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Never let ack-log I/O failure mask a real gate result — log and continue.
    process.stderr.write(`confidentiality-gate: failed to write ack-log (${path}): ${(err as Error).message}\n`);
  }
}

/**
 * Gate a Discord post bound for `guildId`. Internal guilds are skipped
 * entirely (no engine invocation). Public guilds have their message text and
 * every attachment's bytes scanned; an undecodable/binary attachment BLOCKs
 * directly (no engine call needed — an unreadable payload can't be shape- or
 * denylist-matched). Any non-clean result (warn or block) is appended to the
 * ack-log — see module doc for why this is a log-only "ack" in this rollout.
 */
export function gatePublicPost(params: GatePublicPostParams): GateResult {
  const { guildId, content, attachments = [], config } = params;
  const enginePath = params.enginePath ?? process.env.MF_SCAN_ENGINE ?? DEFAULT_ENGINE_PATH;
  const ackLogPath = params.ackLogPath ?? DEFAULT_ACK_LOG_PATH;
  const classification = classifyGuild({ guildId }, config);

  if (classification === "internal") {
    return { ok: true, blocked: false, classification, findings: [] };
  }

  const allowlist = collectAllowlist({ guildId }, config);
  const findings: GateFinding[] = [];
  let engineError: string | undefined;

  if (content.trim().length > 0) {
    const run = runEngineText(redactAllowlisted(content, allowlist), enginePath);
    if (run.error) engineError = run.error;
    for (const f of run.findings) {
      findings.push({ source: "message", ruleId: f.ruleId, class: f.class, action: effectiveAction(f), descriptor: f.descriptor });
    }
  }

  for (const att of attachments) {
    const text = decodeAsText(att.bytes);
    if (text === null) {
      findings.push({
        source: att.filename,
        ruleId: "binary-attachment",
        class: "undecodable-attachment",
        action: "block",
        descriptor: "attachment bytes are not decodable UTF-8 text — undecodable/binary attachments to a public surface are blocked, not scanned",
      });
      continue;
    }
    const run = runEngineText(redactAllowlisted(text, allowlist), enginePath);
    if (run.error && !engineError) engineError = run.error;
    for (const f of run.findings) {
      findings.push({ source: att.filename, ruleId: f.ruleId, class: f.class, action: effectiveAction(f), descriptor: f.descriptor });
    }
  }

  if (engineError) {
    // Missing/broken scanner on a public post: fail closed regardless of
    // whatever content findings (if any) were already collected.
    appendAckLog(ackLogPath, { surface: SURFACE, findings, reason: engineError, ts: new Date().toISOString() });
    return { ok: false, blocked: true, classification, findings, reason: engineError };
  }

  if (findings.length === 0) {
    return { ok: true, blocked: false, classification, findings: [] };
  }

  const blocked = findings.some((f) => f.action === "block");
  const reason = blocked
    ? "confidentiality scan found BLOCK-tier finding(s) on a public-guild post"
    : "confidentiality scan found warn-tier finding(s) on a public-guild post";
  appendAckLog(ackLogPath, { surface: SURFACE, findings, reason, ts: new Date().toISOString() });
  return { ok: false, blocked, classification, findings, reason };
}
