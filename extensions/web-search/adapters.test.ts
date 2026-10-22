import assert from "node:assert/strict";
import { SearchClient } from "./client.js";
import { selectProvider } from "./configuration.js";
import type { SearchAdapter } from "./provider.js";
import { orderedProviders, providers } from "./registry.js";
import { ApiError } from "./response.js";
import { anysearch } from "./providers/anysearch.js";

assert.deepEqual(orderedProviders().map(adapter => adapter.id), ["deepseek", "anysearch"]);
for (const [id, adapter] of Object.entries(providers)) assert.equal(id, adapter.id);
assert.throws(() => new SearchClient({ readEnvFile: () => ({ provider: "exa" }) }), /provider/);
assert.throws(() => new SearchClient({ readEnvFile: () => ({ provider: "toString" }) }), /provider/);

// An offline third provider proves the coordinator does not depend on either wire protocol.
const fixture: SearchAdapter = {
  id: "fixture",
  label: "Fixture",
  defaultBaseUrl: "https://fixture.example",
  requireHttps: true,
  autoPriority: 30,
  credentials: { keyFields: ["fixture_key"], baseUrlFields: ["fixture_url"] },
  priceCny: { search: 0.02, fetch: 0.03 },
  search: {
    request: (query, count, key) => ({ path: `/lookup?q=${encodeURIComponent(query)}&limit=${count}`,
      method: "GET", headers: { "x-api-key": key } }),
    parse: value => {
      assert.deepEqual(value, { matches: ["fixture result"] });
      return [{ title: "Fixture", url: "https://example.com", snippet: "fixture result", summary: "fixture result",
        rerank_score: null, authority: null, date: null, site_name: null }];
    },
  },
  fetch: {
    request: (url, key) => ({ path: "/read", method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key }, body: { target: url } }),
    parse: value => {
      assert.deepEqual(value, { text: "fixture page" });
      return { title: "Fixture page", content: "fixture page" };
    },
  },
  httpError: status => new ApiError(status, `Fixture HTTP ${status}`),
  networkError: () => new ApiError(504, "Fixture network failure"),
};
const file = { fixture_key: "test-fixture", api_key: "test-deep" };
let calls = 0;
const client = new SearchClient({ adapters: [fixture], readEnvFile: () => file, readCredential: () => undefined,
  fetchImpl: async (url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-fixture");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    assert.equal(init?.redirect, "error");
    if (init?.method === "GET") {
      assert.equal(String(url), "https://fixture.example/lookup?q=hello%20world&limit=2");
      assert.equal(init.body, undefined);
      return Response.json({ matches: ["fixture result"] });
    }
    assert.equal(String(url), "https://fixture.example/read");
    assert.deepEqual(JSON.parse(String(init?.body)), { target: "https://example.com" });
    return Response.json({ text: "fixture page" });
  } });
assert.equal(client.provider, "fixture");
const expenses: number[] = [];
client.onCharge(charge => { expenses.push(charge.amountCny); });
assert.equal((await client.search("hello world", 2)).costCny, 0.02);
assert.equal((await client.fetchPage("https://example.com")).costCny, 0.03);
assert.equal((await client.search("hello world", 2)).cached, true);
assert.equal(calls, 2);
assert.deepEqual(expenses, [0.02, 0.03]);
assert.equal(client.stats().estimatedCostCny, 0.05, "status sums operation-specific prices, not calls times a single price");

const searchOnly = new SearchClient({ adapters: [{ ...fixture, fetch: undefined, priceCny: { search: 0.02, fetch: null } }],
  readEnvFile: () => file, fetchImpl: async () => { throw new Error("must not dispatch unsupported extraction"); } });
await assert.rejects(searchOnly.fetchPage("https://example.com"), /does not support page extraction/);
assert.equal(searchOnly.stats().dailyPending, 0);
assert.equal(searchOnly.stats().billed, 0);
assert.equal(searchOnly.stats().estimatedCostCny, 0);

const ordered = [...orderedProviders(), fixture];
assert.equal(selectProvider("auto", { fixture_key: "test-fixture" }, () => undefined, undefined, ordered).adapter.id, "fixture");
assert.equal(selectProvider("auto", { fixture_key: "test-fixture", anysearch_api_key: "test-any" }, () => undefined, undefined, ordered).adapter.id, anysearch.id);
assert.equal(selectProvider("auto", { ...file, anysearch_api_key: "test-any" }, () => undefined, undefined, ordered).adapter.id, "deepseek");
console.log("Adapter contract: third-provider routing, custom auth, GET/POST, capabilities and per-operation pricing passed");
