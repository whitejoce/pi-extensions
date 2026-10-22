# 扩展详细说明

[返回 README](../README.md)

各扩展的用法、配置与行为边界。安装步骤和常用命令见 README；模块职责与维护约束见 [扩展规则](../extensions/AGENTS.md)。

## 安装与迁移

推荐通过 [README 中的 Git 包命令](../README.md#安装与更新) 安装和更新。Pi 管理的包目录只存放分发代码；更新可能重置并清理整个包目录，个人密钥、配置和自定义修改不要保存在其中。

从旧的手动复制方式迁移，只需处理一次：

1. 如果使用旧 `~/.pi/agent/extensions/web-search/.env`，先将 `api_key` 与可选的 `base_url` 保存到 `~/.pi/agent/config/pi-extensions/.env.web-search`。不要覆盖已有个人配置；有两份时先核对内容。
2. 将旧安装中本仓库已有的入口 `.ts` 文件移到 Pi 自动发现目录之外备份，避免旧副本与包同时注册命令和工具。只处理 README 表中列出的扩展入口，保留其他扩展、个人规则和配置。辅助目录可能被其他扩展共用，无需删除。
3. 执行 README 中的 `pi install` 命令，再重启 Pi 或执行 `/reload`。使用 `pi list` 确认包已登记。
4. 后续只更新包；个人配置继续从固定用户目录读取。

若已有手动安装的同名 `pi-upgrade-review` 技能，也先将旧技能目录移到自动发现目录之外备份，避免与包内技能重名。

如果继续手动安装，将仓库 `extensions/` 的内容复制到 `~/.pi/agent/extensions/`，将 `skills/pi-upgrade-review/` 复制到 `~/.pi/agent/skills/pi-upgrade-review/`，保持相对布局完整。配套 `.ps1` 和 `.cs` 文件也需要复制。手动安装同样支持新的个人配置位置，并兼容原来的 `web-search/.env`。

文中的 `~/.pi/agent` 指 Pi 当前使用的 agent 目录；设置了 `PI_CODING_AGENT_DIR` 时，个人配置与 Pi 凭据随该目录解析。`/anim` 样式仍保存在该目录的 `settings.json` 中。

## auto-summary

文件：[`extensions/auto-summary.ts`](../extensions/auto-summary.ts)

- 注册 `/summary`（无参数）：保存当前分支最近一条有文本的助手回复，保留其正文。已有会话名时不调用模型；未命名时先复用 `/n` 的命名逻辑生成标题。
- 注册 `/summary [instructions]`：使用当前模型把当前分支整理成完整 Markdown 文档，参数直接作为整理要求传给模型（无任何旗标，不存在 `--generate` 或 `-g`）。
- 文件名经过 Windows 安全清理，并以 `-v1.md`、`-v2.md` 的版本形式创建，绝不覆盖已有文件。
- 两种模式都复用已有会话名；未命名时增加一次命名请求，保存成功后才设置会话名，并保留请求期间由其他命令设置的名字。命名失败、取消或写入失败时不设置新名字。生成文档的一级标题与所选标题一致；无参数保存不替换原回复标题。
- 生成模式会对会话内容做有界截断，并在超过输入预算时保留开头和最近内容。输出额度采用模型的 `maxTokens`，由 Pi 按实际上下文空间约束，不再固定限制为 16,384 tokens；达到输出上限时提示文档可能不完整。
- TUI 中可用 Esc 取消命名/生成；处理结束前会阻塞会话/分支导航。通过 Pi 的原生模型注册表发起请求，复用调用时的认证、服务地址和虚拟模型路由；即使回复失败或被取消，也会先记录有效用量，再决定是否写文档。用量写入 `extension-usage`，包含实际响应的供应商、模型、币种和结果；命名与正文生成分别记账。

## powershell-bash

文件：[`extensions/powershell-bash.ts`](../extensions/powershell-bash.ts)

- 在 Windows 上将 Pi 的 `bash`、原生 `powershell` 工具和 `!` / `!!` 执行接入同一个经过验证的 PowerShell Core 7+ 执行器（默认 `pwsh.exe`，可通过 `PI_POWERSHELL_EXE` 覆盖），Windows PowerShell 5.1 不受支持。原生 `powershell` 保持按需启用，可通过 Pi 的 `--tools`、`defaultTools` 或工具选择 API 启用。
- 对命令做 AST 解析，拦截以显式旧版 PowerShell 为目标的调用；输出为 UTF-8 纯文本流，非终止性 cmdlet 错误会使命令以失败退出码结束。
- 普通 Windows 子进程由 kill-on-close Job 持有直到退出；直接以 WSL 为目标的调用使用客户端进程树清理。默认超时 120 秒；会话关闭时会等待在跑的命令结束。
- 结果附带 `execution` 状态：操作 ID、管理进程 PID、起止时间、耗时、退出码、日志位置和清理范围。摘要区分成功、非零退出、超时及取消；单个输出日志上限 64 MiB。状态描述的是被观测的管理进程，不能证明提权进程、WSL Linux 后代或业务修改已经完成。
- `/harness tools` 查看工具注册、启用与嵌套可调用情况；`/harness execution [操作ID]` 查看已记录的执行状态，省略 ID 显示最近五次。命令不自动启用工具，也不查询当前 OS 进程状态。
- 每轮提供当前 `run-script` 可用性；本包不提供 `run-script` 入口，若没有另外安装，应先保存脚本、显式检查语法，再按路径执行。直接调用外部程序后需立即检查 `$LASTEXITCODE`；cmdlet 的 fail-fast 不会自动传播所有原生程序失败。

## tps-status

文件：[`extensions/tps-status.ts`](../extensions/tps-status.ts)

> 实现对齐 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

- 在 TUI 中测量最近一条已完成助手回复的解码速度，通过 `ctx.ui.setStatus("tps", ...)` 发布到状态栏。
- 计时窗口为首个非空文本/思考增量（或带名称/参数的工具事件）到 `message_end`，排除首字延迟（TTFT）与工具执行时间。
- 等待输出、思考中、生成中显示对应状态。仅使用供应商输出 token 用量；实时 `~` 值只在用量增长时更新，节流 400 ms，不因累计数不变而重新计算出下降速度。超过 1.5 秒未增长时，在下一事件恢复阶段文字，没有后台刷新定时器。
- 少于 250 ms 的计时窗口显示“短样本”；已知存在隐藏思考或报告了推理用量却未观测到思考增量时显示“计时不全”；无法测量时显示 `TPS —`。取消、错误及延迟回复不保留临时速度，模型或会话切换会清除状态。客户端观测仍可能受服务端缓冲及未报告的隐藏推理影响。

## anim-compaction

文件：[`extensions/anim-compaction.ts`](../extensions/anim-compaction.ts)

- 上下文压缩触发时（手动 `/compact`、阈值自动、溢出恢复）在编辑器上方显示动画 widget：旋转指示符 + 彗星条 / 均衡器波形 / 追逐点三选一，附带金色压缩耗时、待总结消息数、压缩前 token 数，以及自动/溢出触发徽标；Esc 取消仍可用，不重复内置提示行。
- 注册 `/anim` 命令切换样式（无参数弹选择列表并标记当前项，带参数直接设值），持久化写入 `settings.json`（保留其他键、拒绝损坏 JSON，序列化写入并经同目录临时文件原子替换）。
- 样式优先级：`PI_COMET_STYLE` 环境变量 > `cometCompactionStyle` > 每次随机；配色随明暗主题自适应；仅 TUI 模式生效。

## notify-dot

文件：[`extensions/notify-dot.ts`](../extensions/notify-dot.ts)

- 回合结束且用户不在当前终端标签时，在标签标题前缀一个标记并响铃一次：`●` 正常完成、`✅` 完成且本轮含压缩、`❌` 出错；阻塞式 UI 确认框也会可见等待（`🔐` 确认类、`❓` 其他），未见标记优先级 ❌ > 🔐 > ❓ > ✅ > ●。
- 前台判定：终端焦点报告（如支持）→ Windows Terminal 前台探测脚本（窗口标题 → UIA 选中标签 → 祖先窗口检查）→ 按键启发式；探测仅 Windows Terminal 启用。
- 前台探测脚本从扩展自身目录定位，支持 Git 包安装位置和手动复制位置。
- 收到焦点进入报告时，返回标签即可清除标记，全屏模式也生效；终端不提供报告时仍按输入和前台探测回退。任意输入、提交新提示词、会话开始/关闭时也会清除；`PI_NOTIFY_DOT=off` 可整体禁用。
- `/notifydiag` 按需打开焦点诊断，观察 stdin、Pi 现有输入缓冲与扩展输入层，支持一次模拟完成和重新启用焦点报告。日志保存在 Pi agent 目录，仅记录有界元数据和计数，不记录键入文本；关闭或会话退出时移除观察器及定时器。提示结束后的迟到探测不会恢复已结束提示的标记。

## ai-rename

文件：[`extensions/ai-rename.ts`](../extensions/ai-rename.ts)

- 注册 `/n <名字>` 直接重命名会话（同时更改标签标题），不调用模型。
- 裸 `/n` 让会话当前模型从主题摘要（全部用户消息 + AI 首条文本回复，有截断）生成短名，清洗后限 40 字符。
- 调用期间阻塞会话/分支导航；生成中再次运行 `/n` 会提示等待而不是并发发起第二次调用。与 auto-summary 共用 Pi 原生模型注册表请求、用量记录和操作生命周期；用量跟随实际响应的供应商与模型，失败会显示通知。

## permission-gate

文件：[`extensions/permission-gate.ts`](../extensions/permission-gate.ts)

- 拦截凭据文件（`auth.json` / `.env` 等）的读取与搜索，以及 `bash`、原生 `powershell` 工具中的高置信度危险 Shell 命令；模板 `.env` 允许通过。启发式策略，不是沙箱。
- 危险命令在 TUI 中弹出紧凑确认覆盖层：按危险级别着色的标题（⛔高危/⚠中危 + 中文规则名）、≤3 行命令预览（合并命中片段并反色）、目标与后果合并信息行。多个危险原因合并为一次确认；←/→ 导航、回车或字母快捷键选择。
- 普通危险操作提供 `[n]` 拦截（默认）/`[y]` 放行一次/`[a]` 本会话放行。会话许可绑定会话、工作目录的原路径与真实路径、工具、解释器及源内容哈希；调用方提供脚本身份时，还绑定物理路径、原始字节版本与 WSL 发行版。身份信息不足时只提供单次许可，执行上下文变化后需重新确认。
- 静态识别 PowerShell `Start-Process` 的 RunAs（含常见别名、括号和字符串类型转换）以及 gsudo 执行意图，在会话许可查询前要求本次就绪确认；只提供取消和“已就绪，执行一次”，控制器也拒绝会话许可。常见 gsudo 查询、帮助和关闭缓存命令豁免；AST 检查失败会拒绝授权。
- 每个扩展入口独立持有授权状态，会话开始、重载和关闭时清除许可、取消等待；迟到批准及旧会话审计回调被忽略。审计记录包含源/上下文哈希、规则、调用标识与等待时间，不存命令原文或路径。
- 就绪确认后仍使用原来的系统 UAC 流程；动态/内部提权与手动 `!` / `!!` 不在这项静态识别范围内，也没有改变 UAC 启动及执行超时。本包不提供 `run-script` 入口。

## web-search

文件：[`extensions/web-search.ts`](../extensions/web-search.ts)

- 注册两个只读工具：`web_search`（计数 1–10，支持 `site:` / 引号 / `-` 排除语法；模型内容为带评分/权威度的编号结果 + 摘要）和 `web_fetch`（URL 校验 http/https 且不带凭据，按 20k 字符/页分页）。
- 注册 `/websearch <query>` 直接搜索覆盖层（不经过模型）、`/websearch fetch <n|url>` 拉取上一次搜索的第 n 条、`/websearch status` 查看计费调用数、缓存命中、预估费用及当日额度。TUI 中使用可取消加载界面，Esc、会话切换及关闭会取消请求。
- 计费：DeepSeek Search API，5元/1000 成功且非空的请求；失败、空内容及缓存命中不计费。每次计费操作写入一条明确为 CNY 的 `extension-usage` 服务费用，不虚构 token。
- 搜索按原始 query + count 缓存，网页按原始 URL 缓存；TTL 为 10 分钟，两类缓存各最多 50 项、约 16 MiB。网页 `offset` 续读在缓存中本地分页，不重复请求或计费；会话切换清空缓存。
- `PI_WEBSEARCH_DAILY_LIMIT` 默认 300，0 关闭；按当前 Pi 进程的本地自然日重置，并预留并发请求名额。失败、空内容或取消释放名额，达到额度后仍可读取免费缓存。重启清零，多个进程不共享额度。
- 成功与错误响应均限 4 MiB，严格按 UTF-8 解码并校验结构；所有重试共用 90 秒期限，取消不重试、不回填缓存。普通镜像识别保留 URL 路径与查询参数，仅忽略片段。
- 凭据依次解析：个人配置 `~/.pi/agent/config/pi-extensions/.env.web-search` → 旧扩展目录 `web-search/.env` → Pi auth.json 的 `deepseek` API key；默认服务地址为 `https://api.deepseek.com`。`api_key` 和 `base_url` 分别按该顺序回退，个人文件可以只覆盖其中一项。密钥不出现在日志、工具详情与错误中。

需要搜索时，在上述个人配置位置创建文件，填入：

```dotenv
base_url=https://api.deepseek.com
api_key=填写你自己的密钥
```

也可以参照 [配置示例](web-search.env.example)。如果已有 Pi 的 `deepseek` API key 且使用默认服务地址，无需另建文件。配置读取不会自动创建、迁移或覆盖文件；修改配置后执行 `/reload` 或重启 Pi。

### 交互配置与新手接入

无需手工编辑配置文件，在 Pi 交互终端运行：

```text
/websearch setup
/websearch provider
/websearch status
```

首次使用只需输入 `/websearch`（`setup` 为同一入口）。已有凭据时直接显示当前状态，不要求重复配置；无凭据时提供“邮箱快速开始（推荐）/ 我已有 API Key / 高级设置”。推荐路径默认使用自动策略，直接输入邮箱、确认注册与保存；完成后可选择测试搜索或稍后再试，测试可能消耗额度，不会自动执行。高级设置保留“自动（优先 DeepSeek）/ DeepSeek / AnySearch”与渠道配置。已有 API Key 时使用专用隐藏输入界面，支持粘贴与 Esc 取消；只显示星号，不使用普通对话输入，也不会把密钥写入会话记录。确认后密钥以明文保存在个人配置文件，POSIX 新文件权限为 0600，Windows 使用目录继承权限；这不是加密凭据库，请保护个人目录。

AnySearch 还提供“使用真实邮箱注册并获取 API Key”选项：输入邮箱，明确确认将其发送至官方服务、创建账号及本地保存密钥后，只发送一次注册请求。成功后安全保存取回的密钥并立即应用，默认策略仍优先 DeepSeek。新注册密钥只用于 AnySearch 官方地址，不继承旧代理地址。邮箱已注册时引导官网登录获取密钥，不会重复注册；如果网络中断、取消或密钥保存失败，账号可能已创建，应先去官网登录确认，不自动重试或换号。

`provider` 打开策略选择菜单，也可用 `/websearch provider auto|deepseek|anysearch` 直接切换。保存立即生效，取消旧请求并清空旧渠道缓存和上一轮结果，不需要 `/reload`。界面取消或配置发生并发变更时不覆盖现有文件。`status` 默认只显示是否配置/验证、当前渠道、原因与下一步；`status --verbose` 才显示用量、限额和错误诊断。`help` 只提供本地帮助，不发送搜索请求。状态同时说明当前策略、实际渠道、选择原因，以及各渠道“已配置/未配置”的凭据状态，不显示密钥或其前缀；“已配置”不代表服务端已经验证有效。

密钥输入和注册仅在 Pi 交互终端中开放，RPC/无界面模式不会回退到明文密钥输入。不要把密钥作为 `/websearch setup` 的命令参数。手动编辑文件的方式仍受支持，手动修改后需 `/reload` 或重启。

### AnySearch 渠道

同一个扩展支持 DeepSeek 与 AnySearch，不需要额外安装搜索插件。工具名、分页、缓存、取消与 `/websearch` 命令保持不变。默认 `provider=auto`：优先使用已配置的 DeepSeek 密钥（含 Pi 保存的 API key），没有时使用已配置的 AnySearch 密钥；两个都没有时明确提示配置。只配置 AnySearch 密钥即可自动使用，不必指定渠道。示例：

```dotenv
provider=auto
anysearch_api_key=填写你自己的AnySearch密钥
# 可选；默认即为下面的官方地址，只能使用 HTTPS
anysearch_base_url=https://api.anysearch.com
```

- 不配置 `provider` 等同于 `provider=auto`；两个渠道都有凭据时始终优先 DeepSeek。空白密钥不算已配置。显式 `provider=deepseek` 或 `provider=anysearch` 可以固定渠道；缺少该渠道密钥时直接报错，不偷偷换渠道。未知渠道会报告配置错误。
- 自动选择只在创建或重载客户端时根据凭据进行，不会在 DeepSeek 请求失败、额度不足或密钥无效时把查询发送给 AnySearch；如需切换，使用者明确修改渠道。`/websearch status` 显示模式、实际渠道及选择原因。
- AnySearch 使用独立的密钥和地址字段，不读取 `api_key`、`base_url` 或 Pi 的 DeepSeek 凭据，避免跨服务发送密钥；本适配要求配置密钥，不自动注册账号或回退匿名模式。
- 搜索调用 `POST /v1/search`，把 `count` 映射到 `max_results`（1–10）；网页正文调用 `POST /v1/extract`。处理官方 `code/data` 响应封装，摘要缺失时使用截断的 `content`。首版仅提供通用搜索，不暴露垂直领域参数。
- AnySearch 不提供 DeepSeek 的相关度和权威评分，对应结构化字段为 `null`，界面显示 `N/A`，不伪造评分。此字段变化只影响 AnySearch 渠道；DeepSeek 结果仍为数字。
- AnySearch 的非缓存请求显示 `cost unknown`，不产生虚构的 CNY 服务费用记录；这不代表免费，以服务商账户为准。缓存命中不再发出网络请求。当前进程的默认 300 次本地限额统计成功非空请求，不代表服务端余额或精确计费次数。
- 所有 AnySearch 错误响应均不显示原文，防止额度耗尽响应携带生成的账号或密钥；失败只显示 HTTP 状态等安全诊断。请求禁止自动跟随重定向，防止凭据被转发。
- 修改配置后执行 `/reload` 或重启 Pi；`/websearch status` 显示当前渠道。不要在 issue、日志或版本库中附上个人配置文件。

渠道内部使用独立适配器，共享缓存、限额与 HTTP 生命周期；新增渠道无需继续在客户端堆叠条件分支。开发边界及接入步骤见 [Provider 适配器架构](search-providers.md)。目前仅实现 DeepSeek 与 AnySearch，不接受尚未实现的 Tavily、Exa 配置值。

### AnySearch 邮箱获取密钥

官方 [AnySearch Skill README](https://github.com/anysearch-ai/anysearch-skill#register-for-an-api-key-recommended) 提供邮箱注册取钥流程：向 `https://api.anysearch.com/v1/auth/email/register` 发送 `{"email":"真实可接收邮件的邮箱"}`，成功时从 `data.api_key.key` 获取一次性明文密钥。该流程是注册新账号，不是凭任意邮箱登录已有账号；`email_already_registered` 时应前往返回的登录地址自行登录，不重复注册。

这是向第三方发送邮箱并创建账号的操作，必须由用户明确同意。推荐通过 `/websearch setup` 的邮箱注册向导完成；本扩展不会在搜索或启动时擅自注册、登录或保存新密钥。可在官方控制台 https://anysearch.com/console/api-keys 获取密钥，再安全写入个人配置的 `anysearch_api_key`。邮箱已注册、注册失败或额度不足不会触发批量注册或自动换号。获取密钥的门槛与每次调用费用是两回事，具体成本以官方套餐及账户额度为准。

官方接口文档：[Search](https://anysearch.com/docs/api-endpoints/v1-search)、[Extract](https://anysearch.com/docs/api-endpoints/v1-extract)。

## write-transforms

文件：[`extensions/write-transforms.ts`](../extensions/write-transforms.ts)

- 接管 Pi 的 `read`、`edit`、`write`，保留原生参数和 diff 展示。成功的 UTF-8 文本读取记录文件版本与实际展示的行范围；图片、失败或取消的读取，以及未展示的超长行，不取得阅读许可。
- `edit` 前需读取当前文件版本，局部 read 即可。这是文件版本约束，没有限制只能修改已读行。覆盖已有文件的 `write` 需完整读取，可分页累计；新文件可直接创建。
- `oldText` 先要求唯一精确匹配，失败后只容忍 CRLF/LF 和 ASCII 行尾空格、Tab 差异；缩进、引号与 Unicode 字符保持严格匹配。所有修改块基于同一原文件定位，拒绝歧义、重叠及无变化修改。
- 修改经 Pi 文件队列串行执行；写入前核对文件身份与版本，原地写入后逐字节回读。结果不确定时清除阅读许可，要求重新 read，不自动重试或回滚。它不提供跨进程的原子写入保证。
- edit 成功后继承原来的完整或局部阅读级别；write 成功后，新版本视为完整已知。会话开始、分支导航、成功压缩及关闭会清空阅读状态。
- Shell 和脚本读文件不授予阅读许可，通过它们写文件也不受此约束。自动内容转换管线当前为空。

## plugin-manager

文件：[`extensions/plugin-manager.ts`](../extensions/plugin-manager.ts)

- `/plugins` 在 TUI 中打开 Global/Project 双列管理器；输入搜索，↑/↓或 PageUp/PageDown 选择扩展，←/→或 Tab/Shift+Tab 切换列，空格或 Enter 切换 On/Off。Esc/Ctrl+C 关闭并丢弃未保存草稿。当前单元格加粗、下划线标记，`*` 表示待保存修改。
- `/plugins status` 只读查看配置与当前工具；`/plugins reload` 等待空闲后调用 Pi 的重新加载。管理列表包含本地和已安装包中的自定义扩展，不安装依赖或联网发现资源。
- Global 修改全局默认，保留项目覆盖。Project 支持 Inherit/On/Off；显式 On/Off 即使与 Global 一致也继续保留，Ctrl+R 恢复继承。对继承项切换时，得到与当前生效结果相反的显式选择。项目专属扩展仅有 Project 开关。
- 项目列需已有项目信任，未信任时只读，可先执行 `/trust` 再重新打开。项目值与 Global 一致时为绿色，不一致时为红色；颜色表示一致关系，不代表启用或禁用。
- Ctrl+S 保存两列修改并关闭界面，再等待空闲、执行 Pi 完整资源重载。重载包含扩展、技能、提示词、主题和上下文文件，触发扩展关闭/启动生命周期，也会清空文件阅读状态，需要重新 read。其他运行中的会话需自行重载或重启。
- 扩展选择保存在 Pi 原生全局或项目 `settings.json`；保存前验证原生配置能表达所选状态且不改变其他扩展，保留其他配置及包资源筛选。配置损坏、外部冲突或无法表达的宽泛筛选会报错。两类文件分别写入，部分失败会保留未保存草稿、提示已保存部分需重载，不回滚或自动重试；重载失败后可执行 `/reload` 或重启 Pi。
- 新管理器要求 Pi 1.4.0。旧 Mode Default/Auto、Save to 及自动补工具逻辑已移除；工具恢复和启用由 Pi 原生处理。旧 `plugin-manager.json` 保留但不再读取或写入，包括损坏的旧文件。列表表示原生配置选择，不是加载成功或工具启用的证明。

## pi-upgrade-review 技能

文件：[`skills/pi-upgrade-review/SKILL.md`](../skills/pi-upgrade-review/SKILL.md)

- 手动执行 `/skill:pi-upgrade-review`，可附带升级区间（如 `1.3.0 -> 1.4.0`）或关注范围。它在当前会话中运行，不自动创建会话或监听升级，模型不会自行调用该技能。
- 按本地 Changelog、当前扩展、公开 API 和实际原生行为审查升级影响，运行适用的现有离线检查，重新判断补偿逻辑是否仍有必要。技能调用本身只授权审查和报告归档，功能修改继续遵守用户审批规则。
- 根据实际 Pi agent 目录定位本地配置及已安装包，默认 `~/.pi/agent`；报告以 UTF-8、版本化文件名保存到该目录的 `docs/pi-upgrade-reviews/`，不写入可被包更新清理的代码目录。已存在的报告不覆盖。
- 使用当前已有系统/项目运行时，不安装依赖、不读取真实凭据、不发起真实模型或工具请求来做验证；需要外部资料时另行取得授权。复杂界面和交互校验留给人工，测试失败、跳过和未执行项分别记录。

## agent/AGENTS.md

文件：[`agent/AGENTS.md`](../agent/AGENTS.md)

- 当前 `~/.pi/agent/AGENTS.md` 的归档副本，保留 Pi Agent 的规则、术语和扩展清单。

## extensions/AGENTS.md

文件：[`extensions/AGENTS.md`](../extensions/AGENTS.md)

- 只适用于本仓库 `extensions/` 目录的精简规则文件，记录十个扩展的范围、修改约束和验证方式。

## 行为边界

- `powershell-bash` 负责 Windows Shell 的执行适配；危险命令确认由 `permission-gate` 提供，两者都不是权限沙箱。
- 默认启动 `pwsh.exe`；如需使用其他 PowerShell 可执行文件，可设置 `PI_POWERSHELL_EXE`。
- Shell 输出被设置为 UTF-8 纯文本；当 `PYTHONUTF8` 和 `PYTHONIOENCODING` 未设置时，扩展会为 Python 子进程提供默认值。
- 普通 Windows 子进程由 kill-on-close Job 持有，超时或取消会结束该 Job；直接调用 WSL 的命令只做客户端进程树清理，不保证终止所有 Linux 后代。长时间运行的命令应显式设置合理超时。
- 生成摘要时，当前会话内容可能被发送给活动模型，请根据模型服务的隐私策略使用；裸 `/n` 同理。
- `notify-dot` 的前台探测仅在 Windows Terminal 下生效，其他终端依赖焦点报告（如支持）与按键启发式；标记在用户离开时提示，收到返回标签的焦点报告即可清除，未收到报告时仍可通过输入清除。
- `permission-gate` 是启发式策略而非沙箱：动态拼接、混淆或未覆盖的危险命令不保证被拦；白名单按命令哈希匹配，参数变化即视为新命令。
- `web-search` 按配置调用 DeepSeek Search API 或 AnySearch，费用规则以对应服务商为准；查询内容由模型构造并发送给该服务，请按隐私策略使用。限额与凭据见 [web-search](#web-search)。
- 规则文件中的扩展清单来自作者本机环境；如果只安装本仓库的十个扩展，应按实际安装情况维护清单。
