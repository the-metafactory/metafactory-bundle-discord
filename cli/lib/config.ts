/**
 * Discord CLI configuration — stored at ~/.config/metafactory/cortex/cli.yaml.
 *
 * XDG wave-4 (cortex#1869): the canonical location is
 * `~/.config/metafactory/cortex/cli.yaml`. Reads are canonical-first with
 * `~/.config/cortex/cli.yaml` then `~/.config/grove/cli.yaml` as legacy
 * read-fallbacks during the transition window; the first write migrates any
 * legacy copy to canonical (mode-preserving) and persists canonical-side
 * thereafter. See `config-path.ts` for the full precedence and pin marker.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import YAML from "yaml";
// config-path is vendored INTO this bundle (ADR-0017): the only shared helper
// the Discord CLI depended on in cortex (`common/config/config-path`) is a small
// config-path resolver, copied here so the bundle is standalone. It carries a
// pinned-version marker + drift test so it cannot silently fork from cortex.
import { cortexConfigPath, migrateGroveConfigFile, resolveConfigFilePath } from "./config-path";

export interface ChannelConfig {
  /** Discord channel ID */
  id: string;
}

/**
 * A named server profile — a second (or third, …) guild the same bot is in.
 *
 * Only `guildId` is required: it is the value used for channel/thread NAME
 * resolution within that guild. `botToken`, `defaultChannel`, and `channels`
 * are optional overrides; when absent the top-level (grove) values are used.
 * This lets one token serve every guild the bot has joined while keeping each
 * guild's name→id resolution scoped to the right server.
 */
export interface ServerProfile {
  /** Discord guild/server ID for this profile (required) */
  guildId: string;
  /** Per-profile bot token; falls back to top-level botToken when absent */
  botToken?: string;
  /** Per-profile default channel; falls back to top-level defaultChannel */
  defaultChannel?: string;
  /** Per-profile cached channel name→id map */
  channels?: Record<string, ChannelConfig>;
  /**
   * Confidentiality gate (compass#91, design doc §4 L6 "Discord", OD-5):
   * marks this profile's guild as INTERNAL (never scanned before posting).
   * FAIL-CLOSED default when absent/false — the guild is treated as PUBLIC
   * and scanned. This marker is operator-private: it belongs only in the
   * principal's own `~/.config/metafactory/cortex/cli.yaml`, never in a shipped/example
   * config. See `cli/lib/confidentiality-gate.ts`.
   */
  internal?: boolean;
  /**
   * OD-5: known-public channel/guild snowflake IDs for this profile that are
   * exempt from the platform-id-shape warn (e.g. the grove/community server's
   * own well-known channel IDs). Real IDs are operator-private — this field's
   * VALUES belong only in the principal's own config, never in `.example`.
   */
  publicChannelAllowlist?: string[];
}

export interface DiscordCliConfig {
  /** Discord bot token */
  botToken?: string;
  /** Discord guild/server ID */
  guildId?: string;
  /** Default channel name to post to */
  defaultChannel?: string;
  /** Named channel configs */
  channels?: Record<string, ChannelConfig>;
  /** Named server profiles for guilds other than the top-level (grove) one */
  servers?: Record<string, ServerProfile>;
  /**
   * Confidentiality gate (compass#91): marks the TOP-LEVEL (grove) guild as
   * INTERNAL. See `ServerProfile.internal` — same fail-closed-to-public
   * semantics, same operator-private-only rule.
   */
  internal?: boolean;
  /** Confidentiality gate (compass#91, OD-5): top-level allowlisted snowflakes. */
  publicChannelAllowlist?: string[];
}

const CONFIG_FILENAME = "cli.yaml";

export function loadConfig(): DiscordCliConfig {
  // canonical-first (metafactory/cortex), then legacy cortex/grove fallbacks.
  const path = resolveConfigFilePath(CONFIG_FILENAME);
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  return (YAML.parse(text) as DiscordCliConfig | undefined) ?? {};
}

export function saveConfig(config: DiscordCliConfig): void {
  // On first write, migrate any legacy copy (flat ~/.config/cortex, else grove)
  // to the canonical metafactory/cortex tree (mode-preserving), then always
  // persist to the canonical path.
  migrateGroveConfigFile(CONFIG_FILENAME);
  const path = cortexConfigPath(CONFIG_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(config));
}

export function getConfigPath(): string {
  // The path a reader would resolve right now (canonical if present/default,
  // legacy trees only as the fallback net).
  return resolveConfigFilePath(CONFIG_FILENAME);
}

/**
 * Resolve a channel name to its webhook URL.
 * Falls back to defaultChannel if no name given.
 */
export function resolveChannel(config: DiscordCliConfig, name?: string): { name: string; id?: string } | null {
  const channelName = name ?? config.defaultChannel;
  if (!channelName) return null;

  const ch = config.channels?.[channelName];
  return {
    name: channelName,
    id: ch?.id,
  };
}
