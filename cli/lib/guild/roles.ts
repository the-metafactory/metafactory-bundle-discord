/**
 * Guild role lifecycle — create / modify / delete / reorder / list the roles
 * themselves (issue #10). This is the counterpart to `cli/lib/discord.ts`'s
 * member-role helpers (`assignRole` / `removeRole`), which only attach or detach
 * roles that already exist; here we manage the roles as objects.
 *
 * Every call goes through `discordRequest` (cli/lib/http.ts) — the shared
 * transport that owns the bot Authorization header, 429 retry, and rate-limit
 * pacing. This is that transport's first consumer among the guild-config slices.
 *
 * Security invariant (mirrors `mapRoleError`, cli/lib/discord.ts): the bot token
 * lives ONLY in the Authorization header inside `discordRequest`. It is never
 * interpolated into any returned error string — `errorText` carries only the
 * response body, which never echoes the token.
 *
 * Hierarchy / permission prerequisite (document; do NOT self-grant): to mutate a
 * role the bot needs the **Manage Roles** permission AND its own highest role
 * must sit ABOVE the target role's position. The 403 branch fires otherwise.
 *
 * Role icons and `unicode_emoji` require the guild to be Boost **Level 2**
 * (the `ROLE_ICONS` guild feature). On a non-boosted guild Discord rejects the
 * write; we surface its body verbatim (minus the token, which is never in it) so
 * the command degrades to a one-line message rather than a stack trace.
 */

import { discordRequest } from "../http";
import { isSnowflake } from "../discord";

/**
 * Writable role fields. All optional so the same shape drives `createRole`
 * (Discord fills unset fields with defaults) and `modifyRole` (unset = leave as-is).
 */
export interface RoleSpec {
  name?: string;
  /** Integer RGB (e.g. 0x3B82F6). The CLI parses a `#hex` into this. */
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  /** Permission bitmask as a decimal string (Discord's string-encoded bitfield). */
  permissions?: string;
  /** Role icon as a base64 data-URI. Requires guild Boost Level 2 (ROLE_ICONS). */
  icon?: string;
  /** Unicode emoji shown as the role icon. Also requires Boost Level 2. */
  unicode_emoji?: string;
}

/** Narrow projection of a Discord role — only the fields this bundle reads. */
export interface GuildRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  mentionable: boolean;
  managed: boolean;
  icon?: string;
  unicode_emoji?: string;
}

/** A single entry in a `reorderRoles` positions payload. */
export interface RolePosition {
  id: string;
  position: number;
}

/** Result of a create/modify — the projected role, or a mapped error. */
export type RoleWriteResult =
  | { success: true; role: GuildRole }
  | { success: false; error: string };

/** Result of a list/reorder — the projected roles, or a mapped error. */
export type RoleListResult =
  | { success: true; roles: GuildRole[] }
  | { success: false; error: string };

/** Result of a delete — success carries no body (204). */
export type RoleDeleteResult =
  | { success: true }
  | { success: false; error: string };

/** Discord API role shape (narrowest projection this module reads). */
interface DiscordApiRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  mentionable: boolean;
  managed: boolean;
  icon?: string | null;
  unicode_emoji?: string | null;
}

/** Project the raw API role to the narrow `GuildRole`, null → undefined. */
function projectRole(r: DiscordApiRole): GuildRole {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    hoist: r.hoist,
    position: r.position,
    permissions: r.permissions,
    mentionable: r.mentionable,
    managed: r.managed,
    icon: r.icon ?? undefined,
    unicode_emoji: r.unicode_emoji ?? undefined,
  };
}

/** Serialise a spec to a request body, omitting fields the caller left unset. */
function toApiBody(spec: RoleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (spec.name !== undefined) body.name = spec.name;
  if (spec.color !== undefined) body.color = spec.color;
  if (spec.hoist !== undefined) body.hoist = spec.hoist;
  if (spec.mentionable !== undefined) body.mentionable = spec.mentionable;
  if (spec.permissions !== undefined) body.permissions = spec.permissions;
  if (spec.icon !== undefined) body.icon = spec.icon;
  if (spec.unicode_emoji !== undefined) body.unicode_emoji = spec.unicode_emoji;
  return body;
}

/** Sort highest-in-hierarchy first (Discord's own display order), then by name. */
function byHierarchy(a: GuildRole, b: GuildRole): number {
  return b.position - a.position || a.name.localeCompare(b.name);
}

/**
 * Map a non-2xx role-write response to an error string. Mirrors the wording of
 * `mapRoleError` (cli/lib/discord.ts) for the 403 case, and — when the write
 * carried an icon or unicode emoji — appends the Boost Level 2 requirement so an
 * `--icon` on a non-boosted guild reads clearly instead of as a raw API error.
 *
 * `body` is the response body from `discordRequest`; the token is never in it.
 */
function mapRoleError(
  status: number,
  body: string,
  guildId: string,
  spec?: RoleSpec
): string {
  if (status === 403) {
    return (
      `Bot lacks Manage Roles permission (or its highest role is below the target ` +
      `role) in guild ${guildId}. Ensure the bot has Manage Roles and its role sits ` +
      `above the roles it manages in the hierarchy.`
    );
  }
  const base = `${status}: ${body}`;
  if (spec && (spec.icon !== undefined || spec.unicode_emoji !== undefined)) {
    return (
      `${base} — role icons and unicode emoji require the guild to be Boost ` +
      `Level 2 (the ROLE_ICONS feature).`
    );
  }
  return base;
}

/**
 * Create a role. POST `/guilds/{guildId}/roles`.
 * Returns the created role, or a mapped error (never throws on an API failure).
 */
export async function createRole(
  token: string,
  guildId: string,
  spec: RoleSpec
): Promise<RoleWriteResult> {
  if (!isSnowflake(guildId)) {
    return { success: false, error: `invalid guild id: ${guildId}` };
  }

  const res = await discordRequest<DiscordApiRole>(
    token,
    "POST",
    `/guilds/${guildId}/roles`,
    { json: toApiBody(spec) }
  );

  if (!res.ok || !res.data) {
    return { success: false, error: mapRoleError(res.status, res.errorText ?? "", guildId, spec) };
  }
  return { success: true, role: projectRole(res.data) };
}

/**
 * Modify a role. PATCH `/guilds/{guildId}/roles/{roleId}`.
 * Only the fields present in `spec` are changed.
 */
export async function modifyRole(
  token: string,
  guildId: string,
  roleId: string,
  spec: RoleSpec
): Promise<RoleWriteResult> {
  if (!isSnowflake(guildId)) {
    return { success: false, error: `invalid guild id: ${guildId}` };
  }
  if (!isSnowflake(roleId)) {
    return { success: false, error: `invalid role id: ${roleId}` };
  }

  const res = await discordRequest<DiscordApiRole>(
    token,
    "PATCH",
    `/guilds/${guildId}/roles/${roleId}`,
    { json: toApiBody(spec) }
  );

  if (!res.ok || !res.data) {
    return { success: false, error: mapRoleError(res.status, res.errorText ?? "", guildId, spec) };
  }
  return { success: true, role: projectRole(res.data) };
}

/**
 * Delete a role. DELETE `/guilds/{guildId}/roles/{roleId}` — expects 204.
 */
export async function deleteRole(
  token: string,
  guildId: string,
  roleId: string
): Promise<RoleDeleteResult> {
  if (!isSnowflake(guildId)) {
    return { success: false, error: `invalid guild id: ${guildId}` };
  }
  if (!isSnowflake(roleId)) {
    return { success: false, error: `invalid role id: ${roleId}` };
  }

  const res = await discordRequest(
    token,
    "DELETE",
    `/guilds/${guildId}/roles/${roleId}`,
    { expect: "none" }
  );

  if (!res.ok) {
    return { success: false, error: mapRoleError(res.status, res.errorText ?? "", guildId) };
  }
  return { success: true };
}

/**
 * Reorder roles. PATCH `/guilds/{guildId}/roles` with a `{id, position}[]`
 * payload; Discord returns the full, re-positioned role list, which we project
 * and sort highest-first.
 */
export async function reorderRoles(
  token: string,
  guildId: string,
  positions: RolePosition[]
): Promise<RoleListResult> {
  if (!isSnowflake(guildId)) {
    return { success: false, error: `invalid guild id: ${guildId}` };
  }
  for (const p of positions) {
    if (!isSnowflake(p.id)) {
      return { success: false, error: `invalid role id: ${p.id}` };
    }
  }

  const res = await discordRequest<DiscordApiRole[]>(
    token,
    "PATCH",
    `/guilds/${guildId}/roles`,
    { json: positions }
  );

  if (!res.ok || !res.data) {
    return { success: false, error: mapRoleError(res.status, res.errorText ?? "", guildId) };
  }
  return { success: true, roles: res.data.map(projectRole).sort(byHierarchy) };
}

/**
 * List roles. GET `/guilds/{guildId}/roles`, projected and sorted highest-first.
 */
export async function listRoles(
  token: string,
  guildId: string
): Promise<RoleListResult> {
  if (!isSnowflake(guildId)) {
    return { success: false, error: `invalid guild id: ${guildId}` };
  }

  const res = await discordRequest<DiscordApiRole[]>(
    token,
    "GET",
    `/guilds/${guildId}/roles`
  );

  if (!res.ok || !res.data) {
    return { success: false, error: mapRoleError(res.status, res.errorText ?? "", guildId) };
  }
  return { success: true, roles: res.data.map(projectRole).sort(byHierarchy) };
}
