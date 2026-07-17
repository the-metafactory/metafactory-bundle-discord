# metafactory-discord

Discord **CLI + skill** bundle for the metafactory ecosystem — `arc`-installable, independently versioned, reusable outside cortex.

Extracted from cortex per [ADR-0017](https://github.com/the-metafactory/cortex/blob/main/docs/adr/0017-surface-tooling-arc-bundles.md): surface *tooling* (the CLI + skills agents use) lives in per-surface bundles, while cortex core keeps the live surface **adapter** (the bot presence woven into the bus). This is the first such bundle; `metafactory-mattermost`, `metafactory-slack`, … follow the same shape.

## What's in here

```
metafactory-discord/
  arc-manifest.yaml      # capability declaration (name: discord, namespace: metafactory)
  cli/
    discord.ts           # the CLI entrypoint (→ ~/bin/discord)
    lib/
      config.ts               # ~/.config/metafactory/cortex/cli.yaml config (canonical-first, legacy fallbacks)
      config-path.ts          # vendored path resolver (pinned + drift-tested; the one helper cortex shared)
      confidentiality-gate.ts # public-post scan gate before postMessage* (compass#91)
      discord.ts              # Discord REST API ops (post/read/threads/roles) — raw fetch, no discord.js
      server-context.ts       # multi-guild server-profile resolution
    __tests__/           # standalone bun tests
  skill/
    SKILL.md             # the CLI-wrapping skill (→ ~/.claude/skills/Discord)
    Workflows/Post.md
    Workflows/Read.md
  cli.yaml.example      # config schema reference — placeholders only, never real IDs/tokens
  package.json  tsconfig.json  README.md  CLAUDE.md  .gitignore
```

The CLI talks to the Discord REST API directly via `fetch` — it does **not** depend on `discord.js` (that's the cortex adapter's dependency, not the tooling's). Runtime deps are just `commander` + `yaml`.

## Install

Repo-first (the bundle is **not** on the metafactory registry yet):

```bash
arc install <git-url of metafactory-discord>
```

This installs the `~/bin/discord` shim and the `Discord` skill at `~/.claude/skills/Discord`. Config lives at `~/.config/metafactory/cortex/cli.yaml` (canonical-first, with `~/.config/cortex/cli.yaml` then `~/.config/grove/cli.yaml` legacy fallbacks that migrate canonical-side on first write). See [`cli.yaml.example`](cli.yaml.example) for the schema — real guild/channel IDs and the confidentiality-gate markers below belong only in your own config, never committed here.

## Confidentiality gate

Before `discord post` sends a message, `cli/lib/confidentiality-gate.ts` classifies the resolved destination guild and — for any guild not explicitly marked `internal: true` in config — scans the message text and attachments through the shared metafactory confidentiality scan engine (installed via `arc upgrade compass`). See the module's doc comment and [`cli.yaml.example`](cli.yaml.example) for the `internal` / `publicChannelAllowlist` config fields.

**This rollout is advisory (warn-only):** findings are logged to stderr and appended to `~/.config/metafactory/confidentiality/ack-log.jsonl`, but the post still sends. See design doc compass#81 §4 L6 ("Discord") + OD-5 for the full posture — enforcing the block on the live post path, the real `internal: true` guild registry, and the OD-5 public-channel allowlist values are deliberately deferred to the principal (this is the highest-volume egress path every teammate/agent uses, and the shared denylist isn't populated yet).

## Usage

```bash
discord post "PR merged, tests passing"              # Default channel
discord post --channel tasks "Deployed v0.5.0"       # Specific channel
discord post --thread 123456789012345678 "Done"      # Specific thread
discord read                                          # Read last 10 messages
discord --help                                        # Full command list
```

### Commands

Top-level command groups (from `discord --help`):

```
post       Post a message to a Discord channel
read       Read recent messages from a channel or thread
channels   List channels in the Discord server
channel    Create, edit, delete, and list guild channels (incl. forum tags)
threads    List active threads in the Discord server
thread     Create and manage guild threads (public/private, members, archive)
role       Manage guild roles: assign/remove on members, and create/edit/delete/reorder/list
perms      Manage channel permission overwrites
event      Manage guild scheduled events (create, edit, delete, RSVP list)
webhook    Manage guild webhooks (create/list/delete) and post with per-message identity
guild      Guild-level settings: show, edit, community-enable, welcome screen, onboarding
config     Manage discord CLI configuration
help       Display help for command
```

Each group has its own `--help` (e.g. `discord guild --help`). The full
guild-management surface, its worked examples, and its safety defaults live in
[`skill/SKILL.md`](skill/SKILL.md); the end-to-end guild-authoring walkthrough is
[`skill/Workflows/GuildSetup.md`](skill/Workflows/GuildSetup.md).

### Guild layout (declarative snapshot / diff / apply)

Beyond one-off commands, a guild's whole structure can be authored from a single
YAML layout and kept in sync with it:

```bash
discord guild snapshot --server sandbox -o guild.snapshot.yaml   # read live guild → YAML
discord guild diff  --layout guild-layout.yaml --server sandbox  # plan; exit 1 on drift
discord guild apply --layout guild-layout.yaml --server sandbox  # DRY RUN — changes nothing
discord guild apply --layout guild-layout.yaml --server sandbox --execute   # build it
```

A worked layout demonstrating role-gated categories, a forum with tags, and
overwrite patterns ships at
[`examples/guild-layout.example.yaml`](examples/guild-layout.example.yaml). A short excerpt:

```yaml
roles:
  Member:
    color: 0x3B82F6
    hoist: true
    permissions: [VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY]
categories:
  Workshop:                       # members-only: deny @everyone, allow Member
    overwrites:
      "@everyone": { deny: [VIEW_CHANNEL] }
      Member:      { allow: [VIEW_CHANNEL] }
channels:
  workshop-floor:
    type: text
    parent: Workshop
    topic: "Members' working channel."
```

**Safety defaults** (shipped, not conventions):

- `guild apply` is a **dry run** without `--execute` — it prints the plan and changes nothing.
- Deletion requires **both** a `prune:` block in the layout **and** the `--prune` flag; unmanaged resources are never deleted.
- `role`/`channel`/`event`/`webhook delete` refuse to run without `-y/--yes`.
- Webhook URLs are printed once and never stored; webhook/bot tokens never appear in `list` or `snapshot` output.

## Develop

```bash
bun install
bun test            # standalone CLI tests
bunx tsc --noEmit   # standalone typecheck (no cortex imports)
```

## License

MIT
