import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const MAX_FILENAME_BASE_LENGTH = 40;
const MAX_GENERATED_OUTPUT_TOKENS = 16_384;
const PROMPT_TOKEN_RESERVE = 4096;
const MAX_WRITE_ATTEMPTS = 10_000;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Rough token estimate: CJK ≈ 1 token/char, everything else (English, code, whitespace) ≈ 4 chars/token. */
const estimateTokens = (text: string): number => {
  let cjkCount = 0;
  for (const char of text) {
    if (CJK_CHAR.test(char)) {
      cjkCount += 1;
    }
  }
  return Math.ceil(cjkCount + (text.length - cjkCount) / 4);
};

/** String.slice that drops a leading/trailing half of a surrogate pair left at the cut boundary. */
const sliceByChars = (text: string, start: number, end?: number): string => {
  let result = text.slice(start, end);
  if (result.length === 0) {
    return result;
  }
  const first = result.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) {
    result = result.slice(1);
  }
  const lastIndex = result.length - 1;
  const last = result.charCodeAt(lastIndex);
  if (last >= 0xd800 && last <= 0xdbff) {
    result = result.slice(0, lastIndex);
  }
  return result;
};

const sanitizeFilenameBase = (value: string): string => {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .trim();

  let base = (sanitized || "模型输出").slice(0, MAX_FILENAME_BASE_LENGTH).replace(/[. -]+$/g, "");
  if (!base) {
    base = "模型输出";
  }
  if (WINDOWS_RESERVED_NAME.test(base)) {
    base = `_${base}`;
  }
  return base;
};

const nextVersion = async (dir: string, base: string): Promise<number> => {
  const pattern = new RegExp(`^${escapeRegExp(base)}-v(\\d+)\\.md$`, "i");
  const entries = await readdir(dir, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name.match(pattern))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((version) => Number.isFinite(version));

  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
};

const writeVersionedMarkdown = async (dir: string, base: string, content: string): Promise<string> => {
  let version = await nextVersion(dir, base);

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1, version += 1) {
    const filePath = join(dir, `${base}-v${version}.md`);
    try {
      await writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return filePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error("无法分配可用的 Markdown 文件版本号");
};

const extractAssistantText = (message: AssistantMessage): string =>
  message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const findLatestAssistantText = (ctx: ExtensionCommandContext): string | undefined => {
  const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());

  for (let index = sessionContext.messages.length - 1; index >= 0; index -= 1) {
    const message = sessionContext.messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    const text = extractAssistantText(message);
    if (text.trim()) {
      return text.trimEnd();
    }
  }

  return undefined;
};

const markdownHeading = (content: string): string | undefined => {
  const heading = content.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return heading || undefined;
};

type SummaryMode =
  | { mode: "save"; filename?: string }
  | { mode: "generate"; instructions?: string };

const parseMode = (args: string): SummaryMode => {
  const trimmed = args.trim();
  if (trimmed === "--generate" || trimmed === "-g") {
    return { mode: "generate" };
  }
  if (trimmed.startsWith("--generate ")) {
    return { mode: "generate", instructions: trimmed.slice("--generate ".length).trim() || undefined };
  }
  if (trimmed.startsWith("-g ")) {
    return { mode: "generate", instructions: trimmed.slice("-g ".length).trim() || undefined };
  }
  return { mode: "save", filename: trimmed || undefined };
};

const buildDocumentPrompt = (conversationText: string, instructions?: string): string =>
  [
    "你是当前 Pi 会话使用的文档整理模型。请把下面当前分支的会话内容整理成一份完整、可独立阅读的 Markdown 文档。",
    "这不是简短概况：应保留对读者有价值的结论、解释、步骤、代码或配置示例、命令、路径、关键决策、验证结果、限制和后续事项。",
    "根据实际内容组织章节，删除无意义的往返对话和重复信息，但不要遗漏完成任务所需的重要细节，也不要编造未发生的操作。",
    "只输出 Markdown 正文，不要 JSON，不要在整篇文档外包裹代码围栏，不要解释你正在整理文档。",
    "第一行使用准确的一级标题（# 标题），标题也将用于生成文件名。",
    instructions ? `用户附加整理要求：${instructions}` : undefined,
    "",
    "<session>",
    conversationText,
    "</session>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

type PreparedConversation = {
  text: string;
  truncated: boolean;
  estimatedTokens: number;
  inputTokenBudget: number;
};

const prepareConversation = (conversationText: string, model: Model<any>, outputTokens: number): PreparedConversation => {
  const estimatedTokens = estimateTokens(conversationText);
  const inputTokenBudget = Math.max(1024, model.contextWindow - outputTokens - PROMPT_TOKEN_RESERVE);

  if (estimatedTokens <= inputTokenBudget) {
    return { text: conversationText, truncated: false, estimatedTokens, inputTokenBudget };
  }

  const marker = "\n\n[较早的会话内容因文档生成请求的上下文限制已截断]\n\n";
  // Convert the token budget to a character budget proportionally; the estimate is roughly linear in length.
  const maxChars = Math.max(
    0,
    Math.floor((conversationText.length * inputTokenBudget) / estimatedTokens) - marker.length,
  );
  const headChars = Math.floor(maxChars * 0.2);
  const tailChars = maxChars - headChars;

  return {
    text: `${sliceByChars(conversationText, 0, headChars)}${marker}${tailChars > 0 ? sliceByChars(conversationText, -tailChars) : ""}`,
    truncated: true,
    estimatedTokens,
    inputTokenBudget,
  };
};

const pickModel = (ctx: ExtensionCommandContext): Model<any> | undefined => {
  if (ctx.model) {
    return ctx.model;
  }

  const sessionModel = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).model;
  if (!sessionModel) {
    return undefined;
  }

  return ctx.modelRegistry.find(sessionModel.provider, sessionModel.modelId);
};

const generateDocument = async (
  conversationText: string,
  instructions: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> => {
  const model = pickModel(ctx);
  if (!model) {
    ctx.ui.notify("/summary 未找到当前模型，无法生成文档", "warning");
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(`/summary 模型鉴权失败：${auth.error}`, "warning");
    return undefined;
  }
  if (!auth.apiKey) {
    ctx.ui.notify(`/summary 未找到 ${model.provider}/${model.id} 的 API key`, "warning");
    return undefined;
  }

  const maxTokens = Math.max(1, Math.min(MAX_GENERATED_OUTPUT_TOKENS, model.maxTokens));
  const prepared = prepareConversation(conversationText, model, maxTokens);
  if (prepared.truncated) {
    ctx.ui.notify(
      `/summary 会话约 ${prepared.estimatedTokens} tokens，超过生成输入预算 ${prepared.inputTokenBudget}，已保留开头和最近内容`,
      "warning",
    );
  }

  ctx.ui.notify(`/summary 正在使用 ${model.provider}/${model.id} 生成完整 Markdown 文档...`, "info");

  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: buildDocumentPrompt(prepared.text, instructions) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens,
    },
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`模型生成失败（${response.stopReason}）：${response.errorMessage ?? "无错误详情"}`);
  }

  const text = extractAssistantText(response).trim();
  if (!text) {
    throw new Error("当前模型没有返回可保存的 Markdown 文本");
  }
  if (response.stopReason === "length") {
    ctx.ui.notify("/summary 模型输出达到 maxTokens 上限，保存的文档可能不完整", "warning");
  }
  return text;
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("summary", {
    description: "保存最近一次助手回复；使用 --generate [要求] 生成完整会话文档",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      try {
        const requested = parseMode(args);

        if (requested.mode === "save") {
          const content = findLatestAssistantText(ctx);
          if (!content) {
            ctx.ui.notify("/summary 当前分支没有可保存的助手文本回复", "warning");
            return;
          }

          const base = sanitizeFilenameBase(
            requested.filename || markdownHeading(content) || pi.getSessionName() || "模型输出",
          );
          const filePath = await writeVersionedMarkdown(ctx.cwd, base, content);
          ctx.ui.notify(`已保存最近一次助手回复：${filePath}`, "info");
          return;
        }

        const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
        const conversationText = serializeConversation(convertToLlm(sessionContext.messages));
        if (!conversationText.trim()) {
          ctx.ui.notify("/summary 当前分支没有可生成文档的会话内容", "warning");
          return;
        }

        const content = await generateDocument(conversationText, requested.instructions, ctx);
        if (!content) {
          return;
        }

        const base = sanitizeFilenameBase(markdownHeading(content) || pi.getSessionName() || "会话文档");
        const filePath = await writeVersionedMarkdown(ctx.cwd, base, content);
        ctx.ui.notify(`已生成完整 Markdown 文档：${filePath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/summary 失败：${message}`, "error");
      }
    },
  });
}
