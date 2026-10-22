import type { SearchAdapter } from "../provider.js";
import { ApiError, fetchResult, validateUrl } from "../response.js";
import type { SearchResult } from "../types.js";

export const PRICE_PER_CALL_CNY = 0.005;

export function searchResults(value: unknown): SearchResult[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) {
    throw new ApiError(502, "Invalid web-search results response");
  }
  const rows = (value as { results: unknown[] }).results;
  if (rows.length > 100) throw new ApiError(502, "Too many web-search results");
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ApiError(502, "Invalid web-search result fields");
    const r = row as Record<string, unknown>;
    if (!["title", "url", "snippet", "summary"].every(key => typeof r[key] === "string") ||
      typeof r.rerank_score !== "number" || !Number.isFinite(r.rerank_score) || !Number.isInteger(r.authority) ||
      (r.site_name != null && typeof r.site_name !== "string") || (r.date != null && typeof r.date !== "string")) {
      throw new ApiError(502, "Invalid web-search result fields");
    }
    try { validateUrl(r.url as string); }
    catch { throw new ApiError(502, "Invalid URL in web-search results"); }
    return { rerank_score: r.rerank_score, authority: r.authority as number, title: r.title as string,
      url: r.url as string, snippet: r.snippet as string, summary: r.summary as string,
      site_name: r.site_name as string | null ?? null, date: r.date as string | null ?? null };
  });
}

const headers = (key: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${key}` });

export const deepseek = {
  id: "deepseek",
  label: "DeepSeek",
  defaultBaseUrl: "https://api.deepseek.com",
  requireHttps: false,
  autoPriority: 10,
  credentials: { keyFields: ["api_key", "apikey"], baseUrlFields: ["base_url", "baseUrl"], authProvider: "deepseek" },
  priceCny: { search: PRICE_PER_CALL_CNY, fetch: PRICE_PER_CALL_CNY },
  search: {
    request: (query, count, key) => ({ path: "/v1/tools/search", method: "POST", headers: headers(key), body: { query, count, need_content: false } }),
    parse: searchResults,
  },
  fetch: {
    request: (url, key) => ({ path: "/v1/tools/fetch", method: "POST", headers: headers(key), body: { url } }),
    parse: fetchResult,
  },
  httpError(status, text) {
    let message = text;
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; request_id?: string };
      message = parsed.error?.message ?? message;
      requestId = parsed.request_id;
    } catch { /* preserve legacy DeepSeek error behavior */ }
    const friendly: Record<number, string> = {
      402: "DeepSeek account balance insufficient (402): top up at the DeepSeek platform, then retry.",
      429: "Rate limited (429): retrying with backoff.",
    };
    return new ApiError(status, friendly[status] ?? `${message} (HTTP ${status})`, requestId);
  },
  networkError: error => new ApiError(504, `network error: ${(error as Error).message}`),
} as const satisfies SearchAdapter;
