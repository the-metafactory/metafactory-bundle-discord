/**
 * Smoke test for the command-module split (issue #9): `registerAll` must wire
 * the SAME command surface the pre-split monolithic `cli/discord.ts` exposed —
 * same top-level command names (and order), same `role` / `config` subcommands.
 *
 * No network, no config I/O: registration only builds the commander tree; the
 * action handlers (which do the I/O) are never invoked here.
 */

import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerAll } from "../commands/index";

function build(): Command {
  const program = new Command().name("discord").version("0.1.0");
  registerAll(program);
  return program;
}

function names(cmd: Command): string[] {
  // Commander injects an implicit `help` command; exclude it for a stable set.
  return cmd.commands.map((c) => c.name()).filter((n) => n !== "help");
}

describe("registerAll", () => {
  test("registers the same top-level commands, in order", () => {
    expect(names(build())).toEqual(["post", "read", "channels", "channel", "threads", "thread", "role", "perms", "event", "webhook", "config"]);
  });

  test("role has member-assignment + lifecycle subcommands", () => {
    const role = build().commands.find((c) => c.name() === "role")!;
    expect(names(role)).toEqual(["add", "remove", "create", "edit", "delete", "reorder", "list"]);
  });

  test("webhook has create, list, delete, exec subcommands", () => {
    const webhook = build().commands.find((c) => c.name() === "webhook")!;
    expect(names(webhook)).toEqual(["create", "list", "delete", "exec"]);
  });

  test("config has set, set-server, get, show, path subcommands", () => {
    const config = build().commands.find((c) => c.name() === "config")!;
    expect(names(config)).toEqual(["set", "set-server", "get", "show", "path"]);
  });

  test("channels exposes the --all flag", () => {
    const channels = build().commands.find((c) => c.name() === "channels")!;
    const flags = channels.options.map((o) => o.long);
    expect(flags).toContain("--all");
  });
});
