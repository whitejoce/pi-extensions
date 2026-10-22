import { setTimeout as delay } from "node:timers/promises";
import type { ProviderRequest, SearchAdapter } from "./provider.js";
import { ApiError, responseText } from "./response.js";

const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [500, 1000];

/** Shared transport never knows a provider's paths, auth scheme or response schema. */
export class JsonTransport {
  constructor(
    private readonly adapter: SearchAdapter,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
    private readonly onRetry: () => void,
  ) {}

  async request(request: ProviderRequest, signal?: AbortSignal): Promise<unknown> {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const active = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let lastError = new ApiError(500, "unreachable");
    try {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        active.throwIfAborted();
        if (attempt > 0) {
          await delay(RETRY_DELAYS_MS[attempt - 1], undefined, { signal: active });
          active.throwIfAborted();
          this.onRetry();
        }
        // Adapters supply relative paths only; all requests stay on the configured origin.
        if (!request.path.startsWith("/") || request.path.startsWith("//") || request.path.includes("\\")) {
          throw new ApiError(500, "Invalid provider request path");
        }
        let response: Response;
        try {
          response = await this.fetchImpl(`${this.baseUrl}${request.path}`, {
            method: request.method,
            headers: request.headers,
            ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
            signal: active,
            redirect: "error",
          });
        } catch (error) {
          active.throwIfAborted();
          lastError = this.adapter.networkError(error);
          continue;
        }
        const text = await responseText(response, active);
        active.throwIfAborted();
        if (response.ok) {
          try { return JSON.parse(text); }
          catch { throw new ApiError(502, "web-search response is not valid JSON"); }
        }
        lastError = this.adapter.httpError(response.status, text, response.headers);
        if (response.status !== 408 && response.status !== 429 && response.status < 500) break;
      }
      throw lastError;
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw new ApiError(504, "web-search request timed out");
      throw error;
    }
  }
}
