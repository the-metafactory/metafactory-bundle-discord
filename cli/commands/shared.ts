/**
 * Cross-command helpers shared by the `cli/commands/*` modules: server-context
 * resolution with CLI-exit semantics, channel name→id resolution + caching, and
 * the Discord-id shape guard.
 *
 * Extracted verbatim from the former monolithic `cli/discord.ts` during the
 * command-module split (issue #9) — behaviour is unchanged; this is a pure move
 * so the command slices share one copy instead of each re-inlining it.
 */

import { saveConfig } from "../lib/config";
import type { DiscordCliConfig } from "../lib/config";
import { cachedChannelId, resolveServerContext, ServerContextError } from "../lib/server-context";
import type { ResolvedServerContext, ServerContextOptions } from "../lib/server-context";
import { listChannels, resolveChannelByName } from "../lib/discord";

/**
 * Resolve the effective server context for a command, translating a
 * `ServerContextError` into a CLI error + exit. Returns a context whose
 * `guildId`/`botToken` are then validated by the caller exactly as before.
 */
export function resolveContextOrExit(
  config: DiscordCliConfig,
  opts: ServerContextOptions
): ResolvedServerContext {
  try {
    return resolveServerContext(config, opts);
  } catch (err) {
    if (err instanceof ServerContextError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Cache a freshly-resolved channel id back into config, writing to the active
 * server profile's `channels` map when a `--server` profile is in effect, else
 * to the top-level `channels`. Keeps each guild's name→id cache isolated so a
 * name that exists in two guilds never cross-contaminates.
 */
function cacheChannelId(
  config: DiscordCliConfig,
  ctx: ResolvedServerContext,
  channelName: string,
  channelId: string
): void {
  const profile = ctx.serverName ? config.servers?.[ctx.serverName] : undefined;
  if (profile) {
    profile.channels ??= {};
    profile.channels[channelName] = { id: channelId };
  } else {
    config.channels ??= {};
    config.channels[channelName] = { id: channelId };
  }
}

export async function resolveChannelId(
  config: DiscordCliConfig,
  ctx: ResolvedServerContext,
  botToken: string,
  guildId: string,
  channelName: string
): Promise<string | undefined> {
  if (isDiscordId(channelName)) {
    const channels = await listChannels(botToken, guildId);
    return channels.some((channel) => channel.id === channelName) ? channelName : undefined;
  }

  const cached = cachedChannelId(ctx, channelName);
  if (cached) return cached;

  const resolved = (await resolveChannelByName(botToken, guildId, channelName)) ?? undefined;
  if (resolved) {
    cacheChannelId(config, ctx, channelName, resolved);
    saveConfig(config);
  }
  return resolved;
}

export function isDiscordId(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}
