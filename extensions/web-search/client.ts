/**
 * DeepSeek/AnySearch Search/Fetch API client for the web-search extension.
 *
 * DeepSeek billing: 5 CNY per 1000 successful calls (0.005/call); AnySearch
 * pricing is unknown and never generates a fictional expense. Retries: 408/429/5xx
 * are retried with backoff, other 4xx are not.
 *
 * Credentials resolution (first hit wins):
 *   1. config/pi-extensions/.env.web-search under Pi's agent directory
 *   2. Legacy .env in this extension's folder (base_url=..., api_key=...)
 *   3. pi's auth.json `deepseek` entry (readStoredCredential)
 * The API key is never included in errors, logs, or tool details.
 */
import { randomUUID } from "node:crypto";
import { ApiError, validateUrl } from "./response.js";
import { readConfigEnvFile, selectProvider, type CredentialReader } from "./configuration.js";
import type { ProviderMode } from "./registry.js";
import type { SearchAdapter, ProviderRequest } from "./provider.js";
import { JsonTransport } from "./transport.js";
import type { FetchResult, SearchDetails } from "./types.js";
export { ApiError, validateUrl } from "./response.js";
export { PRICE_PER_CALL_CNY } from "./providers/deepseek.js";
export { parseEnvText, readExtEnvFile, readConfigEnvFile, resolveCredentials } from "./configuration.js";
export type { SearchProvider, ProviderMode } from "./registry.js";
export type { SearchResult, FetchResult, SearchDetails } from "./types.js";

const DEFAULT_DAILY_LIMIT = 300;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;

export interface ClientStats {
  billed: number;
  estimatedCostCny: number | null;
  cacheHits: number;
  retries: number;
  lastError: string | null;
  dailyLimit: number;
  dailyBilled: number;
  dailyPending: number;
  day: string;
}
export interface ServiceCharge { id: string; kind: "search" | "fetch"; amountCny: number }

/** Daily call limit reached; the message is model- and user-facing. */
export class LimitError extends Error {
  constructor(limit: number) {
    super(`web-search daily limit reached (${limit} successful nonempty or pending calls in this Pi process). Raise PI_WEBSEARCH_DAILY_LIMIT or retry tomorrow.`);
    this.name = "LimitError";
  }
}

/** Session cache with TTL, entry count and an approximate UTF-16 byte budget. */
class TtlCache<T> {
  private map = new Map<string, { at: number; value: T; bytes: number }>();
  private bytes = 0;
  constructor(
    private ttlMs = CACHE_TTL_MS,
    private maxEntries = CACHE_MAX_ENTRIES,
    private now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.bytes -= hit.bytes;
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    const bytes = JSON.stringify(value).length * 2 + key.length * 2;
    if (bytes > CACHE_MAX_BYTES) return;
    this.bytes -= this.map.get(key)?.bytes ?? 0;
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value, bytes });
    this.bytes += bytes;
    while (this.map.size > this.maxEntries || this.bytes > CACHE_MAX_BYTES) {
      const oldest = this.map.keys().next().value as string;
      this.bytes -= this.map.get(oldest)!.bytes;
      this.map.delete(oldest);
    }
  }
}

/** TTL cache for exact query+count repeats; hits cost nothing. */
export class SearchCache extends TtlCache<SearchDetails> {}

export interface ClientOptions {
  provider?: ProviderMode;
  baseUrl?: string;
  apiKey?: string;
  dailyLimit?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Credential reader override; defaults to pi's readStoredCredential. */
  readCredential?: CredentialReader;
  /** Registry injection for offline adapter contract tests, not runtime discovery. */
  adapters?: readonly SearchAdapter[];
  /** File configuration override; defaults to personal config over legacy extension .env. */
  readEnvFile?: () => Record<string, string>;
}

export class SearchClient {
  verified = false;
  get configured(): boolean { return this.apiKey.length > 0; }
  readonly provider: string;
  readonly providerMode: ProviderMode;
  readonly selectionReason: string;
  readonly selectionReasonCode: "explicit" | "preferred" | "fallback" | "missing";
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly adapter: SearchAdapter;
  private readonly transport: JsonTransport;
  private readonly now: () => number;
  /** Where the active key came from: "file" | "auth.json". */
  readonly credentialSource: "file" | "auth.json" | undefined;
  private cache: SearchCache;
  private pages: TtlCache<FetchResult>;
  private daily?: { day: string; billed: number; pending: number };
  private billed = 0;
  private knownCostCny = 0;
  private cacheHits = 0;
  private retries = 0;
  private lastError: string | null = null;
  private chargeListeners = new Set<(charge: ServiceCharge) => void>();

  constructor(opts: ClientOptions = {}) {
    let config: Record<string, string>;
    try { config = (opts.readEnvFile ?? readConfigEnvFile)(); }
    catch { config = {}; }
    const mode = opts.provider ?? config.provider ?? "auto";
    const selection = selectProvider(mode, config, opts.readCredential, opts.apiKey, opts.adapters);
    this.providerMode = mode as ProviderMode;
    this.selectionReason = selection.reason;
    this.selectionReasonCode = selection.reasonCode;
    this.adapter = selection.adapter;
    this.provider = this.adapter.id;
    const env = selection.credentials;
    this.baseUrl = (opts.baseUrl ?? env.baseUrl ?? this.adapter.defaultBaseUrl).replace(/\/+$/, "");
    const endpoint = validateUrl(this.baseUrl);
    if (this.adapter.requireHttps && endpoint.protocol !== "https:") throw new ApiError(400, `${this.adapter.label} requires an HTTPS base_url`);
    this.apiKey = opts.apiKey ?? env.apiKey ?? "";
    this.credentialSource = env.source === "file" || env.source === "auth.json" ? env.source : undefined;
    this.dailyLimit = opts.dailyLimit ?? resolveDailyLimit();
    this.transport = new JsonTransport(this.adapter, this.baseUrl, opts.fetchImpl ?? fetch, () => { this.retries++; });
    this.now = opts.now ?? Date.now;
    this.cache = new SearchCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
    this.pages = new TtlCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
    if (!this.apiKey) {
      this.lastError = mode === "auto"
        ? "no search API key: configure a search provider in config/pi-extensions/.env.web-search"
        : `no ${this.adapter.label} API key: set ${this.adapter.credentials.keyFields[0]} in config/pi-extensions/.env.web-search`;
    }
  }

  readonly dailyLimit: number;

  stats(): ClientStats {
    const today = this.today();
    const unknownPrice = this.adapter.priceCny.search === null || (!!this.adapter.fetch && this.adapter.priceCny.fetch === null);
    return { billed: this.billed, estimatedCostCny: unknownPrice ? null : this.knownCostCny, cacheHits: this.cacheHits, retries: this.retries, lastError: this.lastError,
      dailyLimit: this.dailyLimit, dailyBilled: today.billed, dailyPending: today.pending, day: today.day };
  }

  clearCache(): void {
    this.cache = new SearchCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
    this.pages = new TtlCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
  }

  onCharge(listener: (charge: ServiceCharge) => void): () => void {
    this.chargeListeners.add(listener);
    return () => { this.chargeListeners.delete(listener); };
  }

  private charge(kind: ServiceCharge["kind"]): void {
    this.billed++;
    const price = this.adapter.priceCny[kind];
    if (price !== null) {
      this.knownCostCny += price;
      const charge = { id: randomUUID(), kind, amountCny: price };
      for (const listener of this.chargeListeners) listener(charge);
    }
  }

  private today() {
    const date = new Date(this.now());
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (this.daily?.day !== day) this.daily = { day, billed: 0, pending: 0 };
    return this.daily;
  }

  /** Reserve before dispatch so parallel misses cannot all pass the final slot. */
  private reserve(): (charged: boolean) => void {
    if (!this.apiKey) throw new ApiError(401, `web-search is not configured: ${this.lastError}`);
    const bucket = this.today();
    if (this.dailyLimit > 0 && bucket.billed + bucket.pending >= this.dailyLimit) throw new LimitError(this.dailyLimit);
    bucket.pending++;
    let settled = false;
    return charged => {
      if (settled) return;
      settled = true;
      bucket.pending--;
      if (charged) bucket.billed++;
    };
  }
  private async request(request: ProviderRequest, signal?: AbortSignal): Promise<unknown> {
    try {
      const value = await this.transport.request(request, signal);
      this.lastError = null;
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ApiError) this.lastError = error.message;
      throw error;
    }
  }

  async search(query: string, count = 5, signal?: AbortSignal): Promise<SearchDetails> {
    signal?.throwIfAborted();
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new ApiError(400, "Search count must be an integer from 1 to 10");
    const key = `${count}\u0000${query}`;
    const cache = this.cache;
    const hit = cache.get(key);
    if (hit) {
      this.cacheHits++;
      return { ...hit, cached: true, ms: 0, costCny: 0 };
    }
    const settle = this.reserve();
    try {
      const t0 = this.now();
      const body = await this.request(this.adapter.search.request(query, count, this.apiKey), signal);
      signal?.throwIfAborted();
      const results = this.adapter.search.parse(body);
      this.verified = true;
      const price = this.adapter.priceCny.search;
      const details: SearchDetails = {
        query,
        count,
        results,
        mirrors: mirrorOf(results),
        ms: this.now() - t0,
        cached: false,
        costCny: price === null ? null : results.length ? price : 0,
      };
      if (results.length > 0) {
        settle(true);
        this.charge("search");
        cache.set(key, details);
      }
      return details;
    } finally { settle(false); }
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<FetchResult & { costCny: number | null }> {
    signal?.throwIfAborted();
    validateUrl(url);
    const fetchAdapter = this.adapter.fetch;
    if (!fetchAdapter) throw new ApiError(501, `${this.adapter.label} does not support page extraction`);
    const cache = this.pages;
    const hit = cache.get(url);
    if (hit) { this.cacheHits++; return { ...hit, costCny: 0 }; }
    const settle = this.reserve();
    try {
      const value = await this.request(fetchAdapter.request(url, this.apiKey), signal);
      const body = fetchAdapter.parse(value);
      this.verified = true;
      signal?.throwIfAborted();
      const billable = body.content.trim().length > 0;
      if (billable) {
        settle(true);
        this.charge("fetch");
        cache.set(url, body);
      }
      const price = this.adapter.priceCny.fetch;
      return { ...body, costCny: price === null ? null : billable ? price : 0 };
    } finally { settle(false); }
  }
}

/**
 * Page identity for mirror detection: `exec(3)`, `exec.3`, and `.../man3/exec.3`
 * all reduce to `exec#3`; ordinary pages match only by URL (excluding fragment).
 */
export function pageIdentity(r: { title: string; url: string }): string {
  const t = `${r.title} ${r.url}`;
  const m = t.match(/([a-z0-9_+-]{2,})\((\d[a-z]?)\)/i) ?? t.match(/\/?([a-z0-9_+-]{2,})\.(\d[a-z]?)(?:[.\s/#]|$)/i);
  if (m) return `${m[1].toLowerCase()}#${m[2]}`;
  const url = new URL(r.url);
  url.hash = "";
  return `url:${url.href}`;
}

/** mirrors[i] = 1-based first-seen index of the same identity, 0 when unique. */
export function mirrorOf(results: { title: string; url: string }[]): number[] {
  const first = new Map<string, number>();
  return results.map((r, i) => {
    const id = pageIdentity(r);
    const seen = first.get(id);
    if (seen !== undefined) return seen + 1;
    first.set(id, i);
    return 0;
  });
}


function resolveDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_WEBSEARCH_DAILY_LIMIT;
  const parsed = raw !== undefined && raw !== "" ? Number.parseInt(raw, 10) : DEFAULT_DAILY_LIMIT;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_LIMIT;
}
