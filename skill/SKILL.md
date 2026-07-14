---
name: Discord
description: >-
  Post messages, read channels, and manage threads on Discord from the terminal.
  USE WHEN discord, post to discord, send message, notify channel, read discord,
  check discord, update discord, discord thread, discord channel, announce.
---

# Discord Skill

Discord CLI for posting updates and reading channels — like `gh` for GitHub.

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

## Workflow Routing

**When executing operations:**
-> **READ:** The workflow file first
-> **EXECUTE:** Follow the workflow steps

| Action | Workflow | Trigger Examples |
|--------|----------|------------------|
| **Post** | [Post](Workflows/Post.md) | "post to discord", "send message to discord", "notify channel", "announce" |
| **Read** | [Read](Workflows/Read.md) | "read discord", "check discord messages", "what's happening on discord" |

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
