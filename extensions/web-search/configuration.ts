import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { SearchAdapter } from "./provider.js";
import { orderedProviders, type SearchProvider } from "./registry.js";
import { ApiError } from "./response.js";

export type CredentialReader = (providerId: string) => { type: string; key?: string } | undefined;
export interface Credentials {
  apiKey?: string;
  baseUrl?: string;
  source: "file" | "auth.json" | "none";
}
const storedCredential: CredentialReader = id => readStoredCredential(id);

/** Parse KEY=VALUE lines; `#` starts a comment (also after an unquoted value), blank lines are skipped. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { /* preserve invalid input for validation */ }
      if (typeof value !== "string") continue;
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

function readEnvPath(path: string): Record<string, string> {
  try {
    return parseEnvText(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Legacy configuration for manual installs. */
export function readExtEnvFile(): Record<string, string> {
  return readEnvPath(fileURLToPath(new URL(".env", import.meta.url)));
}

/** Personal configuration stays outside the checkout managed by Pi updates. */
export function readConfigEnvFile(
  userPath = join(getAgentDir(), "config", "pi-extensions", ".env.web-search"),
  legacyPath = fileURLToPath(new URL(".env", import.meta.url)),
): Record<string, string> {
  const legacy = readEnvPath(legacyPath);
  const user = readEnvPath(userPath);
  const key = user.api_key ?? user.apikey;
  const baseUrl = user.base_url ?? user.baseUrl;
  return {
    ...legacy,
    ...user,
    ...(key !== undefined ? { api_key: key } : {}),
    ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
  };
}


function firstValue(file: Record<string, string>, fields: readonly string[]): string | undefined {
  return fields.map(field => file[field]?.trim()).find(value => !!value);
}

export function credentialsFor(adapter: SearchAdapter, file: Record<string, string>, readCredential: CredentialReader = storedCredential): Credentials {
  const fileKey = firstValue(file, adapter.credentials.keyFields);
  let storedKey: string | undefined;
  if (!fileKey && adapter.credentials.authProvider) {
    try {
      const stored = readCredential(adapter.credentials.authProvider);
      storedKey = stored?.type === "api_key" ? stored.key?.trim() || undefined : undefined;
    } catch { /* unreadable credentials are unavailable, not a startup failure */ }
  }
  return { apiKey: fileKey ?? storedKey, baseUrl: firstValue(file, adapter.credentials.baseUrlFields),
    source: fileKey ? "file" : storedKey ? "auth.json" : "none" };
}

/** Compatibility entry point for configuration checks and existing consumers. */
export function resolveCredentials(
  readCredential: CredentialReader = storedCredential,
  readEnvFile: () => Record<string, string> = readConfigEnvFile,
  provider: SearchProvider = "deepseek",
): Credentials {
  let file: Record<string, string>;
  try { file = readEnvFile(); } catch { file = {}; }
  const adapter = orderedProviders().find(item => item.id === provider);
  if (!adapter) throw new ApiError(400, "Unknown search provider");
  return credentialsFor(adapter, file, readCredential);
}

/** Selection is based on configuration only, never retries or runtime failures. */
export function selectProvider(
  mode: string,
  file: Record<string, string>,
  readCredential?: CredentialReader,
  apiKeyOverride?: string,
  adapters: readonly SearchAdapter[] = orderedProviders(),
): { adapter: SearchAdapter; credentials: Credentials; reason: string; reasonCode: "explicit" | "preferred" | "fallback" | "missing" } {
  const ordered = [...adapters].sort((a, b) => a.autoPriority - b.autoPriority || a.id.localeCompare(b.id));
  if (!ordered.length) throw new ApiError(500, "No search providers registered");
  if (mode !== "auto") {
    const adapter = ordered.find(item => item.id === mode);
    if (!adapter) throw new ApiError(400, `web-search provider must be auto or one of: ${ordered.map(item => item.id).join(", ")}`);
    return { adapter, credentials: credentialsFor(adapter, file, readCredential), reason: "explicit provider selection", reasonCode: "explicit" };
  }
  for (const [index, adapter] of ordered.entries()) {
    const credentials = credentialsFor(adapter, file, readCredential);
    if (credentials.apiKey || apiKeyOverride) {
      return { adapter, credentials, reasonCode: index === 0 ? "preferred" : "fallback", reason: index === 0 ? `${adapter.label} credentials configured (preferred)`
        : `no higher-priority credentials; ${adapter.label} configured` };
    }
  }
  return { adapter: ordered[0], credentials: { source: "none" }, reason: "no search credentials configured", reasonCode: "missing" };
}
