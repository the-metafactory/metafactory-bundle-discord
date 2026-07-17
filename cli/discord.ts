#!/usr/bin/env bun
/**
 * discord — Discord CLI (like gh for GitHub)
 *
 * Post messages, read channels, list threads from the terminal.
 * Uses bot token for all operations via Discord REST API.
 *
 * Command groups live in `cli/commands/*` and are wired on by `registerAll`;
 * this file is program setup only. Add a new capability slice by dropping a
 * `cli/commands/<slice>.ts` and registering it from `cli/commands/index.ts`.
 */

import { Command } from "commander";
import { registerAll } from "./commands/index";

const program = new Command()
  .name("discord")
  .description("Discord CLI — post messages, read channels, manage threads")
  .version("0.1.0");

registerAll(program);

program.parse(process.argv);
