---
name: Discord
description: >-
  Post messages, read channels, and manage a Discord guild from the terminal —
  roles, channels, permission overwrites, threads, scheduled events, webhooks,
  guild-level settings, and a declarative snapshot/diff/apply loop.
  USE WHEN discord, post to discord, send message, notify channel, read discord,
  check discord, update discord, discord thread, discord channel, announce,
  discord role, channel permissions, guild layout, snapshot guild, apply layout.
---

# Discord Skill

Discord CLI for posting updates, reading channels, and managing a whole guild —
like `gh` for GitHub.

> *"From PAI to Discord. Discord to PAI is done through Grove."*

## CLI Tool

Discord uses a CLI at `~/bin/discord`. **All commands are bash commands:**

```bash
discord post "Your message here"           # Post to default channel
discord post --channel tasks "PR merged"   # Post to specific channel
discord read                               # Read last 10 messages
discord channels                           # List server channels
discord threads                            # List active threads
```

Run `discord --help` for full command list.

### Multi-server (posting to a guild other than the default)

The bot can be in several guilds with the same token. Target another guild
either by a one-off `--guild <id>` (overrides the guild used for channel/thread
name resolution) or by a saved `--server <name>` profile:

```bash
# One-off: resolve the channel name in another guild
discord post --guild 123456789012345678 --channel general "Deployed to staging"

# Saved profile (register once, then reference by name):
discord config set-server myserver 123456789012345678 general
discord post --server myserver "Deployed to staging"
discord read  --server myserver
```

Precedence: explicit `--guild`/`--channel` flags  >  `--server` profile  >
top-level config. With neither flag, behaviour is identical to single-guild.
Cached `channels.<name>.id` entries are used only when their owning guild
matches the selected `--guild`/`--server` context; otherwise the CLI resolves
the name inside the selected guild or fails loudly.

---

## Guild management

Beyond post/read, the CLI manages a guild's whole structure: roles, channels,
permission overwrites (the "ring gate"), threads, scheduled events, webhooks, and
guild-level settings — plus a declarative **snapshot → diff → apply** loop for
authoring a guild from a YAML layout. Run `discord guild --help` for the group
list; the command map below is the full surface.

### Safety defaults — read before you mutate a guild

These are shipped behaviours, not conventions. They cannot be turned off:

- **`guild apply` is a dry run by default.** Without `--execute` it prints the
  ordered plan and mutates **nothing**. You must add `--execute` to touch the
  guild. A dry run always ends with `Dry run (no --execute): nothing was changed.`
- **Deletion is opt-in twice over.** `guild apply` **never** deletes a live
  resource just because it is missing from the layout — that resource is reported
  `unmanaged` and left alone. Removing something requires **both** a `prune:`
  block in the layout naming it **and** the `--prune` flag. One without the other
  deletes nothing.
- **Destructive single commands require confirmation.** `role delete`,
  `channel delete`, and `event delete` refuse to run without `-y/--yes`;
  `webhook delete` needs `-y/--yes` too. Managed roles (bot / integration /
  booster) are refused outright — Discord owns their lifecycle.
- **Credentials never appear in output.** `webhook create` prints the webhook URL
  **once** (it is a posting credential — store it yourself; the CLI never saves
  it); `webhook list` never shows token values; `guild snapshot` never serializes
  webhook tokens. The bot token lives only in `cli.yaml`, never in output.

### Command map

Every group takes `-g/--guild <id>` and `-s/--server <name>` to target a guild
other than the config default (same precedence as `post`, see above).

**`role`** — assign/remove on members, and manage the role list:

```bash
discord role list                                   # position-sorted, highest first
discord role add    -m <userId> -r Builder          # assign a role (id or name)
discord role remove -m <userId> -r Builder
discord role create -n Builder -c '#E67E22' --hoist --mentionable
discord role edit   -r Builder -n Maker             # only the flags you pass change
discord role reorder -r Builder -p 5                # higher position = higher in hierarchy
discord role delete -r Builder -y                   # destructive → needs -y
```

**`channel`** — create/edit/delete channels and categories, list, and manage forum tags:

```bash
discord channel create -n workshop-floor -t text -p Workshop --topic "Members' floor"
discord channel create -n Workshop -t category           # a category
discord channel edit   -c workshop-floor --slowmode 10
discord channel list                                      # same as `discord channels --all`
discord channel tags set  -c build-logs -t wip -t shipped -t help-wanted   # replaces the full tag set
discord channel tags list -c build-logs
discord channel delete -c old-channel -y                  # irreversible → needs -y
```

**`perms`** — channel permission overwrites (the ring gate: deny `@everyone`, allow a role):

```bash
discord perms set   -c strategy -r '@everyone' --deny VIEW_CHANNEL
discord perms set   -c strategy -r Builder      --allow VIEW_CHANNEL,SEND_MESSAGES
discord perms show  -c strategy                 # decodes allow/deny masks back to names
discord perms sync  -c strategy                 # copy the parent category's overwrites
discord perms clear -c strategy -r Builder
```

The overwrite is **replaced** (allow/deny are the complete masks for that target),
and a bot can only grant permissions it itself holds.

**`thread`** — create and manage guild threads (active listing is `discord threads`):

```bash
discord thread create -c workshop-floor -n "Build log: v0.6.0"   # prints the thread id
discord thread add    -t <threadId> -m <userId>
discord thread remove -t <threadId> -m <userId>
discord thread archive   -t <threadId>                           # retained, not deleted
discord thread unarchive -t <threadId>
discord thread list -c workshop-floor --archived                 # archived only
```

**`event`** — guild scheduled events (the muster roll — RSVP-able musters):

```bash
discord event create -n "Sprint muster" --start 2026-08-01T19:00:00+12:00 --voice general
discord event create -n "Meetup" --start 2026-08-01T19:00:00+12:00 \
  --location "Wellington" --end 2026-08-01T21:00:00+12:00          # EXTERNAL → --end required
discord event list                                                 # with RSVP counts
discord event rsvps  --event <eventId>
discord event edit   --event <eventId> -n "New name"
discord event delete --event <eventId> --yes                       # destructive → needs --yes
```

**`webhook`** — per-message identity; the URL is a credential shown once:

```bash
discord webhook create -c announcements -n "Release Bot"   # prints the URL ONCE — store it yourself
discord webhook list                                        # never shows token values
discord webhook exec -u <webhookUrl> -m "Shipped v0.6.0" -a "Release Bot"
discord webhook delete -w <webhookId> -y                    # irreversible → needs -y
```

**`guild`** — guild-level settings and the declarative layout loop:

```bash
discord guild show                                          # features, tier, verification, channels
discord guild edit --verification low --rules-channel welcome
discord guild community-enable --rules-channel welcome --updates-channel mod-log
discord guild welcome show
discord guild welcome set --enabled --channel 'welcome::Start here'
discord guild onboarding show
discord guild onboarding set --file onboarding.json

# The snapshot → diff → apply loop (full walkthrough: Workflows/GuildSetup.md):
discord guild snapshot -o guild.snapshot.yaml               # read the live guild → YAML
discord guild diff  --layout guild-layout.yaml              # plan; exit 1 on drift, 0 in sync
discord guild apply --layout guild-layout.yaml              # DRY RUN — prints plan, mutates nothing
discord guild apply --layout guild-layout.yaml --execute    # actually build it
```

For the end-to-end guild-authoring walkthrough, read
[GuildSetup](Workflows/GuildSetup.md).

---

## Workflow Routing

**When executing operations:**
-> **READ:** The workflow file first
-> **EXECUTE:** Follow the workflow steps

| Action | Workflow | Trigger Examples |
|--------|----------|------------------|
| **Post** | [Post](Workflows/Post.md) | "post to discord", "send message to discord", "notify channel", "announce" |
| **Read** | [Read](Workflows/Read.md) | "read discord", "check discord messages", "what's happening on discord" |
| **GuildSetup** | [GuildSetup](Workflows/GuildSetup.md) | "set up a guild", "author a guild layout", "snapshot the guild", "apply a layout", "diff the guild" |

---

## Setup

If `discord config show` returns empty, guide the user:

1. `discord config set botToken <token>`
2. `discord config set guildId <id>`
3. `discord config set defaultChannel <name>`

For a second guild the bot has joined (e.g. a staging server), register a profile:

4. `discord config set-server myserver <guildId> [defaultChannel]`

Or hand-edit the `servers:` block in the config file:

```yaml
servers:
  myserver:
    guildId: "123456789012345678"
    defaultChannel: general   # optional; falls back to top-level
    # botToken / channels optional — omitted fields fall back to top-level
```

Config stored at `~/.config/metafactory/cortex/cli.yaml` (read canonical-first with `~/.config/cortex/cli.yaml` then `~/.config/grove/cli.yaml` as legacy fallbacks during the XDG transition; first write migrates the legacy copy canonical-side).

## Attachments

`discord post --file <path>` attaches a local file (repeatable); the message text is optional when a file is present. Files are read + existence-checked before the post, so a bad path posts nothing.
