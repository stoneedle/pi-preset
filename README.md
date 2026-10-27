# 我的 Pi Preset

我日常使用的 [Pi](https://pi.dev/) 提示词、扩展、技能和代理配置合集。

这里分享的是一套个人使用习惯：怎样约束 agent 的工作方式、怎样与 Gemini 协作、用哪些工具补充 Pi，以及哪些技能值得放在手边。自己的内容和维护中的 fork 直接收录，第三方内容保留来源和许可证。

## 提示词与代理

| 内容 | 分享了什么 |
|---|---|
| [追加系统提示词](APPEND_SYSTEM.md) | 我的工程判断、沟通习惯、前端设计原则，以及浏览器、子代理和 Codemode 的使用约定 |
| [Pi 设置](settings.json) | 模型、思考等级、上下文压缩、工具和显示偏好，不含登录凭据 |
| [advisor](agents/advisor.md) | 独立工程顾问，讨论架构、取舍和关键假设 |
| [implementer](agents/implementer.md) | 负责调查、实现、修复和工程交付的代理 |
| [luna](agents/luna.md) | 检索、资料整理和做法已经明确的轻量任务 |
| [designer](agents/designer.md) | 负责产品体验、交互和视觉表达的独立设计角色 |
| [designer 协作约定](references/designer-collaboration.md) | 主 agent、设计者与用户之间怎样交接、决策和承接实现 |

这些是我的实际偏好，不是通用最佳实践。模型名称、工具和路径可按自己的环境调整。

## 扩展与改造

### [agy-gemini](extensions/agy-gemini/)

把 agy CLI 接入 `pi-subagents`，让 Gemini 作为独立角色参与探索、设计和写作。支持连续讨论、异步执行和原始回复交付；协作身份随扩展注入，不需要在每次请求里重写双方约定。

目录中包含扩展代码、[Gemini 协作身份](extensions/agy-gemini/collaboration.md)、[角色提示词](extensions/agy-gemini/role.md)和执行协议。依赖 `pi-subagents`，使用者需要自行安装并登录 agy CLI。

### [行内技能补全](projects/pi-extensions/packages/inline-skill-completion/)

基于 [CNife/pi-extensions](https://github.com/CNife/pi-extensions) 改造。在输入正文和后续行中使用 `/skill:` 补全，支持多个技能的折叠展示。源码位于下方收录的完整 `pi-extensions` 项目中，保留上游 MIT 许可。

### 两个小扩展

- [bash-timeout-guard.ts](extensions/bash-timeout-guard.ts)：拦截超过一小时的 bash 超时参数，提醒 agent 参数单位是秒，减少把毫秒误填成秒的问题。
- [codex-fast-shortcut.ts](extensions/codex-fast-shortcut.ts)：通过 `Alt+Shift+F` 切换 Codex Fast 模式，并处理 Windows Tabby 的按键编码。需要另装 `pi-codex-fast`。

## 收录的 fork 项目

完整源码放在 `projects/`，每个项目保留自己的目录、说明和许可证。

| 项目 | 内容 | 上游 |
|---|---|---|
| [pi-web](projects/pi-web/) | Pi 手机遥控界面，侧重弱网阅读与接续工作；包含终端状态标题、会话命名和后台标题摘要 | [ygncode/pi-web](https://github.com/ygncode/pi-web) |
| [pi-extensions](projects/pi-extensions/) | 扩展集合；我目前使用和改造的是其中的行内技能补全，项目内也保留其他上游扩展 | [CNife/pi-extensions](https://github.com/CNife/pi-extensions) |
| [pi-subagents](projects/pi-subagents/) | 子代理编排及自己的结果交付相关改造 | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) |

这些是源码项目，不意味着需要同时启用所有扩展。使用入口、依赖和具体功能见各自 README。

## 使用中的第三方插件

这些插件不复制源码，链接到原项目或 npm。

| 插件 | 本次收录时使用的版本 | 用途 |
|---|---|---|
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | 0.37.0 | 网页搜索、内容读取与来源查证 |
| [pi-codex-image-gen](https://www.npmjs.com/package/pi-codex-image-gen) | 0.1.15 | 通过 Codex 登录调用图片生成与编辑 |
| [pi-compact-transcript](https://github.com/avhagedorn/pi-compact-transcript) | 0.11.1 | 紧凑的会话记录展示 |
| [pi-goal](https://www.npmjs.com/package/pi-goal) | 0.1.7 | 持续目标模式 |
| [pi-codex-fast](https://github.com/calesennett/pi-codex-fast) | 0.1.11 | Codex Fast 模式 |

`pi-codex-fast` 上游目前没有声明许可证，因此这里仅分享链接和我自己写的快捷键，不收录该插件源码、本机改造或补丁。

## 技能合集

每个链接都指向技能正文；有辅助脚本、参考资料或素材的技能一并保留。

### 设计与可视化

- [impeccable](skills/impeccable/SKILL.md)：前端体验、视觉设计、界面评审和打磨。来源：[pbakaus/impeccable](https://github.com/pbakaus/impeccable)。
- [archify](skills/archify/SKILL.md)：将架构、流程、时序、数据流和状态关系做成可浏览的图示。来源：[tt-a1i/archify](https://github.com/tt-a1i/archify)。

### 工程与协作

以下技能来自 [Matt Pocock 的 skills](https://github.com/mattpocock/skills)，保留了我的本地使用版本及其 MIT 许可。

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

## 按需取用

可以直接阅读、复制所需内容，也可以 clone 或 fork 后保留自己的版本。追加提示词对应 Pi 用户目录的 `APPEND_SYSTEM.md`；技能按目录取用；扩展的依赖和使用方式见各自目录。

不必整套采用，也不会自动更改使用者的 Pi 配置。登录凭据、会话、数据库、缓存，以及 agy 技能、whiteboard、Hussar 和项目 memory 不在分享范围内。

## 许可

原创部分采用 [MIT](LICENSE)。第三方内容遵循各自许可证，字体、品牌标记等素材另有条款，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
