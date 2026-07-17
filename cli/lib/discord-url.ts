/**
 * Parse a pasted Discord share URL into its snowflake segments.
 *
 * Principals paste `https://discord.com/channels/<guild>/<channel-or-thread>[/<message>]`
 * (the canonical share format) into `--channel`/`--thread`/`--guild`. This module
 * turns that string into ids the resolver can use directly, skipping name
 * resolution. Threads are channels in Discord's model (globally-unique snowflake,
 * `parent_id` link), so the second segment is a valid message target whether it
 * names a channel or a thread — the caller need not tell them apart.
 *
 * `parseDiscordUrl` NEVER throws and NEVER hits the network: anything that is not
 * a well-formed Discord channel URL with snowflake segments returns `null`, so a
 * bare name or id falls through to the existing name-resolution path unchanged.
 */

/**
 * Discord snowflake shape (17–20 digits). Mirrors the canonical guard in
 * `cli/lib/discord.ts` (`isSnowflake`) and `cli/commands/shared.ts`
 * (`isDiscordId`); kept inline here so this module stays dependency-free.
 */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Hosts Discord serves the web client from. `discord.com` is canonical;
 * `ptb.`/`canary.` are the public test/beta builds; `discordapp.com` is the
 * legacy domain still emitted by old clients and bookmarks. All produce the
 * same `/channels/<guild>/<channel>[/<message>]` path shape.
 */
const DISCORD_HOSTS = new Set([
  "discord.com",
  "ptb.discord.com",
  "canary.discord.com",
  "discordapp.com",
  "ptb.discordapp.com",
  "canary.discordapp.com",
]);

/** The snowflake ids carried by a Discord channel/thread/message URL. */
export interface ParsedDiscordUrl {
  /** Guild (server) snowflake — the first path segment after `/channels`. */
  guildId: string;
  /** Channel or thread snowflake — a valid message target either way. */
  channelId: string;
  /**
   * Message snowflake, when the URL is a jump-to-message link. Parsed and
   * exposed, but no command consumes it yet (issue #35 scope).
   */
  messageId?: string;
}

/**
 * Parse `input` as a Discord channel URL. Returns the extracted snowflakes on a
 * match, or `null` for anything else (bare name, bare id, non-Discord URL,
 * malformed path, non-snowflake or `@me` segments, path traversal). Never throws.
 */
export function parseDiscordUrl(input: string): ParsedDiscordUrl | null {
  if (typeof input !== "string") return null;

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    // Not a URL at all (e.g. a bare channel name or snowflake id).
    return null;
  }

  // Only the Discord web client, only over http(s). `URL` has already collapsed
  // any `../` path traversal, so a crafted path decays to non-snowflake segments
  // and is rejected below.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!DISCORD_HOSTS.has(url.hostname.toLowerCase())) return null;

  // Path: /channels/<guild>/<channel>[/<message>]  → 3 or 4 non-empty segments.
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 3 || segments.length > 4) return null;
  if (segments[0] !== "channels") return null;

  const guildId = segments[1];
  const channelId = segments[2];
  const messageId = segments[3];

  // Every segment must be a snowflake. This rejects `@me` (DM) URLs, guild-only
  // links, and any tampered/non-numeric segment.
  if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) return null;
  if (messageId !== undefined && !SNOWFLAKE.test(messageId)) return null;

  return messageId !== undefined
    ? { guildId, channelId, messageId }
    : { guildId, channelId };
}
