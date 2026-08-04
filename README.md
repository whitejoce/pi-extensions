# My Pi Extensions

面向 [Pi](https://github.com/earendil-works/pi) 的两个扩展，以及当前 `~/.pi/agent/AGENTS.md` 规则文件的整理归档。

## 包含内容

- `extensions/auto-summary.ts`
  - 注册 `/summary [filename]`：不调用模型，保存当前分支最近一条有文本的助手回复。
  - 注册 `/summary --generate [instructions]`（也支持 `-g`）：使用当前模型把当前分支整理成完整 Markdown 文档。
  - 文件名经过 Windows 安全清理，并以 `-v1.md`、`-v2.md` 的版本形式创建，绝不覆盖已有文件。
  - 生成模式会对会话内容做有界截断，并在超过输入预算时保留开头和最近内容。
- `extensions/powershell-bash.ts`
  - 在 Windows 上将 Pi 的 `bash` 工具和 `!` / `!!` 执行切换为 PowerShell 7（默认使用 `pwsh.exe`，可通过 `PI_POWERSHELL_EXE` 覆盖）。
  - 使用 UTF-8 纯文本输出，并在未显式设置时为 Python 子进程提供 UTF-8 环境变量默认值。
  - 支持流式输出、超时校验、AbortSignal 取消和进程树终止；默认超时为 120 秒。
  - 保留 Pi 标准的输出截断和错误处理行为。
- `agent/AGENTS.md`
  - 当前 `~/.pi/agent/AGENTS.md` 的归档副本，保留 Pi Agent 的规则、术语和扩展清单。

## 安装

1. 将 `extensions/auto-summary.ts` 和 `extensions/powershell-bash.ts` 复制到：

   ```text
   ~/.pi/agent/extensions/
   ```

2. `agent/AGENTS.md` 对应本机路径：

   ```text
   ~/.pi/agent/AGENTS.md
   ```

   建议先审阅并合并其中的规则，不要在已有本地规则文件包含个人配置时直接覆盖。

3. 在 Pi 中执行 `/reload`，或重新启动 Pi。

## 使用

```text
/summary [可选文件名]
/summary --generate [可选整理要求]
```

- 默认模式只保存最近一次助手文本回复，不产生新的模型请求。
- `--generate` 会调用当前活动模型，并可能产生 API 用量和费用；会话内容会发送给该模型。
- 两种模式都只在当前工作目录创建新的 Markdown 文件。

`powershell-bash` 不提供命令；它通过 `session_start` 和 `user_bash` 事件注册并接管 PowerShell 执行。

## 行为边界

- 该扩展只负责 Windows Shell 的执行适配，不是权限沙箱，也不会自动拦截危险命令。
- 默认启动 `pwsh.exe`；如需使用其他 PowerShell 可执行文件，可设置 `PI_POWERSHELL_EXE`。
- Shell 输出被设置为 UTF-8 纯文本；当 `PYTHONUTF8` 和 `PYTHONIOENCODING` 未设置时，扩展会为 Python 子进程提供默认值。
- 超时或取消时会尝试终止整个 Windows 进程树；长时间运行的命令应显式设置合理超时。
- 生成摘要时，当前会话内容可能被发送给活动模型，请根据模型服务的隐私策略使用。
- 规则文件中的扩展清单来自作者本机环境；如果只安装本仓库的两个扩展，应按实际安装情况维护清单。

## 验证

在已安装 Pi 依赖的环境中，可以使用原扩展目录的 TypeScript 配置进行类型检查：

```powershell
tsc -p "$HOME\.pi\agent\extensions\tsconfig.json"
```

重新加载后，可手动验证：

1. 执行 `/summary test`，确认当前工作目录出现新的 `test-v1.md`（或下一个版本）。
2. 执行 `/summary --generate`，确认使用当前模型生成版本化 Markdown 文件。
3. 让 Pi 执行一个普通 PowerShell 命令，确认使用 PowerShell 输出；也可以设置 `PI_POWERSHELL_EXE` 验证可执行文件覆盖。

## 项目结构

```text
pi-extensions/
├─ extensions/
│  ├─ auto-summary.ts
│  └─ powershell-bash.ts
├─ agent/
│  └─ AGENTS.md
├─ .gitignore
├─ LICENSE
└─ README.md
```

## License

MIT，详见 [`LICENSE`](./LICENSE)。
