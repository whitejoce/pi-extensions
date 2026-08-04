# AGENTS.md

## Scope

Rules for the `extensions/` directory in this repository. These rules apply to the Pi TypeScript extensions stored here and do not replace the user's global `~/.pi/agent/AGENTS.md`.

## Inventory

Keep this table accurate when an extension is added, removed, renamed, or its user-visible behavior changes.

| File | Purpose |
| --- | --- |
| `auto-summary.ts` | Registers `/summary`: saves the latest text-bearing assistant reply without a model call, or uses `--generate [instructions]` to create a complete versioned Markdown document from the current branch. |
| `powershell-bash.ts` | Replaces Pi's Windows shell execution with streaming PowerShell, UTF-8 plain-text output, validated timeouts, abort handling, and process-tree termination. |

## Extension Rules

- Prefer the official Pi `ExtensionAPI`, `pi`, and `ctx` surfaces.
- Keep each extension focused on one user-visible behavior.
- Keep descriptions concrete: name the command, event, tool, environment variable, or visible result that is affected.
- Do not embed API keys, tokens, machine-specific absolute paths, or private service configuration in source files.
- Preserve UTF-8 text handling and Windows compatibility when changing `powershell-bash.ts`.
- Preserve versioned, non-overwriting Markdown writes when changing `auto-summary.ts`.
- Update this inventory and the root `README.md` when an extension's user-visible behavior changes.

## Validation

- Run the TypeScript check from an environment with Pi's type declarations installed.
- Reload Pi or restart it after installing or changing extensions.
- Manually verify `/summary` after changes to `auto-summary.ts`.
- Manually verify a normal shell command, timeout, and `PI_POWERSHELL_EXE` override after changes to `powershell-bash.ts`.
