# Recollect

[English](README.en.md) · [npm](https://www.npmjs.com/package/@kirkchinese/dsh-recollect) · [更新记录](CHANGELOG.md) · [问题反馈](https://github.com/kirkchinese/DSH-Recollect/issues) · 兄弟项目 [CiteCiter](https://github.com/kirkchinese/CiteCiter)

![Recollect](assets/hero/recollect-hero.png)

**换一个模型，记忆也不会丢。**

Recollect 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的插件：一套**兼容 Claude Code 的记忆系统**。它沿用 Claude Code 的约定：按目录分层的 `CLAUDE.md`、`@import`、`.claude/rules`，以及以 `MEMORY.md` 为索引的持久记忆。DeepSeek、GPT、Qwen、Claude 等所有模型都拿到同一套完整的记忆指导，不会因为换了模型就被降级。

## 为什么需要它

在 Claude Code 里，记忆写作指导会随模型变化：不在它模型目录里的模型只能拿到一段很短的说明，"长期积累"、"用户说记住就立即保存"、各类型的示例都被删掉了。这类模型因此很少主动写记忆。Recollect 用自己编写的提示词（中文和英文两套）和完全一样的行为约定，让每个模型都能：

- 在合适的时机**主动记录**用户画像、工作方式反馈、项目背景和外部资源指针；
- 每个会话开始时读到记忆索引，并在需要时读取或召回记忆正文；
- 记忆会过期，所以推荐之前先核验。

你已有的 `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/` 不需要改动，直接生效；`AGENTS.md` 同样会被读取。

## 安装

| DSH 版本 | Recollect 版本 |
| --- | --- |
| `0.2.0-rc.2`（含官方桌面版）、`0.2.1-alpha.1` 至 `0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2` | `0.1.0` |

**官方桌面版：** 在插件页安装 npm 包 `@kirkchinese/dsh-recollect`，或在 Git 地址一栏填写 `https://github.com/kirkchinese/DSH-Recollect.git`，然后按提示重启。

**命令行与 Web：**

```sh
dsh plugin --profile web add @kirkchinese/dsh-recollect@0.1.0
```

也可以从仓库安装某个发布标签：

```sh
dsh plugin --profile web add "git+https://github.com/kirkchinese/DSH-Recollect.git#v0.1.0"
```

安装后重启 DSH 并刷新页面，新会话生效。Recollect 会接管指令文件的加载，并自动过滤 DSH 自带的 AGENTS.md 加载器注入的内容，避免同一份文件被读两次。

## 它做什么

| 功能 | 默认 | 说明 |
| --- | --- | --- |
| 指令文件 | 开 | 按层级加载：组织策略 `/etc/claude-code` → 用户（`~/.claude/CLAUDE.md`、`~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md`、`~/.claude/rules`）→ 从根目录到当前目录逐层加载 `CLAUDE.md`/`AGENTS.md`（`@import` 就地展开，最多 4 层）→ `.claude/CLAUDE.md` → rules（递归 `.md`）→ `CLAUDE.local.md`/`AGENTS.local.md`。各层并列拼接，不截断；单个文件超过 4 MiB 时跳过 |
| 持久记忆 | 开 | system prompt 里放完整的记忆写作指导：四种类型、不该存什么、两步保存法、访问与核验规则。首条消息注入 `MEMORY.md` 索引，超过 200 行或 25 000 字符时截断并附警告 |
| 刷新 | 开 | resume 时只注入发生变化的文件；上下文压缩把指令摘要掉以后整份重新注入；切换目录或暂停、恢复记忆时也会刷新 |
| 子目录发现 | 开 | 读写子目录里的文件时，注入该目录的指令文件，以及 frontmatter 里 `paths:` 匹配的条件 rule |
| 写后检查 | 开 | 写入记忆后立即提醒：索引超限、单个文件超过召回上限、缺少 `description`、出现 `-2` 式的续写文件 |
| 召回 | 关 | 每次提问时检索最多 5 条相关记忆正文。`bm25` 在本地检索，支持中英日韩；`selector` 用一次模型调用挑选 |
| 后台提取 | 关 | 每轮结束后由一个分叉的子智能体补写主对话漏记的内容，写入范围被限制在记忆目录内 |
| 整理（dream） | 关 | 距上次整理超过 24 小时、且期间有 5 个以上会话时，合并、修正和精简记忆目录。也可以用 `/dream` 手动触发 |
| 智能体记忆 | 关 | 给指定预设的智能体一份独立记忆，作用域为 `user`、`project` 或 `local` |

记忆存放在 `~/.dsh/memory/projects/<git 根目录对应的 slug>/`，同一仓库的不同子目录和 worktree 共用一份。

**写入方式会自动适配沙箱。** 沙箱允许写记忆目录时，模型直接用内置的 `write`/`edit`；在 `workspace-write` 等模式下记忆目录位于工作区之外，Recollect 会挂载专用工具 `memory_list/read/write/edit/delete`，指导文本也随之切换。这些工具只能写记忆目录里的 `.md` 文件，并会拒绝写入密钥。只读沙箱下不写记忆。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/memory` | 查看记忆状态、写入方式和已加载的全部指令与记忆文件 |
| `/pause-memory` | 在本会话中暂停或恢复记忆，状态在重启后保留 |
| `/remember <内容>` | 让模型把这句话存进记忆 |
| `/dream` | 立即整理本项目的记忆目录（需先开启 dream） |

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖。覆盖会替换整个 config 对象，未写出的字段使用默认值：

```yaml
- id: recollect
  name: '@kirkchinese/dsh-recollect'
  config:
    language: zh          # 模型看到的记忆文本语言：zh / en
    recall:
      enabled: true
      method: bm25        # 或 selector
    extract:
      enabled: false
    dream:
      enabled: false
      minHours: 24
      minSessions: 5
    instructions:
      authority: strong   # strong：指令文件优先于默认行为（与 Claude Code 一致）；soft：仅作参考
```

全部字段见 [lib/config.js](lib/config.js)，DSH 的设置页也会显示它们。环境变量 `DSH_RECOLLECT_DISABLE_MEMORY=1` 关闭记忆（设为 `0` 则强制开启），`DSH_RECOLLECT_DISABLE_INSTRUCTIONS=1` 关闭指令文件。

## 与 Claude Code 的差异

- 所有模型拿到同一套完整指导，不按模型名单降级或关闭记忆。
- 提示词都是独立编写的，提供中文和英文两套，不包含 Claude Code 的原文。召回使用独立实现的 BM25F。
- 除 `CLAUDE.md` 全套文件外，也读取 `AGENTS.md`、`.agents/rules`、`AGENTS.local.md`；同一目录内内容相同的文件只注入一次。
- 注入前清洗不可见字符和控制字符，并转义文件内容和路径中的 `</system-reminder>`。
- 新增 `/remember`。`/memory` 以文本形式显示状态，没有图形对话框。

## 已知限制

- DSH 在上下文溢出时，会在同一步内压缩并重试，不再经过注入流程，所以这一次重试看不到指令块，要到下一步才补回。
- headless 模式在一轮结束后立即退出，后台提取不会运行。
- 整理锁的做法是写入 PID 后回读校验，不是原子操作；两个宿主进程同时整理同一目录时可能冲突。同一个 DSH 主目录请不要同时运行两个宿主进程。

## 开发

```sh
npm test   # node --test，需要能解析到 DSH 宿主包
```

本项目与 Anthropic 无关。"Claude Code" 只用来说明兼容的文件约定。

## 许可证

[MIT](LICENSE)
