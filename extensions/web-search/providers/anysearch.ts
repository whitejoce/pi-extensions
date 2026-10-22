import type { SearchAdapter } from "../provider.js";
import { ApiError, fetchResult, validateUrl } from "../response.js";
import type { FetchResult, SearchResult } from "../types.js";
import { ANYSEARCH_LOGIN, registerAnySearch } from "./anysearch-registration.js";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function anyData(value: unknown): Record<string, unknown> {
  if (!object(value) || value.code !== 0 || !object(value.data)) {
    // Even HTTP 200 business errors may contain generated credentials.
    throw new ApiError(502, "Invalid AnySearch success response");
  }
  return value.data;
}

export function anySearchResults(value: unknown): SearchResult[] {
  const data = anyData(value);
  if (!Array.isArray(data.results) || data.results.length > 100) throw new ApiError(502, "Invalid AnySearch results");
  return data.results.map((row: unknown) => {
    if (!object(row) || typeof row.title !== "string" || typeof row.url !== "string" ||
      (row.snippet !== undefined && typeof row.snippet !== "string") ||
      (row.content !== undefined && typeof row.content !== "string")) {
      throw new ApiError(502, "Invalid AnySearch result fields");
    }
    try { validateUrl(row.url); }
    catch { throw new ApiError(502, "Invalid URL in AnySearch results"); }
    const snippet = (row.snippet as string | undefined) ?? (row.content as string | undefined) ?? "";
    return { title: row.title || "(untitled)", url: row.url, snippet: snippet.slice(0, 600),
      summary: snippet.slice(0, 600), rerank_score: null, authority: null, site_name: null, date: null };
  });
}

export function anyFetchResult(value: unknown): FetchResult {
  return fetchResult(anyData(value));
}

const headers = (key: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${key}` });

export const anysearch = {
  id: "anysearch",
  label: "AnySearch",
  defaultBaseUrl: "https://api.anysearch.com",
  requireHttps: true,
  autoPriority: 20,
  credentials: { keyFields: ["anysearch_api_key"], baseUrlFields: ["anysearch_base_url"] },
  priceCny: { search: null, fetch: null },
  search: {
    request: (query, count, key) => ({ path: "/v1/search", method: "POST", headers: headers(key), body: { query, max_results: count, format: "json" } }),
    parse: anySearchResults,
  },
  fetch: {
    request: (url, key) => ({ path: "/v1/extract", method: "POST", headers: headers(key), body: { url } }),
    parse: anyFetchResult,
  },
  registration: { loginUrl: ANYSEARCH_LOGIN, createKey: registerAnySearch },
  httpError(status, _text, responseHeaders) {
    const id = responseHeaders.get("x-request-id");
    const requestId = id && /^[a-f\d-]{36}$/i.test(id) ? id : undefined;
    return new ApiError(status, `AnySearch request failed (HTTP ${status})`, requestId);
  },
  networkError: () => new ApiError(504, "AnySearch network request failed"),
} as const satisfies SearchAdapter;
