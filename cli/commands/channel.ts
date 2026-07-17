/**
 * `discord channel create|edit|delete|list` and `discord channel tags set|list`
 * — channel/category lifecycle including forum tags (issue #11).
 *
 * Mirrors the command-module pattern (`role.ts`, `channels.ts`): each subcommand
 * resolves the server context, validates the bot token + guild id, resolves any
 * name→id arguments, then calls the `cli/lib/guild/channels` mutation helpers.
 *
 * Name resolution copies the `resolveRoleId` contract (`cli/lib/discord.ts`):
 * snowflake passthrough, case-insensitive exact-name match, and an ambiguity
 * error that lists the colliding matches so the principal can pass a raw id.
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { listAllChannels, channelTypeName } from "../lib/discord";
import {
  createChannel,
  modifyChannel,
  deleteChannel,
  getChannel,
  CHANNEL_TYPE,
  MAX_FORUM_TAGS,
  type ChannelSpec,
  type ForumTag,
} from "../lib/guild/channels";
import { resolveContextOrExit, isDiscordId } from "./shared";

/** `--type <name>` → Discord channel type number. */
const TYPE_BY_NAME: Record<string, number> = {
  text: CHANNEL_TYPE.text,
  voice: CHANNEL_TYPE.voice,
  category: CHANNEL_TYPE.category,
  announcement: CHANNEL_TYPE.announcement,
  forum: CHANNEL_TYPE.forum,
};
const TYPE_NAMES = Object.keys(TYPE_BY_NAME).join("|");

interface ContextOnly extends ServerContextOptions {}

interface CreateOptions extends ServerContextOptions {
  name: string;
  type: string;
  parent?: string;
  topic?: string;
  position?: string;
  slowmode?: string;
}

interface EditOptions extends ServerContextOptions {
  channel: string;
  name?: string;
  type?: string;
  parent?: string;
  topic?: string;
  position?: string;
  slowmode?: string;
}

interface DeleteOptions extends ServerContextOptions {
  channel: string;
  yes?: boolean;
}

interface TagsSetOptions extends ServerContextOptions {
  channel: string;
  tag: string[];
}

interface TagsListOptions extends ServerContextOptions {
  channel: string;
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
 * Resolve a channel name (or snowflake id) to a channel id, copying the
 * `resolveRoleId` contract. `typeFilter` restricts matches to one channel type
 * (e.g. category 4 for `--parent`); omit it to match any type.
 *
 * Exported for unit testing (parent resolution + ambiguity).
 */
export async function resolveChannelIdByName(
  botToken: string,
  guildId: string,
  value: string,
  kind: string,
  typeFilter?: number
): Promise<string> {
  if (isDiscordId(value)) return value;

  const channels = await listAllChannels(botToken, guildId);
  const lower = value.toLowerCase();
  let matches = channels.filter((c) => c.name.toLowerCase() === lower);
  if (typeFilter !== undefined) matches = matches.filter((c) => c.type === typeFilter);

  if (matches.length === 0) {
    throw new Error(
      `${kind} "${value}" not found in guild ${guildId}. ` +
        `Pass the channel's snowflake id directly, or check: discord channels --all`
    );
  }

  const distinctIds = [...new Set(matches.map((c) => c.id))];
  if (distinctIds.length > 1) {
    const names = matches.map((c) => `"${c.name}" (${c.id})`).join(", ");
    throw new Error(
      `${kind} name "${value}" is ambiguous — multiple channels match: ${names}. ` +
        `Pass the exact snowflake id to disambiguate.`
    );
  }

  const id = distinctIds[0];
  if (!id) throw new Error("internal: channel match produced empty id list");
  return id;
}

/** Map a `--type <name>` string to its Discord number, exiting on an unknown name. */
function typeNumberOrExit(name: string): number {
  const n = TYPE_BY_NAME[name.toLowerCase()];
  if (n === undefined) {
    console.error(`Invalid --type "${name}". Expected one of: ${TYPE_NAMES}`);
    process.exit(1);
  }
  return n;
}

/** Parse a non-negative integer flag value, exiting on a bad value. */
function nonNegativeIntOrExit(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${flag} must be a non-negative integer (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

/** Repeatable-option collector for commander (`--tag a --tag b` → ["a","b"]). */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function registerChannel(program: Command): void {
  const channelCmd = program
    .command("channel")
    .description("Create, edit, delete, and list guild channels (incl. forum tags)");

  // ── create ────────────────────────────────────────────────────────────────
  channelCmd
    .command("create")
    .description("Create a channel or category")
    .requiredOption("-n, --name <name>", "Channel name")
    .option("-t, --type <type>", `Channel type (${TYPE_NAMES})`, "text")
    .option("-p, --parent <id-or-name>", "Parent category (snowflake id, or category name to resolve)")
    .option("--topic <topic>", "Channel topic / description")
    .option("--position <n>", "Sort position within its category")
    .option("--slowmode <seconds>", "Per-user rate limit (rate_limit_per_user), in seconds")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: CreateOptions) => {
      const { botToken, guildId } = requireTokenAndGuild(opts);
      const type = typeNumberOrExit(opts.type);

      const spec: ChannelSpec = { name: opts.name, type };
      if (opts.topic !== undefined) spec.topic = opts.topic;
      if (opts.position !== undefined) spec.position = nonNegativeIntOrExit(opts.position, "--position");
      if (opts.slowmode !== undefined)
        spec.rate_limit_per_user = nonNegativeIntOrExit(opts.slowmode, "--slowmode");

      if (opts.parent !== undefined) {
        try {
          spec.parent_id = await resolveChannelIdByName(
            botToken,
            guildId,
            opts.parent,
            "Parent category",
            CHANNEL_TYPE.category
          );
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      }

      try {
        const ch = await createChannel(botToken, guildId, spec);
        console.log(`Created ${channelTypeName(ch.type)} #${ch.name} (${ch.id})`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  // ── edit ──────────────────────────────────────────────────────────────────
  channelCmd
    .command("edit")
    .description("Edit an existing channel")
    .requiredOption("-c, --channel <id-or-name>", "Channel to edit (snowflake id or name)")
    .option("-n, --name <name>", "New name")
    .option("-t, --type <type>", `New type (${TYPE_NAMES})`)
    .option("-p, --parent <id-or-name>", "New parent category (snowflake id or category name)")
    .option("--topic <topic>", "New topic / description")
    .option("--position <n>", "New sort position")
    .option("--slowmode <seconds>", "New per-user rate limit, in seconds")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: EditOptions) => {
      const { botToken, guildId } = requireTokenAndGuild(opts);

      const spec: ChannelSpec = {};
      if (opts.name !== undefined) spec.name = opts.name;
      if (opts.type !== undefined) spec.type = typeNumberOrExit(opts.type);
      if (opts.topic !== undefined) spec.topic = opts.topic;
      if (opts.position !== undefined) spec.position = nonNegativeIntOrExit(opts.position, "--position");
      if (opts.slowmode !== undefined)
        spec.rate_limit_per_user = nonNegativeIntOrExit(opts.slowmode, "--slowmode");

      try {
        if (opts.parent !== undefined) {
          spec.parent_id = await resolveChannelIdByName(
            botToken,
            guildId,
            opts.parent,
            "Parent category",
            CHANNEL_TYPE.category
          );
        }
        const channelId = await resolveChannelIdByName(botToken, guildId, opts.channel, "Channel");
        const ch = await modifyChannel(botToken, channelId, spec);
        console.log(`Updated ${channelTypeName(ch.type)} #${ch.name} (${ch.id})`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  // ── delete ──────────────────────────────────────────────────────────────────
  channelCmd
    .command("delete")
    .description("Delete a channel (irreversible — requires --yes)")
    .requiredOption("-c, --channel <id-or-name>", "Channel to delete (snowflake id or name)")
    .option("-y, --yes", "Confirm deletion (required to proceed)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: DeleteOptions) => {
      if (!opts.yes) {
        console.error("Refusing to delete without confirmation. Re-run with --yes to proceed.");
        process.exit(1);
      }
      const { botToken, guildId } = requireTokenAndGuild(opts);
      try {
        const channelId = await resolveChannelIdByName(botToken, guildId, opts.channel, "Channel");
        await deleteChannel(botToken, channelId);
        console.log(`Deleted channel ${channelId}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  // ── list ──────────────────────────────────────────────────────────────────
  // Same output as `discord channels --all`. The foundation's `channels` command
  // inlines its render (no exported renderer to import), so this reuses the
  // shared `listAllChannels` + `channelTypeName` helpers to match it verbatim.
  channelCmd
    .command("list")
    .description("List all channels (same output as: discord channels --all)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: ContextOnly) => {
      const { botToken, guildId } = requireTokenAndGuild(opts);
      const channels = await listAllChannels(botToken, guildId);
      for (const ch of channels) {
        console.log(`  ${channelTypeName(ch.type).padEnd(12)} #${ch.name.padEnd(25)} ${ch.id}`);
      }
    });

  // ── tags ────────────────────────────────────────────────────────────────────
  const tagsCmd = channelCmd
    .command("tags")
    .description("Manage a forum channel's available tags");

  tagsCmd
    .command("set")
    .description(
      "Set a forum's tags (REPLACES the full set)\n" +
        "\n" +
        "  Discord has no per-tag add/remove API — the entire available_tags set is\n" +
        "  replaced. Pass every tag you want to keep. Max 20 tags."
    )
    .requiredOption("-c, --channel <id-or-name>", "Forum channel (snowflake id or name)")
    .requiredOption("-t, --tag <name>", "A tag name (repeatable). Replaces the full tag set.", collect, [])
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: TagsSetOptions) => {
      if (opts.tag.length > MAX_FORUM_TAGS) {
        console.error(
          `Too many tags: ${opts.tag.length}. Discord allows at most ${MAX_FORUM_TAGS} tags per forum channel.`
        );
        process.exit(1);
      }
      const { botToken, guildId } = requireTokenAndGuild(opts);
      const available_tags: ForumTag[] = opts.tag.map((name) => ({ name, moderated: false }));
      try {
        const channelId = await resolveChannelIdByName(botToken, guildId, opts.channel, "Channel");
        const ch = await modifyChannel(botToken, channelId, { available_tags });
        const names = (ch.available_tags ?? []).map((t) => t.name).join(", ");
        console.log(`Set ${ch.available_tags?.length ?? 0} tag(s) on #${ch.name}: ${names}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  tagsCmd
    .command("list")
    .description("List a forum channel's available tags")
    .requiredOption("-c, --channel <id-or-name>", "Forum channel (snowflake id or name)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: TagsListOptions) => {
      const { botToken, guildId } = requireTokenAndGuild(opts);
      try {
        const channelId = await resolveChannelIdByName(botToken, guildId, opts.channel, "Channel");
        const ch = await getChannel(botToken, channelId);
        const tags = ch.available_tags ?? [];
        if (tags.length === 0) {
          console.log(`#${ch.name} has no forum tags.`);
          return;
        }
        for (const t of tags) {
          console.log(`  ${t.name} (${t.id})${t.moderated ? " [moderated]" : ""}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });
}
