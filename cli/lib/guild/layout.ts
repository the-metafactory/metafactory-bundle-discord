/**
 * Declarative guild layout — the config-as-code engine (issue #18).
 *
 * A "guild layout" is a versioned YAML file describing the structure a guild
 * SHOULD have: its roles, categories, channels (+ permission overwrites and forum
 * tags), guild settings, and welcome screen. This module turns that file into a
 * reviewable PLAN and, only when explicitly told to, APPLIES it against a live
 * guild. It composes the sibling mutation slices (roles, channels, perms, settings)
 * — it re-implements none of them.
 *
 * Three load-bearing safety rules, all enforced here:
 *
 *   1. DRY-RUN IS THE DEFAULT. `applyPlan` mutates nothing unless `execute: true`.
 *      The command layer defaults to a plan-only run; `--execute` opts in.
 *
 *   2. NEVER DESTRUCTIVE BY DEFAULT. A live resource that is absent from the
 *      layout is reported as `unmanaged` (informational) — it is NEVER deleted.
 *      Deletion requires BOTH an explicit `prune:` block in the layout naming the
 *      resource AND the `--prune` flag at apply time (`diffLayout(..., {prune})`).
 *      Missing either gate → the resource stays and is only reported.
 *
 *   3. MATCHING IS BY NAME. Roles match by name; categories by name; channels by
 *      name+parent. There are no ids in a layout. A consequence worth stating
 *      loudly: RENAMING a resource in the layout is seen as delete-the-old +
 *      create-the-new, because the old name no longer matches anything. Rename in
 *      Discord and in the layout in lockstep, or accept the create (and prune the
 *      orphan deliberately).
 *
 * DEPENDENCY-ORDERED APPLY. Actions run roles → categories → channels → overwrites
 * → forum tags → guild settings → (prune deletes). `applyPlan` seeds a name→id map
 * from the snapshot and extends it as each create resolves, so a channel can
 * reference a category, and an overwrite a role, created earlier in the same run.
 *
 * IDEMPOTENT / RESUMABLE. Apply stops on the first failing action and reports
 * "completed N of M". The command re-snapshots and re-diffs on the next run, so
 * the resources already created no longer appear in the plan and the run picks up
 * exactly where it left off. A clean guild diffs to an empty plan.
 *
 * NAMING NOTE (deliberate): this is the "guild layout / diff / apply" feature. The
 * words "reconcile" and "server-config" are intentionally absent — they belong to
 * the NATS federation layer in this org and collide in search.
 */

import YAML from "yaml";
import {
  PERMISSIONS,
  permissionNamesToBits,
  bitsToPermissionNames,
  bitsToWire,
  setOverwrite,
  deleteOverwrite,
} from "./permissions";
import {
  CHANNEL_TYPE,
  createChannel,
  modifyChannel,
  deleteChannel,
  type ChannelSpec,
  type ForumTag,
} from "./channels";
import { createRole, modifyRole, deleteRole, type RoleSpec } from "./roles";
import {
  modifyGuild,
  modifyWelcomeScreen,
  verificationLevelValue,
  type ModifyGuildSpec,
  type WelcomeChannel,
} from "./settings";
import {
  isUnavailable,
  type GuildSnapshot,
  type SnapshotRole,
  type SnapshotCategory,
  type SnapshotChannel,
  type SnapshotOverwrite,
} from "./snapshot";

// ═══ layout shape (parsed, validated) ══════════════════════════════════════════

/** A permission overwrite in the layout: a role name plus allow/deny name lists. */
export interface LayoutOverwrite {
  /** Role name (or `@everyone`). Members are never expressed in a layout. */
  role: string;
  allow: string[];
  deny: string[];
}

export interface LayoutRole {
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string[];
}

export interface LayoutCategory {
  name: string;
  /** Present only when the layout opts into managing this category's overwrites. */
  overwrites?: LayoutOverwrite[];
}

export interface LayoutForumTag {
  name: string;
  moderated?: boolean;
  emoji_name?: string | null;
}

export interface LayoutChannel {
  name: string;
  /** One of text | voice | announcement | forum (categories are their own section). */
  type: string;
  parent: string | null;
  topic?: string;
  slowmode?: number;
  overwrites?: LayoutOverwrite[];
  /** Forum channels only. */
  forum_tags?: LayoutForumTag[];
}

export interface LayoutGuildSettings {
  verification?: string;
  rules_channel?: string;
  updates_channel?: string;
  system_channel?: string;
}

export interface LayoutWelcomeChannel {
  channel: string;
  description: string;
  emoji?: string;
}

export interface LayoutWelcomeScreen {
  enabled?: boolean;
  description?: string;
  channels: LayoutWelcomeChannel[];
}

/** The explicit deletion opt-in. A resource here is deleted only WITH `--prune`. */
export interface LayoutPrune {
  roles: string[];
  categories: string[];
  channels: string[];
}

export interface Layout {
  roles: LayoutRole[];
  categories: LayoutCategory[];
  channels: LayoutChannel[];
  guild?: LayoutGuildSettings;
  welcome_screen?: LayoutWelcomeScreen;
  prune?: LayoutPrune;
}

// ═══ validation ════════════════════════════════════════════════════════════════

/** A layout that failed schema validation. Message always names key + location. */
export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutError";
  }
}

/** Throw a `LayoutError` prefixed with the offending path. */
function fail(path: string, message: string): never {
  throw new LayoutError(`${path}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Require a plain object at `path`, or fail naming what was found instead. */
function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(path, `expected a mapping, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/** A short type name for an errant value, for error messages. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

/** Fail if `obj` carries any key outside `allowed`, naming the first stray key. */
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], path: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!set.has(key)) {
      fail(`${path}.${key}`, `unknown key (allowed here: ${allowed.join(", ")})`);
    }
  }
}

function optString(obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") fail(`${path}.${key}`, `expected a string, got ${describe(v)}`);
  return v;
}

function optNumber(obj: Record<string, unknown>, key: string, path: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number") fail(`${path}.${key}`, `expected a number, got ${describe(v)}`);
  return v;
}

function optBool(obj: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") fail(`${path}.${key}`, `expected true/false, got ${describe(v)}`);
  return v;
}

function optStringArray(obj: Record<string, unknown>, key: string, path: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    fail(`${path}.${key}`, "expected a list of strings");
  }
  return v as string[];
}

/** Valid layout channel types → their Discord type number (categories excluded). */
const CHANNEL_TYPE_BY_NAME: Record<string, number> = {
  text: CHANNEL_TYPE.text,
  voice: CHANNEL_TYPE.voice,
  announcement: CHANNEL_TYPE.announcement,
  forum: CHANNEL_TYPE.forum,
};

/**
 * Validate an `overwrites:` mapping (`{ roleName: { allow?, deny? } }`). Permission
 * names are validated eagerly (an unknown name fails here, naming the location),
 * so a typo never reaches the API.
 */
function parseOverwrites(value: unknown, path: string): LayoutOverwrite[] {
  const obj = requireObject(value, path);
  const out: LayoutOverwrite[] = [];
  for (const [roleName, raw] of Object.entries(obj)) {
    const owPath = `${path}.${roleName}`;
    const ow = requireObject(raw, owPath);
    rejectUnknownKeys(ow, ["allow", "deny"], owPath);
    const allow = optStringArray(ow, "allow", owPath) ?? [];
    const deny = optStringArray(ow, "deny", owPath) ?? [];
    // Eagerly validate every permission name (throws LayoutError on an unknown one).
    assertPermissionNames(allow, `${owPath}.allow`);
    assertPermissionNames(deny, `${owPath}.deny`);
    out.push({ role: roleName, allow, deny });
  }
  return out;
}

/** Validate permission names, re-throwing the perms-slice error under `path`. */
function assertPermissionNames(names: string[], path: string): void {
  try {
    permissionNamesToBits(names);
  } catch (err) {
    fail(path, (err as Error).message);
  }
}

function parseRoles(value: unknown): LayoutRole[] {
  const obj = requireObject(value, "roles");
  const out: LayoutRole[] = [];
  for (const [name, raw] of Object.entries(obj)) {
    const path = `roles.${name}`;
    const r = requireObject(raw, path);
    rejectUnknownKeys(r, ["color", "hoist", "mentionable", "permissions"], path);
    const permissions = optStringArray(r, "permissions", path);
    if (permissions) assertPermissionNames(permissions, `${path}.permissions`);
    out.push({
      name,
      color: optNumber(r, "color", path),
      hoist: optBool(r, "hoist", path),
      mentionable: optBool(r, "mentionable", path),
      permissions,
    });
  }
  return out;
}

function parseCategories(value: unknown): LayoutCategory[] {
  const obj = requireObject(value, "categories");
  const out: LayoutCategory[] = [];
  for (const [name, raw] of Object.entries(obj)) {
    const path = `categories.${name}`;
    // A category may be an empty mapping (no managed overwrites).
    const c = raw === null ? {} : requireObject(raw, path);
    rejectUnknownKeys(c, ["overwrites"], path);
    const overwrites = "overwrites" in c ? parseOverwrites(c.overwrites, `${path}.overwrites`) : undefined;
    out.push({ name, overwrites });
  }
  return out;
}

function parseForumTags(value: unknown, path: string): LayoutForumTag[] {
  if (!Array.isArray(value)) fail(path, "expected a list of tags");
  return value.map((raw, i) => {
    const tagPath = `${path}[${i}]`;
    const t = requireObject(raw, tagPath);
    rejectUnknownKeys(t, ["name", "moderated", "emoji_name"], tagPath);
    const name = optString(t, "name", tagPath);
    if (name === undefined) fail(tagPath, "a forum tag requires a name");
    const tag: LayoutForumTag = { name };
    const moderated = optBool(t, "moderated", tagPath);
    if (moderated !== undefined) tag.moderated = moderated;
    if ("emoji_name" in t) {
      const e = t.emoji_name;
      if (e !== null && typeof e !== "string") fail(`${tagPath}.emoji_name`, "expected a string or null");
      tag.emoji_name = e as string | null;
    }
    return tag;
  });
}

function parseChannels(value: unknown): LayoutChannel[] {
  const obj = requireObject(value, "channels");
  const out: LayoutChannel[] = [];
  for (const [name, raw] of Object.entries(obj)) {
    const path = `channels.${name}`;
    const c = requireObject(raw, path);
    rejectUnknownKeys(c, ["type", "parent", "topic", "slowmode", "overwrites", "forum_tags"], path);

    const type = optString(c, "type", path);
    if (type === undefined) fail(path, "a channel requires a type (text|voice|announcement|forum)");
    if (!(type in CHANNEL_TYPE_BY_NAME)) {
      fail(`${path}.type`, `"${type}" is not a valid channel type (text|voice|announcement|forum)`);
    }

    let parent: string | null = null;
    if ("parent" in c) {
      const p = c.parent;
      if (p !== null && typeof p !== "string") fail(`${path}.parent`, "expected a category name or null");
      parent = p as string | null;
    }

    const forum_tags = "forum_tags" in c ? parseForumTags(c.forum_tags, `${path}.forum_tags`) : undefined;
    if (forum_tags && type !== "forum") {
      fail(`${path}.forum_tags`, "forum_tags are only valid on a forum channel");
    }

    out.push({
      name,
      type,
      parent,
      topic: optString(c, "topic", path),
      slowmode: optNumber(c, "slowmode", path),
      overwrites: "overwrites" in c ? parseOverwrites(c.overwrites, `${path}.overwrites`) : undefined,
      forum_tags,
    });
  }
  return out;
}

function parseGuildSettings(value: unknown): LayoutGuildSettings {
  const g = requireObject(value, "guild");
  rejectUnknownKeys(g, ["verification", "rules_channel", "updates_channel", "system_channel"], "guild");
  const verification = optString(g, "verification", "guild");
  if (verification !== undefined) {
    try {
      verificationLevelValue(verification);
    } catch (err) {
      fail("guild.verification", (err as Error).message);
    }
  }
  return {
    verification,
    rules_channel: optString(g, "rules_channel", "guild"),
    updates_channel: optString(g, "updates_channel", "guild"),
    system_channel: optString(g, "system_channel", "guild"),
  };
}

function parseWelcomeScreen(value: unknown): LayoutWelcomeScreen {
  const w = requireObject(value, "welcome_screen");
  rejectUnknownKeys(w, ["enabled", "description", "channels"], "welcome_screen");
  const channelsRaw = w.channels;
  if (!Array.isArray(channelsRaw)) fail("welcome_screen.channels", "expected a list of channels");
  const channels = channelsRaw.map((raw, i) => {
    const path = `welcome_screen.channels[${i}]`;
    const c = requireObject(raw, path);
    rejectUnknownKeys(c, ["channel", "description", "emoji"], path);
    const channel = optString(c, "channel", path);
    const description = optString(c, "description", path);
    if (channel === undefined) fail(path, "a welcome channel requires a channel name");
    if (description === undefined) fail(path, "a welcome channel requires a description");
    const out: LayoutWelcomeChannel = { channel, description };
    const emoji = optString(c, "emoji", path);
    if (emoji !== undefined) out.emoji = emoji;
    return out;
  });
  return {
    enabled: optBool(w, "enabled", "welcome_screen"),
    description: optString(w, "description", "welcome_screen"),
    channels,
  };
}

function parsePrune(value: unknown): LayoutPrune {
  const p = requireObject(value, "prune");
  rejectUnknownKeys(p, ["roles", "categories", "channels"], "prune");
  return {
    roles: optStringArray(p, "roles", "prune") ?? [],
    categories: optStringArray(p, "categories", "prune") ?? [],
    channels: optStringArray(p, "channels", "prune") ?? [],
  };
}

/**
 * Parse + schema-validate a guild layout from YAML text. Hand-rolled validation
 * (no zod — runtime deps stay commander+yaml). Every error is a `LayoutError`
 * whose message names the offending key and its location in the document.
 */
export function parseLayout(yamlText: string): Layout {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch (err) {
    throw new LayoutError(`layout is not valid YAML: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) {
    throw new LayoutError("layout is empty");
  }
  const root = requireObject(doc, "(root)");
  rejectUnknownKeys(
    root,
    ["roles", "categories", "channels", "guild", "welcome_screen", "prune"],
    "(root)"
  );

  return {
    roles: "roles" in root ? parseRoles(root.roles) : [],
    categories: "categories" in root ? parseCategories(root.categories) : [],
    channels: "channels" in root ? parseChannels(root.channels) : [],
    guild: "guild" in root ? parseGuildSettings(root.guild) : undefined,
    welcome_screen: "welcome_screen" in root ? parseWelcomeScreen(root.welcome_screen) : undefined,
    prune: "prune" in root ? parsePrune(root.prune) : undefined,
  };
}

// ═══ plan (the diff) ═══════════════════════════════════════════════════════════

/** Identifies the channel or category an overwrite lives on. */
export type Container =
  | { kind: "category"; name: string }
  | { kind: "channel"; name: string; parent: string | null };

/** Desired guild-settings changes carried by a `modify_guild` action. */
export interface GuildChange {
  verification?: string;
  rules_channel?: string;
  updates_channel?: string;
  system_channel?: string;
  welcome?: LayoutWelcomeScreen;
}

/**
 * One planned mutation. Every action carries a one-line human `description` and
 * only NAMES — no ids. `applyPlan` resolves names to live ids as it runs, so an
 * action can reference a resource created earlier in the same plan.
 *
 * `create_role`/`modify_role` also carry the pre-computed permission wire string;
 * overwrites carry pre-computed allow/deny wire strings — all deterministic and
 * id-free, so the plan is fully reviewable before any network call.
 */
export type Action =
  | { kind: "create_role"; description: string; role: LayoutRole; permissionsWire?: string }
  | { kind: "modify_role"; description: string; role: LayoutRole; permissionsWire?: string }
  | { kind: "create_category"; description: string; name: string }
  | {
      kind: "create_channel";
      description: string;
      name: string;
      parent: string | null;
      channelType: number;
      topic?: string;
      slowmode?: number;
    }
  | {
      kind: "modify_channel";
      description: string;
      name: string;
      parent: string | null;
      topic?: string;
      slowmode?: number;
    }
  | { kind: "set_forum_tags"; description: string; name: string; parent: string | null; tags: ForumTag[] }
  | {
      kind: "set_overwrite";
      description: string;
      container: Container;
      role: string;
      allow: string;
      deny: string;
    }
  | { kind: "delete_overwrite"; description: string; container: Container; role: string }
  | { kind: "modify_guild"; description: string; change: GuildChange }
  | { kind: "delete_channel"; description: string; name: string; parent: string | null }
  | { kind: "delete_category"; description: string; name: string }
  | { kind: "delete_role"; description: string; name: string };

/** A live resource absent from the layout — reported, never auto-deleted. */
export interface UnmanagedResource {
  kind: "role" | "category" | "channel";
  name: string;
  /** For channels: the parent category name (or null). */
  parent?: string | null;
}

/** A resource listed under `prune:` and present live, awaiting the `--prune` gate. */
export interface PendingPrune {
  kind: "role" | "category" | "channel";
  name: string;
}

/**
 * The ordered plan `diffLayout` produces. `actions` run top-to-bottom in
 * dependency order. `unmanaged` and `pendingPrune` are informational only.
 */
export interface Plan {
  actions: Action[];
  unmanaged: UnmanagedResource[];
  pendingPrune: PendingPrune[];
}

/** True when a plan would change nothing (its action list is empty). */
export function isEmptyPlan(plan: Plan): boolean {
  return plan.actions.length === 0;
}

// ─── diff helpers ───────────────────────────────────────────────────────────────

/** The composite identity key for a channel: parent + name (name+parent match). */
function channelKey(name: string, parent: string | null): string {
  return `${parent ?? ""} ${name}`;
}

/** Read a snapshot section as an array, treating an `unavailable(...)` marker as empty. */
function sectionArray<T>(value: T[] | string): T[] {
  return isUnavailable(value) ? [] : (value as T[]);
}

/** Tolerant name→bits: accepts the `bit:N` markers a snapshot may carry. */
function snapshotPermsToBits(names: string[]): bigint {
  let bits = 0n;
  for (const raw of names) {
    const m = /^bit:(\d+)$/.exec(raw);
    if (m) {
      bits |= 1n << BigInt(m[1]!);
      continue;
    }
    const bit = PERMISSIONS[raw.trim().toUpperCase()];
    if (bit !== undefined) bits |= bit;
  }
  return bits;
}

/** Canonical sorted permission-name form, for description text. */
function canonicalPerms(names: string[]): string[] {
  return bitsToPermissionNames(permissionNamesToBits(names)).sort();
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Only the role fields the layout actually specifies that differ from live. */
function roleFieldDiffers(desired: LayoutRole, live: SnapshotRole): boolean {
  if (desired.color !== undefined && desired.color !== live.color) return true;
  if (desired.hoist !== undefined && desired.hoist !== live.hoist) return true;
  if (desired.mentionable !== undefined && desired.mentionable !== live.mentionable) return true;
  if (desired.permissions !== undefined) {
    if (permissionNamesToBits(desired.permissions) !== snapshotPermsToBits(live.permissions)) return true;
  }
  return false;
}

/** Build the `RoleSpec` (create or modify body) from a layout role. */
function roleSpec(role: LayoutRole): RoleSpec {
  const spec: RoleSpec = {};
  if (role.color !== undefined) spec.color = role.color;
  if (role.hoist !== undefined) spec.hoist = role.hoist;
  if (role.mentionable !== undefined) spec.mentionable = role.mentionable;
  if (role.permissions !== undefined) spec.permissions = bitsToWire(permissionNamesToBits(role.permissions));
  return spec;
}

/** Index a snapshot overwrite array by target name (role-type overwrites only). */
function overwritesByRole(overwrites: SnapshotOverwrite[] | string): Map<string, SnapshotOverwrite> {
  const map = new Map<string, SnapshotOverwrite>();
  for (const o of sectionArray(overwrites)) {
    if (o.type === "role") map.set(o.target, o);
  }
  return map;
}

/**
 * Diff desired overwrites (from the layout) against the live ones on a container,
 * appending `set_overwrite` / `delete_overwrite` actions. Only role-type overwrites
 * participate — member overwrites are operational and left untouched. Deletions
 * here fire only when the container's layout entry declares an `overwrites` block
 * (opting into full management); this is convergence WITHIN a managed resource, not
 * the resource-level pruning that the `--prune` double-gate governs.
 */
function diffOverwrites(
  desired: LayoutOverwrite[],
  live: SnapshotOverwrite[] | string,
  container: Container,
  label: string,
  out: Action[]
): void {
  const liveByRole = overwritesByRole(live);
  const desiredRoles = new Set(desired.map((o) => o.role));

  for (const ow of desired) {
    const allowBits = permissionNamesToBits(ow.allow);
    const denyBits = permissionNamesToBits(ow.deny);
    const liveOw = liveByRole.get(ow.role);
    const same =
      liveOw !== undefined &&
      snapshotPermsToBits(liveOw.allow) === allowBits &&
      snapshotPermsToBits(liveOw.deny) === denyBits;
    if (!same) {
      out.push({
        kind: "set_overwrite",
        description: `set overwrite for ${ow.role} on ${label} (allow=[${canonicalPerms(ow.allow).join(", ")}] deny=[${canonicalPerms(ow.deny).join(", ")}])`,
        container,
        role: ow.role,
        allow: bitsToWire(allowBits),
        deny: bitsToWire(denyBits),
      });
    }
  }

  for (const [roleName] of liveByRole) {
    if (!desiredRoles.has(roleName)) {
      out.push({
        kind: "delete_overwrite",
        description: `remove overwrite for ${roleName} on ${label} (not in layout)`,
        container,
        role: roleName,
      });
    }
  }
}

/** Map layout forum tags to the `ForumTag` shape the channels slice consumes. */
function toForumTags(tags: LayoutForumTag[]): ForumTag[] {
  return tags.map((t) => {
    const out: ForumTag = { name: t.name };
    if (t.moderated !== undefined) out.moderated = t.moderated;
    if (t.emoji_name !== undefined && t.emoji_name !== null) out.emoji_name = t.emoji_name;
    return out;
  });
}

/** True when the desired forum tag set differs from the live one (name/mod/emoji/order). */
function forumTagsDiffer(desired: LayoutForumTag[], live: SnapshotChannel): boolean {
  const liveTags = live.forum?.tags ?? [];
  if (desired.length !== liveTags.length) return true;
  return desired.some((d, i) => {
    const l = liveTags[i]!;
    return (
      d.name !== l.name ||
      (d.moderated ?? false) !== (l.moderated ?? false) ||
      (d.emoji_name ?? null) !== (l.emoji_name ?? null)
    );
  });
}

/**
 * Compute the ordered plan that would make `snapshot` match `layout`.
 *
 * Ordering is the apply contract: create/modify roles → create categories →
 * create/modify channels → set/delete overwrites → set forum tags → modify guild
 * → (prune deletes, only when `prune` is passed). Matching is by name (channels by
 * name+parent). Live resources absent from the layout become `unmanaged` entries,
 * never delete actions — unless listed under `layout.prune` AND `{ prune: true }`
 * is passed here (the second half of the double-gate; the first is the prune block).
 */
export function diffLayout(layout: Layout, snapshot: GuildSnapshot, opts: { prune?: boolean } = {}): Plan {
  const roleActions: Action[] = [];
  const categoryActions: Action[] = [];
  const channelActions: Action[] = [];
  const overwriteActions: Action[] = [];
  const tagActions: Action[] = [];
  const guildActions: Action[] = [];
  const pruneActions: Action[] = [];

  const liveRoles = sectionArray(snapshot.roles);
  const liveCategories = sectionArray(snapshot.categories);
  const liveChannels = sectionArray(snapshot.channels);

  const roleByName = new Map(liveRoles.map((r) => [r.name, r]));
  const categoryByName = new Map(liveCategories.map((c) => [c.name, c]));
  const channelByKey = new Map(liveChannels.map((c) => [channelKey(c.name, c.parent), c]));

  // ── roles ──────────────────────────────────────────────────────────────────
  for (const role of layout.roles) {
    const live = roleByName.get(role.name);
    if (!live) {
      roleActions.push({
        kind: "create_role",
        description: `create role ${role.name}`,
        role,
        permissionsWire: role.permissions ? bitsToWire(permissionNamesToBits(role.permissions)) : undefined,
      });
    } else if (roleFieldDiffers(role, live)) {
      roleActions.push({
        kind: "modify_role",
        description: `modify role ${role.name}`,
        role,
        permissionsWire: role.permissions ? bitsToWire(permissionNamesToBits(role.permissions)) : undefined,
      });
    }
  }

  // ── categories ───────────────────────────────────────────────────────────────
  for (const category of layout.categories) {
    const live = categoryByName.get(category.name);
    if (!live) {
      categoryActions.push({
        kind: "create_category",
        description: `create category ${category.name}`,
        name: category.name,
      });
    }
    if (category.overwrites) {
      diffOverwrites(
        category.overwrites,
        live?.overwrites ?? [],
        { kind: "category", name: category.name },
        `category ${category.name}`,
        overwriteActions
      );
    }
  }

  // ── channels ────────────────────────────────────────────────────────────────
  for (const channel of layout.channels) {
    const key = channelKey(channel.name, channel.parent);
    const live = channelByKey.get(key);
    const where = channel.parent ? `${channel.parent}/${channel.name}` : channel.name;
    if (!live) {
      channelActions.push({
        kind: "create_channel",
        description: `create ${channel.type} channel ${where}`,
        name: channel.name,
        parent: channel.parent,
        channelType: CHANNEL_TYPE_BY_NAME[channel.type]!,
        topic: channel.topic,
        slowmode: channel.slowmode,
      });
    } else {
      const topicDiffers = channel.topic !== undefined && channel.topic !== (live.topic ?? undefined);
      const slowmodeDiffers = channel.slowmode !== undefined && channel.slowmode !== live.slowmode;
      if (topicDiffers || slowmodeDiffers) {
        channelActions.push({
          kind: "modify_channel",
          description: `modify channel ${where}`,
          name: channel.name,
          parent: channel.parent,
          topic: topicDiffers ? channel.topic : undefined,
          slowmode: slowmodeDiffers ? channel.slowmode : undefined,
        });
      }
    }

    if (channel.overwrites) {
      diffOverwrites(
        channel.overwrites,
        live?.overwrites ?? [],
        { kind: "channel", name: channel.name, parent: channel.parent },
        `channel ${where}`,
        overwriteActions
      );
    }

    if (channel.type === "forum" && channel.forum_tags) {
      if (!live || forumTagsDiffer(channel.forum_tags, live)) {
        tagActions.push({
          kind: "set_forum_tags",
          description: `set forum tags on ${where} (${channel.forum_tags.map((t) => t.name).join(", ")})`,
          name: channel.name,
          parent: channel.parent,
          tags: toForumTags(channel.forum_tags),
        });
      }
    }
  }

  // ── guild settings + welcome ──────────────────────────────────────────────────
  const guildChange = diffGuild(layout, snapshot);
  if (guildChange) {
    guildActions.push({
      kind: "modify_guild",
      description: describeGuildChange(guildChange),
      change: guildChange,
    });
  }

  // ── unmanaged + prune (the never-destructive-by-default core) ──────────────────
  const layoutRoleNames = new Set(layout.roles.map((r) => r.name));
  const layoutCategoryNames = new Set(layout.categories.map((c) => c.name));
  const layoutChannelKeys = new Set(layout.channels.map((c) => channelKey(c.name, c.parent)));

  const prune = layout.prune ?? { roles: [], categories: [], channels: [] };
  const pruneRoleNames = new Set(prune.roles);
  const pruneCategoryNames = new Set(prune.categories);
  const pruneChannelNames = new Set(prune.channels);
  const applyPrune = opts.prune === true;

  const unmanaged: UnmanagedResource[] = [];
  const pendingPrune: PendingPrune[] = [];

  // Channels first (a category can't be deleted while it holds channels).
  for (const c of liveChannels) {
    if (layoutChannelKeys.has(channelKey(c.name, c.parent))) continue;
    if (pruneChannelNames.has(c.name)) {
      if (applyPrune) {
        pruneActions.push({
          kind: "delete_channel",
          description: `PRUNE channel ${c.parent ? `${c.parent}/${c.name}` : c.name}`,
          name: c.name,
          parent: c.parent,
        });
      } else {
        pendingPrune.push({ kind: "channel", name: c.name });
      }
    } else {
      unmanaged.push({ kind: "channel", name: c.name, parent: c.parent });
    }
  }

  for (const c of liveCategories) {
    if (layoutCategoryNames.has(c.name)) continue;
    if (pruneCategoryNames.has(c.name)) {
      if (applyPrune) {
        pruneActions.push({ kind: "delete_category", description: `PRUNE category ${c.name}`, name: c.name });
      } else {
        pendingPrune.push({ kind: "category", name: c.name });
      }
    } else {
      unmanaged.push({ kind: "category", name: c.name });
    }
  }

  for (const r of liveRoles) {
    // @everyone (id === guild id) and integration-managed roles are never managed.
    if (r.name === "@everyone" || r.id === snapshot.guild.id || r.managed) continue;
    if (layoutRoleNames.has(r.name)) continue;
    if (pruneRoleNames.has(r.name)) {
      if (applyPrune) {
        pruneActions.push({ kind: "delete_role", description: `PRUNE role ${r.name}`, name: r.name });
      } else {
        pendingPrune.push({ kind: "role", name: r.name });
      }
    } else {
      unmanaged.push({ kind: "role", name: r.name });
    }
  }

  return {
    actions: [
      ...roleActions,
      ...categoryActions,
      ...channelActions,
      ...overwriteActions,
      ...tagActions,
      ...guildActions,
      ...pruneActions,
    ],
    unmanaged,
    pendingPrune,
  };
}

/** Compare layout guild settings + welcome screen to the snapshot; null if equal. */
function diffGuild(layout: Layout, snapshot: GuildSnapshot): GuildChange | null {
  const change: GuildChange = {};
  const g = layout.guild;
  const live = snapshot.guild;

  if (g?.verification !== undefined) {
    if (verificationLevelValue(g.verification) !== verificationLevelValue(live.verification_level)) {
      change.verification = g.verification;
    }
  }
  if (g?.rules_channel !== undefined && g.rules_channel !== (live.rules_channel?.name ?? undefined)) {
    change.rules_channel = g.rules_channel;
  }
  if (g?.updates_channel !== undefined && g.updates_channel !== (live.public_updates_channel?.name ?? undefined)) {
    change.updates_channel = g.updates_channel;
  }
  if (g?.system_channel !== undefined && g.system_channel !== (live.system_channel?.name ?? undefined)) {
    change.system_channel = g.system_channel;
  }

  if (layout.welcome_screen && welcomeDiffers(layout.welcome_screen, snapshot)) {
    change.welcome = layout.welcome_screen;
  }

  return Object.keys(change).length > 0 ? change : null;
}

/** True when the desired welcome screen differs from the live one. */
function welcomeDiffers(desired: LayoutWelcomeScreen, snapshot: GuildSnapshot): boolean {
  const live = snapshot.welcome_screen;
  if (isUnavailable(live)) return true;
  if (desired.enabled !== undefined && desired.enabled !== live.enabled) return true;
  if (desired.description !== undefined && desired.description !== (live.description ?? undefined)) return true;
  if (desired.channels.length !== live.channels.length) return true;
  return desired.channels.some((d, i) => {
    const l = live.channels[i];
    return !l || d.channel !== l.channel.name || d.description !== l.description;
  });
}

/** One-line description of a guild-settings change. */
function describeGuildChange(change: GuildChange): string {
  const parts: string[] = [];
  if (change.verification) parts.push(`verification=${change.verification}`);
  if (change.rules_channel) parts.push(`rules_channel=${change.rules_channel}`);
  if (change.updates_channel) parts.push(`updates_channel=${change.updates_channel}`);
  if (change.system_channel) parts.push(`system_channel=${change.system_channel}`);
  if (change.welcome) parts.push(`welcome_screen (${change.welcome.channels.length} channel(s))`);
  return `modify guild settings: ${parts.join(", ")}`;
}

// ═══ apply ═════════════════════════════════════════════════════════════════════

/** The outcome of an `applyPlan` run — the "completed N of M" report. */
export interface ApplyResult {
  /** False for a dry run (`execute: false`) — nothing was mutated. */
  executed: boolean;
  total: number;
  completed: number;
  ok: boolean;
  /** The action that failed and why, when `ok` is false. */
  failure?: { action: Action; error: string };
}

/** Running name→id resolution maps, seeded from the snapshot and grown by creates. */
interface Resolver {
  roleIds: Map<string, string>;
  categoryIds: Map<string, string>;
  channelIds: Map<string, string>;
  channelIdByName: Map<string, string>;
}

function seedResolver(snapshot: GuildSnapshot): Resolver {
  const roleIds = new Map<string, string>();
  for (const r of sectionArray(snapshot.roles)) roleIds.set(r.name, r.id);
  const categoryIds = new Map<string, string>();
  for (const c of sectionArray(snapshot.categories)) categoryIds.set(c.name, c.id);
  const channelIds = new Map<string, string>();
  const channelIdByName = new Map<string, string>();
  for (const c of sectionArray(snapshot.channels)) {
    channelIds.set(channelKey(c.name, c.parent), c.id);
    channelIdByName.set(c.name, c.id);
  }
  return { roleIds, categoryIds, channelIds, channelIdByName };
}

/** Resolve the id of the channel/category a `Container` names, or throw. */
function resolveContainerId(container: Container, r: Resolver): string {
  if (container.kind === "category") {
    const id = r.categoryIds.get(container.name);
    if (!id) throw new Error(`category "${container.name}" has no resolved id`);
    return id;
  }
  const id = r.channelIds.get(channelKey(container.name, container.parent));
  if (!id) throw new Error(`channel "${container.name}" has no resolved id`);
  return id;
}

/**
 * Execute one action against the live guild, updating the resolver with any newly
 * created id. Throws on failure (the caller turns that into the N-of-M report).
 */
async function runAction(token: string, guildId: string, action: Action, r: Resolver): Promise<void> {
  switch (action.kind) {
    case "create_role": {
      const res = await createRole(token, guildId, { name: action.role.name, ...roleSpec(action.role) });
      if (!res.success) throw new Error(res.error);
      r.roleIds.set(action.role.name, res.role.id);
      return;
    }
    case "modify_role": {
      const id = r.roleIds.get(action.role.name);
      if (!id) throw new Error(`role "${action.role.name}" has no resolved id`);
      const res = await modifyRole(token, guildId, id, roleSpec(action.role));
      if (!res.success) throw new Error(res.error);
      return;
    }
    case "create_category": {
      const created = await createChannel(token, guildId, {
        name: action.name,
        type: CHANNEL_TYPE.category,
      });
      r.categoryIds.set(action.name, created.id);
      return;
    }
    case "create_channel": {
      const spec: ChannelSpec = { name: action.name, type: action.channelType };
      if (action.parent !== null) {
        const parentId = r.categoryIds.get(action.parent);
        if (!parentId) throw new Error(`parent category "${action.parent}" has no resolved id`);
        spec.parent_id = parentId;
      }
      if (action.topic !== undefined) spec.topic = action.topic;
      if (action.slowmode !== undefined) spec.rate_limit_per_user = action.slowmode;
      const created = await createChannel(token, guildId, spec);
      r.channelIds.set(channelKey(action.name, action.parent), created.id);
      r.channelIdByName.set(action.name, created.id);
      return;
    }
    case "modify_channel": {
      const id = r.channelIds.get(channelKey(action.name, action.parent));
      if (!id) throw new Error(`channel "${action.name}" has no resolved id`);
      const spec: ChannelSpec = {};
      if (action.topic !== undefined) spec.topic = action.topic;
      if (action.slowmode !== undefined) spec.rate_limit_per_user = action.slowmode;
      await modifyChannel(token, id, spec);
      return;
    }
    case "set_forum_tags": {
      const id = r.channelIds.get(channelKey(action.name, action.parent));
      if (!id) throw new Error(`forum channel "${action.name}" has no resolved id`);
      await modifyChannel(token, id, { available_tags: action.tags });
      return;
    }
    case "set_overwrite": {
      const containerId = resolveContainerId(action.container, r);
      const roleId = r.roleIds.get(action.role);
      if (!roleId) throw new Error(`role "${action.role}" has no resolved id`);
      await setOverwrite(token, containerId, roleId, { type: 0, allow: action.allow, deny: action.deny });
      return;
    }
    case "delete_overwrite": {
      const containerId = resolveContainerId(action.container, r);
      const roleId = r.roleIds.get(action.role);
      if (!roleId) throw new Error(`role "${action.role}" has no resolved id`);
      await deleteOverwrite(token, containerId, roleId);
      return;
    }
    case "modify_guild": {
      await applyGuildChange(token, guildId, action.change, r);
      return;
    }
    case "delete_channel": {
      const id = r.channelIds.get(channelKey(action.name, action.parent));
      if (!id) throw new Error(`channel "${action.name}" has no resolved id`);
      await deleteChannel(token, id);
      return;
    }
    case "delete_category": {
      const id = r.categoryIds.get(action.name);
      if (!id) throw new Error(`category "${action.name}" has no resolved id`);
      await deleteChannel(token, id);
      return;
    }
    case "delete_role": {
      const id = r.roleIds.get(action.name);
      if (!id) throw new Error(`role "${action.name}" has no resolved id`);
      const res = await deleteRole(token, guildId, id);
      if (!res.success) throw new Error(res.error);
      return;
    }
  }
}

/** Resolve a channel name to a live id for a guild-settings pointer, or throw. */
function resolveChannelByName(name: string, r: Resolver): string {
  const id = r.channelIdByName.get(name);
  if (!id) throw new Error(`channel "${name}" has no resolved id`);
  return id;
}

/** Apply a guild-settings change (PATCH /guilds, then welcome screen if present). */
async function applyGuildChange(
  token: string,
  guildId: string,
  change: GuildChange,
  r: Resolver
): Promise<void> {
  const spec: ModifyGuildSpec = {};
  if (change.verification !== undefined) spec.verification_level = verificationLevelValue(change.verification);
  if (change.rules_channel !== undefined) spec.rules_channel_id = resolveChannelByName(change.rules_channel, r);
  if (change.updates_channel !== undefined) {
    spec.public_updates_channel_id = resolveChannelByName(change.updates_channel, r);
  }
  if (change.system_channel !== undefined) spec.system_channel_id = resolveChannelByName(change.system_channel, r);
  if (Object.keys(spec).length > 0) await modifyGuild(token, guildId, spec);

  if (change.welcome) {
    const welcome_channels: WelcomeChannel[] = change.welcome.channels.map((c) => ({
      channel_id: resolveChannelByName(c.channel, r),
      description: c.description,
      emoji_name: c.emoji ?? null,
      emoji_id: null,
    }));
    await modifyWelcomeScreen(token, guildId, {
      enabled: change.welcome.enabled,
      description: change.welcome.description,
      welcome_channels,
    });
  }
}

/**
 * Apply a plan to a live guild — but only if `execute` is true.
 *
 * With `execute: false` (the default the command layer relies on) this is a pure
 * dry run: it touches nothing and reports the plan size. With `execute: true` it
 * runs the actions in order, seeding name→id resolution from `snapshot` and
 * extending it as creates return ids. It STOPS on the first failure and reports
 * "completed N of M"; because a re-run re-snapshots and re-diffs, the completed
 * actions drop out of the next plan and the run resumes at the remainder.
 */
export async function applyPlan(
  token: string,
  guildId: string,
  plan: Plan,
  snapshot: GuildSnapshot,
  opts: { execute: boolean }
): Promise<ApplyResult> {
  const total = plan.actions.length;
  if (!opts.execute) {
    return { executed: false, total, completed: 0, ok: true };
  }

  const resolver = seedResolver(snapshot);
  let completed = 0;
  for (const action of plan.actions) {
    try {
      await runAction(token, guildId, action, resolver);
    } catch (err) {
      return {
        executed: true,
        total,
        completed,
        ok: false,
        failure: { action, error: (err as Error).message },
      };
    }
    completed += 1;
  }
  return { executed: true, total, completed, ok: true };
}

// ═══ rendering (for the command layer) ══════════════════════════════════════════

/**
 * Render a plan as human-readable lines: the ordered actions, then the
 * informational `unmanaged` and `pendingPrune` sections. Returned as an array so
 * the caller decides the sink (stdout for diff/apply).
 */
export function renderPlan(plan: Plan): string[] {
  const lines: string[] = [];
  if (plan.actions.length === 0) {
    lines.push("No changes — the guild already matches the layout.");
  } else {
    lines.push(`Plan: ${plan.actions.length} action(s), in dependency order:`);
    plan.actions.forEach((a, i) => lines.push(`  ${i + 1}. ${a.description}`));
  }
  if (plan.unmanaged.length > 0) {
    lines.push("");
    lines.push(`Unmanaged (live, absent from layout — NOT deleted; list under prune: to remove):`);
    for (const u of plan.unmanaged) {
      const where = u.kind === "channel" && u.parent ? `${u.parent}/${u.name}` : u.name;
      lines.push(`  - ${u.kind} ${where}`);
    }
  }
  if (plan.pendingPrune.length > 0) {
    lines.push("");
    lines.push(`Listed under prune: but --prune not passed (NOT deleted this run):`);
    for (const p of plan.pendingPrune) lines.push(`  - ${p.kind} ${p.name}`);
  }
  return lines;
}
