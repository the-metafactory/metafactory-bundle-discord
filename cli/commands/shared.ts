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
import { parseDiscordUrl } from "../lib/discord-url";

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
  // A pasted discord.com/channels URL carries the target snowflake directly —
  // use it and skip name resolution (threads are channels; the id works either
  // way against /channels/{id}/messages). Guild adoption/conflict is handled at
  // context-resolution time (resolveContextWithUrls), not here.
  const url = parseDiscordUrl(channelName);
  if (url) return url.channelId;

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

/**
 * Reduce the single guild a set of pasted URLs agree on, or throw if they
 * disagree. `values` are raw `--channel`/`--thread`/`--guild` strings; non-URL
 * values (names, bare ids) contribute nothing. Returns `undefined` when no value
 * is a Discord URL.
 */
function urlGuildFrom(values: (string | undefined)[]): string | undefined {
  let guildId: string | undefined;
  for (const value of values) {
    if (!value) continue;
    const parsed = parseDiscordUrl(value);
    if (!parsed) continue;
    if (guildId && guildId !== parsed.guildId) {
      throw new ServerContextError(
        `Conflicting guild in pasted URLs: ${guildId} vs ${parsed.guildId}. ` +
          `Pass URLs from a single server.`
      );
    }
    guildId = parsed.guildId;
  }
  return guildId;
}

/**
 * Resolve server context with pasted-URL awareness — the seam that lets a
 * `discord.com/channels/<guild>/…` URL supply the guild when no `--guild`/
 * `--server` was given.
 *
 * `targets` are the raw channel/thread values the command received (each may be
 * a URL). Precedence, per issue #35: explicit `--guild`/`--server` always win;
 * a URL guild only fills context when neither is present. When an explicit flag
 * IS present and a URL names a different guild, this throws rather than guessing.
 *
 * Pure (throws `ServerContextError`); callers translate that into a CLI exit via
 * `resolveContextOrExit`'s pattern. `--guild <url>` is normalised to its guildId
 * here too, so the flag itself accepts a pasted URL.
 */
export function resolveContextWithUrls(
  config: DiscordCliConfig,
  opts: ServerContextOptions,
  targets: (string | undefined)[]
): ResolvedServerContext {
  const urlGuild = urlGuildFrom(targets);

  // `--guild` may itself be a pasted URL — reduce it to its guildId first so an
  // explicit URL flag behaves exactly like an explicit bare id.
  let guildOpt = opts.guild;
  if (guildOpt) {
    const parsed = parseDiscordUrl(guildOpt);
    if (parsed) guildOpt = parsed.guildId;
  }

  if (guildOpt) {
    // Explicit guild wins; a target URL naming a different guild is a mistake.
    if (urlGuild && urlGuild !== guildOpt) {
      throw new ServerContextError(
        `Conflicting guild: pasted URL is in guild ${urlGuild} but --guild ` +
          `resolves to ${guildOpt}. Pass only one, or make them agree.`
      );
    }
    return resolveServerContext(config, { guild: guildOpt, server: opts.server });
  }

  if (opts.server) {
    // Explicit profile wins; a target URL must agree with the profile's guild.
    const ctx = resolveServerContext(config, { server: opts.server });
    if (urlGuild && ctx.guildId && urlGuild !== ctx.guildId) {
      throw new ServerContextError(
        `Conflicting guild: pasted URL is in guild ${urlGuild} but --server ` +
          `"${opts.server}" resolves to guild ${ctx.guildId}. Pass only one, or make them agree.`
      );
    }
    return ctx;
  }

  // No explicit flag — adopt the URL's guild for context when present, else the
  // legacy top-level path (byte-identical to a bare `resolveServerContext`).
  return resolveServerContext(config, urlGuild ? { guild: urlGuild } : {});
}

/**
 * `resolveContextWithUrls` + CLI-exit semantics — the URL-aware sibling of
 * `resolveContextOrExit`. Translates a `ServerContextError` into a printed
 * message + `process.exit(1)`.
 */
export function resolveContextWithUrlsOrExit(
  config: DiscordCliConfig,
  opts: ServerContextOptions,
  targets: (string | undefined)[]
): ResolvedServerContext {
  try {
    return resolveContextWithUrls(config, opts, targets);
  } catch (err) {
    if (err instanceof ServerContextError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
