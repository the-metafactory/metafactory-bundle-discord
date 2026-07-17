/**
 * `discord config set|set-server|get|show|path` — manage the CLI config.
 *
 * Moved verbatim from `cli/discord.ts` during the command-module split (#9),
 * including the dot-notation nested get/set helpers.
 */

import type { Command } from "commander";
import YAML from "yaml";
import { loadConfig, saveConfig, getConfigPath } from "../lib/config";
import { registerServerProfile, ServerContextError } from "../lib/server-context";

// `setNestedValue`/`getNestedValue` walk an arbitrarily-nested config tree.
// `JsonObject` is the recursive shape: every leaf is a string (the only
// value type the CLI's `discord config set <key> <value>` ever writes) or
// another nested object. The cortex.yaml shape (DiscordCliConfig) satisfies
// this constraint structurally, so the helpers don't need to reach for any.
type ConfigValue = string | ConfigObject | undefined;
interface ConfigObject {
  [key: string]: ConfigValue;
}

export function registerConfig(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage discord CLI configuration");

  configCmd
    .command("set")
    .description("Set a config value (dot-notation: channels.collab.id)")
    .argument("<key>", "Config key (dot notation)")
    .argument("<value>", "Config value")
    .action((key: string, value: string) => {
      const config = loadConfig();
      setNestedValue(config as unknown as ConfigObject, key, value);
      saveConfig(config);
      console.log(`Set ${key} = ${value.length > 50 ? value.slice(0, 50) + "..." : value}`);
    });

  configCmd
    .command("set-server")
    .description("Register a named server profile (a second guild the bot is in)")
    .argument("<name>", "Profile name (e.g. halden)")
    .argument("<guildId>", "Discord guild/server ID for the profile")
    .argument("[defaultChannel]", "Optional default channel name for the profile")
    .action((name: string, guildId: string, defaultChannel?: string) => {
      const config = loadConfig();
      try {
        registerServerProfile(config, name, guildId, defaultChannel);
      } catch (err) {
        if (err instanceof ServerContextError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }
      saveConfig(config);
      console.log(
        `Registered server "${name}" → guild ${guildId}` +
          (defaultChannel ? ` (default channel #${defaultChannel})` : "")
      );
    });

  configCmd
    .command("get")
    .description("Get a config value")
    .argument("<key>", "Config key (dot notation)")
    .action((key: string) => {
      const config = loadConfig();
      const value = getNestedValue(config as unknown as ConfigObject, key);
      if (value === undefined) {
        console.error(`Key "${key}" not found.`);
        process.exit(1);
      }
      console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : value);
    });

  configCmd
    .command("show")
    .description("Show full configuration")
    .action(() => {
      const config = loadConfig();
      console.log(`# ${getConfigPath()}\n`);
      console.log(YAML.stringify(config));
    });

  configCmd
    .command("path")
    .description("Print config file path")
    .action(() => {
      console.log(getConfigPath());
    });
}

function setNestedValue(obj: ConfigObject, key: string, value: string): void {
  const parts = key.split(".");
  if (parts.length === 0) return;
  let current: ConfigObject = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? "";
    const next = current[part];
    if (next === undefined || typeof next !== "object") {
      current[part] = {};
    }
    current = current[part] as ConfigObject;
  }
  const leaf = parts[parts.length - 1] ?? "";
  current[leaf] = value;
}

function getNestedValue(obj: ConfigObject, key: string): ConfigValue {
  const parts = key.split(".");
  let current: ConfigValue = obj;
  for (const part of parts) {
    if (current === undefined || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}
