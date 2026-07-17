/**
 * Unit tests for pasted-URL support (issue #35).
 *
 * Two layers under test:
 *   1. `parseDiscordUrl` — pure URL → snowflakes parse: every accepted form
 *      (canonical, ptb/canary, legacy discordapp.com, message-id), and every
 *      rejection (wrong host, non-snowflake segments, path traversal, `@me`,
 *      bare names/ids) returning `null` rather than throwing.
 *   2. `resolveContextWithUrls` + `resolveChannelId` — the wiring seam: a URL
 *      fills the guild when no flag is given, an explicit `--guild`/`--server`
 *      wins, and a URL naming a different guild errors clearly.
 */

import { describe, expect, test } from "bun:test";
import { parseDiscordUrl } from "../lib/discord-url";
import type { DiscordCliConfig } from "../lib/config";
import { ServerContextError } from "../lib/server-context";
import { resolveContextWithUrls, resolveChannelId } from "../commands/shared";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const MESSAGE = "300000000000000003";
const OTHER_GUILD = "900000000000000009";

describe("parseDiscordUrl — accepted forms", () => {
  test("canonical guild/channel URL", () => {
    expect(parseDiscordUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}`)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
    });
  });

  test("guild/channel/message URL exposes messageId", () => {
    expect(
      parseDiscordUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`)
    ).toEqual({ guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE });
  });

  test("ptb subdomain", () => {
    expect(parseDiscordUrl(`https://ptb.discord.com/channels/${GUILD}/${CHANNEL}`)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
    });
  });

  test("canary subdomain", () => {
    expect(parseDiscordUrl(`https://canary.discord.com/channels/${GUILD}/${CHANNEL}`)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
    });
  });

  test("legacy discordapp.com host", () => {
    expect(parseDiscordUrl(`https://discordapp.com/channels/${GUILD}/${CHANNEL}`)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
    });
  });

  test("legacy ptb.discordapp.com host", () => {
    expect(
      parseDiscordUrl(`https://ptb.discordapp.com/channels/${GUILD}/${CHANNEL}`)
    ).toEqual({ guildId: GUILD, channelId: CHANNEL });
  });

  test("trailing slash is tolerated", () => {
    expect(parseDiscordUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}/`)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
    });
  });

  test("surrounding whitespace is trimmed", () => {
    expect(parseDiscordUrl(`  https://discord.com/channels/${GUILD}/${CHANNEL}  `)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
    });
  });

  test("query string and fragment are ignored", () => {
    expect(
      parseDiscordUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}?foo=bar#frag`)
    ).toEqual({ guildId: GUILD, channelId: CHANNEL });
  });

  test("host matching is case-insensitive", () => {
    expect(parseDiscordUrl(`https://Discord.com/channels/${GUILD}/${CHANNEL}`)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
    });
  });
});

describe("parseDiscordUrl — rejections (return null, never throw)", () => {
  test("bare channel name", () => {
    expect(parseDiscordUrl("general")).toBeNull();
  });

  test("bare snowflake id", () => {
    expect(parseDiscordUrl(CHANNEL)).toBeNull();
  });

  test("non-Discord host", () => {
    expect(parseDiscordUrl(`https://evil.com/channels/${GUILD}/${CHANNEL}`)).toBeNull();
  });

  test("look-alike host is not matched as a substring", () => {
    expect(
      parseDiscordUrl(`https://discord.com.evil.com/channels/${GUILD}/${CHANNEL}`)
    ).toBeNull();
  });

  test("non-snowflake guild segment", () => {
    expect(parseDiscordUrl(`https://discord.com/channels/notanid/${CHANNEL}`)).toBeNull();
  });

  test("non-snowflake channel segment", () => {
    expect(parseDiscordUrl(`https://discord.com/channels/${GUILD}/nope`)).toBeNull();
  });

  test("non-snowflake message segment", () => {
    expect(parseDiscordUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}/xx`)).toBeNull();
  });

  test("@me DM URL", () => {
    expect(parseDiscordUrl(`https://discord.com/channels/@me/${CHANNEL}`)).toBeNull();
  });

  test("guild-only URL (no channel segment)", () => {
    expect(parseDiscordUrl(`https://discord.com/channels/${GUILD}`)).toBeNull();
  });

  test("wrong path root", () => {
    expect(parseDiscordUrl(`https://discord.com/users/${GUILD}/${CHANNEL}`)).toBeNull();
  });

  test("too many path segments", () => {
    expect(
      parseDiscordUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}/extra`)
    ).toBeNull();
  });

  test("path traversal collapses to non-snowflake segments", () => {
    expect(parseDiscordUrl("https://discord.com/channels/../../etc/passwd")).toBeNull();
  });

  test("non-http protocol", () => {
    expect(parseDiscordUrl(`ftp://discord.com/channels/${GUILD}/${CHANNEL}`)).toBeNull();
  });

  test("empty string", () => {
    expect(parseDiscordUrl("")).toBeNull();
  });

  // @ts-expect-error — guard against a non-string slipping through at runtime.
  test("non-string input", () => expect(parseDiscordUrl(undefined)).toBeNull());
});

describe("resolveContextWithUrls — guild adoption + precedence", () => {
  function config(): DiscordCliConfig {
    return {
      botToken: "top-token",
      guildId: OTHER_GUILD,
      servers: { halden: { guildId: OTHER_GUILD } },
    };
  }

  const channelUrl = `https://discord.com/channels/${GUILD}/${CHANNEL}`;

  test("URL guild fills context when no --guild/--server given", () => {
    const ctx = resolveContextWithUrls(config(), {}, [channelUrl]);
    expect(ctx.guildId).toBe(GUILD);
  });

  test("no URL and no flags falls back to top-level config (legacy path)", () => {
    const ctx = resolveContextWithUrls(config(), {}, ["general"]);
    expect(ctx.guildId).toBe(OTHER_GUILD);
  });

  test("explicit --guild wins over a URL naming the same guild", () => {
    const sameGuildUrl = `https://discord.com/channels/${OTHER_GUILD}/${CHANNEL}`;
    const ctx = resolveContextWithUrls(config(), { guild: OTHER_GUILD }, [sameGuildUrl]);
    expect(ctx.guildId).toBe(OTHER_GUILD);
  });

  test("--guild that is itself a URL is reduced to its guildId", () => {
    const ctx = resolveContextWithUrls(config(), { guild: channelUrl }, []);
    expect(ctx.guildId).toBe(GUILD);
  });

  test("URL guild conflicting with explicit --guild errors clearly", () => {
    expect(() =>
      resolveContextWithUrls(config(), { guild: OTHER_GUILD }, [channelUrl])
    ).toThrow(ServerContextError);
    expect(() =>
      resolveContextWithUrls(config(), { guild: OTHER_GUILD }, [channelUrl])
    ).toThrow(/Conflicting guild/);
  });

  test("URL guild conflicting with --server profile errors clearly", () => {
    expect(() =>
      resolveContextWithUrls(config(), { server: "halden" }, [channelUrl])
    ).toThrow(/Conflicting guild/);
  });

  test("URL guild agreeing with --server profile is accepted", () => {
    const agreeingUrl = `https://discord.com/channels/${OTHER_GUILD}/${CHANNEL}`;
    const ctx = resolveContextWithUrls(config(), { server: "halden" }, [agreeingUrl]);
    expect(ctx.guildId).toBe(OTHER_GUILD);
  });

  test("two target URLs from different guilds error", () => {
    const otherUrl = `https://discord.com/channels/${OTHER_GUILD}/${CHANNEL}`;
    expect(() => resolveContextWithUrls(config(), {}, [channelUrl, otherUrl])).toThrow(
      /Conflicting guild/
    );
  });
});

describe("resolveChannelId — URL short-circuits name resolution (no network)", () => {
  test("a channel URL resolves to its channelId without any API call", async () => {
    // botToken/guildId are dummies: a fetch would fail the test if reached.
    const id = await resolveChannelId(
      {},
      { guildId: GUILD },
      "unused-token",
      GUILD,
      `https://discord.com/channels/${GUILD}/${CHANNEL}`
    );
    expect(id).toBe(CHANNEL);
  });
});
