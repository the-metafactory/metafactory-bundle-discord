/**
 * Standalone guild thread management — create (public/private), member
 * add/remove, archive toggle, and archived-thread listing.
 *
 * This is the write-and-lifecycle half of thread support that the read-only
 * `listThreads` / `createThreadFromMessage` in `cli/lib/discord.ts` don't cover.
 * A common pattern is a PRIVATE thread that archives (not deletes) when done:
 * create without a starter message, add members, archive when finished, and
 * later list what was archived.
 *
 * Transport: every call goes through the shared `discordRequest` (cli/lib/http),
 * which owns the bot Authorization header, 429 retry, and rate-limit pacing. The
 * bot token is placed ONLY in that outgoing header — it is never interpolated
 * into any returned or thrown string here (mirrors `mapRoleError`,
 * cli/lib/discord.ts). `errorText` from the transport carries only the response
 * body, which never echoes the token.
 *
 * Out of scope (issue #13): creating threads from an existing message (exists as
 * `createThreadFromMessage` / `post --create-thread`). Forum posts — a forum post
 * IS a thread with a mandatory starter message, so it goes through the
 * with-message path, not this one; defer until a forum-post engine needs it.
 */

import { discordRequest } from "../http";

/** Auto-archive window in minutes — Discord's only accepted values. */
export type AutoArchiveMinutes = 60 | 1440 | 4320 | 10080;

/** Thread channel type: 11 = public thread, 12 = private thread (Discord). */
export type ThreadType = 11 | 12;

export interface CreateThreadOptions {
  name: string;
  /** 11 = public, 12 = private. Private threads have no server-boost gate — they
   *  have been free for all servers since Discord's Nov 2022 change. */
  type: ThreadType;
  autoArchiveMinutes?: AutoArchiveMinutes;
  /** Private-thread only: whether non-moderators can add others. Ignored by
   *  Discord for public threads. */
  invitable?: boolean;
}

export interface CreateThreadResult {
  success: boolean;
  threadId?: string;
  error?: string;
}

/** Shared shape for the 204-or-error operations (members, archive). */
export interface ThreadOpResult {
  success: boolean;
  error?: string;
}

export interface ArchivedThread {
  id: string;
  name: string;
  archived: boolean;
}

export interface ArchivedThreadsPage {
  threads: ArchivedThread[];
  /** True when Discord has more archived threads beyond this first page; the
   *  next page is fetched with `before` set to the oldest thread's archive
   *  timestamp (pagination itself is deferred until a caller needs it). */
  hasMore: boolean;
}

/**
 * Map a non-success response from a thread member/lifecycle call to a
 * `ThreadOpResult`. The bot token is NEVER passed here and cannot appear in the
 * output — `body` is the response body only.
 *
 * 403 on member add/remove means the bot lacks MANAGE_THREADS (required to
 * manage the membership of a thread it did not itself create).
 */
function mapThreadOpError(status: number, body: string): ThreadOpResult {
  if (status === 403) {
    return {
      success: false,
      error:
        `Bot lacks Manage Threads permission (required to manage a thread it did not create). ` +
        `Grant the bot Manage Threads in the channel/guild.`,
    };
  }
  if (status === 404) {
    return { success: false, error: `thread or member not found` };
  }
  return { success: false, error: `${status}: ${body}` };
}

/**
 * Create a thread WITHOUT a starter message.
 * Discord: POST /channels/{channelId}/threads
 *
 * `type` selects public (11) or private (12). Name is capped at 100 chars to
 * match Discord's limit (same cap as `createThreadFromMessage`,
 * cli/lib/discord.ts). `auto_archive_duration` and `invitable` are sent only
 * when supplied so Discord applies its own defaults otherwise.
 */
export async function createThread(
  token: string,
  channelId: string,
  opts: CreateThreadOptions
): Promise<CreateThreadResult> {
  const body: {
    name: string;
    type: ThreadType;
    auto_archive_duration?: AutoArchiveMinutes;
    invitable?: boolean;
  } = {
    // Discord caps thread names at 100 characters.
    name: opts.name.slice(0, 100),
    type: opts.type,
  };
  if (opts.autoArchiveMinutes !== undefined) body.auto_archive_duration = opts.autoArchiveMinutes;
  if (opts.invitable !== undefined) body.invitable = opts.invitable;

  const res = await discordRequest<{ id: string }>(
    token,
    "POST",
    `/channels/${channelId}/threads`,
    { json: body }
  );

  if (!res.ok) {
    return { success: false, error: `${res.status}: ${res.errorText ?? ""}` };
  }
  return { success: true, threadId: res.data?.id };
}

/**
 * Add a member to a thread.
 * Discord: PUT /channels/{threadId}/thread-members/{userId} → 204.
 */
export async function addThreadMember(
  token: string,
  threadId: string,
  userId: string
): Promise<ThreadOpResult> {
  const res = await discordRequest(
    token,
    "PUT",
    `/channels/${threadId}/thread-members/${userId}`,
    { expect: "none" }
  );
  if (res.ok) return { success: true };
  return mapThreadOpError(res.status, res.errorText ?? "");
}

/**
 * Remove a member from a thread.
 * Discord: DELETE /channels/{threadId}/thread-members/{userId} → 204.
 *
 * Requires MANAGE_THREADS unless the caller is the thread creator (403 maps to
 * the Manage-Threads message).
 */
export async function removeThreadMember(
  token: string,
  threadId: string,
  userId: string
): Promise<ThreadOpResult> {
  const res = await discordRequest(
    token,
    "DELETE",
    `/channels/${threadId}/thread-members/${userId}`,
    { expect: "none" }
  );
  if (res.ok) return { success: true };
  return mapThreadOpError(res.status, res.errorText ?? "");
}

/**
 * Archive or unarchive a thread.
 * Discord: PATCH /channels/{threadId} with body `{ archived }`.
 *
 * Archiving closes a thread while keeping it — the thread is retained
 * (searchable, listable via `listArchivedThreads`), not deleted.
 */
export async function setArchived(
  token: string,
  threadId: string,
  archived: boolean
): Promise<ThreadOpResult> {
  const res = await discordRequest(
    token,
    "PATCH",
    `/channels/${threadId}`,
    { json: { archived } }
  );
  if (res.ok) return { success: true };
  return mapThreadOpError(res.status, res.errorText ?? "");
}

/** Discord archived-threads list response (narrowest projection read here). */
interface DiscordApiArchivedThreadsResponse {
  threads?: Array<{
    id: string;
    name: string;
    thread_metadata?: { archived?: boolean };
  }>;
  has_more?: boolean;
}

/**
 * List archived threads in a channel (first page only).
 * Discord: GET /channels/{channelId}/threads/archived/public  (public threads)
 *          GET /channels/{channelId}/threads/archived/private (private threads)
 *
 * The response is paginated by `before` (an ISO archive timestamp). This returns
 * the first page and exposes Discord's `has_more` as `hasMore` so a caller can
 * decide whether to page further. Listing PRIVATE archived threads requires the
 * bot to have MANAGE_THREADS.
 */
export async function listArchivedThreads(
  token: string,
  channelId: string,
  opts: { private?: boolean } = {}
): Promise<ArchivedThreadsPage> {
  const scope = opts.private ? "private" : "public";
  const res = await discordRequest<DiscordApiArchivedThreadsResponse>(
    token,
    "GET",
    `/channels/${channelId}/threads/archived/${scope}`
  );

  if (!res.ok) {
    throw new Error(`Failed to list archived threads: ${res.status} ${res.errorText ?? ""}`);
  }

  const data = res.data ?? {};
  return {
    threads: (data.threads ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      archived: t.thread_metadata?.archived ?? true,
    })),
    hasMore: data.has_more ?? false,
  };
}
