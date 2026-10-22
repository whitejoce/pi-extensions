import type { ApiError } from "./response.js";
import type { FetchResult, SearchResult } from "./types.js";

export type ServiceOperation = "search" | "fetch";

/** Request authentication belongs to the adapter (header, query or JSON body). */
export interface ProviderRequest {
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
}

export interface SearchAdapter {
  readonly id: string;
  readonly label: string;
  readonly defaultBaseUrl: string;
  readonly requireHttps: boolean;
  /** Lower values win; adding a provider must not change existing priorities. */
  readonly autoPriority: number;
  readonly credentials: {
    readonly keyFields: readonly string[];
    readonly baseUrlFields: readonly string[];
    readonly authProvider?: string;
  };
  /** Unknown prices are null, never zero. Prices may differ by operation. */
  readonly priceCny: Readonly<Record<ServiceOperation, number | null>>;
  readonly search: {
    request(query: string, count: number, apiKey: string): ProviderRequest;
    parse(value: unknown): SearchResult[];
  };
  /** A search-only provider need not implement page extraction. */
  readonly fetch?: {
    request(url: string, apiKey: string): ProviderRequest;
    parse(value: unknown): FetchResult;
  };
  /** Explicit interactive onboarding only; never invoked by selection or search. */
  readonly registration?: {
    readonly loginUrl: string;
    createKey(email: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string>;
  };
  httpError(status: number, text: string, headers: Headers): ApiError;
  networkError(error: unknown): ApiError;
}
