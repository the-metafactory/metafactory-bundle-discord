/**
 * `discord perms set|clear|show|sync` — manage channel permission overwrites,
 * the mechanism the ring model runs on (each category gated by one role;
 * "promotion is new rooms appearing").
 *
 * Targets are a role (`--role`, overwrite type 0) or a member (`--member`,
 * overwrite type 1). `--role everyone` (or `@everyone`) resolves to the guild's
 * base role, whose snowflake equals the guild id. Other role names resolve via
 * the guild roles list (`resolveRoleId`); channel names resolve via the shared
 * channel resolver. `--allow` / `--deny` are comma-separated permission NAMES,
 * validated against the map — an unknown name errors listing the valid set.
 *
 * A bot can only grant permissions it holds; on 403 the underlying helpers
 * explain that (wording pattern of `mapRoleError`, cli/lib/discord.ts:320).
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { resolveRoleId } from "../lib/discord";
import { resolveContextOrExit, resolveChannelId, isDiscordId } from "./shared";
import type { ResolvedServerContext } from "../lib/server-context";
import type { DiscordCliConfig } from "../lib/config";
import {
  setOverwrite,
  deleteOverwrite,
  getOverwrites,
  syncFromCategory,
  parsePermissionList,
  bitsToPermissionNames,
  bitsToWire,
} from "../lib/guild/permissions";
import type { Overwrite, SyncResult } from "../lib/guild/permissions";

interface PermsOptions extends ServerContextOptions {
  channel: string;
  role?: string;
  member?: string;
  allow?: string;
  deny?: string;
}

/** A resolved overwrite target: role (type 0) or member (type 1). */
interface Target {
  id: string;
  type: 0 | 1;
  /** Human label for output, e.g. the role name or member id. */
  label: string;
}

/** The @everyone role's snowflake equals the guild id. */
function isEveryone(role: string): boolean {
  const lower = role.toLowerCase();
  return lower === "everyone" || lower === "@everyone";
}

/**
 * Resolve `--role`/`--member` to an overwrite target, or exit non-zero with a
 * clear message. Exactly one of the two must be supplied.
 */
async function resolveTargetOrExit(
  opts: PermsOptions,
  botToken: string,
  guildId: string
): Promise<Target> {
  if (opts.role && opts.member) {
    console.error("Pass only one of --role or --member, not both.");
    process.exit(1);
  }
  if (!opts.role && !opts.member) {
    console.error("Target required: pass --role <id-or-name> or --member <id>.");
    process.exit(1);
  }

  if (opts.member) {
    if (!isDiscordId(opts.member)) {
      console.error("--member must be a Discord user id (17–20 digits)");
      process.exit(1);
    }
    return { id: opts.member, type: 1, label: `member ${opts.member}` };
  }

  const role = opts.role as string;
  if (isEveryone(role)) {
    return { id: guildId, type: 0, label: "@everyone" };
  }
  try {
    const roleId = await resolveRoleId(botToken, guildId, role);
    return { id: roleId, type: 0, label: `role ${role} (${roleId})` };
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

/**
 * Resolve `--channel` to a channel id, or exit non-zero. Wraps the shared
 * name/id resolver with CLI-exit semantics.
 */
async function resolveChannelOrExit(
  config: DiscordCliConfig,
  ctx: ResolvedServerContext,
  botToken: string,
  guildId: string,
  channel: string
): Promise<string> {
  const id = await resolveChannelId(config, ctx, botToken, guildId, channel);
  if (!id) {
    console.error(
      `Channel "${channel}" not found in guild ${guildId}. ` +
        `Pass the channel's snowflake id, or check: discord channels --all`
    );
    process.exit(1);
  }
  return id;
}

/** Load config + context and validate token/guild, or exit non-zero. */
function contextOrExit(opts: PermsOptions): {
  config: DiscordCliConfig;
  ctx: ResolvedServerContext;
  botToken: string;
  guildId: string;
} {
  const config = loadConfig();
  const ctx = resolveContextOrExit(config, opts);
  if (!ctx.botToken) {
    console.error("Bot token required. Run: discord config set botToken <token>");
    process.exit(1);
  }
  if (!ctx.guildId) {
    console.error(
      "Guild ID required. Run: discord config set guildId <id> OR use --guild/--server"
    );
    process.exit(1);
  }
  return { config, ctx, botToken: ctx.botToken, guildId: ctx.guildId };
}

export function registerPerms(program: Command): void {
  const permsCmd = program
    .command("perms")
    .description("Manage channel permission overwrites (the ring-gate mechanism)");

  permsCmd
    .command("set")
    .description(
      "Set a channel overwrite for a role or member\n" +
        "\n" +
        "  Permission names are comma-separated and validated against the map.\n" +
        "  The overwrite is REPLACED (allow/deny are the complete masks for the\n" +
        "  target). A bot can only grant permissions it itself holds."
    )
    .requiredOption("-c, --channel <id-or-name>", "Channel snowflake id or name")
    .option("-r, --role <id-or-name>", "Role snowflake id, name, or 'everyone'")
    .option("-m, --member <id>", "Member snowflake id")
    .option("--allow <names>", "Comma-separated permission names to allow", "")
    .option("--deny <names>", "Comma-separated permission names to deny", "")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: PermsOptions) => {
      const { config, ctx, botToken, guildId } = contextOrExit(opts);

      let allow: string;
      let deny: string;
      try {
        allow = bitsToWire(parsePermissionList(opts.allow ?? ""));
        deny = bitsToWire(parsePermissionList(opts.deny ?? ""));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      const channelId = await resolveChannelOrExit(
        config,
        ctx,
        botToken,
        guildId,
        opts.channel
      );
      const target = await resolveTargetOrExit(opts, botToken, guildId);

      try {
        await setOverwrite(botToken, channelId, target.id, {
          type: target.type,
          allow,
          deny,
        });
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(
        `Set overwrite on channel ${channelId} for ${target.label} ` +
          `(allow=${allow}, deny=${deny})`
      );
    });

  permsCmd
    .command("clear")
    .description("Remove a channel overwrite for a role or member")
    .requiredOption("-c, --channel <id-or-name>", "Channel snowflake id or name")
    .option("-r, --role <id-or-name>", "Role snowflake id, name, or 'everyone'")
    .option("-m, --member <id>", "Member snowflake id")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: PermsOptions) => {
      const { config, ctx, botToken, guildId } = contextOrExit(opts);

      const channelId = await resolveChannelOrExit(
        config,
        ctx,
        botToken,
        guildId,
        opts.channel
      );
      const target = await resolveTargetOrExit(opts, botToken, guildId);

      try {
        await deleteOverwrite(botToken, channelId, target.id);
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(
        `Cleared overwrite on channel ${channelId} for ${target.label}`
      );
    });

  permsCmd
    .command("show")
    .description("Show a channel's overwrites, decoding allow/deny back to names")
    .requiredOption("-c, --channel <id-or-name>", "Channel snowflake id or name")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: PermsOptions) => {
      const { config, ctx, botToken, guildId } = contextOrExit(opts);

      const channelId = await resolveChannelOrExit(
        config,
        ctx,
        botToken,
        guildId,
        opts.channel
      );

      let overwrites: Overwrite[];
      try {
        overwrites = await getOverwrites(botToken, channelId);
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }

      if (overwrites.length === 0) {
        console.log(`Channel ${channelId} has no permission overwrites.`);
        return;
      }

      console.log(`Overwrites on channel ${channelId}:`);
      for (const o of overwrites) {
        const kind = o.type === 1 ? "member" : "role";
        const allowNames = bitsToPermissionNames(BigInt(o.allow));
        const denyNames = bitsToPermissionNames(BigInt(o.deny));
        console.log(`  ${kind.padEnd(6)} ${o.id}`);
        console.log(`    allow: ${allowNames.length ? allowNames.join(", ") : "(none)"}`);
        console.log(`    deny:  ${denyNames.length ? denyNames.join(", ") : "(none)"}`);
      }
    });

  permsCmd
    .command("sync")
    .description(
      "Copy the parent category's overwrites onto the channel (Discord 'sync now')"
    )
    .requiredOption("-c, --channel <id-or-name>", "Channel snowflake id or name")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config")
    .action(async (opts: PermsOptions) => {
      const { config, ctx, botToken, guildId } = contextOrExit(opts);

      const channelId = await resolveChannelOrExit(
        config,
        ctx,
        botToken,
        guildId,
        opts.channel
      );

      let result: SyncResult;
      try {
        result = await syncFromCategory(botToken, channelId);
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(
        `Synced channel ${channelId} from category ${result.parentId}: ` +
          `${result.copied} overwrite(s) copied, ${result.removed} removed.`
      );
    });
}
