/**
 * `__NAME__` placeholders in a guild layout — resolved before the layout is parsed.
 *
 * WHY THIS EXISTS. A layout is committed to a repo, but some values it must carry
 * are live platform ids: a channel topic that mentions a bot only renders as a
 * clickable mention when the real numeric id is in the text (`<@…>`). Committing
 * that id publishes it. So a layout writes a placeholder instead —
 *
 *   topic: "Say hello by mentioning <@__ESCORT_BOT_ID__> — it opens you a thread."
 *
 * — and the id arrives at apply time, from the environment or from `--var`. The
 * `__NAME__` spelling is the ecosystem's existing convention (the same one the
 * guildhall agent manifests use for `__ESCORT_BOT_TOKEN__` and friends), not a
 * second mechanism invented here.
 *
 * WHERE IT APPLIES. Substitution walks the WHOLE parsed YAML document — every
 * string value and every mapping KEY — before schema validation. Topics are the
 * motivating case, but nothing is special-cased: a channel name, a role name, a
 * welcome-screen description can all carry a placeholder. Running before
 * validation also means the resolved document is what gets validated, planned and
 * diffed, so a resolved layout that matches the live guild still diffs to nothing.
 *
 * FAIL CLOSED, EARLY. An unresolved `__NAME__` is an ERROR, never a pass-through.
 * Shipping the literal text `__ESCORT_BOT_ID__` into a live channel topic would be
 * visible to every member of the guild and is strictly worse than a refused
 * command — so `resolvePlaceholders` throws `PlaceholderError` naming every
 * missing variable at once (not just the first), and both `guild diff` and
 * `guild apply` refuse before any network call.
 *
 * A variable that is SET BUT EMPTY counts as unset, for the same reason: an empty
 * value silently produces `<@>` in a live topic. It is reported separately so the
 * author can tell "you forgot it" from "you exported it blank".
 */

/**
 * A placeholder token: `__NAME__`, where NAME is upper-snake (leading letter,
 * then letters/digits/underscores). Lazy so `__A__ … __B__` in one string yields
 * two matches rather than one greedy span. Deliberately narrow: lowercase and
 * punctuation do not match, so ordinary prose containing a `__` never becomes an
 * accidental placeholder.
 */
export const PLACEHOLDER_PATTERN = /__([A-Z][A-Z0-9_]*?)__/g;

/** The outcome of looking a variable up. `blank` is "set, but to an empty value". */
export type VarResolution =
  | { status: "resolved"; value: string }
  | { status: "missing" }
  | { status: "blank" };

/** Resolves a placeholder NAME to a value, or explains why it cannot. */
export type VarLookup = (name: string) => VarResolution;

/** A layout that still contains placeholders no variable resolved. */
export class PlaceholderError extends Error {
  /** Names with no value anywhere, sorted, deduped. */
  readonly missing: string[];
  /** Names that WERE set but to an empty/whitespace-only value, sorted, deduped. */
  readonly blank: string[];

  constructor(missing: string[], blank: string[]) {
    super(unresolvedMessage(missing, blank));
    this.name = "PlaceholderError";
    this.missing = missing;
    this.blank = blank;
  }
}

/** The one-line summary carried by a `PlaceholderError`. */
function unresolvedMessage(missing: string[], blank: string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`unresolved placeholder(s): ${missing.map((n) => `__${n}__`).join(", ")}`);
  }
  if (blank.length > 0) {
    parts.push(`set but empty (counts as unset): ${blank.map((n) => `__${n}__`).join(", ")}`);
  }
  return parts.join("; ");
}

/** Every placeholder NAME occurring in `value`, in order of appearance (with repeats). */
export function findPlaceholders(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) names.push(match[1]!);
  return names;
}

/**
 * A `VarLookup` over an environment map plus explicit overrides. Overrides win:
 * `--var NAME=…` beats an exported `NAME`, so an author can correct a stale
 * environment without unsetting it. A value that trims to empty is `blank`.
 */
export function varLookup(
  env: Record<string, string | undefined>,
  overrides: Record<string, string> = {}
): VarLookup {
  return (name: string): VarResolution => {
    const raw = Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : env[name];
    if (raw === undefined) return { status: "missing" };
    if (raw.trim() === "") return { status: "blank" };
    return { status: "resolved", value: raw };
  };
}

/** A lookup that resolves nothing — the default, so an unfed layout fails closed. */
export const NO_VARS: VarLookup = () => ({ status: "missing" });

/** Accumulates unresolved names across one whole-document walk. */
interface Unresolved {
  missing: Set<string>;
  blank: Set<string>;
}

/** Substitute every placeholder in one string, recording any that do not resolve. */
function substitute(value: string, lookup: VarLookup, unresolved: Unresolved): string {
  return value.replace(PLACEHOLDER_PATTERN, (token, name: string) => {
    const resolution = lookup(name);
    if (resolution.status === "resolved") return resolution.value;
    if (resolution.status === "blank") unresolved.blank.add(name);
    else unresolved.missing.add(name);
    // Keep the token so the (about-to-throw) document is never half-substituted.
    return token;
  });
}

/** Recurse through the parsed YAML tree, substituting in string values AND keys. */
function walk(node: unknown, lookup: VarLookup, unresolved: Unresolved): unknown {
  if (typeof node === "string") return substitute(node, lookup, unresolved);
  if (Array.isArray(node)) return node.map((item) => walk(item, lookup, unresolved));
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[substitute(key, lookup, unresolved)] = walk(value, lookup, unresolved);
    }
    return out;
  }
  // Numbers, booleans, null, undefined — nothing to substitute.
  return node;
}

/**
 * Resolve every `__NAME__` in a parsed layout document. Returns a NEW document
 * (the input is not mutated). Throws `PlaceholderError` — naming every offending
 * variable at once — if any placeholder is left unresolved.
 *
 * With no `lookup` nothing resolves, so a layout carrying placeholders always
 * refuses rather than leaking a literal token into a live guild.
 */
export function resolvePlaceholders(doc: unknown, lookup: VarLookup = NO_VARS): unknown {
  const unresolved: Unresolved = { missing: new Set(), blank: new Set() };
  const resolved = walk(doc, lookup, unresolved);
  if (unresolved.missing.size > 0 || unresolved.blank.size > 0) {
    throw new PlaceholderError(
      [...unresolved.missing].sort(),
      [...unresolved.blank].sort()
    );
  }
  return resolved;
}

/** A malformed `--var` argument. */
export class VarFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VarFlagError";
  }
}

/**
 * Parse repeated `--var NAME=VALUE` arguments into an overrides map. Splits on the
 * FIRST `=` only, so a value may itself contain `=`. The name must be a legal
 * placeholder name (upper-snake) — a lowercase or punctuated name could never
 * match a `__NAME__` token, so accepting it would resolve nothing silently. A
 * repeated name takes its last occurrence.
 */
export function parseVarFlags(specs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq === -1) {
      throw new VarFlagError(`expected NAME=VALUE, got "${spec}"`);
    }
    const name = spec.slice(0, eq);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new VarFlagError(
        `"${name}" is not a valid placeholder name (upper-snake, e.g. ESCORT_BOT_ID) in "${spec}"`
      );
    }
    out[name] = spec.slice(eq + 1);
  }
  return out;
}
