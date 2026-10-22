import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import webSearch from "../web-search.js";
import { SearchClient } from "./client.js";
import { readConfigEnvFile } from "./configuration.js";
import { MaskedKeyInput, SearchSettings } from "./settings.js";

const theme = { fg: (_color: string, text: string) => text } as Theme;
initTheme("dark", false);
let entered: string | undefined;
const masked = new MaskedKeyInput(theme, "API Key", key => { entered = key; });
masked.handleInput("test-hidden");
assert.ok(!masked.render(60).join("\n").includes("test-hidden"));
assert.match(masked.render(60).join("\n"), /\*+/);
masked.handleInput("\x7f");
masked.handleInput("\r");
assert.equal(entered, "test-hidde");
const pasted = new MaskedKeyInput(theme, "API Key", key => { entered = key; });
pasted.handleInput("\x1b[200~test-pasted-key\x1b[201~");
assert.ok(!pasted.render(60).join("\n").includes("test-pasted-key"));
pasted.handleInput("\x1b");
assert.equal(entered, undefined);

const root = mkdtempSync(join(tmpdir(), "pi-search-settings-"));
const path = join(root, ".env.web-search");
const legacy = join(root, "absent.env");
const readConfig = () => readConfigEnvFile(path, legacy);
const signal = new AbortController().signal;
let network = 0;
const requests: string[] = [];
let pendingStarted!: () => void;
const pendingReady = new Promise<void>(resolve => { pendingStarted = resolve; });
const fetchImpl: typeof fetch = async (url, init) => {
  network++;
  requests.push(String(url));
  if (init?.body && JSON.parse(String(init.body)).query === "pending") {
    pendingStarted();
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  }
  if (String(url).endsWith("/register")) return Response.json({ code: 0, data: { api_key: { key: "test-registered-key" } } });
  if (String(url).includes("anysearch")) return Response.json({ code: 0, data: { results: [{ title: "Any", url: "https://example.com" }] } });
  return Response.json({ results: [{ title: "Deep", url: "https://example.com", snippet: "x", summary: "x", rerank_score: 2, authority: 3 }] });
};
const service = new SearchSettings({ path, readConfig, readCredential: () => undefined, fetchImpl });
let current = new SearchClient({ readEnvFile: readConfig, readCredential: () => undefined, fetchImpl });
const apply = (client: SearchClient) => { current = client; };
const notices: string[] = [];
let selections: number[] = [];
let confirmations: boolean[] = [];
let email = "new@example.com";
let secret = "test-hidden-key";
let cancelLoader = false;
const ctx = {
  mode: "tui",
  ui: {
    select: async (_title: string, choices: string[]) => { const index = selections.shift(); return index === undefined ? undefined : choices[index]; },
    confirm: async () => confirmations.shift() ?? false,
    input: async () => email,
    notify: (message: string) => { notices.push(message); },
    custom: (factory: Function) => new Promise(resolve => {
      let component: { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
      component = factory({ requestRender() {} }, theme, {}, (result: unknown) => { component?.dispose?.(); resolve(result); });
      if (component.render(100).join("\n").includes("API Key")) {
        component.handleInput?.(secret);
        assert.ok(!component.render(100).join("\n").includes(secret));
        component.handleInput?.("\r");
      } else if (cancelLoader) component.handleInput?.("\x1b");
    }),
  },
} as unknown as ExtensionCommandContext;

try {
  writeFileSync(path, '# preserve comment\nother=value\nprovider=auto\napi_key=test-deep-key\nanysearch_api_key=test-any-key\n');
  current = new SearchClient({ readEnvFile: readConfig, readCredential: () => undefined, fetchImpl });
  selections = [2];
  await service.command("provider", undefined, ctx, signal, current, apply);
  assert.equal(current.provider, "anysearch");
  assert.equal(readConfig().api_key, "test-deep-key");
  assert.match(readFileSync(path, "utf8"), /preserve comment/);
  assert.equal((await current.search("same")).results[0].title, "Any");
  await service.command("provider", "auto", ctx, signal, current, apply);
  assert.equal(current.provider, "deepseek");
  assert.equal((await current.search("same")).results[0].title, "Deep");
  assert.equal(requests.length, 2, "hot switch clears provider-specific cache");

  const before = service.snapshot();
  selections = [];
  await service.command("provider", undefined, ctx, signal, current, apply);
  assert.equal(service.snapshot(), before, "cancelling provider menu writes nothing");
  writeFileSync(path, readFileSync(path, "utf8") + "external=change\n");
  await assert.rejects(service.save({ provider: "anysearch" }, before, signal, apply), /其他操作修改/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(service.save({ provider: "anysearch" }, service.snapshot(), aborted.signal, apply));
  assert.equal(current.provider, "deepseek");

  selections = [2, 0]; confirmations = [true];
  await service.command("setup", undefined, ctx, signal, current, apply);
  assert.equal(current.provider, "anysearch");
  assert.equal(readConfig().anysearch_api_key, secret);
  assert.ok(notices.every(message => !message.includes(secret)));

  // Register only after consent; a declined request creates no account and writes nothing.
  selections = [0, 1, 1]; confirmations = [false];
  const noConsent = service.snapshot(); const callsBefore = network;
  await service.command("setup", undefined, ctx, signal, current, apply);
  assert.equal(network, callsBefore); assert.equal(service.snapshot(), noConsent);
  selections = [0, 1, 1]; confirmations = [true]; cancelLoader = true;
  await service.command("setup", undefined, ctx, signal, current, apply);
  cancelLoader = false;
  assert.equal(service.snapshot(), noConsent, "cancelling a dispatched registration never persists its key");
  assert.ok(notices.some(message => message.includes("注册已取消，账号可能已创建")));
  writeFileSync(path, readFileSync(path, "utf8") + "anysearch_base_url=https://old-proxy.example\n");
  selections = [0, 1, 1]; confirmations = [true];
  await service.command("setup", undefined, ctx, signal, current, apply);
  assert.equal(readConfig().anysearch_api_key, "test-registered-key");
  assert.equal(readConfig().anysearch_base_url, "https://api.anysearch.com", "new official keys cannot inherit a custom endpoint");
  assert.equal(current.provider, "deepseek", "registration respects DeepSeek-first auto strategy");
  assert.ok(notices.every(message => !message.includes("test-registered-key") && !message.includes(email)));

  const headless = { ...ctx, mode: "rpc" } as ExtensionCommandContext;
  const snapshot = service.snapshot();
  await service.command("setup", undefined, headless, signal, current, apply);
  assert.equal(service.snapshot(), snapshot);
  assert.match(notices[notices.length - 1], /RPC 不接收密钥/);

  // Exercise the production command handler and tools, not only the settings service.
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools = new Map<string, { execute: Function }>();
  const pi = { on() {}, registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, command); }, appendEntry() {} } as unknown as ExtensionAPI;
  webSearch(pi, current, service);
  const command = commands.get("websearch")!;
  const beforeHelp = network;
  await command.handler("help", headless);
  assert.equal(network, beforeHelp, "help must never become a billable search");
  await command.handler("provider anysearch", headless);
  const response = await tools.get("web_search")!.execute("test", { query: "integration" }, undefined, undefined, headless);
  assert.equal(response.details.results[0].title, "Any");
  await command.handler("status", headless);
  const status = notices[notices.length - 1];
  assert.match(status, /选择策略：anysearch/);
  assert.match(status, /已手动指定 AnySearch/);
  assert.match(status, /DeepSeek：已配置/);
  assert.match(status, /AnySearch：已配置/);
  assert.ok(!status.includes("本进程今日"), "normal status hides diagnostic counters");
  assert.ok(!status.includes("test-registered-key"));
  const pendingTool = tools.get("web_search")!.execute("pending", { query: "pending" }, undefined, undefined, headless);
  const pendingRejected = assert.rejects(pendingTool);
  await pendingReady;
  await command.handler("provider auto", headless);
  await pendingRejected;
  await command.handler("status", headless);
  assert.match(notices[notices.length - 1], /当前渠道：deepseek/);
  const freshPath = join(root, "fresh.env");
  const freshConfig = () => readConfigEnvFile(freshPath, legacy);
  const freshService = new SearchSettings({ path: freshPath, readConfig: freshConfig, readCredential: () => undefined, fetchImpl });
  let fresh = new SearchClient({ readEnvFile: freshConfig, readCredential: () => undefined, fetchImpl });
  selections = [0, 0]; confirmations = [true];
  const beforeSignup = network;
  await freshService.home(ctx, () => fresh, () => signal, next => { fresh = next; });
  assert.equal(fresh.providerMode, "auto");
  assert.equal(fresh.provider, "anysearch");
  assert.equal(network, beforeSignup + 1, "quick start registers once and does not silently run a paid test");
  assert.equal(fresh.verified, false);
  assert.match(freshService.summary(fresh), /尚未验证/);
  const configuredFile = freshService.snapshot();
  selections = [1];
  await freshService.home(ctx, () => fresh, () => signal, next => { fresh = next; });
  assert.equal(freshService.snapshot(), configuredFile, "existing credentials need no setup or repeated key entry");
  selections = [0];
  await freshService.home(ctx, () => fresh, () => signal, next => { fresh = next; });
  assert.equal(fresh.verified, true);
  assert.match(freshService.summary(fresh), /连接已验证/);
  assert.ok(existsSync(path));
  console.log("Settings UI: masking, consent, signup, cancellation, atomic persistence, stale guards, hot switching and production command integration passed");
} finally { rmSync(root, { recursive: true, force: true }); }
