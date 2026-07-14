# metafactory-discord — Discord CLI + skill bundle

This repo is the Discord **tooling** bundle for the metafactory ecosystem, extracted from cortex per [ADR-0017](https://github.com/the-metafactory/cortex/blob/main/docs/adr/0017-surface-tooling-arc-bundles.md). It is `arc`-installable (repo-first) and self-contained.

## What this is (and isn't)

- **IS:** the Discord CLI (`cli/discord.ts` + `cli/lib/`) and the CLI-wrapping skill (`skill/`). Principal/agent tooling — post / read / threads / roles.
- **IS NOT:** the live Discord adapter (the bot presence). That stays in cortex (`src/adapters/discord/`); it is woven into the bus and is not separable tooling.

## Architecture rules

- **Standalone — no cortex imports.** Nothing here may import from cortex or any `../`-escaping path. The one helper the CLI shared with cortex (`common/config/config-path`) is **vendored** at `cli/lib/config-path.ts`. If you add code that needs a cortex helper, vendor it here too — do not reach back into cortex.
- **No discord.js.** The CLI uses the Discord REST API directly via `fetch`. Runtime deps are `commander` + `yaml` only. Do not add `discord.js` — that is the cortex adapter's dependency.
- **Config location:** `~/.config/metafactory/cortex/cli.yaml` (XDG wave-4 canonical), with `~/.config/cortex/cli.yaml` then `~/.config/grove/cli.yaml` as legacy read-fallbacks (migrate canonical-side on first write, mode-preserving). `$CORTEX_CONFIG_DIR` overrides the whole tree verbatim. This mirrors cortex's resolver — the vendored copy at `cli/lib/config-path.ts` carries a pinned-version marker + a drift test (`cli/__tests__/config-path.drift.test.ts`) that fails if it forks from cortex, so "keep it in sync" is now a mechanism, not a promise: on drift, re-vendor and bump the pin.
- **Install targets** (mirror what cortex installed before extraction):
  - `cli/discord.ts` → `~/bin/discord`
  - `skill/` → `~/.claude/skills/Discord`

## Gate (before any commit)

```bash
bun install
bunx tsc --noEmit   # must exit 0 — bundle compiles standalone
bun test            # CLI tests pass standalone
```

Also confirm no import escapes the repo root and no cortex-relative / `@the-metafactory/` import is unsatisfied.

## Versioning

Version source of truth: `arc-manifest.yaml` (mirrored in `package.json`).

## Bun

Use Bun, not Node/npm:
- `bun <file>`, `bun test`, `bun install`, `bunx <pkg>`.
