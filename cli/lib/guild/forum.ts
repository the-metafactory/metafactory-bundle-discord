/**
 * Forum posts — create a post (thread + mandatory starter message) in a forum
 * channel, resolve tag names to ids, list a forum's posts, and RETAG an
 * existing post (the quest-board state machine: looking-for-party →
 * in-progress → done).
 *
 * A forum post IS a thread: Discord's `POST /channels/{forumId}/threads` on a
 * forum channel takes a `message` object (the starter message) alongside the
 * thread `name`, plus optional `applied_tags` (ids from the forum's
 * `available_tags`). This is the with-message path that
 * `cli/lib/guild/threads.ts` explicitly deferred ("defer until a forum-post
 * engine needs it") — the quest-board workflows are that engine.
 *
 * Because posts are threads, everything downstream already works: the created
 * id is a valid target for `discord post --thread` and `discord read --thread`.
 *
 * Transport: every call goes through the shared `discordRequest` (cli/lib/http),
 * which owns the bot Authorization header, 429 retry, and rate-limit pacing. The
 * bot token is placed ONLY in that outgoing header — it is never interpolated
 * into any returned or thrown string here (mirrors `mapRoleError`,
 * cli/lib/discord.ts). `errorText` from the transport carries only the response
 * body, which never echoes the token.
 *
 * Discord reference: https://discord.com/developers/docs/resources/channel
 *   (start thread in forum channel; a post carries at most 5 applied tags).
 */

import { discordRequest } from "../http";
import { isSnowflake } from "../discord";
import type { ResolvedForumTag } from "./channels";
import type { ThreadOpResult } from "./threads";

/**
 * Discord caps a forum post's `applied_tags` at 5. Enforced client-side (before
 * any network call) so the caller gets a clear message instead of a 400.
 */
export const MAX_APPLIED_TAGS = 5;

export interface CreateForumPostOptions {
  /** Post title (the thread name). Capped at 100 chars, Discord's limit. */
  title: string;
  /** Starter-message text. Discord REQUIRES a non-empty starter message. */
  content: string;
  /** Tag ids from the forum's `available_tags` (max 5, `MAX_APPLIED_TAGS`). */
  appliedTagIds?: string[];
}

export interface CreateForumPostResult {
  success: boolean;
  threadId?: string;
  error?: string;
}

/** A forum post as listed — a thread under the forum channel. */
export interface ForumPost {
  id: string;
  name: string;
  /** Ids from the forum's `available_tags`; map to names via the channel. */
  appliedTagIds: string[];
  archived: boolean;
  messageCount: number;
}

/**
 * Resolve forum tag NAMES to ids against a forum's `available_tags`,
 * case-insensitively. Pure — no I/O. Empty entries (double comma, trailing
 * comma) are skipped. Any unknown name throws an error listing the offending
 * names AND the full set of valid tags (the `permissionNamesToBits` pattern,
 * cli/lib/guild/permissions.ts), so the caller can fix it without another call.
 */
export function resolveForumTagIds(
  availableTags: ResolvedForumTag[],
  names: string[]
): string[] {
  const byName = new Map(availableTags.map((t) => [t.name.toLowerCase(), t.id]));
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "") continue;
    const id = byName.get(name.toLowerCase());
    if (id === undefined) {
      unknown.push(name);
    } else {
      ids.push(id);
    }
  }
  if (unknown.length > 0) {
    const valid =
      availableTags.length > 0
        ? availableTags.map((t) => t.name).join(", ")
        : "(none — the forum has no tags; set some with: discord channel tags set)";
    throw new Error(`Unknown forum tag(s): ${unknown.join(", ")}. Valid tags: ${valid}`);
  }
  return ids;
}

/**
 * Create a forum post: a thread WITH a starter message.
 * Discord: POST /channels/{forumChannelId}/threads with
 * `{ name, message: { content }, applied_tags }`.
 *
 * `applied_tags` is sent only when at least one tag id is supplied, so an
 * untagged post carries no empty array on the wire. Tag count is validated
 * against `MAX_APPLIED_TAGS` before the request.
 */
export async function createForumPost(
  token: string,
  forumChannelId: string,
  opts: CreateForumPostOptions
): Promise<CreateForumPostResult> {
  if (opts.appliedTagIds && opts.appliedTagIds.length > MAX_APPLIED_TAGS) {
    return {
      success: false,
      error:
        `Too many tags: ${opts.appliedTagIds.length}. ` +
        `Discord allows at most ${MAX_APPLIED_TAGS} tags per forum post.`,
    };
  }

  const body: {
    name: string;
    message: { content: string };
    applied_tags?: string[];
  } = {
    // Discord caps thread names at 100 characters (same cap as createThread).
    name: opts.title.slice(0, 100),
    message: { content: opts.content },
  };
  if (opts.appliedTagIds !== undefined && opts.appliedTagIds.length > 0) {
    body.applied_tags = opts.appliedTagIds;
  }

  const res = await discordRequest<{ id: string }>(
    token,
    "POST",
    `/channels/${forumChannelId}/threads`,
    { json: body }
  );

  if (!res.ok) {
    return { success: false, error: `${res.status}: ${res.errorText ?? ""}` };
  }
  return { success: true, threadId: res.data?.id };
}

/** Discord thread projection shared by the active + archived list responses. */
interface DiscordApiForumThread {
  id: string;
  name: string;
  parent_id?: string | null;
  applied_tags?: string[];
  message_count?: number;
  thread_metadata?: { archived?: boolean };
}

interface DiscordApiThreadListResponse {
  threads?: DiscordApiForumThread[];
}

function toForumPost(t: DiscordApiForumThread): ForumPost {
  return {
    id: t.id,
    name: t.name,
    appliedTagIds: t.applied_tags ?? [],
    archived: t.thread_metadata?.archived ?? false,
    messageCount: t.message_count ?? 0,
  };
}

/**
 * List a forum's posts: the guild's active threads filtered to this forum as
 * parent, plus (by default) the forum's archived PUBLIC threads — one extra GET,
 * so a closed quest is still readable, not just an open one.
 *
 * Discord: GET /guilds/{guildId}/threads/active   (all active guild threads)
 *          GET /channels/{forumId}/threads/archived/public (first page)
 *
 * Active posts sort first, then archived; ties keep Discord's order. Archived
 * pagination is first-page-only (the `listArchivedThreads` precedent —
 * deferred until a caller needs more).
 */
export async function listForumPosts(
  token: string,
  guildId: string,
  forumChannelId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<ForumPost[]> {
  const activeRes = await discordRequest<DiscordApiThreadListResponse>(
    token,
    "GET",
    `/guilds/${guildId}/threads/active`
  );
  if (!activeRes.ok) {
    throw new Error(
      `Failed to list active threads: ${activeRes.status} ${activeRes.errorText ?? ""}`
    );
  }
  const active = (activeRes.data?.threads ?? [])
    .filter((t) => t.parent_id === forumChannelId)
    .map(toForumPost);

  if (opts.includeArchived === false) return active;

  const archivedRes = await discordRequest<DiscordApiThreadListResponse>(
    token,
    "GET",
    `/channels/${forumChannelId}/threads/archived/public`
  );
  if (!archivedRes.ok) {
    throw new Error(
      `Failed to list archived posts: ${archivedRes.status} ${archivedRes.errorText ?? ""}`
    );
  }
  // Everything under /channels/{forumId}/... already belongs to this forum; the
  // seen-set guards against a thread appearing in both lists mid-transition.
  const seen = new Set(active.map((p) => p.id));
  const archived = (archivedRes.data?.threads ?? [])
    .filter((t) => !seen.has(t.id))
    .map((t) => ({ ...toForumPost(t), archived: true }));

  return [...active, ...archived];
}

// ─── retag (the tag state machine) ──────────────────────────────────────────

/** A forum post resolved for retagging: identity, parent forum, current tags. */
export interface ForumThreadInfo {
  id: string;
  name: string;
  /** The parent forum channel id; null when Discord returns none (not a thread). */
  parentId: string | null;
  appliedTagIds: string[];
}

/** The raw `--add/--remove/--set` flags as the CLI receives them. */
export interface RetagFlags {
  add?: string;
  remove?: string;
  set?: string;
}

/**
 * Validate the retag flag COMBINATION before any network call: `--set` replaces
 * the whole list so it is mutually exclusive with `--add`/`--remove`, and at
 * least one flag is required. Pure — throws on an invalid combination.
 */
export function assertRetagFlags(flags: RetagFlags): void {
  const incremental = flags.add !== undefined || flags.remove !== undefined;
  if (flags.set !== undefined && incremental) {
    throw new Error("--set replaces the full tag list; it cannot be combined with --add/--remove.");
  }
  if (flags.set === undefined && !incremental) {
    throw new Error("Nothing to change — pass at least one of --add, --remove, or --set.");
  }
}

/**
 * Compute the post's next `applied_tags` id list. Pure — no I/O.
 *
 *   - `setIds` replaces the full list (deduped, order preserved).
 *   - Otherwise: current minus `removeIds`, then `addIds` appended (an id
 *     already present is not duplicated; removing an absent id is a no-op).
 *
 * Throws when the result exceeds `MAX_APPLIED_TAGS`, so the caller fails
 * locally instead of collecting a 400. Flag mutual exclusion is the caller's
 * concern (`assertRetagFlags`) — this only does the math.
 */
export function computeRetaggedTagIds(
  currentIds: string[],
  changes: { addIds?: string[]; removeIds?: string[]; setIds?: string[] }
): string[] {
  let next: string[];
  if (changes.setIds !== undefined) {
    next = [...new Set(changes.setIds)];
  } else {
    const remove = new Set(changes.removeIds ?? []);
    next = currentIds.filter((id) => !remove.has(id));
    for (const id of changes.addIds ?? []) {
      if (!next.includes(id)) next.push(id);
    }
  }
  if (next.length > MAX_APPLIED_TAGS) {
    throw new Error(
      `Too many tags: ${next.length}. Discord allows at most ${MAX_APPLIED_TAGS} tags per forum post.`
    );
  }
  return next;
}

/**
 * Resolve `--thread` (snowflake id OR name) to a forum post.
 *
 * Id path: GET /channels/{id} — works for active AND archived posts.
 * Name path: the guild's ACTIVE threads (GET /guilds/{guildId}/threads/active),
 * matched case-insensitively. An archived post must be retagged by id (there is
 * no guild-wide archived listing); the not-found error says exactly that. An
 * ambiguous name errors listing the matching ids rather than guessing.
 */
export async function resolveForumThread(
  token: string,
  guildId: string,
  threadRef: string
): Promise<ForumThreadInfo> {
  if (isSnowflake(threadRef)) {
    const res = await discordRequest<DiscordApiForumThread>(
      token,
      "GET",
      `/channels/${threadRef}`
    );
    if (!res.ok || !res.data) {
      throw new Error(`Failed to fetch thread ${threadRef}: ${res.status} ${res.errorText ?? ""}`);
    }
    const t = res.data;
    return {
      id: t.id,
      name: t.name,
      parentId: t.parent_id ?? null,
      appliedTagIds: t.applied_tags ?? [],
    };
  }

  const res = await discordRequest<DiscordApiThreadListResponse>(
    token,
    "GET",
    `/guilds/${guildId}/threads/active`
  );
  if (!res.ok) {
    throw new Error(`Failed to list active threads: ${res.status} ${res.errorText ?? ""}`);
  }
  const wanted = threadRef.toLowerCase();
  const matches = (res.data?.threads ?? []).filter((t) => t.name.toLowerCase() === wanted);
  if (matches.length === 0) {
    throw new Error(
      `Thread "${threadRef}" not found among the guild's active threads. ` +
        `Archived posts must be retagged by id — find it with: discord forum posts -c <forum-channel>`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Thread name "${threadRef}" is ambiguous — ${matches.length} active threads match ` +
        `(ids: ${matches.map((t) => t.id).join(", ")}). Use the id instead.`
    );
  }
  const t = matches[0]!;
  return {
    id: t.id,
    name: t.name,
    parentId: t.parent_id ?? null,
    appliedTagIds: t.applied_tags ?? [],
  };
}

/**
 * Replace a forum post's applied tags.
 * Discord: PATCH /channels/{threadId} with body `{ applied_tags }`.
 *
 * Tag count is validated against `MAX_APPLIED_TAGS` before the request. A 403
 * maps to the Manage-Threads guidance (Discord enforces MANAGE_THREADS for
 * `[moderated]` tags and for retagging a post the bot did not create) — the
 * check is NOT pre-blocked client-side; Discord stays the authority.
 */
export async function setAppliedTags(
  token: string,
  threadId: string,
  tagIds: string[]
): Promise<ThreadOpResult> {
  if (tagIds.length > MAX_APPLIED_TAGS) {
    return {
      success: false,
      error:
        `Too many tags: ${tagIds.length}. ` +
        `Discord allows at most ${MAX_APPLIED_TAGS} tags per forum post.`,
    };
  }

  const res = await discordRequest(token, "PATCH", `/channels/${threadId}`, {
    json: { applied_tags: tagIds },
  });
  if (res.ok) return { success: true };
  if (res.status === 403) {
    return {
      success: false,
      error:
        `Bot lacks Manage Threads permission (required for [moderated] tags and for ` +
        `retagging a post it did not create). Grant the bot Manage Threads in the channel/guild.`,
    };
  }
  if (res.status === 404) {
    return { success: false, error: "thread not found" };
  }
  return { success: false, error: `${res.status}: ${res.errorText ?? ""}` };
}
