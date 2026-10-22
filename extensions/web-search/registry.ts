import type { SearchAdapter } from "./provider.js";
import { anysearch } from "./providers/anysearch.js";
import { deepseek } from "./providers/deepseek.js";

// Only working adapters belong here; planned providers are not selectable.
export const providers = { deepseek, anysearch } as const satisfies Record<string, SearchAdapter>;
export type SearchProvider = keyof typeof providers;
export type ProviderMode = SearchProvider | "auto";

export function orderedProviders(): SearchAdapter[] {
  return Object.values(providers).sort((a, b) => a.autoPriority - b.autoPriority || a.id.localeCompare(b.id));
}
