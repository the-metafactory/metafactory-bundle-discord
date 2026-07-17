/**
 * `discord thread create|add|remove|archive|unarchive|list` — standalone thread
 * lifecycle (issue #13).
 *
 * This is the write side of thread support. The read-only active-thread listing
 * stays on the existing `discord threads` command; the `list` subcommand here
 * adds PER-CHANNEL archived listing (public or private).
 *
 * Private threads drive the common case: open a private thread, add members,
 * and archive (not delete) it when the work is done.
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { isSnowflake } from "../lib/discord";
import {
  createThread,
  addThreadMember,
  removeThreadMember,
  setArchived,
  listArchivedThreads,
  type AutoArchiveMinutes,
} from "../lib/guild/threads";
import { resolveContextOrExit, resolveChannelId } from "./shared";

interface CreateOptions extends ServerContextOptions {
  channel: string;
  name: string;
  private?: boolean;
  autoArchive?: string;
}

interface MemberOptions extends ServerContextOptions {
  thread: string;
  member: string;
}

interface ThreadOnlyOptions extends ServerContextOptions {
  thread: string;
}

interface ListOptions extends ServerContextOptions {
  channel: string;
  archived?: boolean;
  private?: boolean;
}

/** Discord's accepted auto-archive windows (minutes). */
const AUTO_ARCHIVE_VALUES: readonly number[] = [60, 1440, 4320, 10080];

export function registerThread(program: Command): void {
  const threadCmd = program
    .command("thread")
    .description("Create and manage guild threads (public/private, members, archive)");

  // ── create ────────────────────────────────────────────────────────────────
  threadCmd
    .command("create")
    .description("Create a thread (no starter message) in a channel and print its id")
    .requiredOption("-c, --channel <id-or-name>", "Channel to create the thread in")
    .requiredOption("-n, --name <name>", "Thread name (capped at 100 chars)")
    .option("-p, --private", "Create a private thread (type 12) instead of public (type 11)")
    .option(
      "-a, --auto-archive <minutes>",
      "Auto-archive after inactivity: 60, 1440, 4320, or 10080 minutes"
    )
    .option("-g, --guild <id>", "Guild ID to resolve the channel name against (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: CreateOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      if (!ctx.botToken || !ctx.guildId) {
        console.error("botToken and guildId required. Run: discord config set botToken <token>");
        process.exit(1);
      }

      let autoArchiveMinutes: AutoArchiveMinutes | undefined;
      if (opts.autoArchive !== undefined) {
        const n = Number(opts.autoArchive);
        if (!AUTO_ARCHIVE_VALUES.includes(n)) {
          console.error("--auto-archive must be one of 60, 1440, 4320, 10080");
          process.exit(1);
        }
        autoArchiveMinutes = n as AutoArchiveMinutes;
      }

      const channelId = await resolveChannelId(config, ctx, ctx.botToken, ctx.guildId, opts.channel);
      if (!channelId) {
        console.error(`Channel "${opts.channel}" not found. Run: discord channels`);
        process.exit(1);
      }

      const result = await createThread(ctx.botToken, channelId, {
        name: opts.name,
        type: opts.private ? 12 : 11,
        autoArchiveMinutes,
      });
      if (!result.success || !result.threadId) {
        console.error(`Failed to create thread: ${result.error ?? "no thread id returned"}`);
        process.exit(1);
      }
      // Print the raw id as the last line so callers can parse it.
      console.log(result.threadId);
    });

  // ── add / remove member ─────────────────────────────────────────────────────
  threadCmd
    .command("add")
    .description("Add a member to a thread")
    .requiredOption("-t, --thread <id>", "Thread id (snowflake)")
    .requiredOption("-m, --member <user-id>", "Discord user id (snowflake) to add")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: MemberOptions) => {
      const ctx = requireThreadAndMember(opts);
      const result = await addThreadMember(ctx.botToken, opts.thread, opts.member);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Added member ${opts.member} to thread ${opts.thread}`);
    });

  threadCmd
    .command("remove")
    .description("Remove a member from a thread (needs Manage Threads unless creator)")
    .requiredOption("-t, --thread <id>", "Thread id (snowflake)")
    .requiredOption("-m, --member <user-id>", "Discord user id (snowflake) to remove")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: MemberOptions) => {
      const ctx = requireThreadAndMember(opts);
      const result = await removeThreadMember(ctx.botToken, opts.thread, opts.member);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Removed member ${opts.member} from thread ${opts.thread}`);
    });

  // ── archive / unarchive ─────────────────────────────────────────────────────
  threadCmd
    .command("archive")
    .description("Archive a thread (retained, not deleted)")
    .requiredOption("-t, --thread <id>", "Thread id (snowflake)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: ThreadOnlyOptions) => {
      await runArchive(opts, true);
    });

  threadCmd
    .command("unarchive")
    .description("Unarchive (restore) a thread")
    .requiredOption("-t, --thread <id>", "Thread id (snowflake)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: ThreadOnlyOptions) => {
      await runArchive(opts, false);
    });

  // ── list (archived, per-channel) ────────────────────────────────────────────
  threadCmd
    .command("list")
    .description("List a channel's archived threads (active threads: use `discord threads`)")
    .requiredOption("-c, --channel <id-or-name>", "Channel to list threads from")
    .option("--archived", "List archived threads (required — active listing is `discord threads`)")
    .option("-p, --private", "List archived PRIVATE threads (needs Manage Threads)")
    .option("-g, --guild <id>", "Guild ID to resolve the channel name against (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: ListOptions) => {
      if (!opts.archived) {
        console.error(
          "Per-channel active listing isn't supported here — run `discord threads` for active " +
            "threads, or pass --archived to list this channel's archived threads."
        );
        process.exit(1);
      }

      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      if (!ctx.botToken || !ctx.guildId) {
        console.error("botToken and guildId required. Run: discord config set botToken <token>");
        process.exit(1);
      }

      const channelId = await resolveChannelId(config, ctx, ctx.botToken, ctx.guildId, opts.channel);
      if (!channelId) {
        console.error(`Channel "${opts.channel}" not found. Run: discord channels`);
        process.exit(1);
      }

      const page = await listArchivedThreads(ctx.botToken, channelId, { private: opts.private });
      if (page.threads.length === 0) {
        console.log(`No archived ${opts.private ? "private " : ""}threads in this channel.`);
        return;
      }
      for (const t of page.threads) {
        console.log(`  ${t.name.padEnd(35)} ${t.id}`);
      }
      if (page.hasMore) {
        console.log("  … more archived threads (page truncated)");
      }
    });
}

/**
 * Validate `--thread` and `--member` as snowflakes and resolve the bot token,
 * exiting non-zero with a clear message on any failure. Shared by `add`/`remove`
 * so the two paths guard identically before any network call.
 */
function requireThreadAndMember(opts: MemberOptions): { botToken: string } {
  if (!isSnowflake(opts.thread)) {
    console.error("--thread must be a Discord thread id (17–20 digits)");
    process.exit(1);
  }
  if (!isSnowflake(opts.member)) {
    console.error("--member must be a Discord user id (17–20 digits)");
    process.exit(1);
  }
  const config = loadConfig();
  const ctx = resolveContextOrExit(config, opts);
  if (!ctx.botToken) {
    console.error("Bot token required. Run: discord config set botToken <token>");
    process.exit(1);
  }
  return { botToken: ctx.botToken };
}

/** Shared archive/unarchive body: validate the thread id, then PATCH archived. */
async function runArchive(opts: ThreadOnlyOptions, archived: boolean): Promise<void> {
  if (!isSnowflake(opts.thread)) {
    console.error("--thread must be a Discord thread id (17–20 digits)");
    process.exit(1);
  }
  const config = loadConfig();
  const ctx = resolveContextOrExit(config, opts);
  if (!ctx.botToken) {
    console.error("Bot token required. Run: discord config set botToken <token>");
    process.exit(1);
  }
  const result = await setArchived(ctx.botToken, opts.thread, archived);
  if (!result.success) {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`${archived ? "Archived" : "Unarchived"} thread ${opts.thread}`);
}
