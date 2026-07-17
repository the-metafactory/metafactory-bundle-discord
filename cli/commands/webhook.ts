/**
 * `discord webhook create|list|delete|exec` — guild webhook management with
 * per-message identity (guildhall idea 0021). Create/list/delete drive the bot
 * API (MANAGE_WEBHOOKS); `exec` posts through a webhook URL with an overridden
 * username/avatar and routes the content through the SAME confidentiality gate
 * as `discord post` (warn-only rollout).
 *
 * Credential storage stays OUT of this CLI: `create` prints the webhook URL once
 * with a warning and stores nothing — the operator keeps it in their own secret
 * store. `list` never displays webhook token values.
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { DiscordCliConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { gatePublicPost } from "../lib/confidentiality-gate";
import type { GateResult } from "../lib/confidentiality-gate";
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  executeWebhook,
  parseWebhookUrl,
} from "../lib/guild/webhooks";
import { resolveContextOrExit, resolveChannelId, isDiscordId } from "./shared";

interface WebhookCreateOptions extends ServerContextOptions {
  channel: string;
  name: string;
}

interface WebhookDeleteOptions extends ServerContextOptions {
  webhook: string;
  yes?: boolean;
}

interface WebhookExecOptions extends ServerContextOptions {
  url: string;
  message: string;
  as?: string;
  avatar?: string;
}

/** Outcome of `execWebhookGated` — the action layer turns this into stdout/stderr + exit code. */
export interface ExecGatedResult {
  /** True when the message was sent (or would be — see `sent`). */
  ok: boolean;
  /** Whether the webhook send was actually attempted (false only for a bad URL). */
  sent: boolean;
  /** Advisory gate lines to print to stderr (warn-only; never blocks the send). */
  gateWarnings: string[];
  /** Username the message was posted under, for the success line. */
  sentAs?: string;
  /** Webhook id parsed from the URL, for the success line. */
  webhookId?: string;
  error?: string;
}

/**
 * Core of `webhook exec`, factored out of the command action so the ordering
 * invariant is unit-testable: the confidentiality gate is ALWAYS consulted
 * before the sender, and a warn/block gate result is advisory only (it logs but
 * still sends — mirrors `discord post`'s warn-only wiring). An unknown guild is
 * classified public (fail-closed) by `gatePublicPost` itself.
 *
 * `deps` is an injection seam for tests; production uses the real gate + sender.
 */
export async function execWebhookGated(
  args: {
    url: string;
    content: string;
    username?: string;
    avatarUrl?: string;
    guildId?: string;
    config: DiscordCliConfig;
  },
  deps: { gate: typeof gatePublicPost; send: typeof executeWebhook } = {
    gate: gatePublicPost,
    send: executeWebhook,
  }
): Promise<ExecGatedResult> {
  const parsed = parseWebhookUrl(args.url);
  if (!parsed) {
    return {
      ok: false,
      sent: false,
      gateWarnings: [],
      error: "Invalid webhook URL. Expected https://discord.com/api/webhooks/<id>/<token>",
    };
  }

  // Gate BEFORE sending. Warn-only: findings are surfaced but never stop the send.
  const gate: GateResult = deps.gate({ guildId: args.guildId, content: args.content, config: args.config });
  const gateWarnings: string[] = [];
  if (!gate.ok) {
    const tier = gate.blocked ? "BLOCK" : "warn";
    gateWarnings.push(
      `confidentiality-gate: ${tier}-tier finding(s) on guild ${args.guildId ?? "(unknown → public)"} ` +
        `(${gate.reason ?? "see ack-log"}) — advisory only, posting anyway`
    );
    for (const f of gate.findings) {
      gateWarnings.push(`  [${f.action}] ${f.source}: ${f.class} (${f.ruleId}) — ${f.descriptor}`);
    }
  }

  const result = await deps.send(parsed.id, parsed.token, {
    content: args.content,
    username: args.username,
    avatar_url: args.avatarUrl,
  });
  if (!result.success) {
    return { ok: false, sent: true, gateWarnings, webhookId: parsed.id, error: result.error };
  }
  return { ok: true, sent: true, gateWarnings, webhookId: parsed.id, sentAs: args.username };
}

export function registerWebhook(program: Command): void {
  const webhookCmd = program
    .command("webhook")
    .description("Manage guild webhooks (create/list/delete) and post with per-message identity");

  webhookCmd
    .command("create")
    .description(
      "Create a webhook in a channel and print its URL ONCE\n" +
        "\n" +
        "  Prerequisite: the bot must have the Manage Webhooks permission in the guild.\n" +
        "  The URL is a posting credential — store it in your own secret store; this CLI\n" +
        "  never saves it."
    )
    .requiredOption("-c, --channel <id-or-name>", "Channel id or name to create the webhook in")
    .requiredOption("-n, --name <name>", 'Webhook name (may not contain "discord"/"clyde")')
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: WebhookCreateOptions) => {
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

      const channelId = await resolveChannelId(config, ctx, ctx.botToken, ctx.guildId, opts.channel);
      if (!channelId) {
        console.error(`Channel "#${opts.channel}" not found. Run: discord channels`);
        process.exit(1);
      }

      const result = await createWebhook(ctx.botToken, channelId, { name: opts.name });
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }

      console.log(`Created webhook ${result.id} in #${opts.channel}`);
      console.log("");
      console.log("WARNING: store this webhook URL in YOUR OWN secret store. It is a posting");
      console.log("credential — anyone holding it can post as this webhook. It is shown ONCE");
      console.log("and is never saved by this CLI:");
      console.log("");
      console.log(`    ${result.url}`);
    });

  webhookCmd
    .command("list")
    .description("List the guild's webhooks (token values are never displayed)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: ServerContextOptions) => {
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

      const result = await listWebhooks(ctx.botToken, ctx.guildId);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }

      const webhooks = result.webhooks ?? [];
      if (webhooks.length === 0) {
        console.log("No webhooks in this guild.");
        return;
      }
      for (const w of webhooks) {
        const app = w.applicationId ? `  app:${w.applicationId}` : "";
        console.log(`${w.id}  ${w.name ?? "(unnamed)"}  channel:${w.channelId}${app}`);
      }
    });

  webhookCmd
    .command("delete")
    .description("Delete a webhook by id")
    .requiredOption("-w, --webhook <id>", "Webhook id (snowflake) to delete")
    .option("-y, --yes", "Confirm deletion (required — delete is irreversible)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: WebhookDeleteOptions) => {
      if (!isDiscordId(opts.webhook)) {
        console.error("--webhook must be a Discord webhook id (17–20 digits)");
        process.exit(1);
      }
      if (!opts.yes) {
        console.error("Refusing to delete without --yes (deletion is irreversible).");
        process.exit(1);
      }

      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      if (!ctx.botToken) {
        console.error("Bot token required. Run: discord config set botToken <token>");
        process.exit(1);
      }

      const result = await deleteWebhook(ctx.botToken, opts.webhook);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Deleted webhook ${opts.webhook}`);
    });

  webhookCmd
    .command("exec")
    .description(
      "Post a message through a webhook URL with a per-message identity override.\n" +
        "\n" +
        "  Content is routed through the same confidentiality gate as `discord post`\n" +
        "  (warn-only). An unknown guild is treated as public (fail-closed)."
    )
    .requiredOption("-u, --url <webhook-url>", "Webhook URL (id + token) to post through")
    .requiredOption("-m, --message <text>", "Message text to post")
    .option("-a, --as <username>", "Override the display name for this message")
    .option("--avatar <url>", "Override the avatar (image URL) for this message")
    .option("-g, --guild <id>", "Guild ID for gate classification (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId)")
    .action(async (opts: WebhookExecOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);

      const result = await execWebhookGated({
        url: opts.url,
        content: opts.message,
        username: opts.as,
        avatarUrl: opts.avatar,
        guildId: ctx.guildId,
        config,
      });

      for (const line of result.gateWarnings) console.error(line);

      if (!result.ok) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Posted via webhook ${result.webhookId}${result.sentAs ? ` as "${result.sentAs}"` : ""}`);
    });
}
