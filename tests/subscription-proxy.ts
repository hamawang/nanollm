import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { oauthPost, resolveOAuthTransportPath } from "../src/oauth-transport.js";
import { bootstrapSubscriptionProviders, configureSubscriptionStorage, startDeviceLogin, pollDeviceLogin, ensureSubscriptionCredential, getCachedSubscriptionCredential } from "../src/openai-subscription.js";

test("OAuth transport fails on proxy rejection without bypassing it", async () => {
  const targets: string[] = [];
  const proxy = http.createServer();
  proxy.on("connect", (request, socket) => {
    targets.push(request.url!);
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const address = proxy.address() as { port: number };
    await assert.rejects(oauthPost("https://auth.openai.com/oauth/token", "dummy", undefined, `http://127.0.0.1:${address.port}`));
    assert.deepEqual(targets, ["auth.openai.com:443"]);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test("device login pins provider proxy; refresh uses updated provider proxy", async (t) => {
  if (process.platform === "win32" || resolveOAuthTransportPath()) return t.skip("Requires an isolated mock helper");
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "nanollm-oauth-test-"));
  const helperDir = join(dir, "native/oauth-transport/target/release");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "nanollm-oauth-transport"), `#!/usr/bin/env node
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync('requests.jsonl', JSON.stringify(request) + '\\n');
const payload = request.url.endsWith('/usercode') ? {device_auth_id:'device',user_code:'CODE'}
  : request.url.endsWith('/deviceauth/token') ? {authorization_code:'code',code_verifier:'verifier'}
  : {access_token:'dummy',refresh_token:'refresh',account_id:'account',expires_in:3600};
console.log(JSON.stringify({status:200,body:JSON.stringify(payload)}));
`, { mode: 0o755 });
  process.chdir(dir);
  try {
    configureSubscriptionStorage(join(dir, "config.yaml"));
    const provider = { name: "proxy-test", provider: "openai-subscription" as const, base_url: "", api_key: "", proxy: "http://first.example:8080" };
    bootstrapSubscriptionProviders([provider]);
    const login = await startDeviceLogin(provider);
    provider.proxy = "http://second.example:8080";
    bootstrapSubscriptionProviders([provider]);
    assert.equal((await pollDeviceLogin(login.sessionId)).status, "authenticated");
    getCachedSubscriptionCredential(provider.name)!.expiresAt = 0;
    await ensureSubscriptionCredential(provider.name);
    const requests = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => request.proxy), ["http://first.example:8080", "http://first.example:8080", "http://first.example:8080", "http://second.example:8080"]);
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), ["/api/accounts/deviceauth/usercode", "/api/accounts/deviceauth/token", "/oauth/token", "/oauth/token"]);
    assert.equal(new URLSearchParams(requests[3].body).get("grant_type"), "refresh_token");
  } finally {
    bootstrapSubscriptionProviders([]);
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
