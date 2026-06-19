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
      config.ts          # ~/.config/cortex/cli.yaml config (cortex-first, grove-fallback)
      config-path.ts     # vendored path resolver (the one helper cortex shared)
      discord.ts         # Discord REST API ops (post/read/threads/roles) — raw fetch, no discord.js
      server-context.ts  # multi-guild server-profile resolution
    __tests__/           # standalone bun tests
  skill/
    SKILL.md             # the CLI-wrapping skill (→ ~/.claude/skills/Discord)
    Workflows/Post.md
    Workflows/Read.md
  package.json  tsconfig.json  README.md  CLAUDE.md  .gitignore
```

The CLI talks to the Discord REST API directly via `fetch` — it does **not** depend on `discord.js` (that's the cortex adapter's dependency, not the tooling's). Runtime deps are just `commander` + `yaml`.

## Install

Repo-first (the bundle is **not** on the metafactory registry yet):

```bash
arc install <git-url of metafactory-discord>
```

This installs the `~/bin/discord` shim and the `Discord` skill at `~/.claude/skills/Discord`. Config lives at `~/.config/cortex/cli.yaml` (cortex-first, with a `~/.config/grove/cli.yaml` legacy fallback that migrates on first write).

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
