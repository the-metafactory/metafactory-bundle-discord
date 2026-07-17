/**
 * `discord threads` — list active threads in the guild.
 *
 * Moved verbatim from `cli/discord.ts` during the command-module split (#9).
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { listThreads } from "../lib/discord";
import { resolveContextOrExit } from "./shared";

export function registerThreads(program: Command): void {
  program
    .command("threads")
    .description("List active threads in the Discord server")
    .option("-g, --guild <id>", "Guild ID to list threads from (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: ServerContextOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      if (!ctx.botToken || !ctx.guildId) {
        console.error("botToken and guildId required.");
        process.exit(1);
      }

      const threads = await listThreads(ctx.botToken, ctx.guildId);
      if (threads.length === 0) {
        console.log("No active threads.");
        return;
      }
      for (const t of threads) {
        console.log(`  ${t.name.padEnd(35)} ${t.id}  (${t.messageCount} msgs${t.archived ? ", archived" : ""})`);
      }
    });
}
