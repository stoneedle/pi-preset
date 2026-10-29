# 子代理：模型档案与技能接入

## 选择执行者

先确定本次职责，再从已发现的档案选择执行者。`scout`、`researcher`、`worker`、`implementer`、`merger`、`reviewer`、`oracle`、`advisor` 等通用称谓表示任务职责，不作为本机可执行 agent 名。实际名称以工具广告或 `subagent({ action: "list" })` 为准；已有广告足够时无需重复列举。

原生档案以模型族命名，可在不同任务中兼任多职。以下是默认分工，不是模型能力排名或职责上限；精确模型、思考等级、工具和继承策略以 [agents/](../agents/) 的档案为准。

| 档案 | 优先分配的工作 |
|---|---|
| `luna` | 快速检索、代码探索、资料研究、日志归并、明确判据的事实核查和轻量执行 |
| `terra` | Computer Use、真实界面验收、截图与图像结果评估、前端小步微调；也做常规实现、规格核对和独立评审 |
| `sol` | 复杂实现、调试、重构、跨模块方案、集成与合并；也可独立评审 |
| `astra` | 复杂推理、架构取舍、深度代码审阅、关键证据核查和独立咨询；必要时在任务授权内验证或实施关键改动 |

选档案后使用其默认模型与思考等级，不为切换职责再覆盖模型。用户明确指定模型时，核对注册表中的完整名称及所需工具；续接已有工作沿用保存的模型。

档案的工具能力不是操作授权。只读工作在 task 中明确只读及允许的采证方式；实施、命令、设备、验证及研究笔记写入按本次授权执行，不因档案名称固定成只读或写入角色。同一个档案可以服务多种职责，但独立评审使用新的 fresh 会话，不让实现者续接自己的线程充当独立审阅者。

## 现有技能的接入

技能规定要完成的工作、证据、独立性与交付；本文件规定本机执行者与调用方式。技能中的前台、脚本、角色名称等 harness 示例按本机接入执行，不照搬为调用参数。固定上游文件保持原样。

| 技能或流程 | 本机分配 |
|---|---|
| `grilling` 的事实调查、`improve-codebase-architecture` 的探索 | `luna` 调查；需要复杂归因或边界判断时选 `astra` |
| `research`、`wayfinder` 的研究 | `luna` 完成研究与笔记；关键结论可按任务要求由 `astra` 核查。子代理直接完成研究契约，不再次启动研究子代理 |
| `implement-spec` 的 exploration / implementer / merger / fixes | 探索按上述分工；常规实现、界面操作和前端小步调优优先 `terra`，复杂实现与集成优先 `sol`；合并在独立交接与授权边界内进行 |
| `code-review` 的 Standards / Spec 两轴 | 默认 `astra` 审规范与结构，`terra` 审需求和实际行为；两个 fresh 会话，保留两轴的只读与报告契约，验证操作另按任务授权 |
| `codebase-design` 的 Design It Twice | 从 `astra`、`sol`、`terra` 分配至少三个不同约束的独立方案；通过批次排队遵守并发配置 |
| `council-mode` / `/council` | 按问题选择两个或三个不同模型档案，task 明确只读；不另外创建 council 专用副本。用户指定名单时核对当前可执行档案 |
| Impeccable 的 documenter / asset-producer / finish-reviewer | 保留 `impeccable-documenter`、`impeccable-asset-producer`、`impeccable-finish-reviewer`，分别承载独立技能契约；按 [Impeccable 接入说明](impeccable-agents.md) 交接 |
| 产品设计主创或用户明确邀请 Gemini | 保留 `designer` 与运行时 `gemini` 的外部执行及创作契约；按系统提示中的授权与协作入口执行 |

没有要求委派的技能不因这张表而增加子代理。任务范围、写入、测试、提交、发布和外部服务授权仍由用户及项目规则决定。

## 本机调用方式

原生委派默认后台、fresh；运行配置在 [plugin-config/subagent.json](../plugin-config/subagent.json)。单任务直接调用，通常只需 agent、task、cwd：

```javascript
subagent({
  agent: "sol",
  task: "<目标、有效决定、材料入口、写入与验证授权、验收及停止条件>",
  cwd: "<工作目录>",
  async: true,
})
```

多个任务需要各自的 cwd、worktree 或其他选项时，分别直接启动并遵守活动容量；同一工作目录和公共选项下的独立任务可用 `tasks: [{agent, task}, ...]` 一次提交。`chain` 用于事先确定的顺序步骤。两者的子项只用当前 schema 展示的字段，不给子项附加模型、上下文或标签等字段。批次数和同时运行数是不同限制，较大的只读批次按配置排队；一个 cwd/worktree 只安排一个写入者。

上游所谓“前台收齐再汇总”在本机仍以后台启动、原生完成通知和最终汇总达成。确实需要阻塞且执行器支持时才显式 `async:false`；外部执行器遵循自己的协议。本机启用的是直接调用、tasks 与 chain，使用这些入口，不发送工作流脚本或未启用功能的参数。

默认值已在配置与档案中提供，常规调用省略 options。需要扩展参数或管理动作时，先查当前 schema 或 `subagent({action:"guide",options:{topic:"tool-reference"}})`；只读职责写在 task 中，工具选择写在档案中，不发明只读或进度开关。

有独立工作就继续；没有就交回控制，等原生通知，不轮询或为原生子代理调用 bg_wait。完成后读取通知所指的保存产物，核对实际证据；启动回执不是任务完成或工具接线已验证。

## 续接与失败

对已完成任务追加同范围工作，用最新的子任务 runId：

```javascript
subagent({ action: "resume", id: "<最新 child runId>", message: "<后续目标与边界>" })
```

resume 不重选 agent 或 model。运行中的补充使用该子任务 ID 的 steer；工作流 ID 不替代其中的子任务 ID。控制动作的其他字段先查当前指南。

参数错误按 schema 或明确错误信息纠正，不靠连续猜字段。启动、扩展装载、运行时或工具接线失败时，停止该分支，报告原始错误、runId、已有改动和阻塞；不要把外层后台回执当成子任务已经可用，也不自行切换 CLI、执行器或模型掩盖故障。仅在已有证据和授权支持时选择下一步。
