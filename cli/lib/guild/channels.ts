/**
 * Guild channel lifecycle — create / modify / delete a channel or category, plus
 * the forum-specific fields (available_tags, default reaction/sort/layout).
 *
 * This is the first mutation surface for channels: the foundation (#9) added
 * read-only `listAllChannels`; this slice adds the write side on top of the
 * shared `discordRequest` transport (which owns auth, 429 retry, and rate-limit
 * pacing).
 *
 * Security invariant (inherited from `discordRequest`): the bot token is placed
 * ONLY in the Authorization header. It never appears in a returned or thrown
 * string — every error here carries only `res.errorText`, which is the response
 * body and never echoes the token.
 *
 * Discord reference: https://discord.com/developers/docs/resources/channel
 *   (create/modify/delete channel; forum tag + default fields; a category may
 *    hold at most 50 children).
 */

import { discordRequest } from "../http";
import type { DiscordResponse } from "../http";
import { isSnowflake } from "../discord";

/** Discord channel type numbers this slice can create. */
export const CHANNEL_TYPE = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  forum: 15,
} as const;

/**
 * Discord caps a forum's `available_tags` at 20. Enforced client-side (before
 * any network call) so the caller gets a clear message instead of a 400.
 */
export const MAX_FORUM_TAGS = 20;

/** Announcement (5) and forum (15) both require the guild's COMMUNITY feature. */
function requiresCommunity(type?: number): boolean {
  return type === CHANNEL_TYPE.announcement || type === CHANNEL_TYPE.forum;
}

/**
 * A forum tag as supplied on create/modify. Discord assigns the `id`; the caller
 * provides only `name` (+ optional `moderated` / `emoji_name`). Replacing the
 * `available_tags` set is the ONLY way to edit forum tags — Discord has no
 * per-tag add/remove endpoint.
 */
export interface ForumTag {
  name: string;
  moderated?: boolean;
  emoji_name?: string;
}

/** Emoji shown by default on new forum posts (id XOR name, per Discord). */
export interface DefaultReactionEmoji {
  emoji_id?: string | null;
  emoji_name?: string | null;
}

/**
 * Fields accepted by create (POST) and modify (PATCH). Every field is optional
 * so a PATCH sends only what the caller sets — an omitted field is left
 * untouched rather than nulled.
 */
export interface ChannelSpec {
  name?: string;
  /** 0 text | 2 voice | 4 category | 5 announcement | 15 forum. */
  type?: number;
  parent_id?: string | null;
  topic?: string;
  position?: number;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  // ── forum-specific ────────────────────────────────────────────────────────
  /** Max 20 (`MAX_FORUM_TAGS`); validated before the request. */
  available_tags?: ForumTag[];
  default_reaction_emoji?: DefaultReactionEmoji;
  /** 0 latest activity | 1 creation date. */
  default_sort_order?: number;
  /** 0 not set | 1 list | 2 gallery. */
  default_forum_layout?: number;
  // Out of scope for this slice's CLI, but passed through verbatim so the future
  // layout engine can set permission overwrites at create time (sibling perms issue).
  permission_overwrites?: unknown[];
}

/** A tag as Discord returns it (carries the server-assigned `id`). */
export interface ResolvedForumTag {
  id: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

/** Narrow projection of the channel object Discord returns on create/modify/get. */
export interface GuildChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  topic?: string | null;
  position?: number;
  available_tags?: ResolvedForumTag[];
}

/** Throw a clear local error rather than interpolate a non-snowflake into a URL. */
function assertSnowflake(id: string, label: string): void {
  if (!isSnowflake(id)) {
    throw new Error(`Invalid ${label}: "${id}" is not a Discord snowflake (17–20 digits).`);
  }
}

/** Reject an over-limit forum tag set before it reaches the wire. */
function validateForumTags(tags?: ForumTag[]): void {
  if (tags && tags.length > MAX_FORUM_TAGS) {
    throw new Error(
      `Too many forum tags: ${tags.length}. Discord allows at most ${MAX_FORUM_TAGS} tags per forum channel.`
    );
  }
}

/**
 * Build the error thrown when a create/modify/delete call fails. Carries the
 * HTTP status + Discord's response body (never the token). On a 400 for an
 * announcement/forum channel, appends the COMMUNITY hint — that type needs the
 * guild's COMMUNITY feature, which is enabled via the guild-settings slice.
 */
function channelError(op: string, res: DiscordResponse, requestedType?: number): Error {
  let msg = `${op} failed (${res.status}): ${res.errorText ?? "no response body"}`;
  if (res.status === 400 && requiresCommunity(requestedType)) {
    msg +=
      "\n  Hint: announcement and forum channels require the guild to have the " +
      "COMMUNITY feature enabled (set it via the guild-settings command).";
  }
  return new Error(msg);
}

/**
 * Create a channel or category in a guild.
 * POST `/guilds/{guildId}/channels`. Returns the created channel.
 */
export async function createChannel(
  botToken: string,
  guildId: string,
  spec: ChannelSpec
): Promise<GuildChannel> {
  assertSnowflake(guildId, "guildId");
  if (typeof spec.parent_id === "string") assertSnowflake(spec.parent_id, "parent_id");
  validateForumTags(spec.available_tags);

  const res = await discordRequest<GuildChannel>(
    botToken,
    "POST",
    `/guilds/${guildId}/channels`,
    { json: spec }
  );
  if (!res.ok || !res.data) throw channelError("Create channel", res, spec.type);
  return res.data;
}

/**
 * Modify an existing channel. PATCH `/channels/{channelId}`. Same fields as
 * create; forum tag edits go through here by replacing `available_tags`.
 */
export async function modifyChannel(
  botToken: string,
  channelId: string,
  spec: ChannelSpec
): Promise<GuildChannel> {
  assertSnowflake(channelId, "channelId");
  if (typeof spec.parent_id === "string") assertSnowflake(spec.parent_id, "parent_id");
  validateForumTags(spec.available_tags);

  const res = await discordRequest<GuildChannel>(
    botToken,
    "PATCH",
    `/channels/${channelId}`,
    { json: spec }
  );
  if (!res.ok || !res.data) throw channelError("Modify channel", res, spec.type);
  return res.data;
}

/**
 * Delete a channel. DELETE `/channels/{channelId}`. Discord answers 200 (with
 * the deleted object) or 204 — both count as success.
 */
export async function deleteChannel(botToken: string, channelId: string): Promise<void> {
  assertSnowflake(channelId, "channelId");
  const res = await discordRequest(botToken, "DELETE", `/channels/${channelId}`, {
    expect: "none",
  });
  if (!res.ok) throw channelError("Delete channel", res);
}

/**
 * Fetch a single channel. GET `/channels/{channelId}`. Used to read a forum's
 * `available_tags` for `channel tags list` (`listAllChannels` omits them).
 */
export async function getChannel(botToken: string, channelId: string): Promise<GuildChannel> {
  assertSnowflake(channelId, "channelId");
  const res = await discordRequest<GuildChannel>(botToken, "GET", `/channels/${channelId}`);
  if (!res.ok || !res.data) throw channelError("Get channel", res);
  return res.data;
}
