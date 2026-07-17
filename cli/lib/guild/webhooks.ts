/**
 * Guild webhook management — create/list/delete + execute-with-identity
 * (guildhall idea 0021: "agents wear their face wherever they speak").
 *
 * The bot API surface (create/list/delete) needs the MANAGE_WEBHOOKS permission
 * and goes through the shared `discordRequest` transport (auth header, 429 retry,
 * rate-limit pacing). Webhook EXECUTION is different: the webhook URL already
 * carries its own token, so `executeWebhook` uses a bare `fetch` with NO bot
 * Authorization header — the per-message `username` / `avatar_url` override is
 * the whole point of a webhook.
 *
 * REDACTION DISCIPLINE (test-enforced). A webhook token is a posting credential,
 * the same threat class as the bot token:
 *   - `listWebhooks` projects only `id / name / channel_id / application_id` and
 *     NEVER the `token` field, so a token cannot leak into `list` output.
 *   - No function interpolates a token into a returned/thrown error string;
 *     `executeWebhook` additionally scrubs its own token out of any error body
 *     via `redactWebhookToken`, in case Discord ever echoed the path back.
 *   - The ONE sanctioned place a token appears in output is `createWebhook`'s
 *     returned `url`: the caller prints it exactly once, with a store-it-safely
 *     warning, and this CLI never persists it.
 */

import { discordRequest } from "../http";

/** Webhook execution base (v10). Execution needs no bot auth — the URL is the credential. */
const DISCORD_API = "https://discord.com/api/v10";

/** Names Discord rejects server-side; we reject them client-side for a clean, network-free error. */
const FORBIDDEN_NAME_SUBSTRINGS = ["clyde", "discord"];

/** Discord caps webhook names at 80 characters. */
const MAX_WEBHOOK_NAME_LENGTH = 80;

/** Discord error code for "Maximum number of webhooks reached" (per-channel cap, ~15). */
const WEBHOOK_CAP_ERROR_CODE = 30007;

/**
 * Discord webhook object — narrowest projection this module reads. `token` is
 * present on the create response and on `GET /guilds/{id}/webhooks` for
 * Incoming webhooks; it is deliberately dropped by `projectWebhook`.
 */
interface DiscordApiWebhook {
  id: string;
  name?: string | null;
  channel_id?: string;
  application_id?: string | null;
  token?: string;
}

/**
 * A webhook as surfaced to callers/output — the token field is intentionally
 * absent. Anything printed by `webhook list` is built from this shape, so a
 * token can never reach the terminal through the list path.
 */
export interface WebhookSummary {
  id: string;
  name: string | null;
  channelId: string;
  applicationId: string | null;
}

export interface CreateWebhookResult {
  success: boolean;
  id?: string;
  /**
   * Full execute URL, token included. The CALLER prints this exactly once with
   * a store-it-safely warning; it is never logged, cached, or written to config.
   */
  url?: string;
  error?: string;
}

export interface ListWebhooksResult {
  success: boolean;
  webhooks?: WebhookSummary[];
  error?: string;
}

export interface DeleteWebhookResult {
  success: boolean;
  error?: string;
}

export interface ExecuteWebhookResult {
  success: boolean;
  error?: string;
}

/** Per-message identity override — the reason webhooks exist here. */
export interface WebhookExecutePayload {
  content: string;
  username?: string;
  avatar_url?: string;
}

/**
 * Validate a webhook name client-side. Returns an error message, or `null` when
 * the name is acceptable. Rejects names containing "clyde"/"discord"
 * (case-insensitive — Discord rejects these), empty names, and names over 80
 * characters, so a bad name fails locally before any API call.
 */
export function validateWebhookName(name: string): string | null {
  if (name.trim().length === 0) return "Webhook name is required.";
  if (name.length > MAX_WEBHOOK_NAME_LENGTH) {
    return `Webhook name must be ${MAX_WEBHOOK_NAME_LENGTH} characters or fewer.`;
  }
  const lower = name.toLowerCase();
  for (const forbidden of FORBIDDEN_NAME_SUBSTRINGS) {
    if (lower.includes(forbidden)) {
      return `Webhook name may not contain "${forbidden}" — Discord rejects it.`;
    }
  }
  return null;
}

/**
 * Parse a webhook URL into its `{ id, token }` parts. Accepts the standard
 * `https://discord.com/api/webhooks/{id}/{token}` form and the `/api/v10/…`
 * and `discordapp.com` variants. Returns `null` when the URL isn't a webhook
 * URL (the caller turns that into a clean CLI error, never a network call).
 */
export function parseWebhookUrl(url: string): { id: string; token: string } | null {
  const match = url.match(/\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]+)/);
  if (!match) return null;
  const id = match[1];
  const token = match[2];
  if (!id || !token) return null;
  return { id, token };
}

/** Build the canonical execute URL for a freshly-created webhook. */
function buildWebhookUrl(id: string, token: string): string {
  return `https://discord.com/api/webhooks/${id}/${token}`;
}

/**
 * Map a non-2xx webhook API response to a plain error string. Surfaces Discord's
 * own `message` when present, and calls out the per-channel webhook cap (code
 * 30007) explicitly. The bot token is never available here, so it cannot appear.
 */
function mapWebhookError(status: number, body?: string): string {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { message?: string; code?: number };
      if (parsed.code === WEBHOOK_CAP_ERROR_CODE) {
        return (
          `Discord webhook cap reached for this channel ` +
          `(${parsed.message ?? "maximum number of webhooks reached"}). ` +
          `Delete an existing webhook, or create it in a different channel.`
        );
      }
      if (parsed.message) return `${status}: ${parsed.message}`;
    } catch {
      // Non-JSON body — fall through to the raw form.
    }
  }
  return `${status}: ${body ?? "request failed"}`;
}

/** Project a raw webhook to the token-free summary shape. */
function projectWebhook(webhook: DiscordApiWebhook): WebhookSummary {
  // `token` is deliberately NOT copied — a webhook token is a posting credential.
  return {
    id: webhook.id,
    name: webhook.name ?? null,
    channelId: webhook.channel_id ?? "",
    applicationId: webhook.application_id ?? null,
  };
}

/** Replace a webhook token wherever it appears in a string, so it can't leak into an error. */
function redactWebhookToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[REDACTED]");
}

/**
 * Create a webhook in a channel — `POST /channels/{channelId}/webhooks`
 * (requires MANAGE_WEBHOOKS). The name is validated client-side first. On
 * success the returned `url` carries the token for a one-time print by the
 * caller; on Discord's per-channel cap error the message is surfaced plainly.
 */
export async function createWebhook(
  botToken: string,
  channelId: string,
  opts: { name: string; avatar?: string }
): Promise<CreateWebhookResult> {
  const nameError = validateWebhookName(opts.name);
  if (nameError) return { success: false, error: nameError };

  const json: Record<string, unknown> = { name: opts.name };
  if (opts.avatar) json.avatar = opts.avatar;

  const res = await discordRequest<DiscordApiWebhook>(
    botToken,
    "POST",
    `/channels/${channelId}/webhooks`,
    { json }
  );
  if (!res.ok) {
    return { success: false, error: mapWebhookError(res.status, res.errorText) };
  }

  const webhook = res.data;
  if (!webhook?.id || !webhook.token) {
    return { success: false, error: "Discord did not return a webhook id and token." };
  }
  return { success: true, id: webhook.id, url: buildWebhookUrl(webhook.id, webhook.token) };
}

/**
 * List a guild's webhooks — `GET /guilds/{guildId}/webhooks` (requires
 * MANAGE_WEBHOOKS). Every returned entry is projected to `WebhookSummary`, so
 * the token field is dropped before it can reach any caller or output.
 */
export async function listWebhooks(
  botToken: string,
  guildId: string
): Promise<ListWebhooksResult> {
  const res = await discordRequest<DiscordApiWebhook[]>(
    botToken,
    "GET",
    `/guilds/${guildId}/webhooks`
  );
  if (!res.ok) {
    return { success: false, error: mapWebhookError(res.status, res.errorText) };
  }
  return { success: true, webhooks: (res.data ?? []).map(projectWebhook) };
}

/**
 * Delete a webhook by id — `DELETE /webhooks/{webhookId}` (204, requires
 * MANAGE_WEBHOOKS). Guild-agnostic: the webhook id is sufficient.
 */
export async function deleteWebhook(
  botToken: string,
  webhookId: string
): Promise<DeleteWebhookResult> {
  const res = await discordRequest(
    botToken,
    "DELETE",
    `/webhooks/${webhookId}`,
    { expect: "none" }
  );
  if (!res.ok) {
    return { success: false, error: mapWebhookError(res.status, res.errorText) };
  }
  return { success: true };
}

/**
 * Execute a webhook — `POST /webhooks/{id}/{token}`. Uses a bare fetch with NO
 * bot Authorization header: the token in the URL is the only credential needed.
 * `username` / `avatar_url` are the per-message identity override. Any error
 * body is scrubbed of the token before being returned.
 */
export async function executeWebhook(
  webhookId: string,
  webhookToken: string,
  payload: WebhookExecutePayload
): Promise<ExecuteWebhookResult> {
  const body: Record<string, unknown> = { content: payload.content };
  if (payload.username) body.username = payload.username;
  if (payload.avatar_url) body.avatar_url = payload.avatar_url;

  let res: Response;
  try {
    res = await fetch(`${DISCORD_API}/webhooks/${webhookId}/${webhookToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      success: false,
      error: redactWebhookToken(`webhook execution failed: ${(err as Error).message}`, webhookToken),
    };
  }

  if (!res.ok) {
    const text = redactWebhookToken(await res.text(), webhookToken);
    return { success: false, error: `${res.status}: ${text}` };
  }
  return { success: true };
}
