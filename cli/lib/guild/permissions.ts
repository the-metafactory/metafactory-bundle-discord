/**
 * Channel permission overwrites — the mechanism for gating channels behind roles.
 *
 * Gating a category behind a role is a permission-overwrite story: deny
 * `@everyone` VIEW_CHANNEL on the category, allow it for the role. This module
 * owns the named-permission bit map, the overwrite REST calls (set / delete /
 * read), and the client-side "sync from category" helper.
 *
 * Two things worth stating up front:
 *
 *   1. **BigInt, not number.** Discord permission flags run past 2^31
 *      (`MANAGE_THREADS` is `1 << 34`, `CREATE_EVENTS` is `1 << 44`), so a JS
 *      `number` bitmask silently corrupts. Bits are `bigint`; the wire format is
 *      a decimal STRING per the API contract (`allow` / `deny` are strings).
 *
 *   2. **"Sync from category" is a client concept.** Discord does not expose
 *      "sync now" as an API verb — a synced channel simply has overwrites
 *      byte-identical to its parent category. `syncFromCategory` reproduces that
 *      by copying the parent's overwrites onto the channel and deleting any
 *      channel-local overwrites the parent doesn't have.
 *
 * Security invariant (mirrors `mapRoleError`, cli/lib/discord.ts): the bot token
 * lives only in the Authorization header (owned by `discordRequest`); it is never
 * interpolated into a thrown message. The `errorText` these helpers surface is the
 * response body, which never echoes the token.
 *
 * A bot can only grant permissions it itself holds — Discord returns 403 when the
 * bot tries to set a bit it does not possess. `permsErrorMessage` explains that in
 * the wording pattern of `mapRoleError`.
 *
 * API: https://discord.com/developers/docs/resources/channel (Edit Channel
 * Permissions — type 0 = role, 1 = member; bot needs MANAGE_ROLES).
 * Flags: https://discord.com/developers/docs/topics/permissions
 */

import { discordRequest } from "../http";

/**
 * Named permission flags → their bit, as `bigint`. Only the flags the guild-
 * config slices actually touch live here; extend the map, never widen the type.
 *
 * Values exceed 2^31 — kept as `bigint` so composition/serialization is lossless.
 */
export const PERMISSIONS: Record<string, bigint> = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_EVENTS: 1n << 33n,
  CREATE_EVENTS: 1n << 44n,
  MODERATE_MEMBERS: 1n << 40n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  ADD_REACTIONS: 1n << 6n,
  ATTACH_FILES: 1n << 15n,
  EMBED_LINKS: 1n << 14n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MENTION_EVERYONE: 1n << 17n,
};

/** Every valid permission name, for error messages. */
export function validPermissionNames(): string[] {
  return Object.keys(PERMISSIONS);
}

/** Union of all known bits — used to isolate unknown bits when decoding. */
const KNOWN_BITS: bigint = Object.values(PERMISSIONS).reduce(
  (acc, bit) => acc | bit,
  0n
);

/**
 * Compose a list of permission names into a single `bigint` bitmask.
 *
 * Names are trimmed and matched case-insensitively. Empty entries (e.g. from a
 * trailing comma) are skipped. Any name not in the map throws an error listing
 * the offending names AND the full set of valid names, so the caller can fix it
 * without consulting the source.
 */
export function permissionNamesToBits(names: string[]): bigint {
  let bits = 0n;
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim().toUpperCase();
    if (name === "") continue;
    const bit = PERMISSIONS[name];
    if (bit === undefined) {
      unknown.push(raw.trim());
    } else {
      bits |= bit;
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown permission name(s): ${unknown.join(", ")}. ` +
        `Valid names: ${validPermissionNames().join(", ")}`
    );
  }
  return bits;
}

/** Parse a comma-separated `--allow`/`--deny` value into a bitmask. */
export function parsePermissionList(csv: string): bigint {
  return permissionNamesToBits(csv.split(","));
}

/**
 * Decode a `bigint` bitmask back into permission names. Bits not in the map are
 * rendered as `bit:N` (N = bit index) so an unrecognised flag stays visible
 * rather than being silently dropped.
 */
export function bitsToPermissionNames(bits: bigint): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(PERMISSIONS)) {
    if ((bits & bit) === bit) names.push(name);
  }
  let leftover = bits & ~KNOWN_BITS;
  for (let i = 0n; leftover !== 0n; i++) {
    if ((leftover & 1n) === 1n) names.push(`bit:${i}`);
    leftover >>= 1n;
  }
  return names;
}

/** Serialize a bitmask to the decimal STRING Discord's API expects. */
export function bitsToWire(bits: bigint): string {
  return bits.toString();
}

/** A channel permission overwrite. `allow`/`deny` are decimal-string bitmasks. */
export interface Overwrite {
  /** Snowflake of the role (type 0) or member (type 1) the overwrite targets. */
  id: string;
  /** 0 = role, 1 = member. */
  type: 0 | 1;
  /** Allowed bits as a decimal string. */
  allow: string;
  /** Denied bits as a decimal string. */
  deny: string;
}

/** Fields of a channel this module reads (narrowest projection). */
interface RawChannel {
  parent_id?: string | null;
  permission_overwrites?: RawOverwrite[];
}

interface RawOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

/** Normalise a Discord overwrite `type` number to the 0|1 union. */
function normaliseType(type: number): 0 | 1 {
  return type === 1 ? 1 : 0;
}

/**
 * Map a non-2xx overwrite response to a caller-facing message, in the wording
 * pattern of `mapRoleError` (cli/lib/discord.ts). The bot token is never passed
 * here and cannot appear in the output; `body` is the response body only.
 */
function permsErrorMessage(status: number, channelId: string, body: string): string {
  if (status === 403) {
    return (
      `Bot lacks permission to edit overwrites on channel ${channelId}. ` +
      `A bot can only grant or deny permissions it holds itself — ensure the bot has ` +
      `Manage Roles and actually possesses every permission bit this overwrite sets.`
    );
  }
  if (status === 404) {
    return `channel or overwrite not found (channel ${channelId})`;
  }
  return `${status}: ${body}`;
}

/**
 * Set (create or replace) a permission overwrite on a channel.
 *
 * `PUT /channels/{channel}/permissions/{overwrite}` — success is 204. The whole
 * overwrite is replaced, so `allow`/`deny` are the complete masks for the target
 * (pure ids in, no interactive prompts — layout-engine friendly).
 */
export async function setOverwrite(
  token: string,
  channelId: string,
  overwriteId: string,
  overwrite: { type: 0 | 1; allow: string; deny: string }
): Promise<void> {
  const res = await discordRequest(
    token,
    "PUT",
    `/channels/${channelId}/permissions/${overwriteId}`,
    {
      json: {
        type: overwrite.type,
        allow: overwrite.allow,
        deny: overwrite.deny,
      },
      expect: "none",
    }
  );
  if (!res.ok) {
    throw new Error(permsErrorMessage(res.status, channelId, res.errorText ?? ""));
  }
}

/**
 * Delete a permission overwrite from a channel.
 *
 * `DELETE /channels/{channel}/permissions/{overwrite}` — success is 204.
 */
export async function deleteOverwrite(
  token: string,
  channelId: string,
  overwriteId: string
): Promise<void> {
  const res = await discordRequest(
    token,
    "DELETE",
    `/channels/${channelId}/permissions/${overwriteId}`,
    { expect: "none" }
  );
  if (!res.ok) {
    throw new Error(permsErrorMessage(res.status, channelId, res.errorText ?? ""));
  }
}

/**
 * Read a channel's current overwrites from `GET /channels/{channel}`'s
 * `permission_overwrites` field.
 */
export async function getOverwrites(
  token: string,
  channelId: string
): Promise<Overwrite[]> {
  const res = await discordRequest<RawChannel>(
    token,
    "GET",
    `/channels/${channelId}`
  );
  if (!res.ok) {
    throw new Error(permsErrorMessage(res.status, channelId, res.errorText ?? ""));
  }
  return (res.data?.permission_overwrites ?? []).map((o) => ({
    id: o.id,
    type: normaliseType(o.type),
    allow: o.allow,
    deny: o.deny,
  }));
}

/** What a `syncFromCategory` run did, for the command to report. */
export interface SyncResult {
  parentId: string;
  copied: number;
  removed: number;
}

/**
 * Make a channel's overwrites byte-identical to its parent category's — the
 * client-side equivalent of Discord's "sync now" (which is not an API verb).
 *
 * Reads the channel (for its `parent_id` and current overwrites), reads the
 * parent category's overwrites, PUTs each parent overwrite onto the channel, then
 * DELETEs any channel-local overwrite the parent does not have. A channel with no
 * parent category throws — there is nothing to sync from.
 */
export async function syncFromCategory(
  token: string,
  channelId: string
): Promise<SyncResult> {
  const res = await discordRequest<RawChannel>(
    token,
    "GET",
    `/channels/${channelId}`
  );
  if (!res.ok) {
    throw new Error(permsErrorMessage(res.status, channelId, res.errorText ?? ""));
  }

  const parentId = res.data?.parent_id ?? undefined;
  if (!parentId) {
    throw new Error(
      `Channel ${channelId} has no parent category to sync from.`
    );
  }
  const childOverwrites = res.data?.permission_overwrites ?? [];

  const parentRes = await discordRequest<RawChannel>(
    token,
    "GET",
    `/channels/${parentId}`
  );
  if (!parentRes.ok) {
    throw new Error(
      permsErrorMessage(parentRes.status, parentId, parentRes.errorText ?? "")
    );
  }
  const parentOverwrites = parentRes.data?.permission_overwrites ?? [];

  // Copy every parent overwrite onto the channel.
  for (const o of parentOverwrites) {
    await setOverwrite(token, channelId, o.id, {
      type: normaliseType(o.type),
      allow: o.allow,
      deny: o.deny,
    });
  }

  // Remove channel-local overwrites the parent does not carry.
  const parentIds = new Set(parentOverwrites.map((o) => o.id));
  const extras = childOverwrites.filter((o) => !parentIds.has(o.id));
  for (const o of extras) {
    await deleteOverwrite(token, channelId, o.id);
  }

  return {
    parentId,
    copied: parentOverwrites.length,
    removed: extras.length,
  };
}
