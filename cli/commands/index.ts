/**
 * Command registry — the single entry point that wires every command group onto
 * the root program. `cli/discord.ts` calls `registerAll(program)` after program
 * setup; each future guild-config slice adds its `register*` here (and its own
 * `cli/commands/<slice>.ts`), keeping the slices in disjoint files.
 *
 * Registration order defines the order `discord --help` lists the commands, so
 * it is kept identical to the pre-split monolithic `cli/discord.ts`.
 */

import type { Command } from "commander";
import { registerPost } from "./post";
import { registerRead } from "./read";
import { registerChannels } from "./channels";
import { registerChannel } from "./channel";
import { registerThreads } from "./threads";
import { registerThread } from "./thread";
import { registerRole } from "./role";
import { registerPerms } from "./perms";
import { registerEvent } from "./event";
import { registerWebhook } from "./webhook";
import { registerGuild } from "./guild";
import { registerConfig } from "./config";

export function registerAll(program: Command): void {
  registerPost(program);
  registerRead(program);
  registerChannels(program);
  registerChannel(program);
  registerThreads(program);
  registerThread(program);
  registerRole(program);
  registerPerms(program);
  registerEvent(program);
  registerWebhook(program);
  registerGuild(program);
  registerConfig(program);
}
