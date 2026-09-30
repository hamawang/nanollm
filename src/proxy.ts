// @ts-nocheck
import type { ModelConfig } from "./config.js";
import { SSEParser, type StreamFormat } from "./converters/streams.js";
import type { NormalizedRequest, NormalizedResponse, NormalizedUsage } from "./converters/shared.js";
import {
  denormalizeToOpenAIChatRequest,
  denormalizeToOpenAIResponsesRequest,
  denormalizeToAnthropicRequest,
} from "./converters/requests.js";
import {
  normalizeOpenAIChatResponse,
  normalizeOpenAIResponsesResponse,
  normalizeAnthropicResponse,
} from "./converters/responses.js";
import { normalizeUsage } from "./converters/shared.js";
import {
  ensureRecordedAttempt,
  setRecordedAttemptError,
  setRecordedAttemptResponseBody,
  setRecordedAttemptResponseMeta,
} from "./record.js";
import { runInNewContext } from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { extractErrorCauses } from "./error-details.js";
import { getClientIp, getClientRequestHeaders } from "./request-context.js";
import { getCachedSubscriptionCredential, ensureSubscriptionCredential, SUBSCRIPTION_URL } from "./openai-subscription.js";
import { CLAUDE_CODE_DEFAULT_HEADERS, CODEX_CLI_ORIGINATOR, CODEX_CLI_USER_AGENT } from "./subscription-client-compat.js";
import { addClaudeBillingBlock } from "./claude-billing.js";
import {
  CLAUDE_CODE_BETA,
  CLAUDE_MESSAGES_URL,
  CLAUDE_OAUTH_BETA,
  ensureClaudeSubscriptionCredential,
  getCachedClaudeSubscriptionCredential,
} from "./claude-subscription.js";

export interface UpstreamRequestOptions {
  userAgent?: string;
  attemptIndex?: number;
  modelName?: string;
  recordedRequestBody?: unknown;
}

export interface UpstreamTiming {
  startedAt: number;
  responseStartedAt: number;
  ttfbMs: number;
}

export type OpenAIImageOperation = "generations" | "edits";

// ─── Upstream URL ───────────────────────────────────────────────────────────

export function getUpstreamURL(config: ModelConfig): string {
  return getUpstreamURLForPath(config);
}

export function getUpstreamURLForPath(config: ModelConfig, imageOperation?: OpenAIImageOperation): string {
  if (config.subscription_provider) return `${SUBSCRIPTION_URL}/responses`;
  if (config.claude_subscription_provider) return CLAUDE_MESSAGES_URL;
  const base = config.base_url.replace(/\/+$/, "");
  switch (config.provider) {
    case "openai-chat":
      return `${base}/chat/completions`;
    case "openai-responses":
      return `${base}/responses`;
    case "openai-image":
      return `${base}/images/${imageOperation ?? "generations"}`;
    case "anthropic":
      return `${base}/messages`;
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export function getAlphaSearchURL(config: ModelConfig): string {
  if (config.subscription_provider) return `${SUBSCRIPTION_URL}/alpha/search`;
  const base = config.base_url.replace(/\/+$/, "");
  return `${base}/alpha/search`;
}

// ─── Auth Headers ───────────────────────────────────────────────────────────

function getAuthHeaders(config: ModelConfig): Record<string, string> {
  if (config.subscription_provider) {
    const credential = getCachedSubscriptionCredential(config.subscription_provider);
    if (!credential) throw new Error(`OpenAI subscription provider '${config.subscription_provider}' is not authenticated`);
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      ...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
    };
  }
  if (config.claude_subscription_provider) {
    const credential = getCachedClaudeSubscriptionCredential(config.claude_subscription_provider);
    if (!credential) throw new Error(`Claude subscription provider '${config.claude_subscription_provider}' is not authenticated`);
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      "anthropic-version": "2023-06-01",
    };
  }
  switch (config.provider) {
    case "openai-chat":
    case "openai-responses":
    case "openai-image":
      return { Authorization: `Bearer ${config.api_key}` };
    case "anthropic":
      return {
        "x-api-key": config.api_key,
        "anthropic-version": "2023-06-01",
      };
    default:
      return {};
  }
}

// ─── Denormalize Request ────────────────────────────────────────────────────

function denormalizeRequest(config: ModelConfig, normalized: NormalizedRequest): unknown {
  switch (config.provider) {
    case "openai-chat":
      return denormalizeToOpenAIChatRequest(normalized);
    case "openai-responses":
      return denormalizeToOpenAIResponsesRequest(normalized);
    case "anthropic":
      return denormalizeToAnthropicRequest(normalized, { ignoreInvalidHistory: config.ignore_invalid_history ?? true });
  }
}

/** For non-passthrough OpenAI requests, disable server-side storage to prevent item_reference usage. */
function applyOpenAIDefaults(provider: StreamFormat, body: unknown): unknown {
  if (provider === "openai-chat" || provider === "openai-responses") {
    (body as Record<string, unknown>).store = false;
  }
  return body;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;

  const result: Record<string, unknown> = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    result[key] = isPlainObject(targetValue) && isPlainObject(sourceValue) ? deepMerge(targetValue, sourceValue) : sourceValue;
  }
  return result;
}

function applyModelBodyOverrides(config: ModelConfig, body: unknown): unknown {
  if (!config.body) return body;
  return deepMerge(body, config.body);
}

function applyModelBodyExpression(config: ModelConfig, body: unknown): unknown {
  if (!config.bodyExpression) return body;

  let result: unknown;
  try {
    result = runInNewContext(`(${config.bodyExpression})`, {
      body,
      console,
      Date,
      JSON,
      Math,
      structuredClone,
    }, {
      filename: `bodyExpression:${config.name}`,
      timeout: 1000,
    });
  } catch (error) {
    throw new Error(`Model '${config.name}' bodyExpression failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (result === undefined) {
    throw new Error(`Model '${config.name}' bodyExpression returned undefined`);
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    throw new Error(`Model '${config.name}' bodyExpression must return synchronously`);
  }
  return result;
}

function applyModelBodyTransforms(config: ModelConfig, body: unknown): unknown {
  return applyModelBodyExpression(config, applyModelBodyOverrides(config, body));
}

function toReadonlyHeaderRecord(headers: Headers): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(headers.entries()));
}

function applyModelResponseExpression(config: ModelConfig, response: unknown, headers: Headers): unknown {
  if (!config.responseExpression) return response;

  let result: unknown;
  try {
    result = runInNewContext(`(${config.responseExpression})`, {
      response,
      headers: toReadonlyHeaderRecord(headers),
      console,
      Date,
      JSON,
      Math,
      structuredClone,
    }, {
      filename: `responseExpression:${config.name}`,
      timeout: 1000,
    });
  } catch (error) {
    const message = isPlainObject(error) && typeof error.message === "string" ? error.message : String(error);
    throw new Error(`Model '${config.name}' responseExpression failed: ${message}`);
  }

  if (result === undefined) throw new Error(`Model '${config.name}' responseExpression returned undefined`);
  if (result && typeof (result as { then?: unknown }).then === "function") {
    throw new Error(`Model '${config.name}' responseExpression must return synchronously`);
  }
  return structuredClone(result);
}

function extractStreamModel(provider: StreamFormat, event: unknown): string | undefined {
  if (!isPlainObject(event)) return undefined;
  if (provider === "openai-chat") return typeof event.model === "string" ? event.model : undefined;
  if (provider === "openai-responses" && event.type === "response.created" && isPlainObject(event.response)) {
    return typeof event.response.model === "string" ? event.response.model : undefined;
  }
  if (provider === "anthropic" && event.type === "message_start" && isPlainObject(event.message)) {
    return typeof event.message.model === "string" ? event.message.model : undefined;
  }
  return undefined;
}

const OPENAI_RESPONSES_UNSTORED_ITEM_ID_TYPES = new Set(["message", "reasoning", "function_call", "custom_tool_call"]);

function stripOpenAIResponsesUnstoredItemIds(config: ModelConfig, body: unknown): unknown {
  if (config.provider !== "openai-responses" || !isPlainObject(body) || body.store !== false || !Array.isArray(body.input)) return body;

  let changed = false;
  const input = body.input.map((item) => {
    if (!isPlainObject(item) || typeof item.type !== "string" || !OPENAI_RESPONSES_UNSTORED_ITEM_ID_TYPES.has(item.type) || !("id" in item)) return item;
    changed = true;
    const withoutId = { ...item };
    delete withoutId.id;
    return withoutId;
  });
  return changed ? { ...body, input } : body;
}

function preparePassthroughBody(config: ModelConfig, rawBody: Record<string, unknown>, stream: boolean): unknown {
  return stripOpenAIResponsesUnstoredItemIds(
    config,
    applyModelBodyTransforms(config, { ...rawBody, model: config.model, stream }),
  );
}

function isJsonContentType(headers: Headers): boolean {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json") || contentType.includes("+json");
}

function isMultipartContentType(headers: Headers): boolean {
  return headers.get("content-type")?.toLowerCase().includes("multipart/form-data") ?? false;
}

function prepareRawJsonBody(config: ModelConfig, body: BodyInit): { body: BodyInit; recordedRequestBody: unknown } | undefined {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;

  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isPlainObject(rawBody)) return undefined;
  const transformedBody = applyModelBodyTransforms(config, { ...rawBody, model: config.model });
  return {
    body: JSON.stringify(transformedBody),
    recordedRequestBody: transformedBody,
  };
}

function replaceRecordedRequestModel(recordedRequestBody: unknown, model: string): unknown {
  return isPlainObject(recordedRequestBody) ? { ...recordedRequestBody, model } : recordedRequestBody;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMultipartBoundary(headers: Headers): string | undefined {
  const contentType = headers.get("content-type") ?? "";
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2]?.trim();
}

function prepareRawMultipartBody(config: ModelConfig, body: BodyInit, incomingHeaders: Headers, recordedRequestBody: unknown): { body: BodyInit; recordedRequestBody: unknown } | undefined {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;
  const boundary = getMultipartBoundary(incomingHeaders);
  if (!boundary) return undefined;

  const text = typeof body === "string" ? body : Buffer.from(body).toString("latin1");
  const boundaryPattern = escapeRegExp(`--${boundary}`);
  const modelPartPattern = new RegExp(
    `((?:^|\\r\\n)${boundaryPattern}\\r\\n(?:[^\\r\\n]+\\r\\n)*Content-Disposition: form-data; name="model"[^\\r\\n]*\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n)([\\s\\S]*?)(\\r\\n${boundaryPattern})`,
  );
  if (!modelPartPattern.test(text)) return undefined;
  const replaced = text.replace(modelPartPattern, `$1${config.model}$3`);
  return {
    body: typeof body === "string" ? replaced : Buffer.from(replaced, "latin1"),
    recordedRequestBody: replaceRecordedRequestModel(recordedRequestBody, config.model),
  };
}

async function prepareRawBody(
  config: ModelConfig,
  body: BodyInit,
  incomingHeaders: Headers,
  recordedRequestBody: unknown,
): Promise<{ body: BodyInit; recordedRequestBody: unknown } | undefined> {
  if (isJsonContentType(incomingHeaders)) {
    return prepareRawJsonBody(config, body);
  }
  if (isMultipartContentType(incomingHeaders)) {
    return prepareRawMultipartBody(config, body, incomingHeaders, recordedRequestBody);
  }
  return undefined;
}

// ─── Normalize Response ─────────────────────────────────────────────────────

function normalizeUpstreamResponse(provider: StreamFormat, body: unknown): NormalizedResponse {
  switch (provider) {
    case "openai-chat":
      return normalizeOpenAIChatResponse(body as any);
    case "openai-responses":
      return normalizeOpenAIResponsesResponse(body as any);
    case "anthropic":
      return normalizeAnthropicResponse(body as any);
  }
}

// ─── Shared fetch ───────────────────────────────────────────────────────────

const OPENAI_RESPONSES_FORWARDED_HEADERS = new Set(["session_id", "thread_id", "conversation_id", "version"]);
const OPENAI_RESPONSES_FORWARDED_HEADER_PREFIXES = ["x-openai-", "x-codex-"];
const ANTHROPIC_FORWARDED_HEADER_PREFIXES = ["anthropic-"];
// Claude Code identifies itself with these on top of anthropic-*; keep them when talking to the subscription backend.
const CLAUDE_SUBSCRIPTION_FORWARDED_HEADERS = new Set(["accept", "user-agent", "x-app", "x-client-app", "x-client-request-id"]);
const CLAUDE_SUBSCRIPTION_FORWARDED_HEADER_PREFIXES = ["x-claude-code-", "x-claude-remote-", "x-stainless-"];
// Gateway-owned: always derived from the final upstream request body, never taken from the client.
const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
const CODEX_ROUTING_HINT_TIERS: Record<string, string> = { priority: "priority", fast: "priority", flex: "flex", ultrafast: "ultrafast" };

function shouldForwardClientHeader(config: ModelConfig, name: string): boolean {
  if (config.claude_subscription_provider && (CLAUDE_SUBSCRIPTION_FORWARDED_HEADERS.has(name) || CLAUDE_SUBSCRIPTION_FORWARDED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)))) {
    return true;
  }
  switch (config.provider) {
    case "openai-responses":
      if (name === CODEX_ROUTING_HINT_HEADER) return false;
      return OPENAI_RESPONSES_FORWARDED_HEADERS.has(name) || OPENAI_RESPONSES_FORWARDED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
    case "anthropic":
      return ANTHROPIC_FORWARDED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
    default:
      return false;
  }
}

/** Client headers that the upstream provider uses for session affinity / prompt cache routing. */
function getForwardedClientHeaders(config: ModelConfig): Record<string, string> {
  const incoming = getClientRequestHeaders();
  if (!incoming) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of incoming.entries()) {
    const name = key.toLowerCase();
    if (shouldForwardClientHeader(config, name)) headers[name] = value;
  }
  return headers;
}

/** Codex backend (ChatGPT subscription) routes prompt cache by session headers and the routing hint. */
export function applyCodexSubscriptionHeaders(headers: Record<string, string>, body: unknown): void {
  if (!isPlainObject(body)) return;
  const promptCacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key.trim() : "";
  if (promptCacheKey) {
    headers.session_id ||= promptCacheKey;
    headers.conversation_id ||= promptCacheKey;
  }
  if (body.stream === true) headers.accept ||= "text/event-stream";

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model || /[;=\r\n]/.test(model)) return;
  const tier = typeof body.service_tier === "string" ? CODEX_ROUTING_HINT_TIERS[body.service_tier.toLowerCase()] : undefined;
  headers[CODEX_ROUTING_HINT_HEADER] = tier ? `model=${model};tier=${tier}` : `model=${model}`;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key];
  headers[name] = value;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === lower);
  return key === undefined ? undefined : headers[key];
}

/**
 * Claude subscription headers use sub2api's Claude Code defaults:
 * https://github.com/Wei-Shaw/sub2api/blob/9a62841fd124d026cf3694fcf9b79e98addcdbdc/backend/internal/pkg/claude/constants.go
 * Add the OAuth and Claude Code betas alongside those defaults.
 * Client-supplied values win; only absent headers receive defaults.
 */
export function applyClaudeSubscriptionHeaders(headers: Record<string, string>, stream = false): void {
  const betas = (getHeader(headers, "anthropic-beta") ?? "").split(",").map((beta) => beta.trim()).filter(Boolean);
  for (const beta of [CLAUDE_CODE_BETA, CLAUDE_OAUTH_BETA]) if (!betas.includes(beta)) betas.push(beta);
  setHeader(headers, "anthropic-beta", betas.join(","));
  for (const [name, value] of Object.entries(CLAUDE_CODE_DEFAULT_HEADERS)) {
    if (!getHeader(headers, name)) setHeader(headers, name, value);
  }
  if (stream && !getHeader(headers, "x-stainless-helper-method")) setHeader(headers, "x-stainless-helper-method", "stream");
  if (!getHeader(headers, "x-client-request-id")) setHeader(headers, "x-client-request-id", randomUUID());
  if (!getHeader(headers, "x-claude-code-session-id")) {
    const ip = getClientIp() || "unknown";
    const day = new Date().toISOString().slice(0, 10);
    setHeader(headers, "x-claude-code-session-id", `${day}-${createHash("sha256").update(ip).digest("hex").slice(0, 24)}`);
  }
}

function applyCodexSubscriptionIdentityHeaders(headers: Record<string, string>, incoming = getClientRequestHeaders()): void {
  const originator = incoming?.get("originator")?.trim();
  const userAgent = incoming?.get("user-agent")?.trim();
  // Forward an intact client identity; otherwise send one consistent Codex CLI pair.
  setHeader(headers, "originator", originator && userAgent ? originator : CODEX_CLI_ORIGINATOR);
  setHeader(headers, "User-Agent", originator && userAgent ? userAgent : CODEX_CLI_USER_AGENT);
}

function getForwardHeaders(config: ModelConfig, body: unknown, options?: UpstreamRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...getForwardedClientHeaders(config),
    "Content-Type": "application/json",
    ...getAuthHeaders(config),
    ...(options?.userAgent ? { "User-Agent": options.userAgent } : {}),
  };
  if (config.claude_subscription_provider) applyClaudeSubscriptionHeaders(headers, isPlainObject(body) && body.stream === true);
  if (config.subscription_provider) {
    applyCodexSubscriptionIdentityHeaders(headers);
    applyCodexSubscriptionHeaders(headers, body);
  }
  if (config.claude_subscription_provider) {
    for (const [name, value] of Object.entries(config.headers ?? {})) setHeader(headers, name, value);
    return headers;
  }
  return { ...headers, ...(config.headers ?? {}) };
}

export function resolveProxyUrl(config: ModelConfig): string | undefined {
  return config.proxy || config.provider_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
}

const upstreamAgents = {
  http1: new Agent({ allowH2: false }),
  http2: new Agent({ allowH2: true }),
};

export function createUpstreamDispatcher(config: ModelConfig, proxyUrl = resolveProxyUrl(config)) {
  const allowH2 = config.allow_h2 ?? false;
  if (!proxyUrl) return allowH2 ? upstreamAgents.http2 : upstreamAgents.http1;

  return new ProxyAgent({
    uri: proxyUrl,
    allowH2,
    requestTls: { allowH2 },
  });
}

async function upstreamFetch(
  config: ModelConfig,
  body: unknown,
  stream: boolean,
  options?: UpstreamRequestOptions,
): Promise<{ response: Response; timing: UpstreamTiming }> {
  if (config.subscription_provider) await ensureSubscriptionCredential(config.subscription_provider);
  if (config.claude_subscription_provider) await ensureClaudeSubscriptionCredential(config.claude_subscription_provider);
  const headers = getForwardHeaders(config, body, options);
  const upstreamBody = config.claude_subscription_provider ? addClaudeBillingBlock(body, getHeader(headers, "user-agent")) : body;
  return upstreamFetchToUrl(
    config,
    getUpstreamURL(config),
    JSON.stringify(upstreamBody),
    stream,
    headers,
    options,
    upstreamBody,
  );
}

async function upstreamFetchToUrl(
  config: ModelConfig,
  url: string,
  body: BodyInit,
  stream: boolean,
  headers: HeadersInit,
  options?: UpstreamRequestOptions,
  recordedRequestBody: unknown = typeof body === "string" ? body : "[binary body]",
): Promise<{ response: Response; timing: UpstreamTiming }> {
  const proxyUrl = resolveProxyUrl(config);
  const timeoutMs = config.ttfb_timeout;
  const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const startedAt = Date.now();

  const fetchOptions: RequestInit = {
    method: "POST",
    headers,
    body,
    ...(abortController ? { signal: abortController.signal } : {}),
  };
  ensureRecordedAttempt({
    index: options?.attemptIndex ?? 0,
    provider: config.provider,
    modelName: options?.modelName ?? config.name,
    url,
    proxy: proxyUrl ?? null,
    requestHeaders: fetchOptions.headers as Record<string, string>,
    requestBody: recordedRequestBody,
  });

  fetchOptions.dispatcher = createUpstreamDispatcher(config, proxyUrl);

  if (abortController && timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      abortController.abort(new Error(`Upstream TTFB timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  let res: Response;
  try {
    res = await undiciFetch(url, fetchOptions);
  } catch (error) {
    if (abortController?.signal.aborted && error === abortController.signal.reason) {
      setRecordedAttemptError({
        index: options?.attemptIndex ?? 0,
        message: `Upstream TTFB timeout after ${timeoutMs}ms`,
      });
      const err = new Error(`Upstream TTFB timeout after ${timeoutMs}ms`) as Error & { cause?: unknown };
      err.cause = error;
      throw err;
    }
    setRecordedAttemptError({
      index: options?.attemptIndex ?? 0,
      message: error instanceof Error ? error.message : String(error),
      causes: extractErrorCauses(error),
    });
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const responseStartedAt = Date.now();
  const timing: UpstreamTiming = {
    startedAt,
    responseStartedAt,
    ttfbMs: responseStartedAt - startedAt,
  };
  setRecordedAttemptResponseMeta({
    index: options?.attemptIndex ?? 0,
    status: res.status,
    headers: res.headers,
  });

  if (!res.ok) {
    const text = await res.text();
    setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
    setRecordedAttemptError({
      index: options?.attemptIndex ?? 0,
      message: `Upstream ${res.status}: ${text}`,
      status: res.status,
      upstream: text,
    });
    const err = new Error(`Upstream ${res.status}: ${text}`) as Error & { status: number; upstream: string };
    err.status = res.status;
    err.upstream = text;
    throw err;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const text = await res.text();
    setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
    setRecordedAttemptError({
      index: options?.attemptIndex ?? 0,
      message: "Upstream returned HTML response (possible error page)",
      status: 200,
      upstream: text,
    });
    const err = new Error("Upstream returned HTML response (possible error page)") as Error & { status: number; upstream: string };
    err.status = 200;
    err.upstream = text;
    throw err;
  }
  // Codex occasionally omits Content-Type while still returning a valid SSE
  // stream. Let the body validator inspect that response; reject only an
  // explicitly non-SSE content type.
  if (stream && contentType.trim() && !contentType.includes("text/event-stream")) {
    const text = await res.text();
    setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
    setRecordedAttemptError({
      index: options?.attemptIndex ?? 0,
      message: `Upstream returned non-SSE Content-Type for stream request: ${contentType}`,
      status: 200,
      upstream: text,
    });
    const err = new Error(`Upstream returned non-SSE Content-Type for stream request: ${contentType}`) as Error & { status: number; upstream: string };
    err.status = 200;
    err.upstream = text;
    throw err;
  }

  return { response: res, timing };
}

// ─── Stream content validation ──────────────────────────────────────────────

const MAX_VALIDATION_BUFFER_BYTES = 1024 * 1024;

function reconstructStream(
  bufferedChunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < bufferedChunks.length) {
        controller.enqueue(bufferedChunks[index++]);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function validateStreamContent(
  body: ReadableStream<Uint8Array>,
  options: { attemptIndex: number; config: ModelConfig; headers: Headers },
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const sseParser = new SSEParser();
  const bufferedChunks: Uint8Array[] = [];
  let totalBytes = 0;
  let expressionApplied = !options.config.responseExpression;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        const flushed = sseParser.flush();
        if (!expressionApplied) {
          for (const event of flushed) {
            let parsed: unknown;
            try { parsed = JSON.parse(event.data); } catch { continue; }
            const model = extractStreamModel(options.config.provider, parsed);
            if (model === undefined) continue;
            applyModelResponseExpression(options.config, parsed, options.headers);
            expressionApplied = true;
            break;
          }
        }
        if (flushed.length > 0 && expressionApplied) {
          return reconstructStream(bufferedChunks, reader);
        }
        const bufferedText = bufferedChunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();
        const message = !expressionApplied
          ? "Upstream SSE stream ended before responseExpression could find a model-bearing start event"
          : "Upstream SSE stream ended with no real content (ping-only or empty)";
        setRecordedAttemptResponseBody({ index: options.attemptIndex, body: bufferedText });
        setRecordedAttemptError({
          index: options.attemptIndex,
          message,
          status: 200,
          upstream: bufferedText,
        });
        const err = new Error(message) as Error & { status: number; upstream: string };
        err.status = 200;
        err.upstream = bufferedText;
        throw err;
      }

      bufferedChunks.push(value);
      totalBytes += value.byteLength;

      const text = decoder.decode(value, { stream: true });
      const events = sseParser.push(text);

      if (!expressionApplied) {
        for (const event of events) {
          let parsed: unknown;
          try { parsed = JSON.parse(event.data); } catch { continue; }
          const model = extractStreamModel(options.config.provider, parsed);
          if (model === undefined) continue;
          applyModelResponseExpression(options.config, parsed, options.headers);
          expressionApplied = true;
          break;
        }
      }

      if (expressionApplied && (events.length > 0 || sseParser.hasBufferedRealData())) {
        return reconstructStream(bufferedChunks, reader);
      }

      if (totalBytes >= MAX_VALIDATION_BUFFER_BYTES) {
        if (!expressionApplied) {
          console.error(`[RESPONSE EXPRESSION] ${options.config.name}: upstream SSE stream exceeded ${MAX_VALIDATION_BUFFER_BYTES} bytes before a model-bearing start event was found; skipping responseExpression and forwarding stream as-is`);
          return reconstructStream(bufferedChunks, reader);
        }
        const bufferedText = bufferedChunks.map(c => new TextDecoder().decode(c, { stream: true })).join("") + new TextDecoder().decode();
        setRecordedAttemptResponseBody({ index: options.attemptIndex, body: bufferedText });
        const message = `Upstream SSE stream exceeded ${MAX_VALIDATION_BUFFER_BYTES} bytes with no real content`;
        setRecordedAttemptError({
          index: options.attemptIndex,
          message,
          status: 200,
          upstream: bufferedText,
        });
        const err = new Error(message) as Error & { status: number; upstream: string };
        err.status = 200;
        err.upstream = bufferedText;
        reader.cancel().catch(() => {});
        throw err;
      }
    }
  } catch (error) {
    reader.cancel(error).catch(() => {});
    if (error instanceof Error && "upstream" in error) throw error;
    throw error;
  }
}

function getRawForwardHeaders(
  config: ModelConfig,
  incomingHeaders: Headers,
  options?: UpstreamRequestOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const skipped = new Set([
    "authorization",
    "cookie",
    "host",
    "content-length",
    "connection",
    "accept-encoding",
  ]);
  for (const [key, value] of incomingHeaders.entries()) {
    if (skipped.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  const forwardHeaders = {
    ...headers,
    ...getAuthHeaders(config),
    ...(options?.userAgent ? { "User-Agent": options.userAgent } : {}),
  };
  if (config.subscription_provider) applyCodexSubscriptionIdentityHeaders(forwardHeaders, incomingHeaders);
  return { ...forwardHeaders, ...(config.headers ?? {}) };
}

export async function passthroughRawRequest(
  config: ModelConfig,
  body: BodyInit,
  incomingHeaders: Headers,
  options?: UpstreamRequestOptions & { imageOperation?: OpenAIImageOperation; recordedRequestBody?: unknown },
): Promise<{ body: unknown; responseText: string; headers: Headers; status: number; timing: UpstreamTiming }> {
  if (config.subscription_provider) await ensureSubscriptionCredential(config.subscription_provider);
  const url = getUpstreamURLForPath(config, options?.imageOperation);
  const headers = getRawForwardHeaders(config, incomingHeaders, options);
  const preparedBody = await prepareRawBody(config, body, incomingHeaders, options?.recordedRequestBody);
  const upstreamBody = preparedBody?.body ?? body;
  const recordedRequestBody = preparedBody?.recordedRequestBody ?? options?.recordedRequestBody;
  const { response, timing } = await upstreamFetchToUrl(
    config,
    url,
    upstreamBody,
    false,
    headers,
    options,
    recordedRequestBody,
  );
  let responseText = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: responseText });
  let responseBody: unknown = responseText;
  try {
    responseBody = JSON.parse(responseText);
  } catch {}
  if (isJsonContentType(response.headers)) {
    responseBody = applyModelResponseExpression(config, responseBody, response.headers);
    responseText = JSON.stringify(responseBody);
  }
  return {
    body: responseBody,
    responseText,
    headers: response.headers,
    status: response.status,
    timing,
  };
}

export async function passthroughAlphaSearchRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<{ body: unknown; responseText: string; headers: Headers; status: number; timing: UpstreamTiming }> {
  if (config.subscription_provider) await ensureSubscriptionCredential(config.subscription_provider);
  // alpha/search is a separate Codex wire protocol. Only remap the model;
  // model body/response expressions are intentionally scoped to normal APIs.
  const body = { ...rawBody, model: config.model };
  const url = getAlphaSearchURL(config);
  const { response, timing } = await upstreamFetchToUrl(
    config,
    url,
    JSON.stringify(body),
    false,
    getForwardHeaders(config, body, options),
    options,
    body,
  );
  const responseText = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: responseText });
  let responseBody: unknown = responseText;
  try { responseBody = JSON.parse(responseText); } catch {}
  return { body: responseBody, responseText, headers: response.headers, status: response.status, timing };
}

// ─── Passthrough (same format, no conversion) ───────────────────────────────

export async function passthroughRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<{ json: unknown; timing: UpstreamTiming; usage?: NormalizedUsage }> {
  const body = preparePassthroughBody(config, rawBody, false);
  const { response, timing } = await upstreamFetch(config, body, false, options);
  const text = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
  const parsed = JSON.parse(text);
  const json = isJsonContentType(response.headers) ? applyModelResponseExpression(config, parsed, response.headers) : parsed;
  const usage = normalizeUsage((json as Record<string, unknown>)?.usage as Record<string, unknown> | undefined);
  return { json, timing, usage };
}

export async function passthroughStreamRequest(
  config: ModelConfig,
  rawBody: Record<string, unknown>,
  options?: UpstreamRequestOptions,
): Promise<{ body: ReadableStream<Uint8Array>; headers: Headers; timing: UpstreamTiming }> {
  const body = preparePassthroughBody(config, rawBody, true);
  const { response, timing } = await upstreamFetch(config, body, true, options);
  if (!response.body) throw new Error("Upstream returned no streaming body");
  const validatedBody = await validateStreamContent(response.body, { attemptIndex: options?.attemptIndex ?? 0, config, headers: response.headers });
  return { body: validatedBody, headers: response.headers, timing };
}

// ─── Forward with conversion (different format) ────────────────────────────

export async function forwardRequest(
  config: ModelConfig,
  normalized: NormalizedRequest,
  options?: UpstreamRequestOptions,
): Promise<{ normalizedResponse: NormalizedResponse; timing: UpstreamTiming; usage?: NormalizedUsage }> {
  normalized.stream = false;
  normalized.model = config.model;
  normalized.image = config.image ?? true;

  const body = applyModelBodyTransforms(config, applyOpenAIDefaults(config.provider, denormalizeRequest(config, normalized)));
  const { response, timing } = await upstreamFetch(config, body, false, options);
  const text = await response.text();
  setRecordedAttemptResponseBody({ index: options?.attemptIndex ?? 0, body: text });
  const parsed = JSON.parse(text);
  const json = isJsonContentType(response.headers) ? applyModelResponseExpression(config, parsed, response.headers) : parsed;
  const normalizedResponse = normalizeUpstreamResponse(config.provider, json);
  return { normalizedResponse, timing, usage: normalizedResponse.usage };
}

export async function forwardStreamRequest(
  config: ModelConfig,
  normalized: NormalizedRequest,
  options?: UpstreamRequestOptions,
): Promise<{ body: ReadableStream<Uint8Array>; upstreamFormat: StreamFormat; timing: UpstreamTiming }> {
  normalized.stream = true;
  normalized.model = config.model;
  normalized.image = config.image ?? true;

  const body = applyModelBodyTransforms(config, applyOpenAIDefaults(config.provider, denormalizeRequest(config, normalized)));
  const { response, timing } = await upstreamFetch(config, body, true, options);
  if (!response.body) throw new Error("Upstream returned no streaming body");
  const validatedBody = await validateStreamContent(response.body, { attemptIndex: options?.attemptIndex ?? 0, config, headers: response.headers });
  return { body: validatedBody, upstreamFormat: config.provider, timing };
}
