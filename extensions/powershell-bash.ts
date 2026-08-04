import { spawn } from "node:child_process";
import {
  createBashToolDefinition,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_POWERSHELL_EXECUTABLE = "pwsh.exe";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const POWERSHELL_ENCODING_PREFIX = [
  "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding = [Console]::OutputEncoding",
  "if ($null -eq $env:PYTHONUTF8) { $env:PYTHONUTF8 = '1' }",
  "if ($null -eq $env:PYTHONIOENCODING) { $env:PYTHONIOENCODING = 'utf-8' }",
  "if (Test-Path variable:PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
].join("\n");

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  // exitCode is null for signal-killed processes too, so also consult `killed`
  // to avoid running taskkill against an already-dead (possibly reused) PID.
  if (!child.pid || child.exitCode !== null || child.killed) {
    return;
  }

  const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });

  killer.once("error", () => {
    child.kill();
  });
  killer.once("close", (code) => {
    if (code !== 0 && child.exitCode === null) {
      child.kill();
    }
  });
}

function createPowerShellOperations(): BashOperations {
  return {
    exec(command, cwd, options) {
      if (options.signal?.aborted) {
        return Promise.reject(new Error("aborted"));
      }

      const timeoutSeconds = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return Promise.reject(new Error("Invalid timeout: must be a finite positive number of seconds"));
      }
      if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
        return Promise.reject(new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
      }

      const env = options.env ?? process.env;
      const executable = env.PI_POWERSHELL_EXE?.trim() || DEFAULT_POWERSHELL_EXECUTABLE;
      const script = `${POWERSHELL_ENCODING_PREFIX}\n${command}`;

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        const child = spawn(
          executable,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
          {
            cwd,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let settled = false;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
          }
          options.signal?.removeEventListener("abort", onAbort);
        };

        const rejectOnce = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        };

        const onAbort = () => {
          terminateProcessTree(child);
        };

        child.stdout.on("data", options.onData);
        child.stderr.on("data", options.onData);

        child.once("error", (error) => {
          rejectOnce(error);
        });

        child.once("close", (code) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();

          if (options.signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeoutSeconds}`));
          } else {
            resolve({ exitCode: code });
          }
        });

        if (options.signal?.aborted) {
          onAbort();
        } else {
          options.signal?.addEventListener("abort", onAbort, { once: true });
        }

        timer = setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child);
        }, timeoutSeconds * 1000);
      });
    },
  };
}

export default function (pi: ExtensionAPI) {
  const operations = createPowerShellOperations();

  pi.on("session_start", (_event, ctx) => {
    const bashTool = createBashToolDefinition(ctx.cwd, { operations });

    pi.registerTool({
      ...bashTool,
      label: "PowerShell",
      description:
        "Execute a PowerShell command on Windows using PowerShell 7 by default (override with PI_POWERSHELL_EXE). Output streams while running and is truncated to Pi's standard 2000-line/50KB limit; complete truncated output is saved to a temporary file. PowerShell uses UTF-8 plain-text output, and Python child processes receive UTF-8 defaults when their encoding environment variables are unset. The default timeout is 120 seconds.",
      promptSnippet:
        "Execute PowerShell commands on Windows (Get-ChildItem, Select-String, Remove-Item, git, npm, etc.)",
      promptGuidelines: [
        "Use bash to run shell commands. On this Windows system, bash executes commands through PowerShell 7 by default.",
        "Use PowerShell syntax and cmdlets when shell behavior matters; common aliases such as ls, cat, rm, cp, mv, and mkdir are available.",
        "Use Get-ChildItem -Recurse for recursive file discovery and Select-String or rg for text search.",
        "Use Out-File or Set-Content when explicit output encoding is important.",
        "Python commands run through bash inherit UTF-8 defaults via PYTHONUTF8 and PYTHONIOENCODING when those variables are unset; override them only for an explicit compatibility requirement.",
      ],
    });
  });

  pi.on("user_bash", () => ({ operations }));
}
