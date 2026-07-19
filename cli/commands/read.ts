/**
 * `discord read` — read recent messages from a channel or thread.
 *
 * Moved verbatim from `cli/discord.ts` during the command-module split (#9).
 */

import { mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { readMessages, resolveThreadByName, downloadAttachment } from "../lib/discord";
import { parseDiscordUrl } from "../lib/discord-url";
import { resolveContextWithUrlsOrExit, resolveChannelId } from "./shared";

interface ReadOptions extends ServerContextOptions {
  channel?: string;
  thread?: string;
  limit: string;
  download?: string;
}

/**
 * Strip an attachment filename to a safe basename — no path traversal, no
 * separators. Collisions are disambiguated by the caller via a prefix.
 */
function safeFilename(name: string): string {
  const base = basename(name).replace(/[^\w.\-() ]+/g, "_");
  return base || "attachment";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export function registerRead(program: Command): void {
  program
    .command("read")
    .description("Read recent messages from a channel or thread")
    .option("-c, --channel <name>", "Channel name, id, or a pasted discord.com/channels URL (default: defaultChannel from config)")
    .option("-t, --thread <name-or-id>", "Thread name, id, or a pasted discord.com/channels URL to read from")
    .option("-n, --limit <n>", "Number of messages", "10")
    .option("-d, --download <dir>", "Download attachments (screenshots, files) into this directory")
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

      if (opts.download) mkdirSync(opts.download, { recursive: true });

      const messages = await readMessages(ctx.botToken, readTargetId, parseInt(opts.limit));
      for (const msg of messages) {
        const time = new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        console.log(`[${time}] ${msg.author}: ${msg.content}`);
        for (const att of msg.attachments ?? []) {
          console.log(`    📎 ${att.filename} (${att.contentType ?? "unknown type"}, ${formatSize(att.size)}) ${att.url}`);
          if (opts.download) {
            // Prefix with the attachment snowflake so same-named files from
            // different messages never clobber each other.
            const dest = join(opts.download, `${att.id}-${safeFilename(att.filename)}`);
            if (existsSync(dest)) {
              console.log(`       already downloaded: ${dest}`);
              continue;
            }
            try {
              const bytes = await downloadAttachment(att.url, dest);
              console.log(`       saved: ${dest} (${formatSize(bytes)})`);
            } catch (err) {
              console.error(`       download failed: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      }
    });
}
