/**
 * `discord dm` — send a direct message to one user.
 *
 * The CLI's other verbs all address a GUILD: a channel, a thread, a forum post,
 * an audience. This one does not. It opens the bot's DM channel with a single
 * recipient and posts there, and it holds one invariant above all others:
 *
 *   A DM NEVER FALLS BACK TO A CHANNEL.
 *
 * There is no `--channel`, no `defaultChannel`, no guild resolution and no
 * implicit recipient. If the recipient is missing or the DM cannot be opened,
 * the command FAILS — because the failure mode worth designing against is a
 * private progress note quietly landing in a room full of people.
 *
 * Recipient precedence: `--to <userId>` > `dmRecipient` in config. Nothing else.
 */

import type { Command } from "commander";
import { basename } from "node:path";
import { loadConfig } from "../lib/config";
import {
  openDmChannel,
  postMessage,
  postMessageWithFiles,
  type AttachmentInput,
} from "../lib/discord";
import { isDiscordId } from "./shared";

interface DmOptions {
  to?: string;
  file?: string[];
}

export function registerDm(program: Command): void {
  program
    .command("dm")
    .description("Send a direct message to a user (never a guild channel)")
    .argument("[message...]", "Message text (optional when --file is given)")
    .option("-t, --to <userId>", "Recipient user id (default: dmRecipient from config)")
    .option("-f, --file <path>", "Attach a file (repeatable)", (v: string, acc: string[]) => [...acc, v], [])
    .action(async (messageParts: string[], opts: DmOptions) => {
      const config = loadConfig();
      const message = messageParts.join(" ");
      const filePaths = opts.file ?? [];

      // A DM must carry something. Checked before any network call so an empty
      // invocation leaves no trace.
      if (message.length === 0 && filePaths.length === 0) {
        console.error("Nothing to send: provide a message, one or more --file, or both.");
        process.exit(1);
      }

      const botToken = config.botToken;
      if (!botToken) {
        console.error("Bot token required. Run: discord config set botToken <token>");
        process.exit(1);
      }

      // No recipient means STOP. This is the whole point of the command: there
      // is no channel to degrade to, so an unset recipient is an error, never a
      // default.
      const recipient = opts.to ?? config.dmRecipient;
      if (!recipient) {
        console.error(
          "No DM recipient. Pass --to <userId>, or set one:  discord config set dmRecipient <userId>\n" +
            "  (`dm` never falls back to a channel — an unset recipient is an error by design.)"
        );
        process.exit(1);
      }
      if (!isDiscordId(recipient)) {
        console.error(`Not a Discord user id: ${JSON.stringify(recipient)} (expected 17-20 digits).`);
        process.exit(1);
      }

      // Read + existence-check attachments BEFORE opening the DM, so a bad path
      // sends nothing.
      const attachments: AttachmentInput[] = [];
      for (const path of filePaths) {
        const f = Bun.file(path);
        if (!(await f.exists())) {
          console.error(`Attachment not found: ${path}`);
          process.exit(1);
        }
        attachments.push({ filename: basename(path), bytes: new Uint8Array(await f.arrayBuffer()) });
      }

      const dm = await openDmChannel(botToken, recipient);
      if (!dm.success) {
        console.error(`Could not open a DM with ${recipient}: ${dm.error}`);
        console.error("  The bot must share a guild with the recipient, and the recipient must accept DMs from server members.");
        process.exit(1);
      }

      const result = attachments.length > 0
        ? await postMessageWithFiles(botToken, dm.channelId, message, attachments)
        : await postMessage(botToken, dm.channelId, message);

      if (!result.success) {
        console.error(`Failed to send DM: ${result.error}`);
        process.exit(1);
      }

      const withFiles = attachments.length > 0 ? ` (+${attachments.length} file${attachments.length === 1 ? "" : "s"})` : "";
      console.log(`DM sent to ${recipient}${withFiles} — message ${result.messageId}`);
    });
}
