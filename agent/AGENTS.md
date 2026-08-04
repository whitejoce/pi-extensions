# AGENTS.md

## Scope

Rules for `~/.pi/agent`. A nearer applicable `AGENTS.md` overrides this file within its directory.

## Environment and Tools

- Do not infer live runtime state from session logs.
- On Windows, use PowerShell as the shell.
- Use tools for their intended tasks when available:
  - `fd` for finding files and directories.
  - `rg` for text and file searches.
  - `jq` for JSON processing.
  - `7z` for archive operations.
  - `ffmpeg` for audio and video processing.
- Use `scoop list` to check whether a tool is installed.

## Directory Rules

- Before editing files under `~/.pi/agent/extensions`, read `~/.pi/agent/extensions/AGENTS.md`.

## Tool selection

1. Create or fully replace a file with the dedicated write-file tool.
2. Make localized changes with the edit/patch tool.
3. Use shell tools for execution, testing, building, searching, moving, and inspection.
4. Do not pass large file contents through shell arguments, heredocs, PowerShell
   here-strings, Base64, or one-line Python commands when a file-writing tool exists.
5. After writing, use shell commands only for validation and testing.

## PowerShell and Encoding

- Use PowerShell 7. All commands must use PowerShell syntax; Bash heredocs are prohibited.
- The shell extension initializes PowerShell and Python standard streams as UTF-8 by default, so there is no need to repeatedly set environment variables for every Python command.
- Use UTF-8 for all text files. When reading or writing text in PowerShell, explicitly specify `-Encoding utf8` where needed.
- When running Python independently of the shell extension, or when troubleshooting encoding issues, use `python -X utf8`.
- `Out-File` and `Set-Content` cannot fix mojibake already produced upstream. Inspect the input file, subprocess stdout/stderr, the PowerShell pipeline, and the terminal rendering layer separately.
- Do not use `errors="ignore"`, blind transcoding, or automatic encoding detection to conceal encoding problems.

## Changes

- Investigate before editing. When behavior is unclear, read the nearest rules, documentation, source, or examples first.
- Only implement the requested change by default.
- Treat optional improvements, refactors, and generalizations as suggestions.
- An explicit user request to implement a specific change counts as approval.
- Before modifying functional code, state the modification plan, possible side effects, and meaningful alternatives.
- Ask for confirmation when the scope is ambiguous, the change is destructive, or materially different alternatives require a user decision.
- Functional code includes changes to runtime behavior, public interfaces, data writes, dependencies, migrations, production configuration, or business logic.
- Documentation, tests, explanatory configuration, non-destructive checks, and small formatting fixes may be changed directly unless they affect runtime behavior.
- Do not discard, revert, or replace unrelated uncommitted changes. Preserve them and edit around them.

## Terminology

Use these terms consistently when discussing Pi concepts. If an ambiguous Pi-related term affects implementation, ask for clarification.

- Pi: A minimal terminal coding harness extended through TypeScript extensions, skills, prompt templates, themes, and Pi packages.
- 扩展 (`Extensions`): TypeScript modules that change Pi behavior through the official extension API.
- 技能 (`Skills`): On-demand workflow packages with their own instructions and optional assets.
- 提示词模板 (`Prompt Templates`): Reusable Markdown prompts.
- 规则文件 (`Rule Files`): Startup context files such as `AGENTS.md` and `CLAUDE.md`.
- 会话 (`Sessions`): Saved conversation history with branching support.

## Priority

1. Current user instruction
2. Nearest applicable project or directory rule file
3. This file
4. Default Pi behavior