/**
 * Rendering and text formatting for the web-search extension.
 *
 * All colors come from Theme slots so the output follows the user's theme:
 *   score >= 2 -> success, >= 1.5 -> warning, else error
 *   authority >= 3 -> success (the API calls these extremely authoritative)
 *   site name -> accent, structure/meta -> muted/dim
 * Collapsed rows use compact badges (`1.7 ¶4`) with the legend in the box
 * header; the expanded view (ctrl+o) uses blocked layout with labeled
 * `相关 1.69/3 · 权威 4/4` meta lines.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SearchDetails, SearchResult } from "./client.js";

/** Structural subset of pi's Theme used by the renderers. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type ScoreToken = "success" | "warning" | "error";

export function scoreToken(score: number): ScoreToken {
  return score >= 2 ? "success" : score >= 1.5 ? "warning" : "error";
}

export function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

/** 今天/昨天/N天前/N周前; falls back to ISO beyond 30 days. */
export function relDate(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((now - t) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 8) return `${days}天前`;
  if (days < 30) return `${Math.round(days / 7)}周前`;
  return iso.slice(0, 10);
}

/** Drop tracking-looking query/hash when the URL is long. */
export function cleanUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.search.length > 24 || url.hash.length > 8) return url.origin + url.pathname;
    return u;
  } catch {
    return u;
  }
}

export function stripScheme(u: string): string {
  return u.startsWith("https://") ? u.slice(8) : u.startsWith("http://") ? u.slice(7) : u;
}

const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);

/** Light troff cleanup for man-page summaries: strip `."` comments and roff macros. */
export function cleanTroff(s: string): string {
  const esc = "." + BS + DQ;
  const macroHead = new RegExp("^" + BS + ".(TH|SH|B |I |RI |BI |nf)" + BS + "b");
  if (!s.startsWith(esc) && !macroHead.test(s)) return s;
  const macroRe = new RegExp("[.](TH|SH|SS|B|I|BI|RI|BR|RB|IR|P|PP|nf|fi|br|ds|so)" + BS + "b" + BS + "s*", "g");
  const commentRe = new RegExp("[.]" + DQ + "[^.]*?(?=[.][A-Z]|$)", "g");
  return s.split(BS).join("").replace(commentRe, " ").replace(macroRe, "").replace(new RegExp(BS + "s+", "g"), " ").trim();
}

/** Undo the heavy backslash escaping in fetched Markdown (`\#`, `\-`, `\|`, ...). */
export function unescapeMd(s: string): string {
  return s.replace(/\\([:#|.`*_()<>[\]!/,;\\-])/g, "$1");
}

/** Word-wrap plain text to a visible width. */
export function wrapPlain(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && stripAnsi(cur).length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function siteOf(r: SearchResult): string {
  return r.site_name ?? safeHost(r.url);
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

const DEFAULT_WIDTH = 96;

/**
 * Build the transcript box for a search result. Collapsed: compact rows with
 * `score ¶authority` badges. Expanded: blocked layout with blank separators,
 * labeled meta lines (相关 x.xx/3 · 权威 x/4), scheme-less URLs, and `┄`
 * gutters before summary lines.
 */
export function buildSearchLines(details: SearchDetails, theme: ThemeLike, opts: { expanded?: boolean } = {}): (width: number) => string[] {
  const expanded = opts.expanded ?? false;
  return (width: number) => {
    const W = width > 40 ? width : DEFAULT_WIDTH;
    const { results, mirrors } = details;
    const scores = results.map((r) => r.rerank_score).filter((s): s is number => s !== null);
    const auths = results.map((r) => r.authority).filter((s): s is number => s !== null);
    const legend = scores.length && auths.length
      ? ` · 相关度 ${Math.min(...scores).toFixed(1)}–${Math.max(...scores).toFixed(1)} · 权威 ${Math.min(...auths)}–${Math.max(...auths)}`
      : "";
    const headerText =
      `┌─ web_search · ${results.length} 条${legend} · ` +
      (details.costCny === null ? "cost unknown" : `¥${details.cached ? "0.000" : details.costCny.toFixed(3)}`) +
      (details.cached ? theme.fg("success", " · cached") : "") +
      (details.ms ? ` · ${(details.ms / 1000).toFixed(1)}s` : "");
    const rows: string[] = [headerText + theme.fg("border", "─".repeat(Math.max(0, W - stripAnsi(headerText).length)))];

    if (results.length === 0) {
      rows.push(theme.fg("border", "│ ") + theme.fg("dim", "无结果。建议：调整关键词 · 去掉 site: 限定 · 尝试英文查询"));
      rows.push(theme.fg("border", "└" + "─".repeat(W - 2)));
      return rows;
    }

    for (const [i, r] of results.entries()) {
      const site = siteOf(r);
      if (!expanded) {
        const mirror = mirrors[i] ? theme.fg("muted", " ") + theme.fg("warning", `↺ 同#${mirrors[i]}`) : "";
        rows.push(
          theme.fg("border", "│ ") +
            theme.fg("muted", `${i + 1}. `) +
            theme.fg(r.rerank_score === null ? "muted" : scoreToken(r.rerank_score), r.rerank_score?.toFixed(1) ?? "N/A") +
            theme.fg("muted", " ¶") +
            theme.fg((r.authority ?? -1) >= 3 ? "success" : "muted", `${r.authority ?? "N/A"}`) +
            "  " +
            theme.bold(truncateToWidth(r.title, 46)) +
            mirror +
            theme.fg("dim", `  ${site} ${relDate(r.date)}`),
        );
        rows.push(theme.fg("border", "│ ") + theme.fg("dim", `    ${truncateToWidth(cleanUrl(r.url), W - 6)}`));
      } else {
        if (i > 0) rows.push(theme.fg("border", "│"));
        const mirror = mirrors[i] ? "  " + theme.fg("warning", `↺ 同#${mirrors[i]}`) : "";
        rows.push(
          theme.fg("border", "│ ") +
            theme.bold(theme.fg("accent", `${i + 1}.`)) +
            " " +
            theme.bold(truncateToWidth(r.title, 60)) +
            mirror,
        );
        const rel = relDate(r.date);
        const iso = fmtDate(r.date);
        const datePart = rel && rel !== iso ? `${iso}（${rel}）` : rel || iso;
        const sep = theme.fg("dim", " · ");
        const meta = [
          theme.fg("muted", "   相关 ") + theme.fg(r.rerank_score === null ? "muted" : scoreToken(r.rerank_score), r.rerank_score === null ? "N/A" : `${r.rerank_score.toFixed(2)}/3`),
          theme.fg("muted", "权威 ") + theme.fg((r.authority ?? -1) >= 3 ? "success" : "muted", r.authority === null ? "N/A" : `${r.authority}/4`),
          site ? theme.fg("accent", site) : "",
          datePart ? theme.fg("dim", datePart) : "",
        ]
          .filter(Boolean)
          .join(sep);
        rows.push(theme.fg("border", "│ ") + meta);
        rows.push(theme.fg("border", "│ ") + theme.fg("dim", `   ${truncateToWidth(stripScheme(cleanUrl(r.url)), W - 4)}`));
        for (const line of wrapPlain(cleanTroff(r.summary), W - 12).slice(0, 4)) {
          rows.push(theme.fg("border", "│ ") + theme.fg("dim", "   ┄ ") + line);
        }
      }
    }
    rows.push(theme.fg("border", "└" + "─".repeat(W - 2)));
    return rows;
  };
}

/** Model-facing plain text: numbered results with score/authority, URL, and summary. */
export function searchContent(details: SearchDetails): string {
  if (details.results.length === 0) {
    return `Web search "${details.query}" returned no results. Try different keywords, drop site: filters, or search in English.`;
  }
  const lines: string[] = [
    `Web search: "${details.query}" — ${details.results.length} results (N/A means the provider did not supply a score; score/authority; score ≥ 1.5 is high quality, authority ≥ 3 is highly authoritative):`,
    "",
  ];
  for (const [i, r] of details.results.entries()) {
    const site = siteOf(r);
    const date = fmtDate(r.date);
    const mirror = details.mirrors[i] ? ` (mirror of #${details.mirrors[i]})` : "";
    lines.push(
      `${i + 1}. [${r.rerank_score?.toFixed(2) ?? "N/A"}/${r.authority ?? "N/A"}] ${r.title} — ${site}${date ? ` · ${date}` : ""}${mirror}`,
      `   ${r.url}`,
      `   ${cleanTroff(r.summary).slice(0, 600)}`,
      "",
    );
  }
  lines.push("Use web_fetch(url) to read the full page when a summary is not enough.");
  return lines.join("\n");
}

export interface FetchDetails {
  url: string;
  title: string;
  totalChars: number;
  offset: number;
  length: number;
  text: string;
  costCny: number | null;
}

export const FETCH_PAGE_CHARS = 20_000;

/** Model-facing fetch text: paged window over the unescaped Markdown. */
export function fetchContent(page: { title: string; content: string }, url: string, offset = 0, length = FETCH_PAGE_CHARS): string {
  const text = unescapeMd(page.content);
  const total = text.length;
  const from = Math.max(0, Math.min(offset, total));
  const slice = text.slice(from, from + length);
  const parts = [`Fetched page: ${page.title || "(untitled)"}\n${url}\n[${from + 1}–${from + slice.length} of ${total} chars]`];
  parts.push(slice);
  if (from + slice.length < total) {
    parts.push(`\n[truncated: call web_fetch again with offset=${from + slice.length} to continue]`);
  }
  return parts.join("\n\n");
}

export function buildFetchLines(details: FetchDetails, theme: ThemeLike): (width: number) => string[] {
  return (width: number) => {
    const W = width > 40 ? width : DEFAULT_WIDTH;
    const lines = details.text.split(/\r?\n/).filter((l) => l.trim());
    const shown = lines.slice(0, 12);
    const cost = details.costCny === null ? "cost unknown" : `¥${details.costCny.toFixed(3)}`;
    const headerText = `┌─ web_fetch · ${truncateToWidth(stripScheme(details.url), 42)} · ${details.totalChars} chars · ${cost}`;
    const rows = [headerText + theme.fg("border", "─".repeat(Math.max(0, W - stripAnsi(headerText).length)))];
    for (const l of shown) rows.push(theme.fg("border", "│ ") + truncateToWidth(l, W - 4));
    if (lines.length > shown.length) {
      rows.push(theme.fg("border", "│ ") + theme.fg("dim", `… 已截断（${shown.length}/${lines.length} 行），offset 可续读`));
    }
    rows.push(theme.fg("border", "└" + "─".repeat(W - 2)));
    return rows;
  };
}
