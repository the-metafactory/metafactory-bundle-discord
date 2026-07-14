/**
 * DRIFT GUARD for the vendored cortex config-file resolver
 * (`cli/lib/config-path.ts`, vendored per ADR-0017).
 *
 * A vendored copy is a fork unless it carries a pinned-version marker AND a
 * test that fails on drift (cortex#1867 plan v3 §1.4 rule 3, trap T10). This is
 * that test. Modeled on arc's cortex-config-dir drift oracle.
 *
 * The oracle is INDEPENDENT: `oracleResolve` / `oracleMigrate` below re-derive
 * cortex's wave-4 precedence in a different shape (an ordered candidate list)
 * from the one the resolver uses (early-return branches). If someone edits the
 * vendored resolver's precedence in isolation — the exact silent-fork failure
 * mode this guards — the two disagree on some cell of the presence matrix and
 * the parity test fails, forcing a re-vendor + pin bump.
 *
 * PINNED TO cortex `origin/main` @ dfc62dda (the commit that last touched
 * `src/common/config/config-path.ts`; XDG wave-4, cortex#1869). The pin marker
 * exported from the resolver is asserted below; bump it on every re-vendor.
 *
 * Hermetic: every case runs against a fresh scratch `$HOME` (mkdtemp) passed as
 * the `home` param, and `CORTEX_CONFIG_DIR` is saved/cleared/restored per test
 * so the real home is never read or written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  VENDORED_CORTEX_RESOLVER_PIN,
  resolveConfigFile,
  migrateGroveConfigFile,
  cortexConfigPath,
  type ConfigSource,
} from "../lib/config-path";

const FILE = "cli.yaml";

/** The three trees a config file can live in, relative to a scratch home. */
function canonicalDir(home: string): string {
  return join(home, ".config", "metafactory", "cortex");
}
function legacyCortexDir(home: string): string {
  return join(home, ".config", "cortex");
}
function groveDir(home: string): string {
  return join(home, ".config", "grove");
}

/** Plant a config file with known contents in a given directory. */
function plant(dir: string, contents: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), contents);
}

// ─── Independent oracle ──────────────────────────────────────────────────
// Re-derives cortex wave-4 precedence as an ordered candidate list. Written
// deliberately differently from the resolver's branch structure so a drift in
// the resolver's ordering surfaces as a parity mismatch.

interface OracleResult {
  path: string;
  source: ConfigSource;
}

function oracleResolve(home: string, override: string | undefined): OracleResult {
  const canonical =
    override !== undefined ? join(override, FILE) : join(canonicalDir(home), FILE);
  // 1. canonical always wins if present (even under an override root).
  if (existsSync(canonical)) return { path: canonical, source: "cortex" };
  // Under an explicit override root, NO legacy fallback is probed.
  if (override === undefined) {
    const ordered: OracleResult[] = [
      { path: join(legacyCortexDir(home), FILE), source: "legacy-cortex" },
      { path: join(groveDir(home), FILE), source: "grove" },
    ];
    for (const c of ordered) if (existsSync(c.path)) return c;
  }
  // 5. nothing exists → canonical write target.
  return { path: canonical, source: "default" };
}

function oracleMigrate(home: string, override: string | undefined): boolean {
  if (override !== undefined) return false; // override root has no legacy side
  const canonical = join(canonicalDir(home), FILE);
  if (existsSync(canonical)) return false; // never clobber canonical
  // cortex-wins-on-dup: flat cortex before grove.
  const ordered = [join(legacyCortexDir(home), FILE), join(groveDir(home), FILE)];
  return ordered.some((p) => existsSync(p));
}

// ─── Env + scratch-home harness ──────────────────────────────────────────

let home: string;
const ENV_KEY = "CORTEX_CONFIG_DIR";
let savedEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "discord-cfg-drift-"));
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

// ─── Pin marker ──────────────────────────────────────────────────────────

describe("vendored resolver — pin marker", () => {
  test("carries a non-empty cortex pin (bump on every re-vendor)", () => {
    expect(VENDORED_CORTEX_RESOLVER_PIN).toBe("dfc62dda");
    expect(VENDORED_CORTEX_RESOLVER_PIN.length).toBeGreaterThan(0);
  });
});

// ─── Drift oracle: exhaustive presence matrix × override on/off ───────────

describe("drift oracle — vendored precedence matches the independent oracle", () => {
  // All 2^3 combinations of {canonical, legacy-cortex, grove} presence.
  const combos: Array<{ canonical: boolean; legacy: boolean; grove: boolean }> = [];
  for (const canonical of [false, true])
    for (const legacy of [false, true])
      for (const grove of [false, true]) combos.push({ canonical, legacy, grove });

  for (const c of combos) {
    for (const withOverride of [false, true]) {
      const label =
        `canonical=${c.canonical} legacy-cortex=${c.legacy} grove=${c.grove}` +
        ` override=${withOverride}`;
      test(`resolve parity — ${label}`, () => {
        let override: string | undefined;
        if (withOverride) {
          override = join(home, "override-root");
          process.env[ENV_KEY] = override;
          if (c.canonical) plant(override, "canonical-override");
        } else if (c.canonical) {
          plant(canonicalDir(home), "canonical");
        }
        if (c.legacy) plant(legacyCortexDir(home), "legacy-cortex");
        if (c.grove) plant(groveDir(home), "grove");

        const got = resolveConfigFile(FILE, home);
        const want = oracleResolve(home, override);
        expect({ path: got.path, source: got.source }).toEqual(want);

        // migrate parity across the same cell. Capture the oracle's expectation
        // BEFORE running the side-effecting migrate (which would otherwise plant
        // the canonical file and change what the oracle observes).
        const wantMigrate = oracleMigrate(home, override);
        expect(migrateGroveConfigFile(FILE, home)).toBe(wantMigrate);
      });
    }
  }
});

// ─── Named precedence assertions (human-readable) ─────────────────────────

describe("resolveConfigFile — named precedence", () => {
  test("canonical metafactory/cortex wins over both legacy trees", () => {
    plant(canonicalDir(home), "canonical");
    plant(legacyCortexDir(home), "legacy");
    plant(groveDir(home), "grove");
    const r = resolveConfigFile(FILE, home);
    expect(r.source).toBe("cortex");
    expect(r.path).toBe(join(canonicalDir(home), FILE));
  });

  test("legacy flat ~/.config/cortex wins over grove when canonical absent", () => {
    plant(legacyCortexDir(home), "legacy");
    plant(groveDir(home), "grove");
    const r = resolveConfigFile(FILE, home);
    expect(r.source).toBe("legacy-cortex");
    expect(r.path).toBe(join(legacyCortexDir(home), FILE));
  });

  test("grove is the last read-fallback", () => {
    plant(groveDir(home), "grove");
    const r = resolveConfigFile(FILE, home);
    expect(r.source).toBe("grove");
    expect(r.path).toBe(join(groveDir(home), FILE));
  });

  test("nothing planted → canonical default write target", () => {
    const r = resolveConfigFile(FILE, home);
    expect(r.source).toBe("default");
    expect(r.path).toBe(join(canonicalDir(home), FILE));
  });
});

// ─── CORTEX_CONFIG_DIR override semantics ─────────────────────────────────

describe("CORTEX_CONFIG_DIR override", () => {
  test("verbatim root wins and skips ALL legacy fallbacks", () => {
    const override = join(home, "scratch-cfg");
    process.env[ENV_KEY] = override;
    // Legacy trees are planted but MUST be ignored under an override root.
    plant(legacyCortexDir(home), "legacy");
    plant(groveDir(home), "grove");
    const r = resolveConfigFile(FILE, home);
    expect(r.source).toBe("default");
    expect(r.path).toBe(join(override, FILE));
  });

  test("override file present resolves to it (source cortex)", () => {
    const override = join(home, "scratch-cfg");
    process.env[ENV_KEY] = override;
    plant(override, "override-file");
    const r = resolveConfigFile(FILE, home);
    expect(r.source).toBe("cortex");
    expect(r.path).toBe(join(override, FILE));
  });

  test("blank/whitespace CORTEX_CONFIG_DIR reads as unset (keeps default)", () => {
    for (const blank of ["", "   "]) {
      process.env[ENV_KEY] = blank;
      const r = resolveConfigFile(FILE, home);
      expect(r.path).toBe(join(canonicalDir(home), FILE));
      expect(r.source).toBe("default");
    }
  });

  test("override root is never migrated into", () => {
    const override = join(home, "scratch-cfg");
    process.env[ENV_KEY] = override;
    plant(legacyCortexDir(home), "legacy");
    expect(migrateGroveConfigFile(FILE, home)).toBe(false);
    expect(existsSync(join(override, FILE))).toBe(false);
  });
});

// ─── migrateGroveConfigFile — behavior + mode preservation ────────────────

describe("migrateGroveConfigFile", () => {
  test("canonical present → no-op (never clobber)", () => {
    plant(canonicalDir(home), "canonical");
    plant(legacyCortexDir(home), "legacy");
    expect(migrateGroveConfigFile(FILE, home)).toBe(false);
  });

  test("cortex-wins-on-dup: flat cortex copy migrated over grove", () => {
    plant(legacyCortexDir(home), "from-legacy-cortex");
    plant(groveDir(home), "from-grove");
    expect(migrateGroveConfigFile(FILE, home)).toBe(true);
    const canonical = join(canonicalDir(home), FILE);
    expect(existsSync(canonical)).toBe(true);
    expect(require("fs").readFileSync(canonical, "utf-8")).toBe("from-legacy-cortex");
  });

  test("grove migrated when it is the only legacy copy", () => {
    plant(groveDir(home), "from-grove");
    expect(migrateGroveConfigFile(FILE, home)).toBe(true);
    expect(require("fs").readFileSync(join(canonicalDir(home), FILE), "utf-8")).toBe(
      "from-grove",
    );
  });

  test("nothing to migrate → false", () => {
    expect(migrateGroveConfigFile(FILE, home)).toBe(false);
  });

  test("preserves 0o600 mode on the canonical copy (secret not widened)", () => {
    if (process.platform === "win32") return; // mode bits are a POSIX concern
    const dir = legacyCortexDir(home);
    mkdirSync(dir, { recursive: true });
    const src = join(dir, FILE);
    writeFileSync(src, "secret");
    require("fs").chmodSync(src, 0o600);
    expect(migrateGroveConfigFile(FILE, home)).toBe(true);
    const mode = statSync(join(canonicalDir(home), FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ─── cli.yaml staging: canonical / legacy / override ──────────────────────
// The three concrete migration scenarios the bundle must handle for cli.yaml.

describe("cli.yaml staging scenarios", () => {
  test("canonical present → reads canonical, cortexConfigPath targets canonical", () => {
    plant(canonicalDir(home), "guildId: '123456789012345678'\n");
    const r = resolveConfigFile("cli.yaml", home);
    expect(r.source).toBe("cortex");
    expect(cortexConfigPath("cli.yaml", home)).toBe(join(canonicalDir(home), "cli.yaml"));
  });

  test("legacy-only → reads legacy, migrate stages it canonical-side", () => {
    plant(legacyCortexDir(home), "guildId: '123456789012345678'\n");
    // Pre-migrate: resolves to the legacy tree.
    expect(resolveConfigFile("cli.yaml", home).source).toBe("legacy-cortex");
    // Migrate (first write path), then canonical becomes authoritative.
    expect(migrateGroveConfigFile("cli.yaml", home)).toBe(true);
    expect(resolveConfigFile("cli.yaml", home).source).toBe("cortex");
  });

  test("CORTEX_CONFIG_DIR staging: reads/writes strictly within the override root", () => {
    const override = join(home, "scratch-cfg");
    process.env[ENV_KEY] = override;
    expect(cortexConfigPath("cli.yaml", home)).toBe(join(override, "cli.yaml"));
    plant(override, "guildId: '123456789012345678'\n");
    expect(resolveConfigFile("cli.yaml", home).source).toBe("cortex");
  });
});
