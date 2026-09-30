import { createHash } from "node:crypto";

export const CLAUDE_SUBSCRIPTION_DEFAULT_MAX_TOKENS = 128000;

export function hasClaudeMetadataUserId(body: unknown): boolean {
  return isRecord(body) && isRecord(body.metadata) && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim().length > 0;
}

/** Session hints are read from the original client request, before default headers. */
export function addClaudeSubscriptionUserId(body: unknown, options: {
  provider: string;
  deviceId: string;
  clientHeaders?: Headers;
  clientIp?: string;
  promptCacheKey?: string;
}): unknown {
  if (!isRecord(body) || hasClaudeMetadataUserId(body)) return body;
  let source = "fallback";
  let value = "";
  for (const name of ["x-claude-code-session-id", "session_id", "thread_id", "conversation_id"]) {
    const hint = options.clientHeaders?.get(name)?.trim();
    if (hint) { source = name; value = hint; break; }
  }
  if (!value && options.promptCacheKey?.trim()) {
    source = "prompt_cache_key";
    value = options.promptCacheKey.trim();
  }
  if (!value) {
    const firstUser = Array.isArray(body.messages)
      ? body.messages.find((message) => isRecord(message) && message.role === "user") : undefined;
    const content = isRecord(firstUser) ? firstUser.content : undefined;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : "";
    value = JSON.stringify([options.clientIp ?? "", options.clientHeaders?.get("user-agent") ?? "", text]);
  }
  const hash = createHash("sha256").update(JSON.stringify([options.provider, source, value])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { ...body, metadata: {
    ...(isRecord(body.metadata) ? body.metadata : {}),
    user_id: JSON.stringify({ device_id: options.deviceId, account_uuid: "", session_id: sessionId }),
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOpus55(model: unknown): boolean {
  if (typeof model !== "string") return false;
  let id = model.trim().toLowerCase().replace(/^models\//, "");
  if (id.includes("/")) id = id.slice(id.indexOf("/") + 1).trim().replace(/^models\//, "");
  id = id.replace(/^(?:us-gov|global|apac|us|eu|jp|au)\./, "").replace(/^anthropic\./, "");
  id = id.replace(/-thinking$/, "").replace(/-\d{8}$/, "");
  return id === "claude-opus-5-5" || id === "claude-opus-5.5";
}

/** Apply subscription defaults and sub2api's explicit cache breakpoint cleanup. */
export function sanitizeClaudeSubscriptionBody(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const result = structuredClone(body);
  if (result.tools === undefined) result.tools = [];
  if (result.max_tokens === undefined) result.max_tokens = CLAUDE_SUBSCRIPTION_DEFAULT_MAX_TOKENS;
  if (result.temperature === undefined && !isOpus55(result.model)) result.temperature = 1;
  if (!Array.isArray(result.tools) || result.tools.length === 0) delete result.tool_choice;

  const systemBreakpoints: Record<string, unknown>[] = [];
  const messageBreakpoints: Record<string, unknown>[] = [];
  const toolBreakpoints: Record<string, unknown>[] = [];
  const collect = (blocks: unknown, breakpoints: Record<string, unknown>[]) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!isRecord(block) || !("cache_control" in block)) continue;
      if (block.type === "thinking") delete block.cache_control;
      else breakpoints.push(block);
    }
  };
  collect(result.system, systemBreakpoints);
  if (Array.isArray(result.messages)) {
    for (const message of result.messages) {
      if (isRecord(message)) collect(message.content, messageBreakpoints);
    }
  }
  if (Array.isArray(result.tools)) {
    for (const tool of result.tools) {
      if (isRecord(tool) && "cache_control" in tool) toolBreakpoints.push(tool);
    }
  }
  let excess = systemBreakpoints.length + messageBreakpoints.length + toolBreakpoints.length - 4;
  for (const block of [...toolBreakpoints.reverse(), ...messageBreakpoints, ...systemBreakpoints.reverse()]) {
    if (excess <= 0) break;
    delete block.cache_control;
    excess--;
  }
  return result;
}
