/**
 * web-search: DeepSeek or AnySearch Search/Fetch tools for pi.
 *
 * Registers two read-only tools and a /websearch command family:
 *   - web_search(query, count?) — ranked results with model-facing summaries;
 *     the transcript box shows compact `score ¶authority` rows collapsed and a
 *     blocked detail layout expanded (ctrl+o toggles, pi-provided).
 *   - web_fetch(url, offset?) — paged Markdown of one page.
 *   - /websearch <query> — direct search overlay (no model round-trip)
 *   - /websearch fetch <n|url> — fetch the n-th result of the last /websearch
 *   - /websearch status — provider, nonempty calls, cache hits, estimated cost
 *
 * Session-scoped TTL cache dedupes exact repeats for free; billing counters are
 * per process (DeepSeek: 5 CNY / 1000 successful calls; AnySearch: price unknown). The process-local daily quota
 * resets on the local calendar date; restarts reset it too. Credentials come from
 * personal config or legacy web-search/.env; only DeepSeek falls back to Pi's credential (see client.ts).
 */
import { Type } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import {
  AgentToolResult,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { ApiError, LimitError, SearchClient, type FetchResult, type SearchDetails } from "./web-search/client.js";
import { commandRequest, showOverlay } from "./web-search/command-ui.js";
import { SearchSettings } from "./web-search/settings.js";
import { recordExpense } from "./shared/billing.js";
import {
  buildFetchLines,
  buildSearchLines,
  fetchContent,
  FETCH_PAGE_CHARS,
  searchContent,
  type FetchDetails,
} from "./web-search/render.js";

/** A component that renders lazily computed lines for the given width. */
class LinesComponent implements Component {
  private width = -1;
  private lines: string[] = [];

  constructor(private compute: (width: number) => string[]) {}

  render(width: number): string[] {
    if (width !== this.width) {
      this.lines = this.compute(width);
      this.width = width;
    }
    return this.lines;
  }

  invalidate(): void {
    this.width = -1;
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof LimitError || e instanceof ApiError) return e.message;
  return `web-search failed: ${(e as Error).message}`;
}

type SearchErrDetails = { query: string; error: string };
type FetchErrDetails = { url: string; error: string };
type SearchToolDetails = SearchDetails | SearchErrDetails;
type FetchToolDetails = FetchDetails | FetchErrDetails;

export default function webSearch(pi: ExtensionAPI, client = new SearchClient(), settings = new SearchSettings()) {
  let lifecycle = new AbortController();
  let lastSearch: SearchDetails | null = null;
  let context: ExtensionContext | undefined;
  let ledgerError = false;
  let settingsBusy = false;
  const subscribe = () => {
    const sourceClient = client;
    return sourceClient.onCharge(charge => {
    try {
      recordExpense(pi, { id: charge.id, source: "web-search", kind: charge.kind,
        amount: charge.amountCny, currency: "CNY", provider: sourceClient.provider, model: "web-service" });
    } catch {
      ledgerError = true;
      context?.ui.notify("web-search 费用写入失败，本次会话的费用统计可能不完整", "warning");
    }
    });
  };
  let unsubscribe: (() => void) | undefined = subscribe();
  const applyClient = (next: SearchClient) => {
    lifecycle.abort();
    lifecycle = new AbortController();
    unsubscribe?.();
    client = next;
    lastSearch = null;
    ledgerError = false;
    unsubscribe = subscribe();
  };
  pi.on("session_start", (_event, ctx) => {
    lifecycle.abort();
    lifecycle = new AbortController();
    context = ctx;
    ledgerError = false;
    unsubscribe ??= subscribe();
    lastSearch = null;
    client.clearCache();
  });
  pi.on("session_shutdown", () => { lifecycle.abort(); unsubscribe?.(); unsubscribe = undefined; });
  const requestSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;

  pi.registerTool(
    defineTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web and return ranked results with summaries. Supports site:, -site:, \"exact phrase\", | (OR) and .. (range) syntax. " +
        "DeepSeek results carry rerank_score (0-3, >=1.5 high quality) and authority (0-4, >=3 highly authoritative). " +
        "AnySearch does not provide these scores (null). Call web_fetch(url) when you need the full page.",
      promptSnippet: "web search with ranked results and page fetch",
      promptGuidelines: [
        "Prefer web_search for time-sensitive or unverifiable facts instead of guessing; only DeepSeek results include per-source authority scores; null means unavailable, not low quality.",
      ],
      annotations: { readOnlyHint: true, openWorldHint: true },
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 128, description: "Search query, 1-128 chars. Supports site:, quotes, |, .. syntax." }),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of results (default 5)." })),
      }),
      outputSchema: Type.Object({
        query: Type.String(),
        count: Type.Integer(),
        cached: Type.Boolean(),
        results: Type.Array(
          Type.Object({
            rerank_score: Type.Union([Type.Number(), Type.Null()]),
            authority: Type.Union([Type.Integer(), Type.Null()]),
            title: Type.String(),
            url: Type.String(),
            snippet: Type.String(),
            summary: Type.String(),
            site_name: Type.Union([Type.String(), Type.Null()]),
            date: Type.Union([Type.String(), Type.Null()]),
            mirror_of: Type.Optional(Type.Integer()),
          }),
        ),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<SearchToolDetails>> {
        context = ctx;
        const active = requestSignal(signal);
        try {
          const details = await client.search(params.query, params.count ?? 5, active);
          active.throwIfAborted();
          return {
            content: [{ type: "text", text: searchContent(details) }],
            details,
            structuredContent: {
              query: details.query,
              count: details.count,
              cached: details.cached,
              results: details.results.map((r, i) => ({
                rerank_score: r.rerank_score,
                authority: r.authority,
                title: r.title,
                url: r.url,
                snippet: r.snippet,
                summary: r.summary,
                site_name: r.site_name,
                date: r.date,
                ...(details.mirrors[i] ? { mirror_of: details.mirrors[i] } : {}),
              })),
            },
          };
        } catch (e) {
          active.throwIfAborted();
          const msg = errorMessage(e);
          return { content: [{ type: "text", text: msg }], details: { query: params.query, error: msg }, isError: true };
        }
      },

      renderCall: (args, theme) =>
        new LinesComponent(() => [
          theme.bold(theme.fg("accent", "⚡ web_search ")) +
            theme.fg("text", `"${args.query}"`) +
            theme.fg("dim", ` ×${args.count ?? 5}`),
        ]),

      renderResult: (result, options: ToolRenderResultOptions, theme: Theme) => {
        const details = result.details as SearchToolDetails | undefined;
        if (!details || "error" in details) {
          return new LinesComponent(() => [theme.fg("error", `✗ web_search: ${details?.error ?? "unknown"}`)]);
        }
        return new LinesComponent(buildSearchLines(details, theme, { expanded: options.expanded }));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "web_fetch",
      label: "Web Fetch",
      description:
        "Fetch one web page and return it as Markdown, 20,000 characters per call; pass offset to continue reading a truncated page. " +
        "Pages are cached for 10 minutes in this session; continuation reads use the same page without another billed request while cached. " +
        "Only http/https without embedded credentials. Note: JavaScript-only pages (e.g. NVD detail views) and non-HTML endpoints (JSON feeds) often yield no content; prefer web_search for those.",
      promptSnippet: "fetch a web page as Markdown",
      annotations: { readOnlyHint: true, openWorldHint: true },
      parameters: Type.Object({
        url: Type.String({ maxLength: 8192, description: "Absolute http(s) URL to fetch." }),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to continue reading a truncated page." })),
        length: Type.Optional(Type.Integer({ minimum: 200, maximum: 40_000, description: "Characters to return (default 20000)." })),
      }),
      outputSchema: Type.Object({
        url: Type.String(),
        title: Type.String(),
        total_chars: Type.Integer(),
        offset: Type.Integer(),
        truncated: Type.Boolean(),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<FetchToolDetails>> {
        context = ctx;
        const active = requestSignal(signal);
        try {
          const offset = params.offset ?? 0;
          const page: FetchResult & { costCny: number | null } = await client.fetchPage(params.url, active);
          active.throwIfAborted();
          const length = params.length ?? FETCH_PAGE_CHARS;
          const text = fetchContent(page, params.url, offset, length);
          const window = text.split("\n\n").slice(2).join("\n\n");
          const details: FetchDetails = {
            url: params.url,
            title: page.title,
            totalChars: page.content.length,
            offset,
            length: Math.min(length, Math.max(0, page.content.length - offset)),
            text: window,
            costCny: page.costCny,
          };
          return {
            content: [{ type: "text", text }],
            details,
            structuredContent: {
              url: details.url,
              title: details.title,
              total_chars: details.totalChars,
              offset: details.offset,
              truncated: details.offset + details.length < details.totalChars,
            },
          };
        } catch (e) {
          active.throwIfAborted();
          const msg = errorMessage(e);
          return { content: [{ type: "text", text: msg }], details: { url: params.url, error: msg }, isError: true };
        }
      },

      renderCall: (args, theme) =>
        new LinesComponent(() => [theme.bold(theme.fg("accent", "🌐 web_fetch ")) + theme.fg("text", args.url)]),

      renderResult: (result, options: ToolRenderResultOptions, theme: Theme) => {
        const details = result.details as FetchToolDetails | undefined;
        if (!details || "error" in details) {
          return new LinesComponent(() => [theme.fg("error", `✗ web_fetch: ${details?.error ?? "unknown"}`)]);
        }
        if (!options.expanded) {
          return new LinesComponent(() => [
            theme.fg("muted", `web_fetch · ${details.title || "(untitled)"} · ${details.totalChars} chars · offset ${details.offset}`),
          ]);
        }
        return new LinesComponent(buildFetchLines(details, theme));
      },
    }),
  );

  /* ---------- /websearch command family ---------- */

  pi.registerCommand("websearch", {
    description: "Web search: /websearch setup | provider [auto|deepseek|anysearch] | status | <query> | fetch <n|url>",
    handler: async (args, ctx) => {
      context = ctx;
      const active = lifecycle.signal;
      const argv = args.trim().split(/\s+/).filter(Boolean);

      if (argv[0] === "help") {
        ctx.ui.notify("/websearch：开始使用或测试连接\n/websearch <关键词>：搜索\n/websearch provider：高级渠道选择\n/websearch status：简洁状态\n/websearch status --verbose：诊断详情\n帮助不会发起网络请求。", "info");
        return;
      }
      if (argv[0] === "setup" || argv[0] === "provider" || (!argv.length && ctx.mode === "tui")) {
        if (argv.length > (argv[0] === "setup" ? 1 : 2)) {
          ctx.ui.notify("用法：/websearch setup 或 /websearch provider [auto|deepseek|anysearch]；不要把密钥粘贴到命令中", "error");
          return;
        }
        if (settingsBusy) { ctx.ui.notify("搜索设置已打开，请先完成或取消当前操作", "warning"); return; }
        settingsBusy = true;
        let signal = ctx.signal ? AbortSignal.any([active, ctx.signal]) : active;
        try {
          if (ctx.mode === "tui" && argv[0] !== "provider") {
            await settings.home(ctx, () => client, () => signal, next => {
              applyClient(next);
              signal = requestSignal(ctx.signal);
            });
          } else await settings.command(argv[0] as "setup" | "provider", argv[1], ctx, signal, client, applyClient);
        }
        catch (error) {
          if (!signal.aborted) ctx.ui.notify(errorMessage(error), "error");
        } finally { settingsBusy = false; }
        return;
      }

      if (argv.length === 0 || argv[0] === "status") {
        const s = client.stats();
        const details = argv[1] === "--verbose";
        ctx.ui.notify(settings.summary(client) + (details
          ? `\n调用：${s.billed}；缓存命中：${s.cacheHits}；重试：${s.retries}` +
            `\n本进程今日调用：${s.dailyBilled}/${s.dailyLimit || "不限"}（非服务商余额）` +
            (s.estimatedCostCny === null ? "\n费用：未知，以服务商账户为准" : `\n预估费用：¥${s.estimatedCostCny.toFixed(3)}`) +
            (s.lastError ? `\n最近错误：${s.lastError}` : "") + (ledgerError ? "\n费用记录失败" : "") : ""), "info");
        return;
      }

      if (argv[0] === "fetch") {
        const target = argv[1];
        let url: string | undefined;
        if (target && /^\d+$/.test(target)) {
          const r = lastSearch?.results[Number(target) - 1];
          if (!r) {
            ctx.ui.notify(`没有第 ${target} 条结果；先运行 /websearch <query>`, "error");
            return;
          }
          url = r.url;
        } else if (target) {
          url = target;
        } else {
          ctx.ui.notify("用法：/websearch fetch <n|url>", "error");
          return;
        }
        try {
          const page = await commandRequest(ctx, active, "获取网页", signal => client.fetchPage(url, signal));
          if (!page || active.aborted) return;
          const text = fetchContent(page, url, 0, FETCH_PAGE_CHARS * 2);
          const details: FetchDetails = {
            url,
            title: page.title,
            totalChars: page.content.length,
            offset: 0,
            length: Math.min(FETCH_PAGE_CHARS * 2, page.content.length),
            text: text.split("\n\n").slice(2).join("\n\n"),
            costCny: page.costCny,
          };
          if (ctx.mode === "tui") {
            await showOverlay(ctx, (theme, width) => buildFetchLines(details, theme)(width), "Esc 关闭", active);
          } else {
            ctx.ui.notify(text, "info");
          }
        } catch (e) {
          if (active.aborted) return;
          ctx.ui.notify(errorMessage(e), "error");
        }
        return;
      }

      /* direct search */
      const query = argv.join(" ");
      try {
        const details = await commandRequest(ctx, active, "搜索网页", signal => client.search(query, 5, signal));
        if (!details || active.aborted) return;
        lastSearch = details;
        if (ctx.mode === "tui") {
          await showOverlay(
            ctx,
            (theme, width) => buildSearchLines(details, theme)(width),
            "Esc 关闭 · /websearch fetch <n> 取全文",
            active,
          );
        } else {
          const top = details.results.slice(0, 3).map((r, i) => `${i + 1}. ${r.title} — ${r.url}`);
          ctx.ui.notify([`web_search "${query}" · ${details.results.length} 条`, ...top].join("\n"), "info");
        }
      } catch (e) {
        if (active.aborted) return;
        ctx.ui.notify(errorMessage(e), "error");
      }
    },
  });
}
