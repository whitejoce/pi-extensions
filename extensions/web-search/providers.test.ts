import assert from "node:assert/strict";
import { SearchClient, resolveCredentials } from "./client.js";
import { anySearchResults, anyFetchResult } from "./providers/anysearch.js";
import { buildSearchLines, buildFetchLines, searchContent } from "./render.js";

const config = () => ({ provider: "anysearch", anysearch_api_key: "test-any-key", api_key: "test-deep-key" });
const absent = () => undefined;
const choose = (file: Record<string, string>, readCredential = absent) => new SearchClient({ readEnvFile: () => file, readCredential });
assert.equal(choose({ anysearch_api_key: "test-any" }).provider, "anysearch", "only AnySearch configured: automatically use it");
assert.equal(choose({ api_key: "test-deep" }).provider, "deepseek");
assert.equal(choose({ api_key: "test-deep", anysearch_api_key: "test-any" }).provider, "deepseek", "DeepSeek always wins in auto mode");
assert.equal(choose({ provider: "auto", api_key: "test-deep", anysearch_api_key: "test-any" }).providerMode, "auto");
const authDeep = new SearchClient({ readEnvFile: () => ({ anysearch_api_key: "test-any" }),
  readCredential: () => ({ type: "api_key", key: "test-auth" }) });
assert.equal(authDeep.provider, "deepseek", "Pi's saved DeepSeek API key also wins");
assert.match(authDeep.selectionReason, /preferred/);
assert.equal(choose({ api_key: "  ", anysearch_api_key: "test-any" }).provider, "anysearch", "blank keys are not configured credentials");
const corruptAuth = new SearchClient({ readEnvFile: () => ({ anysearch_api_key: "test-any" }),
  readCredential: () => { throw new Error("unreadable credential store"); } });
assert.equal(corruptAuth.provider, "anysearch");
assert.match(choose({}).stats().lastError!, /no search API key/);
assert.match(choose({}).selectionReason, /no search credentials/);
assert.equal(choose({ provider: "anysearch", api_key: "test-deep" }).provider, "anysearch", "explicit mode never silently switches");
assert.equal(choose({ provider: "deepseek", anysearch_api_key: "test-any" }).provider, "deepseek");
assert.equal(choose({ provider: "anysearch", api_key: "test-deep", anysearch_api_key: "test-any" }).provider, "anysearch");
const calls: { url: string; body: unknown; authorization: string | null }[] = [];
const fetchImpl: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("Authorization") });
  assert.equal(init?.redirect, "error");
  return Response.json({ code: 0, data: String(input).endsWith("/search")
    ? { results: [{ title: "Example", url: "https://example.com", snippet: "Test summary" }] }
    : { title: "Example", content: "Full text" } });
};

// A different provider must never reuse the old provider's key or endpoint.
const noFallback = resolveCredentials(() => { throw new Error("must not read DeepSeek credential"); },
  () => ({ api_key: "private-deep-key", base_url: "https://deep.example" }), "anysearch");
assert.equal(noFallback.apiKey, undefined);
assert.equal(noFallback.baseUrl, undefined);
assert.equal(noFallback.source, "none");
const client = new SearchClient({ readEnvFile: config, fetchImpl, dailyLimit: 2 });
assert.equal(client.provider, "anysearch");
assert.equal(client.stats().estimatedCostCny, null);
let charges = 0;
client.onCharge(() => { charges++; });
const result = await client.search("example", 3);
assert.equal(calls[0].url, "https://api.anysearch.com/v1/search");
assert.deepEqual(calls[0].body, { query: "example", max_results: 3, format: "json" });
assert.equal(calls[0].authorization, "Bearer test-any-key");
assert.equal(result.results[0].rerank_score, null);
assert.equal(result.results[0].authority, null);
assert.equal(result.costCny, null);
assert.match(searchContent(result), /N\/A/);
const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
for (const expanded of [false, true]) {
  const lines = buildSearchLines(result, theme, { expanded })(96).join("\n");
  assert.match(lines, /cost unknown/);
  assert.match(lines, /N\/A/);
}
assert.equal((await client.search("example", 3)).cached, true);
assert.equal(calls.length, 1);
const page = await client.fetchPage("https://example.com");
assert.equal(calls[1].url, "https://api.anysearch.com/v1/extract");
assert.deepEqual(calls[1].body, { url: "https://example.com" });
assert.equal(page.content, "Full text");
assert.equal(page.costCny, null);
assert.match(buildFetchLines({ ...page, url: "https://example.com", totalChars: 9, offset: 0, length: 9, text: page.content }, theme)(96).join("\n"), /cost unknown/);
assert.equal((await client.fetchPage("https://example.com")).costCny, 0);
assert.equal(charges, 0, "unknown price must not generate fictional CNY expenses");
await assert.rejects(client.search("over limit"), /daily limit/);
assert.equal(client.stats().dailyPending, 0);

const missing = new SearchClient({ readEnvFile: () => ({ provider: "anysearch", api_key: "deep-key" }), fetchImpl });
await assert.rejects(missing.search("test"), /no AnySearch API key/);
assert.throws(() => new SearchClient({ readEnvFile: () => ({ provider: "typo" }) }), /provider/);
assert.throws(() => new SearchClient({ provider: "anysearch", baseUrl: "http://example.com" }), /HTTPS/);
assert.throws(() => new SearchClient({ provider: "anysearch", baseUrl: "https://user:secret@example.com" }), /embedded credentials/);
await assert.rejects(client.search("invalid", 11), /integer from 1 to 10/);

for (const status of [401, 402, 403, 429, 502]) {
  const failed = new SearchClient({ readEnvFile: config, fetchImpl: async () => Response.json({ message: "password=SENSITIVE api_key=SENSITIVE" }, { status }) });
  await assert.rejects(failed.search("fail"), e => e instanceof Error && e.message.includes(String(status)) && !e.message.includes("SENSITIVE"));
  assert.equal(failed.stats().dailyPending, 0);
  assert.equal(failed.stats().billed, 0);
  assert.ok(!failed.stats().lastError?.includes("SENSITIVE"));
}
const businessError = new SearchClient({ readEnvFile: config, fetchImpl: async () => Response.json({ code: -1, message: "SENSITIVE", data: {} }) });
await assert.rejects(businessError.search("fail"), /Invalid AnySearch success response/);
const empty = new SearchClient({ readEnvFile: config, fetchImpl: async () => Response.json({ code: 0, data: { results: [] } }) });
assert.deepEqual((await empty.search("empty")).results, []);
assert.equal(empty.stats().billed, 0);
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(client.search("cancel", 1, cancelled.signal));
await assert.rejects(client.fetchPage("https://example.com", cancelled.signal));

let begin!: () => void;
const started = new Promise<void>(resolve => { begin = resolve; });
let attempts = 0;
const slow = new SearchClient({ readEnvFile: config, fetchImpl: async (_url, init) => {
  attempts++;
  begin();
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
} });
const inFlight = new AbortController();
const pending = slow.search("cancel in flight", 1, inFlight.signal);
const rejection = assert.rejects(pending);
await started;
inFlight.abort();
await rejection;
assert.equal(attempts, 1, "cancelled network requests must not retry");
assert.equal(slow.stats().dailyPending, 0);
assert.equal(slow.stats().billed, 0);

let release!: (response: Response) => void;
const singleSlot = new SearchClient({ readEnvFile: config, dailyLimit: 1,
  fetchImpl: async () => new Promise<Response>(resolve => { release = resolve; }) });
const first = singleSlot.search("first");
await assert.rejects(singleSlot.search("second"), /daily limit/);
release(Response.json({ code: 0, data: { results: [{ title: "one", url: "https://example.com" }] } }));
await first;
assert.equal(singleSlot.stats().dailyPending, 0);
assert.equal(singleSlot.stats().dailyBilled, 1);

assert.throws(() => anySearchResults({ code: 0, data: { results: [{ title: "x", url: "javascript:alert(1)" }] } }), /Invalid URL/);
assert.throws(() => anySearchResults({ code: 0, data: { results: [{ title: "x", url: "https://example.com", snippet: 3 }] } }), /Invalid AnySearch/);
assert.throws(() => anyFetchResult({ code: 0, data: { title: "x" } }), /Invalid web-fetch/);
const noSnippet = anySearchResults({ code: 0, data: { results: [{ title: "", url: "https://example.com", content: "x".repeat(1000) }] } })[0];
assert.equal(noSnippet.summary.length, 600);
assert.equal(noSnippet.title, "(untitled)");

// Default route and accounting stay backward compatible.
const deep = new SearchClient({ readEnvFile: () => ({}), readCredential: () => ({ type: "api_key", key: "test-deep" }), fetchImpl: async (url, init) => {
  assert.equal(String(url), "https://api.deepseek.com/v1/tools/search");
  assert.deepEqual(JSON.parse(String(init?.body)), { query: "deep", count: 5, need_content: false });
  return Response.json({ results: [{ title: "Deep", url: "https://example.com", snippet: "x", summary: "x", rerank_score: 2, authority: 3 }] });
} });
let amount = 0;
deep.onCharge(c => { amount += c.amountCny; });
assert.equal((await deep.search("deep")).costCny, 0.005);
assert.equal(amount, 0.005);
assert.equal((await deep.search("deep")).costCny, 0);
let failedDeepCalls = 0;
const autoFailure = new SearchClient({ readEnvFile: () => ({ api_key: "test-deep", anysearch_api_key: "test-any" }), readCredential: absent,
  fetchImpl: async url => {
    failedDeepCalls++;
    assert.equal(String(url), "https://api.deepseek.com/v1/tools/search");
    return Response.json({ error: { message: "invalid test key" } }, { status: 401 });
  } });
await assert.rejects(autoFailure.search("failure"), /401/);
assert.equal(failedDeepCalls, 1, "auto selection is not runtime failover to another service");
console.log("DeepSeek/AnySearch routing, credentials, parsing, rendering, cache, quota, errors and accounting passed");
