/**
 * Guild-level settings — the API surface behind `discord guild` (issue #16).
 *
 * Wraps the Modify Guild, Welcome Screen, and Onboarding endpoints on top of the
 * shared `discordRequest` transport (auth, 429 retry, rate-limit pacing, and the
 * token-redaction invariant all live there). This module owns:
 *   - the narrow projection of the guild object the CLI reads,
 *   - the client-side whitelist of writable PATCH /guilds fields,
 *   - the COMMUNITY-enable orchestration (verification + channels, then features),
 *   - the welcome-screen 5-channel cap and onboarding shape validation.
 *
 * Security invariant (inherited from `discordRequest`): the bot token reaches
 * only the outgoing Authorization header. Every error surfaced here carries the
 * response body (`errorText`, which never echoes the token) and/or the guildId —
 * never the token.
 *
 * API constraints (verified 2026-07-17, docs.discord.com):
 *   - Modify Guild `PATCH /guilds/{id}` (MANAGE_GUILD) writes verification_level,
 *     system_channel_id, rules_channel_id, public_updates_channel_id, description.
 *     `features` is also writable, but adding/removing COMMUNITY requires the bot
 *     to hold ADMINISTRATOR and, empirically, rules_channel_id +
 *     public_updates_channel_id + verification_level >= LOW. When a prerequisite
 *     is missing the API 400s with the missing list in the body — treat that body
 *     as authoritative and surface it verbatim.
 *   - Membership Screening has NO supported bot API (the /member-verification
 *     endpoint was removed). It is configured in the Discord UI; Onboarding is the
 *     API-manageable alternative. This module does not attempt screening.
 *   - Welcome Screen GET/PATCH `/guilds/{id}/welcome-screen` (MANAGE_GUILD; guild
 *     must be COMMUNITY; max 5 welcome channels).
 *   - Onboarding GET/PATCH `/guilds/{id}/onboarding` (MANAGE_GUILD + MANAGE_ROLES;
 *     COMMUNITY required).
 */

import { discordRequest } from "../http";

// =============================================================================
// Verification levels — name ⇄ Discord integer (docs: Guild verification_level).
// =============================================================================

/** Verification level names (rung 0 = "low", verified email) → Discord ints. */
export const VERIFICATION_LEVELS = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  highest: 4,
} as const;

export type VerificationLevelName = keyof typeof VERIFICATION_LEVELS;

/** Map a verification level integer to its name (`unknown(<n>)` if out of range). */
export function verificationLevelName(value: number): string {
  const match = Object.entries(VERIFICATION_LEVELS).find(([, n]) => n === value);
  return match ? match[0] : `unknown(${value})`;
}

/**
 * Map a verification level name to its Discord integer. Throws on an unknown
 * name so a typo fails locally with the valid set, never reaching the API.
 */
export function verificationLevelValue(name: string): number {
  const key = name.toLowerCase() as VerificationLevelName;
  if (!(key in VERIFICATION_LEVELS)) {
    throw new Error(
      `Unknown verification level "${name}". Valid: ${Object.keys(VERIFICATION_LEVELS).join(", ")}.`
    );
  }
  return VERIFICATION_LEVELS[key];
}

// =============================================================================
// Guild object — narrowest projection the CLI reads.
// =============================================================================

/** Projected guild settings (`getGuild` / `modifyGuild` return this shape). */
export interface GuildSettings {
  id: string;
  name: string;
  features: string[];
  verification_level: number;
  system_channel_id: string | null;
  rules_channel_id: string | null;
  public_updates_channel_id: string | null;
  description: string | null;
  premium_tier: number;
}

/** Raw Discord guild fields this module projects. */
interface DiscordApiGuild {
  id: string;
  name: string;
  features?: string[];
  verification_level?: number;
  system_channel_id?: string | null;
  rules_channel_id?: string | null;
  public_updates_channel_id?: string | null;
  description?: string | null;
  premium_tier?: number;
}

/** Project a raw guild object down to the fields the CLI reads. */
function projectGuild(raw: DiscordApiGuild): GuildSettings {
  return {
    id: raw.id,
    name: raw.name,
    features: raw.features ?? [],
    verification_level: raw.verification_level ?? 0,
    system_channel_id: raw.system_channel_id ?? null,
    rules_channel_id: raw.rules_channel_id ?? null,
    public_updates_channel_id: raw.public_updates_channel_id ?? null,
    description: raw.description ?? null,
    premium_tier: raw.premium_tier ?? 0,
  };
}

/**
 * The exact set of keys writable through `PATCH /guilds/{id}`. `modifyGuild`
 * refuses any key outside this set client-side, so a caller typo never reaches
 * the API and a caller can never smuggle an unintended field into the PATCH.
 * `features` lives here because COMMUNITY toggling PATCHes it — see
 * `enableCommunity` — but the standard `edit` path only ever passes the other
 * five.
 */
export const WRITABLE_GUILD_FIELDS = [
  "verification_level",
  "system_channel_id",
  "rules_channel_id",
  "public_updates_channel_id",
  "description",
  "features",
] as const;

export type WritableGuildField = (typeof WRITABLE_GUILD_FIELDS)[number];

/** A guild-modify spec: any subset of the writable fields. */
export type ModifyGuildSpec = Partial<{
  verification_level: number;
  system_channel_id: string | null;
  rules_channel_id: string | null;
  public_updates_channel_id: string | null;
  description: string | null;
  features: string[];
}>;

/**
 * Throw if `spec` carries any key outside `WRITABLE_GUILD_FIELDS`. Naming every
 * offending key (not just the first) so the caller fixes them in one pass.
 */
function assertWritableGuildKeys(spec: Record<string, unknown>): void {
  const allowed = new Set<string>(WRITABLE_GUILD_FIELDS);
  const unknown = Object.keys(spec).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown guild field(s): ${unknown.join(", ")}. ` +
        `Writable fields are: ${WRITABLE_GUILD_FIELDS.join(", ")}.`
    );
  }
}

/**
 * GET `/guilds/{guildId}` → projected `GuildSettings`.
 * Throws on a non-2xx response with the status + body (never the token).
 */
export async function getGuild(token: string, guildId: string): Promise<GuildSettings> {
  const res = await discordRequest<DiscordApiGuild>(token, "GET", `/guilds/${guildId}`);
  if (!res.ok || !res.data) {
    throw new Error(`Failed to fetch guild ${guildId}: ${res.status} ${res.errorText ?? ""}`.trim());
  }
  return projectGuild(res.data);
}

/**
 * PATCH `/guilds/{guildId}` with exactly the whitelisted writable fields.
 * Refuses unknown keys client-side (`assertWritableGuildKeys`). Returns the
 * updated projected guild. Throws on a non-2xx response (status + body, no token).
 */
export async function modifyGuild(
  token: string,
  guildId: string,
  spec: ModifyGuildSpec
): Promise<GuildSettings> {
  assertWritableGuildKeys(spec as Record<string, unknown>);
  const res = await discordRequest<DiscordApiGuild>(token, "PATCH", `/guilds/${guildId}`, {
    json: spec,
  });
  if (!res.ok || !res.data) {
    throw new Error(`Failed to modify guild ${guildId}: ${res.status} ${res.errorText ?? ""}`.trim());
  }
  return projectGuild(res.data);
}

// =============================================================================
// COMMUNITY enablement — orchestration helper.
// =============================================================================

export interface EnableCommunityArgs {
  rulesChannelId: string;
  updatesChannelId: string;
}

/** Structured outcome of `enableCommunity`, with a human-readable step log. */
export interface EnableCommunityResult {
  ok: boolean;
  /** Ordered log of the steps taken, for the command layer to print. */
  steps: string[];
  /** The updated guild when `ok`. */
  guild?: GuildSettings;
  /** On failure: Discord's verbatim prerequisite body (400) or the ADMIN note (403). */
  error?: string;
}

/**
 * Enable the COMMUNITY feature on a guild.
 *
 * Orchestration order (each step surfaces its own failure):
 *   1. GET the guild to read current verification_level + features.
 *   2. PATCH verification_level up to LOW (1) if below, and set both the rules
 *      and public-updates channel ids — the empirical COMMUNITY prerequisites.
 *   3. PATCH `features` = current features + "COMMUNITY" (deduped).
 *
 * Failure surfacing (the token never appears in any of these):
 *   - 403 → the bot lacks ADMINISTRATOR. Toggling COMMUNITY requires it; this is
 *     stated exactly, naming the guild. We do NOT attempt to self-grant it.
 *   - 400 → Discord's own body lists the missing prerequisites; it is surfaced
 *     verbatim (the body never contains the token).
 *   - other → status + body.
 *
 * Prerequisite (documented, not enforced here): the bot must hold ADMINISTRATOR
 * in the target guild for the features PATCH to succeed.
 */
export async function enableCommunity(
  token: string,
  guildId: string,
  args: EnableCommunityArgs
): Promise<EnableCommunityResult> {
  const steps: string[] = [];

  // Step 1 — read current state.
  const current = await getGuild(token, guildId);
  steps.push(
    `Read guild ${guildId}: verification_level=${current.verification_level} ` +
      `(${verificationLevelName(current.verification_level)}), features=[${current.features.join(", ")}]`
  );

  if (current.features.includes("COMMUNITY")) {
    steps.push("COMMUNITY already enabled — nothing to do.");
    return { ok: true, steps, guild: current };
  }

  // Step 2 — verification_level >= LOW + both prerequisite channels, in one PATCH.
  const prereq: ModifyGuildSpec = {
    rules_channel_id: args.rulesChannelId,
    public_updates_channel_id: args.updatesChannelId,
  };
  if (current.verification_level < VERIFICATION_LEVELS.low) {
    prereq.verification_level = VERIFICATION_LEVELS.low;
    steps.push(
      `Raising verification_level ${current.verification_level} → ${VERIFICATION_LEVELS.low} (low)`
    );
  }
  steps.push(
    `Setting rules_channel_id=${args.rulesChannelId}, public_updates_channel_id=${args.updatesChannelId}`
  );
  const prereqRes = await discordRequest<DiscordApiGuild>(token, "PATCH", `/guilds/${guildId}`, {
    json: prereq,
  });
  if (!prereqRes.ok) {
    return { ok: false, steps, error: mapCommunityError(prereqRes.status, prereqRes.errorText, guildId) };
  }

  // Step 3 — add COMMUNITY to the features array (deduped).
  const nextFeatures = [...new Set([...current.features, "COMMUNITY"])];
  steps.push(`Adding COMMUNITY to features → [${nextFeatures.join(", ")}]`);
  const featRes = await discordRequest<DiscordApiGuild>(token, "PATCH", `/guilds/${guildId}`, {
    json: { features: nextFeatures },
  });
  if (!featRes.ok || !featRes.data) {
    return { ok: false, steps, error: mapCommunityError(featRes.status, featRes.errorText, guildId) };
  }

  steps.push("COMMUNITY enabled.");
  return { ok: true, steps, guild: projectGuild(featRes.data) };
}

/**
 * Map a failed COMMUNITY-enable response to a caller-facing message. 403 is the
 * missing-ADMINISTRATOR case (stated exactly); 400 carries Discord's own
 * prerequisite list, surfaced verbatim. Neither the status text nor the body can
 * contain the token (it lives only in the Authorization header).
 */
function mapCommunityError(status: number, body: string | undefined, guildId: string): string {
  if (status === 403) {
    return (
      `Bot lacks ADMINISTRATOR in guild ${guildId}. Enabling the COMMUNITY feature ` +
      `requires the bot to hold ADMINISTRATOR — grant it in the guild's role settings ` +
      `and retry. (This command does not self-grant permissions.)`
    );
  }
  if (status === 400) {
    // Discord's body enumerates the missing prerequisites — authoritative.
    return `Discord rejected COMMUNITY enable (400) for guild ${guildId}: ${body ?? "(no body)"}`;
  }
  return `Failed to enable COMMUNITY on guild ${guildId}: ${status} ${body ?? ""}`.trim();
}

// =============================================================================
// Welcome screen — GET/PATCH /guilds/{id}/welcome-screen (COMMUNITY, max 5).
// =============================================================================

/** The maximum number of welcome channels Discord accepts. */
export const MAX_WELCOME_CHANNELS = 5;

export interface WelcomeChannel {
  channel_id: string;
  description: string;
  /** Custom-emoji snowflake, or null for a unicode / no emoji. */
  emoji_id?: string | null;
  /** Unicode emoji, or null. */
  emoji_name?: string | null;
}

export interface WelcomeScreen {
  enabled?: boolean;
  description?: string | null;
  welcome_channels: WelcomeChannel[];
}

/** A welcome-screen modify spec (all fields optional; Discord patches partially). */
export interface ModifyWelcomeScreenSpec {
  enabled?: boolean;
  description?: string | null;
  welcome_channels?: WelcomeChannel[];
}

interface DiscordApiWelcomeScreen {
  enabled?: boolean;
  description?: string | null;
  welcome_channels?: WelcomeChannel[];
}

/** GET `/guilds/{id}/welcome-screen`. Throws on non-2xx (status + body, no token). */
export async function getWelcomeScreen(token: string, guildId: string): Promise<WelcomeScreen> {
  const res = await discordRequest<DiscordApiWelcomeScreen>(
    token,
    "GET",
    `/guilds/${guildId}/welcome-screen`
  );
  if (!res.ok || !res.data) {
    throw new Error(
      `Failed to fetch welcome screen for guild ${guildId}: ${res.status} ${res.errorText ?? ""}`.trim()
    );
  }
  return {
    enabled: res.data.enabled,
    description: res.data.description ?? null,
    welcome_channels: res.data.welcome_channels ?? [],
  };
}

/**
 * PATCH `/guilds/{id}/welcome-screen`. Enforces the 5-channel cap client-side so
 * an over-cap request fails locally naming the limit, never reaching the API.
 * Returns the updated welcome screen. Throws on non-2xx (status + body, no token).
 */
export async function modifyWelcomeScreen(
  token: string,
  guildId: string,
  spec: ModifyWelcomeScreenSpec
): Promise<WelcomeScreen> {
  if (spec.welcome_channels && spec.welcome_channels.length > MAX_WELCOME_CHANNELS) {
    throw new Error(
      `Too many welcome channels: ${spec.welcome_channels.length} (max ${MAX_WELCOME_CHANNELS}). ` +
        `Discord's welcome screen accepts at most ${MAX_WELCOME_CHANNELS} channels.`
    );
  }
  const res = await discordRequest<DiscordApiWelcomeScreen>(
    token,
    "PATCH",
    `/guilds/${guildId}/welcome-screen`,
    { json: spec }
  );
  if (!res.ok || !res.data) {
    throw new Error(
      `Failed to modify welcome screen for guild ${guildId}: ${res.status} ${res.errorText ?? ""}`.trim()
    );
  }
  return {
    enabled: res.data.enabled,
    description: res.data.description ?? null,
    welcome_channels: res.data.welcome_channels ?? [],
  };
}

// =============================================================================
// Onboarding — GET/PATCH /guilds/{id}/onboarding (COMMUNITY; MANAGE_ROLES).
// Onboarding stands in for membership screening (which has NO bot API).
// =============================================================================

/** Onboarding shape — pass-through projection (the nested prompt shape is large). */
export interface Onboarding {
  guild_id?: string;
  prompts?: unknown[];
  default_channel_ids?: string[];
  enabled?: boolean;
  mode?: number;
}

/** An onboarding modify spec — the four writable top-level fields. */
export interface ModifyOnboardingSpec {
  prompts?: unknown[];
  default_channel_ids?: string[];
  enabled?: boolean;
  mode?: number;
}

/** GET `/guilds/{id}/onboarding`. Throws on non-2xx (status + body, no token). */
export async function getOnboarding(token: string, guildId: string): Promise<Onboarding> {
  const res = await discordRequest<Onboarding>(token, "GET", `/guilds/${guildId}/onboarding`);
  if (!res.ok || !res.data) {
    throw new Error(
      `Failed to fetch onboarding for guild ${guildId}: ${res.status} ${res.errorText ?? ""}`.trim()
    );
  }
  return res.data;
}

/**
 * Validate the top-level shape of an onboarding spec: `prompts` and
 * `default_channel_ids` must be arrays (the latter of strings), `enabled` a
 * boolean, `mode` a number. Unknown keys are refused. Throws naming the offending
 * field. This is a structural guard, not a deep validation of the (large) nested
 * prompt schema — Discord validates that server-side and its 400 is surfaced.
 */
function assertOnboardingShape(spec: Record<string, unknown>): void {
  const allowed = new Set(["prompts", "default_channel_ids", "enabled", "mode"]);
  const unknown = Object.keys(spec).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown onboarding field(s): ${unknown.join(", ")}. Writable: ${[...allowed].join(", ")}.`
    );
  }
  if ("prompts" in spec && !Array.isArray(spec.prompts)) {
    throw new Error("onboarding.prompts must be an array.");
  }
  if ("default_channel_ids" in spec) {
    const ids = spec.default_channel_ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      throw new Error("onboarding.default_channel_ids must be an array of channel id strings.");
    }
  }
  if ("enabled" in spec && typeof spec.enabled !== "boolean") {
    throw new Error("onboarding.enabled must be a boolean.");
  }
  if ("mode" in spec && typeof spec.mode !== "number") {
    throw new Error("onboarding.mode must be a number (0 = default, 1 = advanced).");
  }
}

/**
 * PATCH `/guilds/{id}/onboarding`. Validates the top-level shape client-side
 * (`assertOnboardingShape`), then passes through. Returns the updated onboarding.
 * Throws on non-2xx (status + body, no token).
 */
export async function modifyOnboarding(
  token: string,
  guildId: string,
  spec: ModifyOnboardingSpec
): Promise<Onboarding> {
  assertOnboardingShape(spec as Record<string, unknown>);
  const res = await discordRequest<Onboarding>(token, "PATCH", `/guilds/${guildId}/onboarding`, {
    json: spec,
  });
  if (!res.ok || !res.data) {
    throw new Error(
      `Failed to modify onboarding for guild ${guildId}: ${res.status} ${res.errorText ?? ""}`.trim()
    );
  }
  return res.data;
}
