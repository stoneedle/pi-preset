# Gemini 角色与 agy 执行提供者

`agy-gemini` 注册常驻 `gemini` 角色与 `agy` external-job 提供者。主代理通过 pi-subagents 的通用 `subagent` 工具委派，agy 使用自己的订阅登录执行 Gemini。

## 使用

调用授权见用户级 `APPEND_SYSTEM.md`，双方的协作身份见 [collaboration.md](collaboration.md)，由扩展自动注入。先安装并登录 agy，通过 `agy models` 核对实际目录。扩展与 **pi-subagents 0.78.0** 一同加载，并安装本目录的局部锁文件依赖。

```javascript
subagents_enable()
subagent({ action: "list", capabilities: true })
subagent({ agent: "gemini", task: "<设计或写作目的、用户原话与授权材料>", async: true })
subagent({ action: "resume", id: "<最新返回的 runId>", message: "<同一设计或正文的反馈与纠正>" })
subagent({ action: "stop", id: "<正在运行的 runId>" })
```

完成通知在 `results[0].output` 中提供去除首尾空白的回复，`results[0].externalJob.resultArtifactPath` 指向逐字保留的原始文件。交付 Gemini 正文时读取原始 artifact，主代理负责事实查证、工程落地与忠实搬运，不承担创作审批。同一设计问题或正文沿原任务续聊；较长材料在 task 中提供允许读取的文件路径。

默认模型来自 `adapter.mjs` 的 `DEFAULT_MODEL`，为 **gemini-3.8-flash-high**。角色的 `runner.options` 管理订阅模型、可选 JSON Schema 与执行超时；续聊保留原模型、工作目录和输出契约。Pi 主模型由 Pi 的配置管理。

## 身份与提示注入

调用入口与授权边界由用户级 `APPEND_SYSTEM.md` 持有。[collaboration.md](collaboration.md) 是双方权责的唯一来源；[role.md](role.md) 补充 Gemini 在探索、设计与人类写作中的创作任务，不预设文风。

扩展加载时读取共享契约。在每次 `before_agent_start` 中，将它加入主代理的 `gemini_collaboration` prompt section，因此首次构造交接 task 前、续聊以及异步完成后的承接均能看到身份边界，不依赖工具是否已经启用。契约只适用于用户已邀请 Gemini 的问题，不会自动调用 Gemini，也不通过关键词猜测用户是否已邀请。

session 启动时，将同一份契约与 `role.md` 拼成 Gemini 的 `systemPrompt`。Gemini 仍使用 fresh 上下文，不继承主代理的会话、项目规则或 skills；具体用户原话、授权材料与交付要求来自本次 task。修改提示后重启 Pi 或 `/reload` 生效；这是角色原则的自动加载，不增加模式开关、审稿状态机或纠错计数器。

- **Collaboration**（`collaboration.md`）：双方共享的协作身份与权责。
- **Role**（`role.md`）：Gemini 专属的探索、设计与写作任务。
- **Extension**（`index.ts`）：双方提示注入、角色和提供者注册、生命周期及订阅进程取消接线。
- **Adapter**（`adapter.mjs`）：agy CLI 协议、精确回复、SQLite 讨论映射与进程控制。
- **pi-subagents**：公开运行 ID、编排、完成通知和续聊恢复。

SQLite 与原始回复位于系统临时目录；保留状态及 Pi 运行记录才能继续原讨论。已派发且结果不确定的后继阻止旧父引用继续派发。错误保持原义，新的讨论由调用方明确建立。执行协议见 [protocol.md](protocol.md)。

adapter 使用 `--mode plan --dangerously-skip-permissions` 读取用户授权的可信材料。只读行为由 planning 模式与提示词承担；OS 隔离需要独立的部署边界。

## 验证

`npm test` 检查 CLI 回复解析契约，不调用 Gemini。用户明确授权真实 Gemini 验证后，设置 `PI_SDK_ROOT` 指向实际 Pi SDK 并运行 `npm run smoke`，验证常驻角色、单一通用入口、完整声明传入 CLI、产品设计与两轮完善、只读材料、精确 artifact、重开后续聊，以及 native stop 终止 agy。
