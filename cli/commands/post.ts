/**
 * `discord post` — post a message (and optional file attachments) to a channel
 * or thread, with the confidentiality gate wired on the send path.
 *
 * Moved verbatim from `cli/discord.ts` during the command-module split (#9):
 * behaviour is unchanged, including the WARN-ONLY confidentiality-gate wiring.
 */

import type { Command } from "commander";
import { basename } from "node:path";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import {
  postMessage,
  postMessageWithFiles,
  createThreadFromMessage,
  resolveThreadByName,
  type AttachmentInput,
} from "../lib/discord";
import { gatePublicPost } from "../lib/confidentiality-gate";
import { resolveContextOrExit, resolveChannelId } from "./shared";

interface PostOptions extends ServerContextOptions {
  channel?: string;
  thread?: string;
  createThread?: string;
  file?: string[];
}

export function registerPost(program: Command): void {
  program
    .command("post")
    .description("Post a message to a Discord channel")
    .argument("[message...]", "Message text (optional when --file is given)")
    .option("-c, --channel <name>", "Channel name (default: defaultChannel from config)")
    .option("-t, --thread <name-or-id>", "Thread name or ID to post into")
    .option("-T, --create-thread <name>", "Create a thread from the posted message and print its ID")
    .option("-f, --file <path>", "Attach a file (repeatable)", (v: string, acc: string[]) => [...acc, v], [])
    .option("-g, --guild <id>", "Guild ID to resolve channel/thread names against (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (messageParts: string[], opts: PostOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      const message = messageParts.join(" ");
      const filePaths = opts.file ?? [];

      if (opts.thread && opts.createThread) {
        console.error("--thread and --create-thread are mutually exclusive (a thread cannot contain a thread).");
        process.exit(1);
      }

      // A post must carry SOMETHING — text or at least one file. An empty post
      // is rejected before any network call (no dangling empty message).
      if (message.length === 0 && filePaths.length === 0) {
        console.error("Nothing to post: provide a message, one or more --file, or both.");
        process.exit(1);
      }

      // Read + existence-check every attachment BEFORE resolving the channel or
      // hitting the API, so a bad path fails cleanly with nothing posted.
      const attachments: AttachmentInput[] = [];
      for (const path of filePaths) {
        const f = Bun.file(path);
        if (!(await f.exists())) {
          console.error(`Attachment not found: ${path}`);
          process.exit(1);
        }
        attachments.push({ filename: basename(path), bytes: new Uint8Array(await f.arrayBuffer()) });
      }

      if (!ctx.botToken) {
        console.error("Bot token required. Run: discord config set botToken <token>");
        process.exit(1);
      }
      if (!ctx.guildId) {
        console.error("Guild ID required. Run: discord config set guildId <id>");
        process.exit(1);
      }

      // Resolve thread by name if provided and not a numeric ID
      let threadId = opts.thread;
      if (threadId && !/^\d+$/.test(threadId)) {
        const resolved = await resolveThreadByName(ctx.botToken, ctx.guildId, threadId);
        if (!resolved) {
          console.error(`Thread "${threadId}" not found. Run: discord threads`);
          process.exit(1);
        }
        threadId = resolved.id;
      }

      const channelName = opts.channel ?? ctx.defaultChannel;
      if (!threadId && !channelName) {
        console.error("No channel or thread specified and no defaultChannel configured.");
        console.error("Run: discord config set defaultChannel <name>");
        process.exit(1);
      }

      // Resolve channel name → ID. Cached ids and raw ids are only trusted when
      // they belong to this command's effective guild.
      let channelId: string | undefined;
      if (channelName) {
        channelId = await resolveChannelId(config, ctx, ctx.botToken, ctx.guildId, channelName);
        if (!channelId && !threadId) {
          console.error(`Channel "#${channelName}" not found. Run: discord channels`);
          process.exit(1);
        }
      }

      const targetId = threadId ?? channelId;
      if (!targetId) {
        console.error("internal: no target id resolved");
        process.exit(1);
      }

      // Confidentiality gate (compass#91, design doc §4 L6 "Discord"). Resolves
      // classification off the SAME guildId this command already resolved for
      // channel/thread lookups. WARN-ONLY in this rollout — a block/warn signal
      // is logged + acked but never stops the send; see confidentiality-gate.ts
      // module doc for why the enforcing flip is a separate, principal-owned step.
      const gate = gatePublicPost({ guildId: ctx.guildId, content: message, attachments, config });
      if (!gate.ok) {
        const tier = gate.blocked ? "BLOCK" : "warn";
        console.error(`confidentiality-gate: ${tier}-tier finding(s) on guild ${ctx.guildId} (${gate.reason ?? "see ack-log"}) — advisory only, posting anyway`);
        for (const f of gate.findings) {
          console.error(`  [${f.action}] ${f.source}: ${f.class} (${f.ruleId}) — ${f.descriptor}`);
        }
      }

      const result = attachments.length > 0
        ? await postMessageWithFiles(ctx.botToken, targetId, message, attachments)
        : await postMessage(ctx.botToken, targetId, message);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      const attachNote = attachments.length > 0 ? ` (+${attachments.length} file${attachments.length === 1 ? "" : "s"})` : "";
      console.log(`Posted to #${channelName}${opts.thread ? ` (thread)` : ""}${attachNote}`);

      if (opts.createThread) {
        if (!result.messageId) {
          console.error("Cannot create thread: Discord did not return a message id.");
          process.exit(1);
        }
        const thread = await createThreadFromMessage(ctx.botToken, targetId, result.messageId, opts.createThread);
        if (!thread.success) {
          console.error(`Thread creation failed: ${thread.error}`);
          process.exit(1);
        }
        // Machine-readable last line — callers parse this id to post follow-ups via --thread
        console.log(`thread:${thread.threadId}`);
      }
    });
}
