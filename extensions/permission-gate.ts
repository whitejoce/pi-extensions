import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DANGEROUS_COMMAND_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "recursive deletion", pattern: /\b(?:remove-item|rm|ri|del|erase)\b[\s\S]*\s-(?:recurse|r)\b/i },
  { label: "forced wildcard deletion", pattern: /\b(?:remove-item|rm|ri|del|erase)\b[\s\S]*(?:\*|\?)[\s\S]*\s-force\b/i },
  { label: "cmd recursive deletion", pattern: /\b(?:cmd(?:\.exe)?\s+\/c\s+)?(?:rd|rmdir)\b[\s\S]*\/(?:s|q)\b/i },
  // cmd `del /s`: require the /s flag to stand alone so Windows paths like `C:/src` don't match.
  { label: "cmd recursive file deletion", pattern: /\b(?:cmd(?:\.exe)?\s+\/c\s+)?del\b[\s\S]*\/s(?![\w])/i },
  { label: "Unix recursive deletion", pattern: /\brm\s+(?:-[a-z]*r[a-z]*f?|--recursive)\b/i },
  { label: "Git clean", pattern: /\bgit\s+clean\b[\s\S]*-[a-z]*f/i },
  { label: "Git hard reset", pattern: /\bgit\s+reset\b[\s\S]*--hard\b/i },
  { label: "disk formatting", pattern: /\b(?:format-volume|clear-disk|remove-partition|diskpart)\b/i },
];

/** Exact basenames that must never be read/written/edited by model tools. */
const SENSITIVE_BASENAMES = new Set(["auth.json"]);

/**
 * Shell text that likely targets secrets.
 * Intentionally broad: false positives are preferred over leaking credentials.
 */
const SENSITIVE_COMMAND_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "auth.json", pattern: /\bauth\.json\b/i },
  { label: ".env", pattern: /(?:^|[\s"'`=([{:;,])\.env(?:\.[\w.-]+)?\b/i },
  { label: ".env path", pattern: /[\\/]\.env(?:\.[\w.-]+)?\b/i },
  { label: "~/.pi/agent/auth.json", pattern: /[\\/]\.pi[\\/]agent[\\/]auth\.json\b/i },
];

function detectDangerousCommand(command: string): string | undefined {
  return DANGEROUS_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))?.label;
}

function detectSensitiveCommand(command: string): string | undefined {
  return SENSITIVE_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))?.label;
}

function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 800 ? `${normalized.slice(0, 797)}...` : normalized;
}

function expandHome(path: string): string {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

function resolvePath(path: string, cwd: string): string {
  const expanded = expandHome(path.trim());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function isEnvBasename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.");
}

function sensitivePathLabel(path: string, cwd: string): string | undefined {
  if (!path.trim()) {
    return undefined;
  }

  try {
    const abs = resolvePath(path, cwd);
    const name = basename(abs);
    const lower = name.toLowerCase();

    if (SENSITIVE_BASENAMES.has(lower)) {
      return name;
    }
    if (isEnvBasename(name)) {
      return name;
    }
  } catch {
    // Fall through to basename-only checks on unresolvable inputs.
  }

  const rawName = basename(expandHome(path.trim()));
  if (SENSITIVE_BASENAMES.has(rawName.toLowerCase())) {
    return rawName;
  }
  if (isEnvBasename(rawName)) {
    return rawName;
  }

  return undefined;
}

function blockSensitive(reason: string) {
  return { block: true as const, reason };
}

function hasStringProperty<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // File tools: hard-block sensitive paths (no confirmation).
    if (
      (isToolCallEventType("read", event) ||
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)) &&
      hasStringProperty(event.input, "path")
    ) {
      const path = event.input.path;
      const label = sensitivePathLabel(path, ctx.cwd);
      if (label) {
        if (ctx.hasUI) {
          ctx.ui.notify(`已拦截对敏感文件的访问：${label}`, "warning");
        }
        return blockSensitive(`Blocked access to sensitive path (${label}): ${path}`);
      }
      return undefined;
    }

    // Grep: hard-block searches that explicitly target sensitive files via `path` or `glob`.
    // Residual risk: a bare grep over cwd could still surface .env contents; blocking that
    // would make grep unusable, so it is accepted intentionally.
    if (isToolCallEventType("grep", event)) {
      if (hasStringProperty(event.input, "path")) {
        const label = sensitivePathLabel(event.input.path, ctx.cwd);
        if (label) {
          if (ctx.hasUI) {
            ctx.ui.notify(`已拦截对敏感文件的搜索：${label}`, "warning");
          }
          return blockSensitive(`Blocked grep on sensitive path (${label}): ${event.input.path}`);
        }
      }
      if (hasStringProperty(event.input, "glob")) {
        const secretLabel = detectSensitiveCommand(event.input.glob);
        if (secretLabel) {
          if (ctx.hasUI) {
            ctx.ui.notify(`已拦截针对敏感文件的搜索 glob：${secretLabel}`, "warning");
          }
          return blockSensitive(`Blocked grep glob that may touch secrets (${secretLabel}): ${event.input.glob}`);
        }
      }
      return undefined;
    }

    if (!isToolCallEventType("bash", event) || !hasStringProperty(event.input, "command")) {
      return undefined;
    }

    const command = event.input.command;

    // Shell: hard-block commands that mention secret files/paths.
    const secretLabel = detectSensitiveCommand(command);
    if (secretLabel) {
      if (ctx.hasUI) {
        ctx.ui.notify(`已拦截可能触及敏感文件的命令：${secretLabel}`, "warning");
      }
      return blockSensitive(
        `Blocked shell access that may touch secrets (${secretLabel}): ${commandPreview(command)}`,
      );
    }

    // Destructive commands: confirm when UI exists, otherwise block.
    const reason = detectDangerousCommand(command);
    if (!reason) {
      return undefined;
    }

    if (!ctx.hasUI) {
      return blockSensitive(`Dangerous PowerShell command blocked without interactive confirmation (${reason})`);
    }

    const confirmed = await ctx.ui.confirm(
      "危险命令确认",
      `检测到 ${reason}：\n\n${commandPreview(command)}\n\n是否允许执行？`,
    );

    if (!confirmed) {
      return blockSensitive(`Blocked by user (${reason})`);
    }

    return undefined;
  });
}
