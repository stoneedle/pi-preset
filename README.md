# 我的 Pi 环境

复刻我日常使用的 [Pi](https://pi.dev/) 工作环境：工程与沟通习惯、常用技能、自定义代理、Gemini 协作，以及手机远程界面。

这是一套个人偏好，不是通用最佳实践。提示词与配置可以直接取用；需要完整能力时，按下面的顺序安装。登录凭据、会话、数据库和缓存始终由使用者自己保管。

## 先认识目录

| 目录／文件 | 用途 |
|---|---|
| [APPEND_SYSTEM.md](APPEND_SYSTEM.md) | 追加系统提示词：工程判断、沟通、设计与工具使用约定 |
| [settings.json](settings.json) | 主模型、思考等级、压缩与显示偏好，不含凭据或安装来源 |
| [agents/](agents/) | advisor、implementer、luna、designer 四个自定义角色 |
| [references/](references/) | designer 的协作约定 |
| [skills/](skills/) | 可独立取用的技能及辅助资源 |
| [packages/](packages/) | 可通过 `pi install` 加载的完整 Pi 包，含依赖和源码 |
| [extensions/](extensions/) | 两个单文件扩展 |
| [LICENSE](LICENSE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 原创 MIT 许可与集中保存的第三方来源、版权和完整许可 |

**你安装的是 Pi 包，包可以提供扩展、技能和提示词。** 是否来自 fork 只是来源信息，不是另一种安装类别；Pi Web 还需要构建和安装网页服务。

## 复刻步骤

以下命令使用 Bash；Windows 使用 Git Bash。在 clone 后的仓库根目录执行，并保留这个源码目录：本地 `pi install` 登记的是路径，不会复制源码，移动目录后需要重新登记。

### 1. 准备 Pi 与账号

本次整理时的本机版本是 **Pi 1.4.0、Node.js 24.15.0**。Pi 要求 Node.js 22.19+，还需 Git；Pi Web 另有工具链要求，见第 5 步。

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0
pi --version
pi
```

在 Pi 中执行 `/login` 登录自己的提供方，再用 `/model` 确认模型可用。本仓库默认使用 OpenAI Codex；`settings.json` 和 `agents/*.md` 中的模型名称需要与你的账号实际目录一致。

### 2. 放入偏好、角色和技能

以下复制命令适用于**新的 Pi 用户目录**。已有配置时，先自行保留原文件，再合并所需字段与目录；不要直接覆盖原来的设置和角色。

```bash
agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent/agents" "$agent/references" "$agent/skills"
cp APPEND_SYSTEM.md settings.json "$agent/"
cp -R agents/. "$agent/agents/"
cp -R references/. "$agent/references/"
cp -R skills/. "$agent/skills/"
```

自定义角色由下一步的 pi-subagents 发现。`settings.json` 关闭了它的内置角色，使用这里提供的 advisor、implementer、luna 和 designer；designer 还依赖第 4 步的 agy。

### 3. 安装本仓库扩展与外部插件

先安装本地依赖，再将本地包登记到 Pi。**pi-subagents 使用本仓库的 fork，不用 npm 上游替代。**

```bash
npm --prefix packages/pi-subagents ci --ignore-scripts --omit=dev
pi install ./packages/pi-subagents
pi install ./packages/inline-skill-completion
pi install ./extensions/bash-timeout-guard.ts

pi install npm:pi-web-access@0.37.0
pi install npm:pi-codex-image-gen@0.1.15
pi install npm:pi-compact-transcript@0.11.1
pi install npm:pi-goal@0.1.7
pi install npm:@calesennett/pi-codex-fast@0.1.11
pi install ./extensions/codex-fast-shortcut.ts
```

| 插件 | 用途 |
|---|---|
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | 网页搜索、内容读取与来源查证 |
| [pi-codex-image-gen](https://www.npmjs.com/package/pi-codex-image-gen) | Codex 图片生成与编辑；按该插件说明完成自己的登录 |
| [pi-compact-transcript](https://github.com/avhagedorn/pi-compact-transcript) | 紧凑会话展示 |
| [pi-goal](https://www.npmjs.com/package/pi-goal) | 显式开启的持续目标模式 |
| [pi-codex-fast](https://github.com/calesennett/pi-codex-fast) | Codex Fast；快捷键为 Alt+Shift+F |

搜索提供方、图片账号等外部能力仍需按各插件说明配置，安装包不等于完成登录。第三方插件不复制源码，版本固定在上述安装命令。

### 4. 接入 Gemini 协作

需要已安装、已登录且在 PATH 中可用的 **agy CLI**。本仓库不分发 agy 的安装器、账号或订阅；没有可用 agy 时，可以先跳过这一能力。

```bash
agy models
npm --prefix packages/agy-gemini ci --ignore-scripts --omit=peer
pi install ./packages/agy-gemini
```

agy-gemini 的依赖指向同级 `packages/pi-subagents`，与第 3 步使用同一份 fork。通过 `agy models` 核对默认 Gemini 模型；模型与执行协议见 [包说明](packages/agy-gemini/README.md)，协作权责见 [collaboration.md](packages/agy-gemini/collaboration.md)。

### 5. 安装手机遥控与标题能力

需要 **Go 1.26+、GNU Make**，以及前面安装的 Pi、Node.js、Git。Windows 还需 Git Bash，所有工具加入 PATH；远程访问使用自己的 Tailscale。

```bash
npm --prefix packages/pi-web ci --ignore-scripts
pi install ./packages/pi-web
node packages/pi-web/scripts/run-lifecycle.mjs install
```

安装入口从本仓库源码构建前端与 Go 服务，并安装对应平台的登录启动配置。默认地址是 `http://127.0.0.1:31415`；稳定令牌、Tailscale、更新和卸载见 [Pi Web 说明](packages/pi-web/README.md)。

手机界面的 Fast 速度控制还需给已安装的 `pi-codex-fast@0.1.11` 应用会话接口适配：

```bash
node packages/pi-web/scripts/enable-fast-state.mjs --apply
```

该脚本会修改本机已安装插件，保留备份并拒绝未知源码指纹；省略 `--apply` 只检查。没有这项接口时，网页不会提供可用的速度控制。本仓库不包含 pi-codex-fast 原版源码。

### 6. 检查是否生效

重启 Pi，或在已有会话执行 `/reload`，检查：

- `pi list` 中的本地包路径指向本次 clone；启动时没有扩展加载错误。
- `/skill:grilling` 能发现对应技能，正文中也能使用行内技能补全。
- `/subagents-doctor` 可用，自定义角色能被发现；已接入 agy 时包含 gemini 和 designer。
- 安装了 Pi Web 时，`/pi-web status` 显示服务状态，`/web` 能打开当前会话。

这些是安装后的人工检查点；本次仓库整理没有在干净机器上执行完整安装验收。

## 本地包与来源

| 包 | 提供的能力 | 来源 |
|---|---|---|
| [pi-subagents](packages/pi-subagents/) | 子代理编排、监督与结果交付 | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)，含本地改造 |
| [agy-gemini](packages/agy-gemini/) | Gemini 角色与 agy 执行提供者 | 自有扩展，依赖本仓库 pi-subagents |
| [inline-skill-completion](packages/inline-skill-completion/) | 正文与后续行的技能补全、多技能折叠展示 | [CNife/pi-extensions](https://github.com/CNife/pi-extensions)，含本地改造 |
| [pi-web](packages/pi-web/) | 手机遥控、终端状态标题、会话命名与后台摘要 | [ygncode/pi-web](https://github.com/ygncode/pi-web)，标题模块来自 [t0mj/pi-title-glyphs](https://github.com/t0mj/pi-title-glyphs) |

两个单文件扩展分别用于限制 bash 超时参数，以及切换 Codex Fast／处理 Windows Tabby 按键编码。

## 技能合集

每个链接都指向技能正文；有辅助脚本、参考资料或素材的技能一并保留。

### 设计与可视化

- [impeccable](skills/impeccable/SKILL.md)：前端体验、视觉设计、界面评审和打磨。来源：[pbakaus/impeccable](https://github.com/pbakaus/impeccable)。
- [archify](skills/archify/SKILL.md)：将架构、流程、时序、数据流和状态关系做成可浏览的图示。来源：[tt-a1i/archify](https://github.com/tt-a1i/archify)。

### 工程与协作

以下技能来自 [Matt Pocock 的 skills](https://github.com/mattpocock/skills)，保留我的本地使用版本；版权与 MIT 许可集中在根目录第三方声明。

| 场景 | 技能 |
|---|---|
| 不确定该从哪里开始 | [ask-matt](skills/ask-matt/SKILL.md) |
| 澄清问题、追问方案 | [grilling](skills/grilling/SKILL.md)、[grill-me](skills/grill-me/SKILL.md)、[grill-with-docs](skills/grill-with-docs/SKILL.md) |
| 大任务规划与需求拆解 | [wayfinder](skills/wayfinder/SKILL.md)、[to-spec](skills/to-spec/SKILL.md)、[to-tickets](skills/to-tickets/SKILL.md)、[to-questionnaire](skills/to-questionnaire/SKILL.md) |
| 调查与快速探索 | [research](skills/research/SKILL.md)、[prototype](skills/prototype/SKILL.md) |
| 模块、架构与领域概念 | [codebase-design](skills/codebase-design/SKILL.md)、[improve-codebase-architecture](skills/improve-codebase-architecture/SKILL.md)、[domain-modeling](skills/domain-modeling/SKILL.md) |
| 实现、诊断与评审 | [implement](skills/implement/SKILL.md)、[implement-spec](skills/implement-spec/SKILL.md)、[diagnosing-bugs](skills/diagnosing-bugs/SKILL.md)、[tdd](skills/tdd/SKILL.md)、[code-review](skills/code-review/SKILL.md) |
| Issue 与 PR | [triage](skills/triage/SKILL.md)、[pr](skills/pr/SKILL.md)、[setup-matt-pocock-skills](skills/setup-matt-pocock-skills/SKILL.md) |
| 交接、复盘与教学 | [handoff](skills/handoff/SKILL.md)、[retro](skills/retro/SKILL.md)、[teach](skills/teach/SKILL.md)、[wait-what](skills/wait-what/SKILL.md) |
| 编写 agent 指令、引导人工操作 | [writing-for-agents](skills/writing-for-agents/SKILL.md)、[wizard](skills/wizard/SKILL.md) |

另外还有 Vercel 的 [find-skills](skills/find-skills/SKILL.md)，用于发现可安装的技能。来源：[vercel-labs/skills](https://github.com/vercel-labs/skills)。

## 仓库维护

在 Pi Web 包目录执行 `make build`，正常程序固定输出到 `build/`；安装器和测试共用 Makefile 给出的路径。`make clean` 删除程序、测试报告和前端产物，保留依赖与用户数据。pi-subagents 的打包产物由该包的 `npm run clean` 清理。

临时调查与版本对照使用系统临时目录，任务结束清理；日常维护约定见 [AGENTS.md](AGENTS.md)。

## 不随仓库分发的内容

- **个人状态**：登录凭据、会话、数据库、缓存和服务运行配置。复刻能力不需要复制这些数据。
- **外部工具**：agy、Chrome／MCP 服务、Tailscale 及搜索提供方，需使用者自行准备。提示词中的 Chrome DevTools 约定不是 MCP 安装配置；本仓库没有提供作者使用的浏览器 MCP 实现与配置。
- **未分享的能力**：agy 技能、whiteboard 和 Hussar。

## 许可

原创内容采用根目录 [MIT](LICENSE)。第三方版权、完整许可与字体／品牌素材的独立条款集中在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；子目录不重复放置许可文件。
