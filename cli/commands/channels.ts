/**
 * `discord channels` — list channels in the guild.
 *
 * Moved from `cli/discord.ts` during the command-module split (#9). The default
 * (text + announcement only) path is unchanged. The new `--all` flag lists every
 * channel type with its type-name label (issue #9, "full channel listing").
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { listChannels, listAllChannels, channelTypeName } from "../lib/discord";
import { resolveContextOrExit } from "./shared";

interface ChannelsOptions extends ServerContextOptions {
  all?: boolean;
}

export function registerChannels(program: Command): void {
  program
    .command("channels")
    .description("List channels in the Discord server")
    .option("-g, --guild <id>", "Guild ID to list channels from (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .option("-a, --all", "List ALL channel types (categories, voice, forum, stage) with type names")
    .action(async (opts: ChannelsOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      if (!ctx.botToken || !ctx.guildId) {
        console.error("botToken and guildId required. Run: discord config set botToken <token>");
        process.exit(1);
      }

      if (opts.all) {
        const channels = await listAllChannels(ctx.botToken, ctx.guildId);
        for (const ch of channels) {
          console.log(`  ${channelTypeName(ch.type).padEnd(12)} #${ch.name.padEnd(25)} ${ch.id}`);
        }
        return;
      }

      const channels = await listChannels(ctx.botToken, ctx.guildId);
      for (const ch of channels) {
        console.log(`  #${ch.name.padEnd(25)} ${ch.id}`);
      }
    });
}
