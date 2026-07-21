/**
 * `discord forum post|tags|posts` — board-native forum workflows: create a
 * forum post (thread + starter message), list a forum's tags, and list its
 * posts with applied tag names.
 *
 * This closes the documented gap that kept quest boards hand-posted: forum
 * TAGS were already manageable (`channel tags set|list`) but there was no CLI
 * verb to create or list forum POSTS. A forum post IS a thread, so follow-ups
 * need no new verbs — `discord post --thread <id>` and `discord read --thread
 * <id>` work on the ids this command prints.
 *
 * Channel resolution uses `resolveChannelIdByName` with the forum type filter
 * (the `perms.ts` precedent for picking the right resolver), then verifies the
 * fetched channel really is a forum — a raw snowflake passes the resolver
 * unchecked, so the type guard lives on the fetched channel. Tags are given by
 * NAME and resolved case-insensitively against the forum's `available_tags`;
 * an unknown tag errors listing the valid set (the permissions-map pattern).
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { channelTypeName } from "../lib/discord";
import { getChannel, CHANNEL_TYPE, type GuildChannel } from "../lib/guild/channels";
import {
  createForumPost,
  listForumPosts,
  resolveForumTagIds,
  MAX_APPLIED_TAGS,
} from "../lib/guild/forum";
import { resolveContextOrExit } from "./shared";
import { resolveChannelIdByName } from "./channel";

interface PostOptions extends ServerContextOptions {
  channel: string;
  title: string;
  tags?: string;
}

interface TagsOptions extends ServerContextOptions {
  channel: string;
}

interface PostsOptions extends ServerContextOptions {
  channel: string;
  tag?: string;
}

/** Resolve the {botToken, guildId} pair or exit non-zero with a clear message. */
function requireTokenAndGuild(opts: ServerContextOptions): { botToken: string; guildId: string } {
  const config = loadConfig();
  const ctx = resolveContextOrExit(config, opts);
  if (!ctx.botToken) {
    console.error("Bot token required. Run: discord config set botToken <token>");
    process.exit(1);
  }
  if (!ctx.guildId) {
    console.error("Guild ID required. Run: discord config set guildId <id> OR use --guild/--server");
    process.exit(1);
  }
  return { botToken: ctx.botToken, guildId: ctx.guildId };
}

/**
 * Resolve `--channel` to a FORUM channel and fetch it (for `available_tags`),
 * or exit non-zero. The resolver's type filter handles name lookups; the
 * post-fetch type check catches a raw snowflake that names a non-forum channel.
 */
async function resolveForumChannelOrExit(
  botToken: string,
  guildId: string,
  channel: string
): Promise<GuildChannel> {
  try {
    const channelId = await resolveChannelIdByName(
      botToken,
      guildId,
      channel,
      "Forum channel",
      CHANNEL_TYPE.forum
    );
    const ch = await getChannel(botToken, channelId);
    if (ch.type !== CHANNEL_TYPE.forum) {
      throw new Error(
        `#${ch.name} (${ch.id}) is a ${channelTypeName(ch.type)} channel, not a forum. ` +
          `Forum posts need a forum channel — check: discord channels --all`
      );
    }
    return ch;
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

export function registerForum(program: Command): void {
  const forumCmd = program
    .command("forum")
    .description("Create and list forum posts, and list a forum's tags");

  // ── post ──────────────────────────────────────────────────────────────────
  forumCmd
    .command("post")
    .description(
      "Create a forum post (thread + starter message) and print its id + URL\n" +
        "\n" +
        "  A forum post IS a thread: follow up on the printed id with\n" +
        "  `discord post --thread <id>` and `discord read --thread <id>`.\n" +
        `  Tags are names from the forum's tag set (max ${MAX_APPLIED_TAGS} per post);\n` +
        "  see them with: discord forum tags -c <forum-channel>"
    )
    .argument("<message...>", "Starter-message text (required — a forum post cannot be empty)")
    .requiredOption("-c, --channel <id-or-name>", "Forum channel (snowflake id or name)")
    .requiredOption("--title <name>", "Post title (the thread name, capped at 100 chars)")
    .option("--tags <names>", "Comma-separated tag NAMES from the forum's available tags")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (messageParts: string[], opts: PostOptions) => {
      const { botToken, guildId } = requireTokenAndGuild(opts);
      const content = messageParts.join(" ");

      const ch = await resolveForumChannelOrExit(botToken, guildId, opts.channel);

      let appliedTagIds: string[] = [];
      if (opts.tags !== undefined) {
        try {
          appliedTagIds = resolveForumTagIds(ch.available_tags ?? [], opts.tags.split(","));
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
        if (appliedTagIds.length > MAX_APPLIED_TAGS) {
          console.error(
            `Too many tags: ${appliedTagIds.length}. Discord allows at most ` +
              `${MAX_APPLIED_TAGS} tags per forum post.`
          );
          process.exit(1);
        }
      }

      const result = await createForumPost(botToken, ch.id, {
        title: opts.title,
        content,
        appliedTagIds,
      });
      if (!result.success || !result.threadId) {
        console.error(`Failed to create forum post: ${result.error ?? "no thread id returned"}`);
        process.exit(1);
      }

      const tagNote = appliedTagIds.length > 0 ? ` [${appliedTagIds.length} tag(s)]` : "";
      console.log(
        `Created forum post "${opts.title}" in #${ch.name}${tagNote} — ` +
          `https://discord.com/channels/${guildId}/${result.threadId}`
      );
      // Print the raw id as the last line so callers can parse it (the
      // `thread create` convention) and follow up via `discord post --thread`.
      console.log(result.threadId);
    });

  // ── tags ──────────────────────────────────────────────────────────────────
  forumCmd
    .command("tags")
    .description("List a forum channel's available tags (id, name, emoji)")
    .requiredOption("-c, --channel <id-or-name>", "Forum channel (snowflake id or name)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: TagsOptions) => {
      const { botToken, guildId } = requireTokenAndGuild(opts);
      const ch = await resolveForumChannelOrExit(botToken, guildId, opts.channel);
      const tags = ch.available_tags ?? [];
      if (tags.length === 0) {
        console.log(`#${ch.name} has no forum tags. Set some with: discord channel tags set`);
        return;
      }
      for (const t of tags) {
        const emoji = t.emoji_name ? ` ${t.emoji_name}` : "";
        console.log(`  ${t.name.padEnd(25)} ${t.id}${emoji}${t.moderated ? " [moderated]" : ""}`);
      }
    });

  // ── posts ─────────────────────────────────────────────────────────────────
  forumCmd
    .command("posts")
    .description(
      "List a forum's posts (active + first page of archived) with tag names\n" +
        "\n" +
        "  Posts are threads — read one with `discord read --thread <id>`."
    )
    .requiredOption("-c, --channel <id-or-name>", "Forum channel (snowflake id or name)")
    .option("--tag <name>", "Only posts carrying this tag (name from the forum's tag set)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: PostsOptions) => {
      const { botToken, guildId } = requireTokenAndGuild(opts);
      const ch = await resolveForumChannelOrExit(botToken, guildId, opts.channel);
      const availableTags = ch.available_tags ?? [];

      // Validate the --tag filter against the forum's tag set BEFORE listing,
      // so a typo errors with the valid tags instead of an empty result.
      let filterTagId: string | undefined;
      if (opts.tag !== undefined) {
        try {
          const ids = resolveForumTagIds(availableTags, [opts.tag]);
          filterTagId = ids[0];
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      }

      let posts;
      try {
        posts = await listForumPosts(botToken, guildId, ch.id);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      if (filterTagId !== undefined) {
        const id = filterTagId;
        posts = posts.filter((p) => p.appliedTagIds.includes(id));
      }

      if (posts.length === 0) {
        console.log(
          opts.tag
            ? `No posts tagged "${opts.tag}" in #${ch.name}.`
            : `No posts in #${ch.name}.`
        );
        return;
      }

      const tagNameById = new Map(availableTags.map((t) => [t.id, t.name]));
      for (const p of posts) {
        const tagNames = p.appliedTagIds.map((id) => tagNameById.get(id) ?? `tag:${id}`);
        const tagNote = tagNames.length > 0 ? `  [${tagNames.join(", ")}]` : "";
        const archivedNote = p.archived ? " (archived)" : "";
        console.log(
          `  ${p.name.padEnd(35)} ${p.id}  (${p.messageCount} msgs)${tagNote}${archivedNote}`
        );
      }
    });
}
