/**
 * Guild scheduled events — the "muster roll" CRUD + RSVP reads (issue #14).
 *
 * Musters and team efforts use Discord Scheduled Events as the native RSVP
 * mechanism. This module wraps the five REST operations behind the shared
 * transport (`discordRequest`, cli/lib/http.ts):
 *
 *   createEvent  → POST   /guilds/{guild}/scheduled-events
 *   modifyEvent  → PATCH  /guilds/{guild}/scheduled-events/{event}
 *   deleteEvent  → DELETE /guilds/{guild}/scheduled-events/{event}
 *   listEvents   → GET    /guilds/{guild}/scheduled-events?with_user_count=true
 *   getEventUsers→ GET    /guilds/{guild}/scheduled-events/{event}/users (paginated)
 *
 * Client-side validation (past start times, EXTERNAL requiring an end time +
 * location, voice/stage requiring a channel) happens BEFORE any network call so
 * a bad spec fails fast with a one-line error instead of a Discord 400.
 *
 * Security invariant (mirrors mapRoleError, cli/lib/discord.ts): the bot token
 * is used only for the Authorization header inside `discordRequest`. It is never
 * interpolated into any returned or thrown message — error text carries only the
 * HTTP status and the response body, which never echoes the token.
 *
 * Out of scope (issue #14): recurring events (Discord `recurrence_rule` — defer
 * until a Muster needs it), cover images, and stage instances themselves.
 *
 * API: https://discord.com/developers/docs/resources/guild-scheduled-event
 */

import { discordRequest } from "../http";

/** Discord `entity_type` values for a guild scheduled event. */
export const EntityType = {
  STAGE_INSTANCE: 1,
  VOICE: 2,
  EXTERNAL: 3,
} as const;

export type EntityTypeValue = (typeof EntityType)[keyof typeof EntityType];

/** Discord `privacy_level` — only GUILD_ONLY (2) is valid for guild events. */
const PRIVACY_LEVEL_GUILD_ONLY = 2;

/** Discord caps a single page of the RSVP (`/users`) list at 100 entries. */
const USERS_PAGE_MAX = 100;

/**
 * Spec for creating an event. Camel-cased at this boundary; the snake_case wire
 * shape (`scheduled_start_time`, `entity_metadata.location`, …) is built inside
 * `createEvent`.
 *
 *   - EXTERNAL (3): `location` and `scheduledEndTime` required; `channelId` is
 *     forced to null on the wire.
 *   - VOICE (2) / STAGE_INSTANCE (1): `channelId` required.
 */
export interface EventSpec {
  name: string;
  description?: string;
  /** ISO8601 start time. Must be valid and not in the past. */
  scheduledStartTime: string;
  /** ISO8601 end time. Required for EXTERNAL. */
  scheduledEndTime?: string;
  entityType: EntityTypeValue;
  /** Required for VOICE/STAGE; ignored (nulled) for EXTERNAL. */
  channelId?: string;
  /** Physical location text. Required for EXTERNAL. */
  location?: string;
}

/** Partial spec for an edit (PATCH) — every field optional. */
export interface EventEditSpec {
  name?: string;
  description?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  entityType?: EntityTypeValue;
  channelId?: string;
  location?: string;
}

/** Narrowest projection of a Discord scheduled event this module reads. */
export interface GuildScheduledEvent {
  id: string;
  name: string;
  description?: string | null;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  entity_type: number;
  status?: number;
  channel_id?: string | null;
  entity_metadata?: { location?: string } | null;
  user_count?: number;
}

/** One RSVP entry — an "interested" user, flattened from the API `user` object. */
export interface EventUser {
  id: string;
  username: string;
}

/** Result of a create/modify/delete mutation. Token never appears in `error`. */
export interface EventResult {
  success: boolean;
  event?: GuildScheduledEvent;
  error?: string;
}

// Discord API `/users` entry shape (narrow projection).
interface DiscordApiEventUser {
  guild_scheduled_event_id: string;
  user: { id: string; username: string; global_name?: string | null };
}

/**
 * Parse an ISO8601 timestamp to epoch milliseconds, or null when the string is
 * not a well-formed ISO8601 datetime. `Date.parse` is lenient, so we first gate
 * on the ISO shape (date + time, optional seconds/fraction/offset) to reject
 * loose input like "next friday" that Discord would 400 on.
 */
function parseIso(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validate an event spec entirely client-side. Returns a one-line error string,
 * or null when the spec is well-formed. Called by `createEvent` before any
 * network call so a bad spec never reaches Discord.
 */
export function validateEventSpec(spec: EventSpec): string | null {
  if (!spec.name || spec.name.trim() === "") {
    return "Event name is required.";
  }

  const startMs = parseIso(spec.scheduledStartTime);
  if (startMs === null) {
    return `Invalid ISO8601 start time "${spec.scheduledStartTime}". Use e.g. 2026-08-01T19:00:00+12:00.`;
  }
  if (startMs < Date.now()) {
    return `Start time "${spec.scheduledStartTime}" is in the past; pick a future time.`;
  }

  let endMs: number | null = null;
  if (spec.scheduledEndTime !== undefined) {
    endMs = parseIso(spec.scheduledEndTime);
    if (endMs === null) {
      return `Invalid ISO8601 end time "${spec.scheduledEndTime}". Use e.g. 2026-08-01T21:00:00+12:00.`;
    }
    if (endMs <= startMs) {
      return `End time "${spec.scheduledEndTime}" must be after the start time.`;
    }
  }

  if (spec.entityType === EntityType.EXTERNAL) {
    if (!spec.location) {
      return "EXTERNAL events require a location (--location).";
    }
    if (spec.scheduledEndTime === undefined) {
      return "EXTERNAL events require an end time (--end).";
    }
  } else {
    if (!spec.channelId) {
      return "VOICE/STAGE events require a channel (--voice).";
    }
  }

  return null;
}

/** Validate only the fields present on an edit spec (no required-field checks). */
function validateEditSpec(spec: EventEditSpec): string | null {
  if (spec.name !== undefined && spec.name.trim() === "") {
    return "Event name cannot be empty.";
  }
  if (spec.scheduledStartTime !== undefined) {
    const ms = parseIso(spec.scheduledStartTime);
    if (ms === null) {
      return `Invalid ISO8601 start time "${spec.scheduledStartTime}". Use e.g. 2026-08-01T19:00:00+12:00.`;
    }
    if (ms < Date.now()) {
      return `Start time "${spec.scheduledStartTime}" is in the past; pick a future time.`;
    }
  }
  if (spec.scheduledEndTime !== undefined && parseIso(spec.scheduledEndTime) === null) {
    return `Invalid ISO8601 end time "${spec.scheduledEndTime}". Use e.g. 2026-08-01T21:00:00+12:00.`;
  }
  return null;
}

/** Build the snake_case create payload from a validated spec. */
function buildCreatePayload(spec: EventSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    privacy_level: PRIVACY_LEVEL_GUILD_ONLY,
    scheduled_start_time: spec.scheduledStartTime,
    entity_type: spec.entityType,
  };
  if (spec.description !== undefined) body.description = spec.description;
  if (spec.scheduledEndTime !== undefined) body.scheduled_end_time = spec.scheduledEndTime;
  if (spec.entityType === EntityType.EXTERNAL) {
    // Discord requires channel_id to be null for EXTERNAL and the location in
    // entity_metadata.
    body.channel_id = null;
    body.entity_metadata = { location: spec.location };
  } else {
    body.channel_id = spec.channelId;
  }
  return body;
}

/** Build a PATCH payload carrying only the fields the edit spec supplies. */
function buildEditPayload(spec: EventEditSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (spec.name !== undefined) body.name = spec.name;
  if (spec.description !== undefined) body.description = spec.description;
  if (spec.scheduledStartTime !== undefined) body.scheduled_start_time = spec.scheduledStartTime;
  if (spec.scheduledEndTime !== undefined) body.scheduled_end_time = spec.scheduledEndTime;
  if (spec.entityType !== undefined) {
    body.entity_type = spec.entityType;
    if (spec.entityType === EntityType.EXTERNAL) {
      body.channel_id = null;
      if (spec.location !== undefined) body.entity_metadata = { location: spec.location };
    } else if (spec.channelId !== undefined) {
      body.channel_id = spec.channelId;
    }
  } else {
    if (spec.channelId !== undefined) body.channel_id = spec.channelId;
    if (spec.location !== undefined) body.entity_metadata = { location: spec.location };
  }
  return body;
}

/**
 * Map a non-2xx event API response to a caller-facing error string. The bot
 * token is never passed here and cannot appear in the output.
 */
function mapEventError(status: number, body: string, guildId: string): string {
  if (status === 403) {
    return (
      `Bot lacks permission to manage scheduled events in guild ${guildId}. ` +
      `EXTERNAL create needs Create Events; VOICE/STAGE also need Manage Channels + Mute Members + Move Members; ` +
      `modifying others' events needs Manage Events.`
    );
  }
  if (status === 404) {
    return `Scheduled event or guild ${guildId} not found.`;
  }
  if (status === 400) {
    return `Discord rejected the event (400): ${body}`;
  }
  return `${status}: ${body}`;
}

/**
 * Create a guild scheduled event. Validates the spec client-side first; on a
 * validation failure it returns `{ success: false, error }` WITHOUT a network
 * call. Guild cap: 100 scheduled/active events (Discord returns 400 past that).
 */
export async function createEvent(
  botToken: string,
  guildId: string,
  spec: EventSpec
): Promise<EventResult> {
  const invalid = validateEventSpec(spec);
  if (invalid) return { success: false, error: invalid };

  const res = await discordRequest<GuildScheduledEvent>(
    botToken,
    "POST",
    `/guilds/${guildId}/scheduled-events`,
    { json: buildCreatePayload(spec) }
  );
  if (!res.ok) return { success: false, error: mapEventError(res.status, res.errorText ?? "", guildId) };
  return { success: true, event: res.data };
}

/**
 * Modify an existing event (PATCH). Only the supplied fields are sent. Modifying
 * an event the bot does not own needs the Manage Events permission (403 branch).
 */
export async function modifyEvent(
  botToken: string,
  guildId: string,
  eventId: string,
  spec: EventEditSpec
): Promise<EventResult> {
  const invalid = validateEditSpec(spec);
  if (invalid) return { success: false, error: invalid };

  const res = await discordRequest<GuildScheduledEvent>(
    botToken,
    "PATCH",
    `/guilds/${guildId}/scheduled-events/${eventId}`,
    { json: buildEditPayload(spec) }
  );
  if (!res.ok) return { success: false, error: mapEventError(res.status, res.errorText ?? "", guildId) };
  return { success: true, event: res.data };
}

/** Delete an event (DELETE → 204, no body). */
export async function deleteEvent(
  botToken: string,
  guildId: string,
  eventId: string
): Promise<EventResult> {
  const res = await discordRequest(
    botToken,
    "DELETE",
    `/guilds/${guildId}/scheduled-events/${eventId}`,
    { expect: "none" }
  );
  if (!res.ok) return { success: false, error: mapEventError(res.status, res.errorText ?? "", guildId) };
  return { success: true };
}

/**
 * List the guild's scheduled events, requesting `with_user_count=true` so the
 * RSVP total rides along on each event. Throws on a non-2xx status (matching
 * the read helpers in cli/lib/discord.ts); the token never appears in the throw.
 */
export async function listEvents(
  botToken: string,
  guildId: string
): Promise<GuildScheduledEvent[]> {
  const res = await discordRequest<GuildScheduledEvent[]>(
    botToken,
    "GET",
    `/guilds/${guildId}/scheduled-events?with_user_count=true`
  );
  if (!res.ok) {
    throw new Error(`Failed to list events in guild ${guildId}: ${res.status} ${res.errorText ?? ""}`.trim());
  }
  return res.data ?? [];
}

/**
 * Fetch ONE page of the RSVP ("interested users") list for an event. `limit` is
 * clamped to Discord's max of 100; `after` is a user-id cursor for pagination.
 * Throws on a non-2xx status; the token never appears in the throw.
 */
export async function getEventUsers(
  botToken: string,
  guildId: string,
  eventId: string,
  opts: { limit?: number; after?: string } = {}
): Promise<EventUser[]> {
  const limit = Math.min(opts.limit ?? USERS_PAGE_MAX, USERS_PAGE_MAX);
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.after) params.set("after", opts.after);

  const res = await discordRequest<DiscordApiEventUser[]>(
    botToken,
    "GET",
    `/guilds/${guildId}/scheduled-events/${eventId}/users?${params.toString()}`
  );
  if (!res.ok) {
    throw new Error(
      `Failed to list RSVPs for event ${eventId} in guild ${guildId}: ${res.status} ${res.errorText ?? ""}`.trim()
    );
  }
  return (res.data ?? []).map((u) => ({
    id: u.user.id,
    username: u.user.global_name ?? u.user.username,
  }));
}

/**
 * Collect the FULL RSVP list, paging through `getEventUsers` 100 at a time until
 * a short page signals the end. The cursor is the last user id of each page.
 */
export async function collectEventUsers(
  botToken: string,
  guildId: string,
  eventId: string
): Promise<EventUser[]> {
  const all: EventUser[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await getEventUsers(botToken, guildId, eventId, { limit: USERS_PAGE_MAX, after });
    all.push(...page);
    if (page.length < USERS_PAGE_MAX) break;
    after = page[page.length - 1]?.id;
    if (!after) break;
  }
  return all;
}

/** Discord `entity_type` number → short human label (for `event list`). */
const EVENT_TYPE_NAMES: Record<number, string> = {
  1: "stage",
  2: "voice",
  3: "external",
};

/** Map an event `entity_type` to a short label; unknown types stay visible. */
export function eventTypeName(type: number): string {
  return EVENT_TYPE_NAMES[type] ?? `other(${type})`;
}
