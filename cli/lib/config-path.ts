/**
 * GV-1 (cortex#1076, EPIC cortex#1075 Phase 1) — config-FILE path resolver.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VENDORED FROM cortex `src/common/config/config-path.ts` (ADR-0017).
 *
 * This is a **pinned, standalone copy** of cortex's config-file resolver so the
 * Discord bundle can ship without importing from cortex. A vendored copy is a
 * fork unless it carries a pinned-version marker AND a test that fails on drift
 * (cortex#1867 plan v3 §1.4 rule 3, trap T10). Both live here:
 *
 *   - Pin marker: {@link VENDORED_CORTEX_RESOLVER_PIN} below.
 *   - Drift test: `cli/__tests__/config-path.drift.test.ts` — an independent
 *     oracle that re-derives the precedence and fails if this copy diverges.
 *
 * When cortex's resolver changes, the drift test fails: re-vendor from the new
 * cortex revision and bump the pin. Do NOT edit the precedence here in
 * isolation — cli.yaml must resolve the SAME way live cortex does.
 *
 * INTENTIONAL DIVERGENCE (does NOT affect precedence): cortex surfaces every
 * legacy-tree hit through `noteXdgFallback` (a `CORTEX_XDG_STRICT` observability
 * hook wired to cortex's hermetic-install guard, cortex#1870). That guard does
 * not run inside this standalone bundle, so the telemetry hook is omitted. The
 * resolved PATH and SOURCE are byte-for-byte identical to cortex's; only the
 * stderr diagnostic is dropped. The drift oracle asserts path+source parity.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The metafactory config directory has migrated to the shared `metafactory`
 * XDG root: the canonical tree is now `~/.config/metafactory/cortex/`. The two
 * pre-move trees (`~/.config/cortex`, `~/.config/grove`) are READ-FALLBACKS
 * during the transition. This module resolves a config FILE (cli.yaml, …) under
 * that directory with the following precedence.
 *
 * Precedence (read):
 *   1. `$CORTEX_CONFIG_DIR/<file>`           — env override; VERBATIM, when set,
 *      it is a self-contained config root and ALL legacy fallbacks are skipped.
 *   2. `~/.config/metafactory/cortex/<file>` — canonical; used if it exists.
 *   3. `~/.config/cortex/<file>`             — legacy flat cortex tree.
 *   4. `~/.config/grove/<file>`              — legacy grove tree (oldest).
 *   5. canonical path                        — the write/default target when
 *      NONE exist (a fresh install writes canonical-side, never legacy-side).
 *
 * SCOPE — this owns config FILES ONLY. It deliberately does NOT touch the live
 * runtime state the same directory also holds (`state/`, `networks/`, `logs/`,
 * `personas/`). See cortex#1075.
 */

import { copyFileSync, existsSync, mkdirSync, statSync, chmodSync } from "fs";
import { dirname, join } from "path";

/**
 * The cortex revision this vendored resolver mirrors. Bump on every re-vendor.
 *
 * Pinned to cortex `origin/main`, commit that last touched
 * `src/common/config/config-path.ts`:
 *   dfc62dda — "feat(config): XDG wave 4 — cortex config-dir move
 *               (grove|cortex → metafactory/cortex)" (cortex#1869, EPIC #1867 §P3a)
 * origin/main HEAD at vendoring: e2a4d151bf17f0b99ab66cf262174520ca3ef3a7.
 */
export const VENDORED_CORTEX_RESOLVER_PIN = "dfc62dda";

/** The shared metafactory XDG root under `~/.config` (wave-3/wave-4 cutover). */
export const METAFACTORY_DIRNAME = "metafactory";
/** The canonical config directory name (now nested under `metafactory/`). */
export const CORTEX_CONFIG_DIRNAME = "cortex";
/** The legacy grove config directory name (read-fallback only during transition). */
export const GROVE_CONFIG_DIRNAME = "grove";

/** Which directory a resolved path came from. */
export type ConfigSource = "cortex" | "legacy-cortex" | "grove" | "default";

export interface ResolvedConfigFile {
  /** Absolute path to use. */
  path: string;
  /**
   * Where it resolved:
   *  - `cortex`        — the canonical `metafactory/cortex` file exists (or the
   *    `$CORTEX_CONFIG_DIR` override is in effect / the default write target).
   *  - `legacy-cortex` — only the legacy flat `~/.config/cortex` file exists.
   *  - `grove`         — only the legacy `~/.config/grove` file exists.
   *  - `default`       — none exist; `path` is the canonical write target.
   */
  source: ConfigSource;
}

function homeDir(home?: string): string {
  return home ?? process.env.HOME ?? "~";
}

/**
 * The `CORTEX_CONFIG_DIR` override, or `undefined` when unset/empty.
 *
 * When set it is the config directory VERBATIM (an absolute or relative path
 * the caller controls) — it wins over both the canonical default and any `home`
 * test override. Value is trimmed; a blank/whitespace-only value reads as unset
 * so a caller that exports `CORTEX_CONFIG_DIR=` (blank) keeps the default,
 * not `/`. (Inlined equivalent of cortex's shared `readDirEnv`.)
 */
export function cortexConfigDirOverride(): string | undefined {
  const raw = process.env.CORTEX_CONFIG_DIR;
  if (raw === undefined) return undefined;
  const v = raw.trim();
  return v.length > 0 ? v : undefined;
}

/**
 * The cortex config DIRECTORY: `$CORTEX_CONFIG_DIR` if set, else the canonical
 * `~/.config/metafactory/cortex` (XDG wave-4). This is the single seam every
 * config-file path is built on, so overriding the env var relocates the whole
 * config tree at once. The two pre-move trees are read-fallbacks only — see
 * {@link resolveConfigFile}.
 */
export function cortexConfigDir(home?: string): string {
  return (
    cortexConfigDirOverride() ??
    join(homeDir(home), ".config", METAFACTORY_DIRNAME, CORTEX_CONFIG_DIRNAME)
  );
}

/** Build the canonical `metafactory/cortex/<filename>` (or under `$CORTEX_CONFIG_DIR`). */
export function cortexConfigPath(filename: string, home?: string): string {
  return join(cortexConfigDir(home), filename);
}

/** Legacy flat cortex config dir `~/.config/cortex` (read-fallback only). */
export function legacyCortexConfigDir(home?: string): string {
  return join(homeDir(home), ".config", CORTEX_CONFIG_DIRNAME);
}

/** Build `~/.config/cortex/<filename>` (legacy flat cortex tree / fallback). */
export function legacyCortexConfigPath(filename: string, home?: string): string {
  return join(legacyCortexConfigDir(home), filename);
}

/** Build `~/.config/grove/<filename>` (legacy grove tree / oldest fallback). */
export function groveConfigPath(filename: string, home?: string): string {
  return join(homeDir(home), ".config", GROVE_CONFIG_DIRNAME, filename);
}

/**
 * Resolve a config FILE with canonical-first / legacy-fallback precedence.
 *
 * Never throws on a missing file: when none exist it returns the canonical
 * path with `source: "default"` so a caller writing a fresh config lands it
 * canonical-side.
 *
 * @param filename Bare filename under the config dir, e.g. `"cli.yaml"`.
 * @param home Override for `$HOME` (tests). Defaults to `process.env.HOME`.
 */
export function resolveConfigFile(filename: string, home?: string): ResolvedConfigFile {
  const cortex = cortexConfigPath(filename, home);
  if (existsSync(cortex)) return { path: cortex, source: "cortex" };

  // With an explicit `CORTEX_CONFIG_DIR` BOTH legacy read-fallbacks are SKIPPED:
  // the override is a self-contained config root, and probing the real
  // `~/.config/{cortex,grove}` would both break hermeticity and be meaningless.
  if (cortexConfigDirOverride() === undefined) {
    // Fallback 1 — legacy flat `~/.config/cortex` (the pre-wave-4 canonical).
    const legacyCortex = legacyCortexConfigPath(filename, home);
    if (existsSync(legacyCortex)) return { path: legacyCortex, source: "legacy-cortex" };
    // Fallback 2 — legacy `~/.config/grove` (oldest tree).
    const grove = groveConfigPath(filename, home);
    if (existsSync(grove)) return { path: grove, source: "grove" };
  }

  return { path: cortex, source: "default" };
}

/**
 * Convenience: the path to READ a config file from (canonical if present/
 * default, else the legacy trees in precedence order).
 */
export function resolveConfigFilePath(filename: string, home?: string): string {
  return resolveConfigFile(filename, home).path;
}

/**
 * Auto-migrate a legacy-tree config FILE to its canonical location,
 * **preserving the file mode**. (Historically grove-only; XDG wave-4 widened
 * it to also carry the legacy flat `~/.config/cortex` tree into the canonical
 * `~/.config/metafactory/cortex`.)
 *
 * Precedence when both legacy copies exist: the flat `~/.config/cortex` copy is
 * newer than grove, so it wins (cortex-wins-on-dup, matching the merge policy).
 *
 * Idempotent and non-destructive:
 *   - if the canonical copy already exists → no-op, returns `false` (canonical
 *     is authoritative; we never clobber it with a stale legacy copy);
 *   - if only a legacy copy exists → copies it to canonical with the SAME mode
 *     (so a `chmod 600` secret stays 600 and is never widened), returns `true`;
 *   - if none exist → no-op, returns `false`.
 *
 * An explicit `$CORTEX_CONFIG_DIR` root has no legacy side — never reach into
 * the real `~/.config/{cortex,grove}` to migrate.
 *
 * Mode preservation is explicit: `copyFileSync` does NOT preserve mode (the
 * destination is created with the process umask), so we re-apply the source
 * mode bits with `chmodSync`.
 *
 * @returns whether a migration copy was performed.
 */
export function migrateGroveConfigFile(filename: string, home?: string): boolean {
  const canonical = cortexConfigPath(filename, home);
  if (existsSync(canonical)) return false; // canonical copy is authoritative — never clobber

  // An explicit `CORTEX_CONFIG_DIR` root is self-contained — never migrate.
  if (cortexConfigDirOverride() !== undefined) return false;

  // cortex-wins-on-dup: prefer the newer flat `~/.config/cortex` copy, else grove.
  const legacyCortex = legacyCortexConfigPath(filename, home);
  const grove = groveConfigPath(filename, home);
  const src = existsSync(legacyCortex)
    ? legacyCortex
    : existsSync(grove)
      ? grove
      : undefined;
  if (src === undefined) return false; // nothing to migrate

  const mode = statSync(src).mode & 0o777;
  mkdirSync(dirname(canonical), { recursive: true });
  copyFileSync(src, canonical);
  // copyFileSync applies the umask, not the source mode — re-assert it so a
  // 0o600 secret is preserved exactly (and never widened) on the canonical copy.
  if (process.platform !== "win32") chmodSync(canonical, mode);
  return true;
}
