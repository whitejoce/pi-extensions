import type { FetchResult } from "./types.js";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function validateUrl(raw: string): URL {
  if (raw.length > 8192) throw new ApiError(400, "URL exceeds 8192 characters");
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ApiError(400, `Invalid URL: ${raw.slice(0, 100)}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(400, `Only http/https URLs are supported: ${url.protocol}`);
  }
  if (url.username || url.password) throw new ApiError(400, "URLs with embedded credentials are not allowed");
  return url;
}

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Bound both success and error bodies before decoding; never trust Content-Length alone. */
export async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new ApiError(502, "web-search response exceeds 4 MiB");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ApiError(502, "web-search response exceeds 4 MiB");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ApiError(502, "web-search response is not valid UTF-8"); }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function fetchResult(value: unknown): FetchResult {
  if (!object(value) || typeof value.title !== "string" || typeof value.content !== "string") {
    throw new ApiError(502, "Invalid web-fetch response");
  }
  return { title: value.title, content: value.content };
}
