# Pi Agent Summary & Permission Extensions

面向 [Pi](https://github.com/earendil-works/pi) 的两个扩展，以及当前 `~/.pi/agent/AGENTS.md` 规则文件的整理归档。

## 包含内容

- `extensions/auto-summary.ts`
  - 注册 `/summary [filename]`：不调用模型，保存当前分支最近一条有文本的助手回复。
  - 注册 `/summary --generate [instructions]`（也支持 `-g`）：使用当前模型把当前分支整理成完整 Markdown 文档。
  - 文件名经过 Windows 安全清理，并以 `-v1.md`、`-v2.md` 的版本形式创建，绝不覆盖已有文件。
  - 生成模式会对会话内容做有界截断，并在超过输入预算时保留开头和最近内容。
- `extensions/permission-gate.ts`
  - 硬拦截模型工具对 `auth.json`、`.env` 及 `.env.*` 的读写编辑。
  - 硬拦截 grep 明确指向上述敏感文件的路径或 glob。
  - 拦截 shell 命令中可能触及敏感文件的文本。
  - 对递归删除、强制通配符删除、Git 清理/硬重置和磁盘操作等危险命令进行确认；无交互界面时直接阻止。
- `agent/AGENTS.md`
  - 当前 `~/.pi/agent/AGENTS.md` 的归档副本，保留 Pi Agent 的规则、术语和扩展清单。

## 安装

1. 将 `extensions/auto-summary.ts` 和 `extensions/permission-gate.ts` 复制到：

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

`permission-gate` 不提供命令；它通过 Pi 的 `tool_call` 事件自动生效。

## 安全边界

- 这是防护层，不是完整的沙箱。它优先选择误拦截而不是泄露凭据。
- 对不带明确敏感文件路径的宽泛搜索，无法保证发现风险；应继续避免在命令输出中打印秘密。
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
3. 让模型尝试读取 `.env` 或执行递归删除命令，确认被拦截或要求确认。

## 项目结构

```text
pi-agent-summary-permission/
├─ extensions/
│  ├─ auto-summary.ts
│  └─ permission-gate.ts
├─ agent/
│  └─ AGENTS.md
├─ .gitignore
├─ LICENSE
└─ README.md
```

## License

MIT，详见 [`LICENSE`](./LICENSE)。
