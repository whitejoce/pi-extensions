export interface SearchResult {
  rerank_score: number | null;
  authority: number | null;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  site_name: string | null;
  date: string | null;
}

export interface FetchResult {
  title: string;
  content: string;
}

export interface SearchDetails {
  query: string;
  count: number;
  results: SearchResult[];
  /** 1-based index of the first result with the same page identity; 0 if unique. */
  mirrors: number[];
  ms: number;
  cached: boolean;
  costCny: number | null;
}
