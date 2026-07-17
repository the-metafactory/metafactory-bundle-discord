/**
 * `discord event create|edit|delete|list|rsvps` — guild scheduled events, the
 * native "muster roll" RSVP mechanism (issue #14).
 *
 *   discord event create --name "The Muster" --start <ISO> --end <ISO> --location "guild voice"
 *   discord event create --name "Standup"    --start <ISO> --voice general
 *   discord event edit   --event <id> --name "The Muster I"
 *   discord event delete --event <id> --yes
 *   discord event list
 *   discord event rsvps  --event <id>
 *
 * Entity type is inferred from the flags: `--voice` → VOICE (2), `--location` →
 * EXTERNAL (3, end time then required). Client-side validation (past start,
 * EXTERNAL-without-end) lives in cli/lib/guild/events.ts and fails before any
 * network call.
 *
 * Recurring events are out of scope (Discord `recurrence_rule` is newer surface;
 * defer until a Muster needs it).
 */

import type { Command } from "commander";
import { loadConfig } from "../lib/config";
import type { ServerContextOptions } from "../lib/server-context";
import { listAllChannels } from "../lib/discord";
import {
  createEvent,
  modifyEvent,
  deleteEvent,
  listEvents,
  collectEventUsers,
  eventTypeName,
  EntityType,
  type EventSpec,
  type EventEditSpec,
  type EntityTypeValue,
} from "../lib/guild/events";
import { resolveContextOrExit, isDiscordId } from "./shared";

interface CreateOptions extends ServerContextOptions {
  name: string;
  start: string;
  end?: string;
  voice?: string;
  location?: string;
  description?: string;
}

interface EditOptions extends ServerContextOptions {
  event: string;
  name?: string;
  start?: string;
  end?: string;
  voice?: string;
  location?: string;
  description?: string;
}

interface DeleteOptions extends ServerContextOptions {
  event: string;
  yes?: boolean;
}

interface EventIdOptions extends ServerContextOptions {
  event: string;
}

/**
 * Resolve a `--voice` value (snowflake or channel name) to a voice channel id.
 * Matches VOICE (type 2) channels case-insensitively; returns null when no
 * voice channel matches so the caller can print a clear error.
 */
async function resolveVoiceChannelId(
  botToken: string,
  guildId: string,
  value: string
): Promise<string | null> {
  if (isDiscordId(value)) return value;
  const channels = await listAllChannels(botToken, guildId);
  const lower = value.toLowerCase();
  const match = channels.find((c) => c.type === 2 && c.name.toLowerCase() === lower);
  return match?.id ?? null;
}

/** Guard: exactly one of botToken/guildId missing → exit with a clear message. */
function requireContext(botToken?: string, guildId?: string): asserts botToken is string {
  if (!botToken) {
    console.error("Bot token required. Run: discord config set botToken <token>");
    process.exit(1);
  }
  if (!guildId) {
    console.error("Guild ID required. Run: discord config set guildId <id> OR use --guild/--server");
    process.exit(1);
  }
}

export function registerEvent(program: Command): void {
  const eventCmd = program
    .command("event")
    .description("Manage guild scheduled events (the muster roll: RSVP-able musters and team efforts)");

  // ── create ────────────────────────────────────────────────────────────────
  eventCmd
    .command("create")
    .description(
      "Create a scheduled event\n" +
        "\n" +
        "  --voice <channel>  → a VOICE event in that channel.\n" +
        "  --location <text>  → an EXTERNAL event (then --end is required).\n" +
        "  Recurring events are not supported yet (Discord recurrence_rule); defer\n" +
        "  until a Muster needs it."
    )
    .requiredOption("-n, --name <name>", "Event name")
    .requiredOption("--start <ISO8601>", "Start time, ISO8601 (e.g. 2026-08-01T19:00:00+12:00)")
    .option("--end <ISO8601>", "End time, ISO8601 (required for --location/EXTERNAL)")
    .option("--voice <channel-id-or-name>", "Voice channel (makes this a VOICE event)")
    .option("--location <text>", "Physical location (makes this an EXTERNAL event)")
    .option("-d, --description <text>", "Event description")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: CreateOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      requireContext(ctx.botToken, ctx.guildId);
      const guildId = ctx.guildId as string;

      if (opts.voice && opts.location) {
        console.error("Pass only one of --voice or --location (voice vs external event).");
        process.exit(1);
      }

      let entityType: EntityTypeValue;
      let channelId: string | undefined;
      let location: string | undefined;

      if (opts.voice) {
        entityType = EntityType.VOICE;
        const resolved = await resolveVoiceChannelId(ctx.botToken, guildId, opts.voice);
        if (!resolved) {
          console.error(`Voice channel "${opts.voice}" not found in guild ${guildId}.`);
          process.exit(1);
        }
        channelId = resolved;
      } else if (opts.location) {
        entityType = EntityType.EXTERNAL;
        location = opts.location;
      } else {
        console.error("Specify --voice <channel> (VOICE event) or --location <text> (EXTERNAL event).");
        process.exit(1);
      }

      const spec: EventSpec = {
        name: opts.name,
        scheduledStartTime: opts.start,
        entityType,
        ...(opts.end !== undefined ? { scheduledEndTime: opts.end } : {}),
        ...(channelId !== undefined ? { channelId } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      };

      const result = await createEvent(ctx.botToken, guildId, spec);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      const ev = result.event;
      console.log(`Created event "${ev?.name}" (${ev?.id}) — ${eventTypeName(ev?.entity_type ?? entityType)}, starts ${ev?.scheduled_start_time}`);
    });

  // ── edit ────────────────────────────────────────────────────────────────
  eventCmd
    .command("edit")
    .description("Edit a scheduled event (only the flags you pass are changed)")
    .requiredOption("--event <id>", "Event ID to edit")
    .option("-n, --name <name>", "New event name")
    .option("--start <ISO8601>", "New start time, ISO8601")
    .option("--end <ISO8601>", "New end time, ISO8601")
    .option("--voice <channel-id-or-name>", "New voice channel (VOICE event)")
    .option("--location <text>", "New location (EXTERNAL event)")
    .option("-d, --description <text>", "New description")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: EditOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      requireContext(ctx.botToken, ctx.guildId);
      const guildId = ctx.guildId as string;

      if (opts.voice && opts.location) {
        console.error("Pass only one of --voice or --location.");
        process.exit(1);
      }

      const spec: EventEditSpec = {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.start !== undefined ? { scheduledStartTime: opts.start } : {}),
        ...(opts.end !== undefined ? { scheduledEndTime: opts.end } : {}),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      };

      if (opts.voice) {
        const resolved = await resolveVoiceChannelId(ctx.botToken, guildId, opts.voice);
        if (!resolved) {
          console.error(`Voice channel "${opts.voice}" not found in guild ${guildId}.`);
          process.exit(1);
        }
        spec.entityType = EntityType.VOICE;
        spec.channelId = resolved;
      } else if (opts.location) {
        spec.entityType = EntityType.EXTERNAL;
        spec.location = opts.location;
      }

      const result = await modifyEvent(ctx.botToken, guildId, opts.event, spec);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Updated event ${opts.event}.`);
    });

  // ── delete ────────────────────────────────────────────────────────────────
  eventCmd
    .command("delete")
    .description("Delete a scheduled event (requires --yes to confirm)")
    .requiredOption("--event <id>", "Event ID to delete")
    .option("--yes", "Confirm deletion (required — this cannot be undone)")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: DeleteOptions) => {
      if (!opts.yes) {
        console.error("Refusing to delete without --yes. Re-run with --yes to confirm.");
        process.exit(1);
      }
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      requireContext(ctx.botToken, ctx.guildId);
      const guildId = ctx.guildId as string;

      const result = await deleteEvent(ctx.botToken, guildId, opts.event);
      if (!result.success) {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Deleted event ${opts.event}.`);
    });

  // ── list ────────────────────────────────────────────────────────────────
  eventCmd
    .command("list")
    .description("List the guild's scheduled events with RSVP counts")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: ServerContextOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      requireContext(ctx.botToken, ctx.guildId);
      const guildId = ctx.guildId as string;

      const events = await listEvents(ctx.botToken, guildId);
      if (events.length === 0) {
        console.log("No scheduled events.");
        return;
      }
      for (const ev of events) {
        const type = eventTypeName(ev.entity_type).padEnd(8);
        const count = ev.user_count ?? 0;
        console.log(`  ${ev.id}  ${ev.name.padEnd(30)} ${type} ${ev.scheduled_start_time}  (${count} interested)`);
      }
    });

  // ── rsvps ────────────────────────────────────────────────────────────────
  eventCmd
    .command("rsvps")
    .description("List the users who RSVP'd 'interested' to an event")
    .requiredOption("--event <id>", "Event ID to list RSVPs for")
    .option("-g, --guild <id>", "Guild ID (overrides config)")
    .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
    .action(async (opts: EventIdOptions) => {
      const config = loadConfig();
      const ctx = resolveContextOrExit(config, opts);
      requireContext(ctx.botToken, ctx.guildId);
      const guildId = ctx.guildId as string;

      const users = await collectEventUsers(ctx.botToken, guildId, opts.event);
      if (users.length === 0) {
        console.log("No RSVPs yet.");
        return;
      }
      for (const u of users) {
        console.log(`  ${u.username.padEnd(30)} ${u.id}`);
      }
      console.log(`\n${users.length} interested${users.length >= 100 ? " (paginated across multiple pages)" : ""}.`);
    });
}
