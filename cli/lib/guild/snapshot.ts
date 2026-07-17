/**
 * Guild snapshot — read the entire live guild into one deterministic document
 * (issue #17). This is the read side the declarative apply (issue #18) diffs
 * against, and the manual verification tool for every other guild-config slice.
 *
 * COMPOSITION, NOT RE-IMPLEMENTATION: every field here comes from a read function
 * that already landed in a sibling slice —
 *   - `listRoles`           (roles slice)     → roles
 *   - `listAllChannels`     (foundation #9)   → the channel/category enumeration
 *   - `getChannel`          (channels slice)  → per-channel detail: overwrites,
 *                                               forum tags, slowmode, sort/layout
 *   - `bitsToPermissionNames` (perms slice)   → decode allow/deny + role bitmasks
 *   - `listEvents`          (events slice)    → scheduled events
 *   - `listWebhooks`        (webhooks slice)  → webhooks (token already dropped)
 *   - `getGuild` / `getWelcomeScreen` (settings slice) → guild + welcome screen
 *
 * `getChannel` (not `getOverwrites`) is the per-channel primitive: it returns the
 * full channel object, so one GET yields overwrites AND the forum/slowmode fields
 * the narrow `getOverwrites` projection omits. Its `permission_overwrites` are
 * decoded through the SAME perms-slice map (`bitsToPermissionNames`).
 *
 * DETERMINISM: the serialized body must be byte-identical run to run so apply
 * diffs are clean. Every array is sorted on a stable key, every object is built
 * with a fixed key order, permission-name arrays are sorted, and the only
 * non-deterministic value (the capture time) lives on the single header line,
 * which the determinism check strips (`tail -n +2`).
 *
 * REDACTION: no credential is ever serialized. Output is built by copying named
 * fields only — raw API objects are never spread — so a webhook token (or any
 * credential-shaped field) present on an upstream object cannot reach the YAML.
 * `serializeSnapshot` additionally asserts the rendered document is credential-free.
 *
 * SKIP-GRACEFULLY: if a section's read fails (e.g. a 403 from a missing bot
 * permission), that section renders as `unavailable(<status> <hint>)` and the
 * snapshot continues — a partial document with explicit gaps beats a crash.
 */

import YAML from "yaml";
import { listAllChannels, channelTypeName } from "../discord";
import { listRoles } from "./roles";
import { getChannel, CHANNEL_TYPE } from "./channels";
import { bitsToPermissionNames } from "./permissions";
import { listEvents, eventTypeName } from "./events";
import { listWebhooks } from "./webhooks";
import { getGuild, getWelcomeScreen, verificationLevelName } from "./settings";

// ─── output shape ─────────────────────────────────────────────────────────────

/** A resolved reference: the human name plus the id it resolves to. */
export interface NamedRef {
  name: string;
  id: string;
}

/** A section that could not be read renders as this marker string. */
export type Unavailable = string;

/** True when a section value is an `unavailable(...)` marker rather than data. */
export function isUnavailable(value: unknown): value is Unavailable {
  return typeof value === "string" && value.startsWith("unavailable(");
}

export interface SnapshotOverwrite {
  /** Role/member name (role names resolve; members keep their id). */
  target: string;
  target_id: string;
  type: "role" | "member";
  allow: string[];
  deny: string[];
}

export interface SnapshotRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  managed: boolean;
  permissions: string[];
}

export interface SnapshotCategory {
  id: string;
  name: string;
  position: number;
  overwrites: SnapshotOverwrite[] | Unavailable;
}

export interface SnapshotForumTag {
  name: string;
  moderated?: boolean;
  emoji_name?: string | null;
}

export interface SnapshotForum {
  tags: SnapshotForumTag[];
  default_sort_order: number | null;
  default_forum_layout: number | null;
}

export interface SnapshotChannel {
  id: string;
  name: string;
  type: string;
  parent: string | null;
  topic: string | null;
  position: number;
  slowmode: number;
  overwrites: SnapshotOverwrite[] | Unavailable;
  forum?: SnapshotForum;
}

export interface SnapshotEvent {
  id: string;
  name: string;
  start: string;
  end: string | null;
  entity_type: string;
  location?: string;
  channel?: NamedRef;
}

export interface SnapshotWebhook {
  id: string;
  name: string | null;
  channel: NamedRef;
}

export interface SnapshotWelcomeChannel {
  channel: NamedRef;
  description: string;
  emoji?: string;
}

export interface SnapshotWelcomeScreen {
  enabled: boolean;
  description: string | null;
  channels: SnapshotWelcomeChannel[];
}

export interface SnapshotGuildMeta {
  id: string;
  name: string;
  features: string[];
  verification_level: string;
  rules_channel: NamedRef | null;
  public_updates_channel: NamedRef | null;
  system_channel: NamedRef | null;
  premium_tier: number;
}

/** The whole live guild, as one deterministic, human-readable document. */
export interface GuildSnapshot {
  guild: SnapshotGuildMeta;
  roles: SnapshotRole[] | Unavailable;
  categories: SnapshotCategory[] | Unavailable;
  channels: SnapshotChannel[] | Unavailable;
  events: SnapshotEvent[] | Unavailable;
  webhooks: SnapshotWebhook[] | Unavailable;
  welcome_screen: SnapshotWelcomeScreen | Unavailable;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Runtime-only fields `getChannel` returns but its narrow type omits. */
interface RawChannelExtras {
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
  rate_limit_per_user?: number;
  default_sort_order?: number | null;
  default_forum_layout?: number | null;
}

/** Extract an HTTP-ish status code from an error/message, if one is present. */
function statusFromError(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/\b([45]\d\d)\b/);
  return m ? Number(m[1]) : undefined;
}

/** Build an `unavailable(...)` marker, prefixing the status code when known. */
function unavailable(err: unknown, hint: string): Unavailable {
  const status = statusFromError(err);
  return status !== undefined ? `unavailable(${status} ${hint})` : `unavailable(${hint})`;
}

/** Decode a Discord decimal-string bitmask to a sorted permission-name array. */
function decodePermissions(wire: string): string[] {
  let bits: bigint;
  try {
    bits = BigInt(wire || "0");
  } catch {
    bits = 0n;
  }
  return bitsToPermissionNames(bits).sort();
}

/** Resolve an optional channel id to a `{ name, id }` ref, or null. */
function channelRef(id: string | null | undefined, names: Map<string, string>): NamedRef | null {
  if (!id) return null;
  return { name: names.get(id) ?? id, id };
}

/** Project a raw channel's `permission_overwrites` to sorted, name-resolved entries. */
function projectOverwrites(
  raw: RawChannelExtras["permission_overwrites"],
  roleNames: Map<string, string>
): SnapshotOverwrite[] {
  return (raw ?? [])
    .map((o) => {
      const type: "role" | "member" = o.type === 1 ? "member" : "role";
      const target = type === "role" ? roleNames.get(o.id) ?? o.id : o.id;
      return {
        target,
        target_id: o.id,
        type,
        allow: decodePermissions(o.allow),
        deny: decodePermissions(o.deny),
      };
    })
    .sort((a, b) => a.target_id.localeCompare(b.target_id));
}

/** Stable channel ordering: Discord position, then name, then id. */
function byPositionThenName(
  a: { position?: number; name: string; id: string },
  b: { position?: number; name: string; id: string }
): number {
  return (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

// ─── snapshot ───────────────────────────────────────────────────────────────

/**
 * Read the entire live guild into a `GuildSnapshot`. Composes the sibling-slice
 * read functions; each section degrades to an `unavailable(...)` marker rather
 * than throwing when its read fails, so the caller always gets a document.
 *
 * The `guild` anchor (name, features, channel pointers) is the one hard
 * dependency: if it cannot be read the guild is unreachable and the error
 * propagates.
 */
export async function snapshotGuild(token: string, guildId: string): Promise<GuildSnapshot> {
  // Anchor + role table first — both feed name resolution for every other section.
  const guild = await getGuild(token, guildId);

  const rolesResult = await listRoles(token, guildId);
  const roleNames = new Map<string, string>();
  if (rolesResult.success) {
    for (const r of rolesResult.roles) roleNames.set(r.id, r.name);
  }

  // Channel enumeration (for name resolution + the categories/channels sections).
  let channelList: Awaited<ReturnType<typeof listAllChannels>> | null = null;
  let channelsError: unknown = null;
  try {
    channelList = await listAllChannels(token, guildId);
  } catch (err) {
    channelsError = err;
  }
  const channelNames = new Map<string, string>();
  if (channelList) {
    for (const c of channelList) channelNames.set(c.id, c.name);
  }

  // ── roles ─────────────────────────────────────────────────────────────────
  const roles: SnapshotRole[] | Unavailable = rolesResult.success
    ? rolesResult.roles.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        position: r.position,
        managed: r.managed,
        permissions: decodePermissions(r.permissions),
      }))
    : unavailable(rolesResult.error, "missing MANAGE_ROLES");

  // ── categories + channels ───────────────────────────────────────────────────
  let categories: SnapshotCategory[] | Unavailable;
  let channels: SnapshotChannel[] | Unavailable;
  if (!channelList) {
    const marker = unavailable(channelsError, "missing VIEW_CHANNEL");
    categories = marker;
    channels = marker;
  } else {
    const cats: SnapshotCategory[] = [];
    const chans: SnapshotChannel[] = [];
    for (const c of [...channelList].sort(byPositionThenName)) {
      // One GET per channel: overwrites + forum tags + slowmode + sort/layout.
      let detail: (Awaited<ReturnType<typeof getChannel>> & RawChannelExtras) | null = null;
      let detailError: unknown = null;
      try {
        detail = (await getChannel(token, c.id)) as Awaited<ReturnType<typeof getChannel>> &
          RawChannelExtras;
      } catch (err) {
        detailError = err;
      }
      const overwrites: SnapshotOverwrite[] | Unavailable = detail
        ? projectOverwrites(detail.permission_overwrites, roleNames)
        : unavailable(detailError, "missing VIEW_CHANNEL");

      if (c.type === CHANNEL_TYPE.category) {
        cats.push({ id: c.id, name: c.name, position: c.position ?? 0, overwrites });
        continue;
      }

      const channel: SnapshotChannel = {
        id: c.id,
        name: c.name,
        type: channelTypeName(c.type),
        parent: channelRef(c.parentId, channelNames)?.name ?? null,
        topic: c.topic ?? null,
        position: c.position ?? 0,
        slowmode: detail?.rate_limit_per_user ?? 0,
        overwrites,
      };
      if (c.type === CHANNEL_TYPE.forum && detail) {
        channel.forum = {
          tags: (detail.available_tags ?? []).map((t) => ({
            name: t.name,
            moderated: t.moderated,
            emoji_name: t.emoji_name ?? null,
          })),
          default_sort_order: detail.default_sort_order ?? null,
          default_forum_layout: detail.default_forum_layout ?? null,
        };
      }
      chans.push(channel);
    }
    categories = cats;
    channels = chans;
  }

  // ── events ──────────────────────────────────────────────────────────────────
  let events: SnapshotEvent[] | Unavailable;
  try {
    const list = await listEvents(token, guildId);
    events = [...list]
      .sort(
        (a, b) => a.scheduled_start_time.localeCompare(b.scheduled_start_time) || a.id.localeCompare(b.id)
      )
      .map((e) => {
        const out: SnapshotEvent = {
          id: e.id,
          name: e.name,
          start: e.scheduled_start_time,
          end: e.scheduled_end_time ?? null,
          entity_type: eventTypeName(e.entity_type),
        };
        if (e.entity_type === 3) {
          out.location = e.entity_metadata?.location ?? "";
        } else {
          const ref = channelRef(e.channel_id, channelNames);
          if (ref) out.channel = ref;
        }
        return out;
      });
  } catch (err) {
    events = unavailable(err, "missing MANAGE_EVENTS");
  }

  // ── webhooks (token NEVER serialized — `listWebhooks` already drops it) ───────
  const webhooksResult = await listWebhooks(token, guildId);
  const webhooks: SnapshotWebhook[] | Unavailable = webhooksResult.success
    ? (webhooksResult.webhooks ?? [])
        .map((w) => ({
          id: w.id,
          name: w.name,
          channel: channelRef(w.channelId, channelNames) ?? { name: w.channelId, id: w.channelId },
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : unavailable(webhooksResult.error, "missing MANAGE_WEBHOOKS");

  // ── welcome screen ────────────────────────────────────────────────────────
  let welcome_screen: SnapshotWelcomeScreen | Unavailable;
  try {
    const ws = await getWelcomeScreen(token, guildId);
    welcome_screen = {
      enabled: ws.enabled ?? false,
      description: ws.description ?? null,
      channels: [...ws.welcome_channels]
        .sort((a, b) => a.channel_id.localeCompare(b.channel_id))
        .map((wc) => {
          const out: SnapshotWelcomeChannel = {
            channel: channelRef(wc.channel_id, channelNames) ?? {
              name: wc.channel_id,
              id: wc.channel_id,
            },
            description: wc.description,
          };
          const emoji = wc.emoji_name ?? wc.emoji_id ?? undefined;
          if (emoji) out.emoji = emoji;
          return out;
        }),
    };
  } catch (err) {
    welcome_screen = unavailable(err, "missing MANAGE_GUILD or not COMMUNITY");
  }

  // ── guild anchor ──────────────────────────────────────────────────────────
  const guildMeta: SnapshotGuildMeta = {
    id: guild.id,
    name: guild.name,
    features: [...guild.features].sort(),
    verification_level: verificationLevelName(guild.verification_level),
    rules_channel: channelRef(guild.rules_channel_id, channelNames),
    public_updates_channel: channelRef(guild.public_updates_channel_id, channelNames),
    system_channel: channelRef(guild.system_channel_id, channelNames),
    premium_tier: guild.premium_tier,
  };

  return {
    guild: guildMeta,
    roles,
    categories,
    channels,
    events,
    webhooks,
    welcome_screen,
  };
}

// ─── serialization ────────────────────────────────────────────────────────────

/** Section keys whose value may be an `unavailable(...)` marker. */
const SECTION_KEYS: Array<keyof GuildSnapshot> = [
  "roles",
  "categories",
  "channels",
  "events",
  "webhooks",
  "welcome_screen",
];

/**
 * The sections that could not be read, as `<section>: <marker>` pairs — the
 * command turns these into stderr warnings while still writing the document.
 */
export function unavailableSections(snapshot: GuildSnapshot): Array<{ section: string; marker: string }> {
  const out: Array<{ section: string; marker: string }> = [];
  for (const key of SECTION_KEYS) {
    const value = snapshot[key];
    if (isUnavailable(value)) out.push({ section: key, marker: value });
  }
  return out;
}

/** Key fragments that identify a credential-shaped field — never serialized. */
const CREDENTIAL_KEY = /token|secret|password|authorization|api[_-]?key|client[_-]?secret/i;

/**
 * Deterministic YAML body (no header). Fixed key order + pre-sorted arrays make
 * the output byte-identical run to run. Before returning, it asserts the rendered
 * document carries no credential-shaped key — the test-enforced redaction rule.
 */
export function serializeSnapshot(snapshot: GuildSnapshot): string {
  assertNoCredentials(snapshot);
  // lineWidth: 0 disables Discord-topic line wrapping, which would otherwise make
  // output depend on string length in a way that muddies diffs.
  return YAML.stringify(snapshot, { lineWidth: 0 });
}

/** Walk the object graph; throw if any key looks like a credential. */
function assertNoCredentials(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCredentials(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) {
        throw new Error(`Refusing to serialize credential-shaped field "${path}${path ? "." : ""}${key}".`);
      }
      assertNoCredentials(v, `${path}${path ? "." : ""}${key}`);
    }
  }
}

/** The single header comment line: guild id + capture time (ISO8601). */
export function snapshotHeader(guildId: string, at: Date = new Date()): string {
  return `# metafactory guild snapshot — guild ${guildId} @ ${at.toISOString()}`;
}

/** Full document: one-line header + deterministic body. */
export function renderSnapshot(snapshot: GuildSnapshot, guildId: string, at: Date = new Date()): string {
  return `${snapshotHeader(guildId, at)}\n${serializeSnapshot(snapshot)}`;
}
