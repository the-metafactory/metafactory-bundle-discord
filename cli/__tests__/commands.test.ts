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
    expect(names(build())).toEqual(["post", "dm", "read", "channels", "channel", "threads", "thread", "forum", "role", "perms", "event", "webhook", "guild", "config"]);
  });

  test("dm carries no channel-addressing option — a DM can never become a post", () => {
    const dm = build().commands.find((c) => c.name() === "dm")!;
    const flags = dm.options.map((o) => o.long);
    // The whole point of the verb: no --channel, no --thread, no --guild, no
    // --server. If one of these is ever added, a misconfigured DM could land in
    // a room full of people, which is the failure this command exists to refuse.
    expect(flags).not.toContain("--channel");
    expect(flags).not.toContain("--thread");
    expect(flags).not.toContain("--guild");
    expect(flags).not.toContain("--server");
    expect(flags).toContain("--to");
  });

  test("role has member-assignment + lifecycle subcommands", () => {
    const role = build().commands.find((c) => c.name() === "role")!;
    expect(names(role)).toEqual(["add", "remove", "create", "edit", "delete", "reorder", "list"]);
  });

  test("forum has post, tags, posts, retag subcommands", () => {
    const forum = build().commands.find((c) => c.name() === "forum")!;
    expect(names(forum)).toEqual(["post", "tags", "posts", "retag"]);
  });

  test("webhook has create, list, delete, exec subcommands", () => {
    const webhook = build().commands.find((c) => c.name() === "webhook")!;
    expect(names(webhook)).toEqual(["create", "list", "delete", "exec"]);
  });

  test("guild has show, edit, community-enable, welcome, onboarding, snapshot, diff, apply subcommands", () => {
    const guild = build().commands.find((c) => c.name() === "guild")!;
    expect(names(guild)).toEqual(["show", "edit", "community-enable", "welcome", "onboarding", "snapshot", "diff", "apply"]);
    const welcome = guild.commands.find((c) => c.name() === "welcome")!;
    expect(names(welcome)).toEqual(["show", "set"]);
    const onboarding = guild.commands.find((c) => c.name() === "onboarding")!;
    expect(names(onboarding)).toEqual(["show", "set"]);
  });

  test("config has set, set-server, get, show, path subcommands", () => {
    const config = build().commands.find((c) => c.name() === "config")!;
    expect(names(config)).toEqual(["set", "set-server", "get", "show", "path"]);
  });

  test("guild diff and apply both expose --layout and the repeatable --var", () => {
    const guild = build().commands.find((c) => c.name() === "guild")!;
    for (const name of ["diff", "apply"]) {
      const cmd = guild.commands.find((c) => c.name() === name)!;
      const flags = cmd.options.map((o) => o.long);
      expect(flags).toContain("--layout");
      expect(flags).toContain("--var");
    }
  });

  test("channels exposes the --all flag", () => {
    const channels = build().commands.find((c) => c.name() === "channels")!;
    const flags = channels.options.map((o) => o.long);
    expect(flags).toContain("--all");
  });
});
