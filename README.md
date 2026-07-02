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
      config.ts               # ~/.config/cortex/cli.yaml config (cortex-first, grove-fallback)
      config-path.ts          # vendored path resolver (the one helper cortex shared)
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

This installs the `~/bin/discord` shim and the `Discord` skill at `~/.claude/skills/Discord`. Config lives at `~/.config/cortex/cli.yaml` (cortex-first, with a `~/.config/grove/cli.yaml` legacy fallback that migrates on first write). See [`cli.yaml.example`](cli.yaml.example) for the schema — real guild/channel IDs and the confidentiality-gate markers below belong only in your own config, never committed here.

## Confidentiality gate

Before `discord post` sends a message, `cli/lib/confidentiality-gate.ts` classifies the resolved destination guild and — for any guild not explicitly marked `internal: true` in config — scans the message text and attachments through the shared metafactory confidentiality scan engine (installed via `arc upgrade compass`). See the module's doc comment and [`cli.yaml.example`](cli.yaml.example) for the `internal` / `publicChannelAllowlist` config fields.

**This rollout is advisory (warn-only):** findings are logged to stderr and appended to `~/.config/metafactory/confidentiality/ack-log.jsonl`, but the post still sends. See design doc compass#81 §4 L6 ("Discord") + OD-5 for the full posture — enforcing the block on the live post path, the real `internal: true` guild registry, and the OD-5 public-channel allowlist values are deliberately deferred to the principal (this is the highest-volume egress path every teammate/agent uses, and the shared denylist isn't populated yet).

## Usage

```bash
discord post "PR merged, tests passing"              # Default channel
discord post --channel tasks "Deployed v0.5.0"       # Specific channel
discord post --thread 1487204875912609844 "Done"     # Specific thread
discord read                                          # Read last 10 messages
discord --help                                        # Full command list
```

## Develop

```bash
bun install
bun test            # standalone CLI tests
bunx tsc --noEmit   # standalone typecheck (no cortex imports)
```

## License

MIT
