/**
 * `discord role …` — guild role tooling.
 *
 *   add|remove   — assign or remove a role from a member (O-5, community-fleet
 *                  admission). Moved verbatim from `cli/discord.ts` during the
 *                  command-module split (#9).
 *   create|edit|delete|reorder|list — full role lifecycle (issue #10), built on
 *                  `cli/lib/guild/roles.ts`.
 *
 * Target use cases:
 *   discord role add --server community --role community-fleet --member <discord-user-id>
 *   discord role create --name Adventurer --color '#3B82F6' --hoist --server community
 *   discord role list --server community
 *
 * Prerequisites (the bot must meet these; if not, the 403 branch fires):
 *   • Bot token has the Manage Roles permission in the target guild.
 *   • The bot's highest role sits ABOVE the target role in the guild role hierarchy.
 *   The commands document these requirements but do NOT attempt to self-grant them.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { assignRole, removeRole, resolveRoleId } from "../lib/discord";
import {
  createRole,
  modifyRole,
  deleteRole,
  reorderRoles,
  listRoles,
  type RoleSpec,
} from "../lib/guild/roles";
import { resolveContextOrExit, isDiscordId } from "./shared";

interface RoleActionOptions extends ServerContextOptions {
  member: string;
  role: string;
}

/** Options shared by role fields the `create`/`edit` subcommands accept. */
interface RoleFieldOptions extends ServerContextOptions {
  name?: string;
  color?: string;
  hoist?: boolean;
  mentionable?: boolean;
  icon?: string;
  emoji?: string;
}

interface RoleCreateOptions extends RoleFieldOptions {
  name: string;
}

interface RoleEditOptions extends RoleFieldOptions {
  role: string;
}

interface RoleDeleteOptions extends ServerContextOptions {
  role: string;
  yes?: boolean;
}

interface RoleReorderOptions extends ServerContextOptions {
  role: string;
  position: string;
}

/**
 * Resolve the effective guild context (token + guild id) or exit non-zero with a
 * clear message. Mirrors the token/guild guards the add/remove actions inline.
 */
function requireGuildContext(opts: ServerContextOptions): {
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
    console.error("Guild ID required. Run: discord config set guildId <id> OR use --guild/--server");
    process.exit(1);
  }
  return { botToken: ctx.botToken, guildId: ctx.guildId };
}

/** Parse a `#RRGGBB` (or `RRGGBB`) hex colour into a Discord integer, or exit. */
function parseColorOrExit(hex: string): number {
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    console.error(`--color must be a 6-digit hex like '#3B82F6' (got: ${hex})`);
    process.exit(1);
  }
  return parseInt(cleaned, 16);
}

/** Read an icon file into a base64 data-URI, or exit with a clear message. */
function readIconDataUriOrExit(file: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    console.error(`--icon file not readable: ${file}`);
    process.exit(1);
  }
  const ext = file.toLowerCase().split(".").pop() ?? "";
  const mime =
    ext === "png"
      ? "image/png"
      : ext === "gif"
        ? "image/gif"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : "";
  if (!mime) {
    console.error(`--icon must be a .png, .jpg, or .gif file (got: .${ext || "?"})`);
    process.exit(1);
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Build a `RoleSpec` from the shared create/edit field options. */
function specFromFieldOptions(opts: RoleFieldOptions): RoleSpec {
  const spec: RoleSpec = {};
  if (opts.name !== undefined) spec.name = opts.name;
  if (opts.color !== undefined) spec.color = parseColorOrExit(opts.color);
  if (opts.hoist) spec.hoist = true;
  if (opts.mentionable) spec.mentionable = true;
  if (opts.icon !== undefined) spec.icon = readIconDataUriOrExit(opts.icon);
  if (opts.emoji !== undefined) spec.unicode_emoji = opts.emoji;
  return spec;
}

/** Render a Discord colour integer as a display string (`0` → `default`). */
function colorHex(color: number): string {
  return color === 0 ? "default" : `#${color.toString(16).padStart(6, "0")}`;
}

export function registerRole(program: Command): void {
  const roleCmd = program
    .command("role")
    .description("Manage guild roles: assign/remove on members, and create/edit/delete/reorder/list");

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

  // ─── create ──────────────────────────────────────────────────────────────
  roleCmd
    .command("create")
    .description(
      "Create a guild role\n" +
        "\n" +
        "  --icon / --emoji require the guild to be Boost Level 2 (ROLE_ICONS);\n" +
        "  on a non-boosted guild the command exits non-zero with a one-line reason."
    )
    .requiredOption("-n, --name <name>", "Role name")
    .option("-c, --color <hex>", "Role colour as #RRGGBB (e.g. '#3B82F6')")
    .option("--hoist", "Display members with this role separately in the sidebar")
    .option("--mentionable", "Allow anyone to @mention this role")
    .option("--icon <file>", "Role icon image file (.png/.jpg/.gif; needs Boost Level 2)")
    .option("--emoji <unicode>", "Unicode emoji as the role icon (needs Boost Level 2)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: RoleCreateOptions) => {
      const { botToken, guildId } = requireGuildContext(opts);
      const spec = specFromFieldOptions(opts);

      const result = await createRole(botToken, guildId, spec);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Created role ${result.role.name} (${result.role.id}) in guild ${guildId}`);
    });

  // ─── edit ────────────────────────────────────────────────────────────────
  roleCmd
    .command("edit")
    .description("Edit an existing guild role (only the flags you pass are changed)")
    .requiredOption("-r, --role <id-or-name>", "Role snowflake id, or role name (resolved via the guild roles list)")
    .option("-n, --name <name>", "New role name")
    .option("-c, --color <hex>", "Role colour as #RRGGBB (e.g. '#3B82F6')")
    .option("--hoist", "Display members with this role separately in the sidebar")
    .option("--mentionable", "Allow anyone to @mention this role")
    .option("--icon <file>", "Role icon image file (.png/.jpg/.gif; needs Boost Level 2)")
    .option("--emoji <unicode>", "Unicode emoji as the role icon (needs Boost Level 2)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: RoleEditOptions) => {
      const { botToken, guildId } = requireGuildContext(opts);
      const spec = specFromFieldOptions(opts);
      if (Object.keys(spec).length === 0) {
        console.error("Nothing to edit — pass at least one of --name/--color/--hoist/--mentionable/--icon/--emoji");
        process.exit(1);
      }

      let roleId: string;
      try {
        roleId = await resolveRoleId(botToken, guildId, opts.role);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      const result = await modifyRole(botToken, guildId, roleId, spec);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Updated role ${result.role.name} (${result.role.id}) in guild ${guildId}`);
    });

  // ─── delete ──────────────────────────────────────────────────────────────
  roleCmd
    .command("delete")
    .description(
      "Delete a guild role\n" +
        "\n" +
        "  Requires --yes to confirm (this is destructive). Managed roles (bot /\n" +
        "  integration / booster roles) are refused — Discord owns their lifecycle."
    )
    .requiredOption("-r, --role <id-or-name>", "Role snowflake id, or role name (resolved via the guild roles list)")
    .option("-y, --yes", "Confirm the deletion (without it, the command aborts)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: RoleDeleteOptions) => {
      const { botToken, guildId } = requireGuildContext(opts);

      if (!opts.yes) {
        console.error(`Refusing to delete role "${opts.role}" without confirmation. Re-run with --yes.`);
        process.exit(1);
      }

      let roleId: string;
      try {
        roleId = await resolveRoleId(botToken, guildId, opts.role);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      // Refuse managed roles — Discord owns those (bot/integration/booster roles)
      // and rejects the delete anyway; catch it locally with a clear message.
      const listing = await listRoles(botToken, guildId);
      if (!listing.success) {
        console.error(`Failed: ${listing.error}`);
        process.exit(1);
      }
      const target = listing.roles.find((r) => r.id === roleId);
      if (target?.managed) {
        console.error(`Refusing to delete managed role "${target.name}" (${roleId}) — it is owned by a bot, integration, or booster and cannot be deleted here.`);
        process.exit(1);
      }

      const result = await deleteRole(botToken, guildId, roleId);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Deleted role ${opts.role} (${roleId}) from guild ${guildId}`);
    });

  // ─── reorder ─────────────────────────────────────────────────────────────
  roleCmd
    .command("reorder")
    .description("Move a role to a new position in the guild hierarchy")
    .requiredOption("-r, --role <id-or-name>", "Role snowflake id, or role name (resolved via the guild roles list)")
    .requiredOption("-p, --position <n>", "Target position (integer; higher = higher in the hierarchy)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: RoleReorderOptions) => {
      const { botToken, guildId } = requireGuildContext(opts);

      const position = Number(opts.position);
      if (!Number.isInteger(position) || position < 0) {
        console.error(`--position must be a non-negative integer (got: ${opts.position})`);
        process.exit(1);
      }

      let roleId: string;
      try {
        roleId = await resolveRoleId(botToken, guildId, opts.role);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      const result = await reorderRoles(botToken, guildId, [{ id: roleId, position }]);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Reordered role ${opts.role} (${roleId}) to position ${position} in guild ${guildId}`);
    });

  // ─── list ────────────────────────────────────────────────────────────────
  roleCmd
    .command("list")
    .description("List guild roles (position-sorted, highest first) with the managed flag")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: ServerContextOptions) => {
      const { botToken, guildId } = requireGuildContext(opts);

      const result = await listRoles(botToken, guildId);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }

      console.log(
        `  ${"pos".padStart(4)}  ${"name".padEnd(24)}  ${"id".padEnd(20)}  ${"color".padEnd(9)}  hoist  managed`
      );
      for (const r of result.roles) {
        console.log(
          `  ${String(r.position).padStart(4)}  ${r.name.padEnd(24)}  ${r.id.padEnd(20)}  ` +
            `${colorHex(r.color).padEnd(9)}  ${(r.hoist ? "yes" : "no").padEnd(5)}  ${r.managed ? "yes" : "no"}`
        );
      }
    });
}
