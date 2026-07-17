/**
 * `discord role add|remove` — assign or remove a guild role from a member
 * (O-5 — community-fleet admission).
 *
 * Moved verbatim from `cli/discord.ts` during the command-module split (#9).
 *
 * Target use case:
 *   discord role add --server community --role community-fleet --member <discord-user-id>
 *   discord role remove --server community --role community-fleet --member <discord-user-id>
 *
 * Prerequisites (the bot must meet these; if not, the 403 branch fires):
 *   • Bot token has the Manage Roles permission in the target guild.
 *   • The bot's highest role sits ABOVE the target role in the guild role hierarchy.
 *   The command documents these requirements but does NOT attempt to self-grant them.
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { assignRole, removeRole, resolveRoleId } from "../lib/discord";
import { resolveContextOrExit, isDiscordId } from "./shared";

interface RoleActionOptions extends ServerContextOptions {
  member: string;
  role: string;
}

export function registerRole(program: Command): void {
  const roleCmd = program
    .command("role")
    .description("Assign or remove a guild role from a member");

  roleCmd
    .command("add")
    .description(
      "Assign a guild role to a member\n" +
        "\n" +
        "  Prerequisite: the bot must have Manage Roles permission in the guild,\n" +
        "  and its highest role must be above the target role in the hierarchy.\n" +
        "  If not, the command exits non-zero with a clear error."
    )
    .requiredOption("-m, --member <id>", "Discord user ID (snowflake) to assign the role to")
    .requiredOption("-r, --role <id-or-name>", "Role snowflake id, or role name (resolved via the guild roles list)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: RoleActionOptions) => {
      if (!isDiscordId(opts.member)) {
        console.error("--member must be a Discord user id (17–20 digits)");
        process.exit(1);
      }

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

      let roleId: string;
      try {
        roleId = await resolveRoleId(ctx.botToken, ctx.guildId, opts.role);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      const result = await assignRole(ctx.botToken, ctx.guildId, opts.member, roleId);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Assigned role ${opts.role} (${roleId}) to member ${opts.member} in guild ${ctx.guildId}`);
    });

  roleCmd
    .command("remove")
    .description(
      "Remove a guild role from a member\n" +
        "\n" +
        "  Prerequisite: the bot must have Manage Roles permission in the guild,\n" +
        "  and its highest role must be above the target role in the hierarchy."
    )
    .requiredOption("-m, --member <id>", "Discord user ID (snowflake) to remove the role from")
    .requiredOption("-r, --role <id-or-name>", "Role snowflake id, or role name (resolved via the guild roles list)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: RoleActionOptions) => {
      if (!isDiscordId(opts.member)) {
        console.error("--member must be a Discord user id (17–20 digits)");
        process.exit(1);
      }

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

      let roleId: string;
      try {
        roleId = await resolveRoleId(ctx.botToken, ctx.guildId, opts.role);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      const result = await removeRole(ctx.botToken, ctx.guildId, opts.member, roleId);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Removed role ${opts.role} (${roleId}) from member ${opts.member} in guild ${ctx.guildId}`);
    });
}
