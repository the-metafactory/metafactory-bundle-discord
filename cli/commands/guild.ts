/**
 * `discord guild` — guild-level settings (issue #16).
 *
 * Subcommands:
 *   show                — render the guild projection (features, tier, verification, channels).
 *   edit                — PATCH the writable guild fields (verification / channels / description).
 *   community-enable    — orchestrated COMMUNITY enablement (prereqs → features PATCH).
 *   welcome show|set    — welcome-screen read / write (max 5 channels).
 *   onboarding show|set — onboarding read / write (file-based JSON; stands in for screening).
 *
 * Membership screening is intentionally absent: it has NO supported bot API (the
 * /member-verification endpoint was removed). It is configured in the Discord UI;
 * Onboarding is the API-manageable alternative and is what this group manages.
 *
 * Registration is one-subcommand-per-block ON PURPOSE: the snapshot issue (#17)
 * adds `guild snapshot` and the layout issue (#18) adds `guild diff|apply` to this
 * same command group. Keep each block self-contained so those land additively.
 */

import { readFileSync } from "fs";
import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { resolveContextOrExit, resolveChannelId } from "./shared";
import {
  getGuild,
  modifyGuild,
  enableCommunity,
  getWelcomeScreen,
  modifyWelcomeScreen,
  getOnboarding,
  modifyOnboarding,
  verificationLevelName,
  verificationLevelValue,
  MAX_WELCOME_CHANNELS,
  type ModifyGuildSpec,
  type WelcomeChannel,
} from "../lib/guild/settings";

/** Resolve `{ botToken, guildId }` for a guild command, exiting on any gap. */
function resolveGuildContext(opts: ServerContextOptions): {
  config: ReturnType<typeof loadConfig>;
  ctx: ReturnType<typeof resolveContextOrExit>;
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
  return { config, ctx, botToken: ctx.botToken, guildId: ctx.guildId };
}

/**
 * Resolve a `--…-channel` flag (snowflake id OR channel name) to an id, exiting
 * with a clear message when a name doesn't resolve in the guild.
 */
async function resolveChannelOrExit(
  config: ReturnType<typeof loadConfig>,
  ctx: ReturnType<typeof resolveContextOrExit>,
  botToken: string,
  guildId: string,
  flag: string,
  value: string
): Promise<string> {
  const id = await resolveChannelId(config, ctx, botToken, guildId, value);
  if (!id) {
    console.error(`${flag}: channel "${value}" not found in guild ${guildId}.`);
    process.exit(1);
  }
  return id;
}

/** Collect a repeatable option into an array (commander reducer). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// ─── option shapes ────────────────────────────────────────────────────────────

interface EditOptions extends ServerContextOptions {
  verification?: string;
  rulesChannel?: string;
  updatesChannel?: string;
  systemChannel?: string;
  description?: string;
}

interface CommunityEnableOptions extends ServerContextOptions {
  rulesChannel: string;
  updatesChannel: string;
}

interface WelcomeSetOptions extends ServerContextOptions {
  description?: string;
  channel: string[];
  enabled?: boolean;
}

interface OnboardingSetOptions extends ServerContextOptions {
  file: string;
}

/** Shared `-g/-s` context flags applied to each leaf subcommand. */
function withContextFlags(cmd: Command): Command {
  return cmd
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)");
}

export function registerGuild(program: Command): void {
  const guildCmd = program
    .command("guild")
    .description("Guild-level settings: show, edit, community-enable, welcome screen, onboarding");

  // ── show ──────────────────────────────────────────────────────────────────
  withContextFlags(
    guildCmd.command("show").description("Show guild settings (features, tier, verification, channels)")
  ).action(async (opts: ServerContextOptions) => {
    const { botToken, guildId } = resolveGuildContext(opts);
    const g = await getGuild(botToken, guildId);
    console.log(`Guild: ${g.name} (${g.id})`);
    console.log(`  Premium tier:       ${g.premium_tier}`);
    console.log(
      `  Verification level: ${verificationLevelName(g.verification_level)} (${g.verification_level})`
    );
    console.log(`  Rules channel:      ${g.rules_channel_id ?? "(none)"}`);
    console.log(`  Updates channel:    ${g.public_updates_channel_id ?? "(none)"}`);
    console.log(`  System channel:     ${g.system_channel_id ?? "(none)"}`);
    console.log(`  Description:        ${g.description ?? "(none)"}`);
    console.log(`  Features:           ${g.features.length ? g.features.join(", ") : "(none)"}`);
  });

  // ── edit ──────────────────────────────────────────────────────────────────
  withContextFlags(
    guildCmd
      .command("edit")
      .description("Edit writable guild fields")
      .option("--verification <level>", "Verification: none|low|medium|high|highest")
      .option("--rules-channel <id-or-name>", "Rules channel (id or name)")
      .option("--updates-channel <id-or-name>", "Public updates channel (id or name)")
      .option("--system-channel <id-or-name>", "System messages channel (id or name)")
      .option("--description <text>", "Guild description")
  ).action(async (opts: EditOptions) => {
    const { config, ctx, botToken, guildId } = resolveGuildContext(opts);
    const spec: ModifyGuildSpec = {};

    if (opts.verification !== undefined) {
      try {
        spec.verification_level = verificationLevelValue(opts.verification);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }
    if (opts.rulesChannel !== undefined) {
      spec.rules_channel_id = await resolveChannelOrExit(
        config, ctx, botToken, guildId, "--rules-channel", opts.rulesChannel
      );
    }
    if (opts.updatesChannel !== undefined) {
      spec.public_updates_channel_id = await resolveChannelOrExit(
        config, ctx, botToken, guildId, "--updates-channel", opts.updatesChannel
      );
    }
    if (opts.systemChannel !== undefined) {
      spec.system_channel_id = await resolveChannelOrExit(
        config, ctx, botToken, guildId, "--system-channel", opts.systemChannel
      );
    }
    if (opts.description !== undefined) {
      spec.description = opts.description;
    }

    if (Object.keys(spec).length === 0) {
      console.error("Nothing to edit — pass at least one of --verification/--rules-channel/--updates-channel/--system-channel/--description.");
      process.exit(1);
    }

    try {
      const g = await modifyGuild(botToken, guildId, spec);
      console.log(`Updated guild ${g.name} (${g.id}).`);
      console.log(`  Verification level: ${verificationLevelName(g.verification_level)} (${g.verification_level})`);
      console.log(`  Rules channel:      ${g.rules_channel_id ?? "(none)"}`);
      console.log(`  Updates channel:    ${g.public_updates_channel_id ?? "(none)"}`);
      console.log(`  System channel:     ${g.system_channel_id ?? "(none)"}`);
      console.log(`  Description:        ${g.description ?? "(none)"}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

  // ── community-enable ────────────────────────────────────────────────────────
  withContextFlags(
    guildCmd
      .command("community-enable")
      .description(
        "Enable the COMMUNITY feature (unlocks announcement + forum channels)\n" +
          "\n" +
          "  Requires the bot to hold ADMINISTRATOR in the guild. Sets the rules and\n" +
          "  public-updates channels and raises verification to at least LOW first —\n" +
          "  Discord's own 400 body (missing prerequisites) is surfaced verbatim."
      )
      .requiredOption("--rules-channel <id-or-name>", "Rules channel (id or name)")
      .requiredOption("--updates-channel <id-or-name>", "Public updates channel (id or name)")
  ).action(async (opts: CommunityEnableOptions) => {
    const { config, ctx, botToken, guildId } = resolveGuildContext(opts);
    const rulesChannelId = await resolveChannelOrExit(
      config, ctx, botToken, guildId, "--rules-channel", opts.rulesChannel
    );
    const updatesChannelId = await resolveChannelOrExit(
      config, ctx, botToken, guildId, "--updates-channel", opts.updatesChannel
    );

    const result = await enableCommunity(botToken, guildId, { rulesChannelId, updatesChannelId });
    for (const step of result.steps) console.log(`  • ${step}`);
    if (!result.ok) {
      console.error(result.error ?? "COMMUNITY enable failed.");
      process.exit(1);
    }
  });

  // ── welcome show|set ────────────────────────────────────────────────────────
  const welcomeCmd = guildCmd
    .command("welcome")
    .description("Welcome screen (guild must be COMMUNITY; max 5 channels)");

  withContextFlags(
    welcomeCmd.command("show").description("Show the welcome screen")
  ).action(async (opts: ServerContextOptions) => {
    const { botToken, guildId } = resolveGuildContext(opts);
    const ws = await getWelcomeScreen(botToken, guildId);
    console.log(`Welcome screen (guild ${guildId}):`);
    console.log(`  Enabled:     ${ws.enabled ?? false}`);
    console.log(`  Description: ${ws.description ?? "(none)"}`);
    console.log(`  Channels:    ${ws.welcome_channels.length}/${MAX_WELCOME_CHANNELS}`);
    for (const c of ws.welcome_channels) {
      const emoji = c.emoji_name ?? c.emoji_id ?? "";
      console.log(`    ${emoji ? emoji + " " : ""}${c.channel_id} — ${c.description}`);
    }
  });

  withContextFlags(
    welcomeCmd
      .command("set")
      .description(
        "Set the welcome screen. --channel is repeatable, max 5.\n" +
          "  --channel <id-or-name>:<emoji>:<text>  (emoji may be empty: id::text)"
      )
      .option("--description <text>", "Welcome-screen description")
      .option("--enabled", "Enable the welcome screen")
      .option(
        "-c, --channel <spec>",
        "Welcome channel as <id-or-name>:<emoji>:<text> (repeatable, max 5)",
        collect,
        [] as string[]
      )
  ).action(async (opts: WelcomeSetOptions) => {
    const { config, ctx, botToken, guildId } = resolveGuildContext(opts);

    if (opts.channel.length > MAX_WELCOME_CHANNELS) {
      console.error(
        `Too many welcome channels: ${opts.channel.length} (max ${MAX_WELCOME_CHANNELS}).`
      );
      process.exit(1);
    }

    const welcome_channels: WelcomeChannel[] = [];
    for (const spec of opts.channel) {
      const parsed = parseWelcomeChannelSpec(spec);
      if (!parsed) {
        console.error(`--channel: malformed spec "${spec}". Expected <id-or-name>:<emoji>:<text>.`);
        process.exit(1);
      }
      const channelId = await resolveChannelOrExit(
        config, ctx, botToken, guildId, "--channel", parsed.channel
      );
      welcome_channels.push({
        channel_id: channelId,
        description: parsed.text,
        emoji_name: parsed.emoji === "" ? null : isEmojiId(parsed.emoji) ? null : parsed.emoji,
        emoji_id: parsed.emoji === "" ? null : isEmojiId(parsed.emoji) ? parsed.emoji : null,
      });
    }

    const spec: Parameters<typeof modifyWelcomeScreen>[2] = {};
    if (opts.description !== undefined) spec.description = opts.description;
    if (opts.enabled) spec.enabled = true;
    if (welcome_channels.length > 0) spec.welcome_channels = welcome_channels;

    if (Object.keys(spec).length === 0) {
      console.error("Nothing to set — pass --description, --enabled, and/or --channel.");
      process.exit(1);
    }

    try {
      const ws = await modifyWelcomeScreen(botToken, guildId, spec);
      console.log(`Welcome screen updated: enabled=${ws.enabled ?? false}, ${ws.welcome_channels.length} channel(s).`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

  // ── onboarding show|set ─────────────────────────────────────────────────────
  const onboardingCmd = guildCmd
    .command("onboarding")
    .description("Onboarding (COMMUNITY required) — the API-manageable stand-in for membership screening");

  withContextFlags(
    onboardingCmd.command("show").description("Show onboarding config")
  ).action(async (opts: ServerContextOptions) => {
    const { botToken, guildId } = resolveGuildContext(opts);
    const ob = await getOnboarding(botToken, guildId);
    console.log(`Onboarding (guild ${guildId}):`);
    console.log(`  Enabled:            ${ob.enabled ?? false}`);
    console.log(`  Mode:               ${ob.mode ?? 0}`);
    console.log(`  Prompts:            ${ob.prompts?.length ?? 0}`);
    console.log(`  Default channels:   ${ob.default_channel_ids?.length ?? 0}`);
    console.log(JSON.stringify(ob, null, 2));
  });

  withContextFlags(
    onboardingCmd
      .command("set")
      .description(
        "Set onboarding from a JSON file (complex nested shape — file-based input).\n" +
          "  The JSON's top level may hold: prompts[], default_channel_ids[], enabled, mode."
      )
      .requiredOption("--file <json>", "Path to a JSON file with the onboarding spec")
  ).action(async (opts: OnboardingSetOptions) => {
    const { botToken, guildId } = resolveGuildContext(opts);

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(opts.file, "utf8"));
    } catch (err) {
      console.error(`--file: could not read/parse "${opts.file}": ${(err as Error).message}`);
      process.exit(1);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("--file: expected a JSON object at the top level.");
      process.exit(1);
    }

    try {
      const ob = await modifyOnboarding(botToken, guildId, parsed as Parameters<typeof modifyOnboarding>[2]);
      console.log(`Onboarding updated: enabled=${ob.enabled ?? false}, ${ob.prompts?.length ?? 0} prompt(s).`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
}

/** True if `value` is a Discord snowflake (custom-emoji id), vs a unicode emoji. */
function isEmojiId(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

/**
 * Parse a welcome-channel spec `<id-or-name>:<emoji>:<text>`. Splits on the first
 * two colons only, so the description text may itself contain colons. The emoji
 * segment may be empty (`id::text`). Returns null when there aren't two colons.
 */
export function parseWelcomeChannelSpec(
  spec: string
): { channel: string; emoji: string; text: string } | null {
  const firstColon = spec.indexOf(":");
  if (firstColon === -1) return null;
  const secondColon = spec.indexOf(":", firstColon + 1);
  if (secondColon === -1) return null;
  const channel = spec.slice(0, firstColon);
  const emoji = spec.slice(firstColon + 1, secondColon);
  const text = spec.slice(secondColon + 1);
  if (channel === "") return null;
  return { channel, emoji, text };
}
