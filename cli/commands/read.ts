/**
 * `discord read` — read recent messages from a channel or thread.
 *
 * Moved verbatim from `cli/discord.ts` during the command-module split (#9).
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { readMessages, resolveThreadByName } from "../lib/discord";
import { parseDiscordUrl } from "../lib/discord-url";
import { resolveContextWithUrlsOrExit, resolveChannelId } from "./shared";

interface ReadOptions extends ServerContextOptions {
  channel?: string;
  thread?: string;
  limit: string;
}

export function registerRead(program: Command): void {
  program
    .command("read")
    .description("Read recent messages from a channel or thread")
    .option("-c, --channel <name>", "Channel name, id, or a pasted discord.com/channels URL (default: defaultChannel from config)")
    .option("-t, --thread <name-or-id>", "Thread name, id, or a pasted discord.com/channels URL to read from (forum posts are threads — their id works here)")
    .option("-n, --limit <n>", "Number of messages", "10")
    .option("-g, --guild <id>", "Guild ID (or a pasted discord.com/channels URL) to resolve names against (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: ReadOptions) => {
      const config = loadConfig();
      const ctx = resolveContextWithUrlsOrExit(config, opts, [opts.channel, opts.thread]);

      if (!ctx.botToken) {
        console.error("Bot token required. Run: discord config set botToken <token>");
        process.exit(1);
      }
      if (!ctx.guildId) {
        console.error("Guild ID required. Run: discord config set guildId <id>");
        process.exit(1);
      }

      // Resolve the thread target. A pasted URL carries the thread/channel
      // snowflake directly; otherwise a non-numeric value is a name to look up.
      let threadId = opts.thread;
      if (threadId) {
        const url = parseDiscordUrl(threadId);
        if (url) {
          threadId = url.channelId;
        } else if (!/^\d+$/.test(threadId)) {
          const resolved = await resolveThreadByName(ctx.botToken, ctx.guildId, threadId);
          if (!resolved) {
            console.error(`Thread "${threadId}" not found. Run: discord threads`);
            process.exit(1);
          }
          threadId = resolved.id;
        }
      }

      let readTargetId: string;

      if (threadId) {
        readTargetId = threadId;
      } else {
        const channelName = opts.channel ?? ctx.defaultChannel;
        if (!channelName) {
          console.error("No channel or thread specified and no defaultChannel configured.");
          process.exit(1);
        }

        const channelId = await resolveChannelId(config, ctx, ctx.botToken, ctx.guildId, channelName);
        if (!channelId) {
          console.error(`Channel "#${channelName}" not found.`);
          process.exit(1);
        }
        readTargetId = channelId;
      }

      const messages = await readMessages(ctx.botToken, readTargetId, parseInt(opts.limit));
      for (const msg of messages) {
        const time = new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        console.log(`[${time}] ${msg.author}: ${msg.content}`);
      }
    });
}
