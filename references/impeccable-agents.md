# Impeccable 角色接入

[extensions/impeccable-agents.ts](../extensions/impeccable-agents.ts) 通过 pi-subagents 的公开事件协议注册三个按需角色，不增加主代理的常驻提示或角色广告。Impeccable 的 `new-work` 已按原名调用它们，`subagent({ action: "list" })` 也可发现。

| 角色 | 执行方式 | 职责与权限 |
|---|---|---|
| `impeccable-finish-reviewer` | agy / Gemini | 依据截图和确认的设计审阅成品；只读，不启动浏览器 |
| `impeccable-documenter` | 原生 Pi | 从最终实现核对或更新 DESIGN.md 与 design.json；仅写材料包指定的设计记录 |
| `impeccable-asset-producer` | 原生 Pi + Codex Image | 按方向卡或批准的设计稿生成、保存与检查图片、提示侧车；不修改页面、规格或批准稿 |

## 安装与模型

按根目录 README 运行 `setup.ps1`，准备 pi-subagents、生图插件及 `preset.json` 固定版本的上游技能。共享设置直接加载 `extensions/` 目录，无需另行登记单文件。

原生角色的模型与思考等级由 `settings.json` 的 `subagents.agentOverrides` 管理，不写进扩展或技能契约。审阅角色需要 [agy-gemini](../packages/agy-gemini/README.md) 提供执行入口，订阅模型由其 adapter 管理。

producer 显式加载用户 Pi 目录内的 `npm/node_modules/pi-codex-image-gen/index.ts`，不依赖主代理的扩展继承；其他角色不因此获得生图工具。生成策略来自 Impeccable 契约，工具自身的调用授权与配额规则照常生效。配置、注册和发现不生成图片。

## 提示与调用

注册时，从 `~/.pi/upstreams/impeccable/.pi/skills/impeccable/reference/degraded/` 下对应文件的角色标题开始提取完整原文，仅移除针对无子代理环境的 inline 前言。技能文件是契约的唯一来源；缺文件或标题不匹配会明确报错。完整契约进入子代理 `systemPrompt`，参与正常提示组装与摘要，不经主代理手动转述。更新技能或扩展后 `/reload` 重新读取。

三个角色默认 fresh，不继承主会话或 skills 目录；原生写入角色保留项目指令，但不继承全局指令。按实际命令进入的流程调用角色，不因角色已注册就给每次 UI 修改套完整流水线。调用方只交接本次需求、有效决定、产物与证据入口、写入边界，不重述已注入的角色契约：

```javascript
subagent({
  agent: "impeccable-documenter",
  cwd: "<项目根目录>",
  task: "<本次材料包：成品路径、确认的方向、PRODUCT.md、document.md 路径及允许写入的设计记录位置>",
  async: true,
})
```

producer 的任务是生产真实素材，不是仅交一份生图提示。方向图任务需要方向卡和输出位置；正式素材任务需要测量后的 spec、批准稿及技能脚本路径。每次交接都须包含用户对图片生成的授权；skill 的委派授权不代替生图工具自身的授权与配额规则。

## 交接与收尾

收尾审阅前，由实现责任人准备并核对该轮所需截图、成品与设计依据，以一份就绪材料开始审阅。finish-reviewer 没有浏览器，采证属于实现交付，不交给它补做；新增证据按上游复核路径处理。

审阅输入、报告结构与复核策略遵循 new-work 的收尾步骤。主代理将修复一次归并交回原实现责任人；修复复核用 `resume` 和最新 `runId` 继续同一审阅，范围及补拍、重建后的完整复审仍以上游为准，不另开一轮泛化检查。角色返回不代替必要的工程验收或用户的设计审批。

documenter 接收最后一次修正后的实现。既有设计系统未变化时，返回 `No changes` 和检查依据就是有效交付，不为证明工作发生而改写记录。
