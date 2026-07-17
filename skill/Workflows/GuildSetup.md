# Set Up a Guild from a Layout

Author a Discord guild's structure — roles, categories, channels, permission
overwrites, forum tags, guild settings — from a single declarative YAML file, and
keep the live guild in sync with it. This is the **snapshot → author → diff →
apply → verify → iterate** loop.

Read the safety defaults in [SKILL.md](../SKILL.md#safety-defaults--read-before-you-mutate-a-guild)
first. The two that matter most:

- **`guild apply` does nothing without `--execute`** — the default is a dry run.
- **Nothing is ever deleted** unless it is both named in a `prune:` block **and**
  you pass `--prune`.

## Command reference (verified)

`discord guild --help`, run locally (no bot token needed) against this bundle:

<!-- TODO: replace with live sandbox output once the sandbox guild exists (epic #20 holds) -->
```text
Usage: discord guild [options] [command]

Guild-level settings: show, edit, community-enable, welcome screen, onboarding

Commands:
  show [options]              Show guild settings (features, tier, verification,
                              channels)
  edit [options]              Edit writable guild fields
  community-enable [options]  Enable the COMMUNITY feature (unlocks announcement + forum channels)
  welcome                     Welcome screen (guild must be COMMUNITY; max 5
                              channels)
  onboarding                  Onboarding (COMMUNITY required) — the
                              API-manageable stand-in for membership screening
  snapshot [options]          Read the entire live guild into one deterministic YAML document
  diff [options]              Diff a declarative guild layout against the live guild (CI drift check).
  apply [options]             Apply a declarative guild layout to the live guild.
  help [command]              display help for command
```

## Prerequisites

1. **A sandbox guild you can safely mutate.** Never rehearse `apply --execute`
   against a live community. Register it as a server profile so every command can
   target it with `--server <name>`:
   ```bash
   discord config set-server sandbox <sandboxGuildId>
   ```
2. **The bot is in that guild with the permissions the layout needs** — typically
   Manage Roles, Manage Channels, and (for `community-enable`) Administrator. A
   command that lacks a permission exits non-zero with Discord's own reason.

## Steps

1. **Snapshot the live guild** — read its entire current state into one
   deterministic YAML document. This is your starting point and your backup.
   ```bash
   discord guild snapshot --server sandbox -o guild.snapshot.yaml
   ```
   The snapshot captures guild settings, roles, categories, channels (with
   overwrites), events, webhooks, and the welcome screen. Webhook tokens are
   **never** serialized. A section the bot cannot read renders as
   `unavailable(...)` with a stderr warning; the exit stays 0 (a partial snapshot
   beats a crash). Running it twice yields byte-identical output apart from the
   header timestamp.

   <!-- TODO: replace with live sandbox output once the sandbox guild exists (epic #20 holds) -->
   ```text
   Wrote guild snapshot to guild.snapshot.yaml
   ```

2. **Author the layout** — write (or copy and edit) a declarative layout that
   describes the structure the guild *should* have. Start from the worked example
   shipped in the bundle, which demonstrates every feature (ring-gated categories,
   a forum with tags, category- and channel-level overwrites):
   ```bash
   cp ../../examples/guild-layout.example.yaml guild-layout.yaml
   # then edit roles / categories / channels / guild to taste
   ```
   Identity is **by name** (channels by name + parent category). Renaming a
   resource in the layout reads as delete-then-create, not a rename.

3. **Diff the layout against the live guild** — see exactly what would change
   before touching anything. `diff` mutates nothing; it exits 1 when there is
   drift (a non-empty plan) and 0 when the guild already matches — so it doubles
   as a CI drift check.
   ```bash
   discord guild diff --layout guild-layout.yaml --server sandbox
   ```
   Live resources absent from the layout are reported `unmanaged` and are never
   part of a delete.

   <!-- TODO: replace with live sandbox output once the sandbox guild exists (epic #20 holds) -->
   ```text
   + role "Builder"
   + category "Workshop"
   + channel "workshop-floor" (parent: Workshop)
   + overwrite on "Workshop": deny VIEW_CHANNEL for @everyone
   ...
   (plan lines above; command exits 1 because the plan is non-empty = drift)
   ```

4. **Dry-run the apply** — `apply` without `--execute` prints the same ordered
   plan it *would* run and changes nothing. Always look at this before executing.
   ```bash
   discord guild apply --layout guild-layout.yaml --server sandbox
   ```
   The plan runs in dependency order: roles → categories → channels → overwrites →
   forum tags → guild settings, resolving created ids as it goes.

   <!-- TODO: replace with live sandbox output once the sandbox guild exists (epic #20 holds) -->
   ```text
   + role "Builder"
   + category "Workshop"
   + channel "workshop-floor" (parent: Workshop)
   ...

   Dry run (no --execute): nothing was changed. Re-run with --execute to apply.
   ```

5. **Execute** — once the dry-run plan is what you want, add `--execute`.
   ```bash
   discord guild apply --layout guild-layout.yaml --server sandbox --execute
   ```
   It stops on the first failure and reports `Completed N of M action(s)`; a
   re-run re-diffs and resumes at the remainder, so `apply --execute` is
   idempotent — running it twice on a matching guild is a no-op.

   <!-- TODO: replace with live sandbox output once the sandbox guild exists (epic #20 holds) -->
   ```text
   + role "Builder"
   + category "Workshop"
   ...

   Executing...
   Applied 12 of 12 action(s).
   ```

6. **Verify, then iterate** — confirm the guild now matches: a clean `diff` exits
   0 with an empty plan.
   ```bash
   discord guild diff --layout guild-layout.yaml --server sandbox   # exit 0 = in sync
   ```
   Change the layout, re-run step 3 (diff) → step 4 (dry run) → step 5 (execute).
   That is the whole loop.

## Deleting managed resources (opt-in, twice)

`apply` is non-destructive by default: something live but missing from the layout
is reported `unmanaged` and left alone. To actually remove it, name it under a
`prune:` block in the layout **and** pass `--prune`:

```yaml
# in guild-layout.yaml
prune:
  channels: [old-channel-name]
  categories: []
  roles: []
```

```bash
discord guild apply --layout guild-layout.yaml --server sandbox --execute --prune
```

Omit either the `prune:` entry or the `--prune` flag and nothing is deleted.

## Notes

- **Config location** and **multi-server precedence** are exactly as for `post` —
  see [SKILL.md](../SKILL.md). `--guild` and `--server` must not disagree on the
  guild id; the CLI errors if they do.
- `community-enable` requires the bot to hold ADMINISTRATOR and surfaces Discord's
  own 400 body verbatim when prerequisites are missing. `welcome` and `onboarding`
  require the guild to already be COMMUNITY.
- Keep the snapshot from step 1. If an execute goes wrong, it is the record of the
  prior state.
- Never run `apply --execute` against a production guild you have not diffed first.
