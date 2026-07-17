/**
 * Shared Discord REST transport.
 *
 * One helper — `discordRequest` — owns the bot Authorization header, JSON vs.
 * multipart body handling, 429 retry, and rate-limit-aware pacing, so the seven
 * upcoming guild-config slices (roles, channels, perms, threads, events,
 * webhooks, settings) don't each re-inline `fetch` + auth boilerplate.
 *
 * Security invariant (mirrors `mapRoleError`, cli/lib/discord.ts): the bot token
 * is placed ONLY in the outgoing Authorization header. It is never interpolated
 * into any returned or thrown string — `errorText` carries only the response
 * body, which never echoes the token.
 *
 * Rate limits (https://discord.com/developers/docs/topics/rate-limits):
 *   - 429 → read `retry_after` (seconds) from the body, wait, retry. Up to 3
 *     attempts total, then return the 429 to the caller.
 *   - `X-RateLimit-Remaining: 0` → the bucket is exhausted; wait
 *     `X-RateLimit-Reset-After` seconds before the next call. We pay that pause
 *     at the tail of the current call (still holding the caller) so a following
 *     sequential request only starts once the bucket has reset. Bucket timings
 *     come from the response headers — never hardcoded.
 */

const DISCORD_API = "https://discord.com/api/v10";
const MAX_ATTEMPTS = 3;

/** How to treat a 2xx body: parse it as JSON (default) or ignore it (204s). */
export type DiscordExpect = "json" | "none";

export interface DiscordRequestOptions {
  /** JSON body. Sets `Content-Type: application/json`. Mutually exclusive with `form`. */
  json?: unknown;
  /** Multipart body. Content-Type is left UNSET so fetch derives the boundary. */
  form?: FormData;
  /** Whether to parse a success body as JSON (default) or ignore it (e.g. 204). */
  expect?: DiscordExpect;
}

export interface DiscordResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  /** Response body on a non-2xx status. Never contains the token. */
  errorText?: string;
}

// Sleeper indirection: a real timer in production; unit tests swap in a spy so
// retry / pacing delays are asserted deterministically without wall-clock waits.
let sleeper: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Test-only seam: override the sleeper. Returns the previous one for restore. */
export function __setSleeperForTest(
  fn: (ms: number) => Promise<void>
): (ms: number) => Promise<void> {
  const prev = sleeper;
  sleeper = fn;
  return prev;
}

/** Parse a header/field that holds a float count of seconds. */
function parseSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read `retry_after` (seconds) from a 429 response. Primary source is the JSON
 * body (`{ retry_after }`); falls back to the `Retry-After` header, then 0.
 * Clones the response so the body stays readable if we ever need it again.
 */
async function read429RetryAfterSeconds(res: Response): Promise<number> {
  try {
    const data = (await res.clone().json()) as { retry_after?: number };
    if (typeof data.retry_after === "number") return data.retry_after;
  } catch {
    // Non-JSON body — fall through to the header.
  }
  return parseSeconds(res.headers.get("Retry-After")) ?? 0;
}

/**
 * Issue one Discord REST call with shared auth, body handling, 429 retry, and
 * rate-limit pacing. `path` is either an absolute URL or a `/…` path appended
 * to the v10 API base.
 *
 * The token is used only for the Authorization header; it is never placed in
 * the returned `errorText` or any thrown message.
 */
export async function discordRequest<T = unknown>(
  botToken: string,
  method: string,
  path: string,
  opts: DiscordRequestOptions = {}
): Promise<DiscordResponse<T>> {
  const url = path.startsWith("http") ? path : `${DISCORD_API}${path}`;
  const headers: Record<string, string> = { Authorization: `Bot ${botToken}` };
  let body: string | FormData | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    // No Content-Type — fetch sets multipart/form-data + boundary from the body.
    body = opts.form;
  }

  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, { method, headers, body });
    if (res.status !== 429 || attempt === MAX_ATTEMPTS) break;
    // 429 with attempts left — honour retry_after (seconds) from the body.
    const retryAfter = await read429RetryAfterSeconds(res);
    await sleeper(Math.max(0, retryAfter) * 1000);
  }

  // res is always assigned — the loop runs at least once.
  const settled = res as Response;
  const remaining = settled.headers.get("X-RateLimit-Remaining");
  const resetAfter = parseSeconds(settled.headers.get("X-RateLimit-Reset-After"));

  let result: DiscordResponse<T>;
  if (!settled.ok) {
    result = { ok: false, status: settled.status, errorText: await settled.text() };
  } else if ((opts.expect ?? "json") === "none") {
    result = { ok: true, status: settled.status };
  } else {
    const text = await settled.text();
    result = {
      ok: true,
      status: settled.status,
      data: text.length > 0 ? (JSON.parse(text) as T) : undefined,
    };
  }

  // Bucket exhausted — pause before the caller's next request.
  if (remaining === "0" && resetAfter !== undefined) {
    await sleeper(resetAfter * 1000);
  }

  return result;
}
