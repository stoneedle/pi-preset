# 我的 Pi 定制

两台 Windows 共用一套 Pi 定制：仓库保存自制与修改过的内容，原版技能和插件固定引用上游。Git 通过 HTTPS 传递变更，Pi 直接使用仓库本体，不另做文件同步。

## 来源与入口

| 内容 | 权威来源 |
|---|---|
| 系统提示词 | [APPEND_SYSTEM.md](APPEND_SYSTEM.md) |
| Pi 偏好、模型与插件安装声明 | [settings.json](settings.json) |
| 原生快捷键 | [keybindings.json](keybindings.json) |
| 角色、参考约定 | [agents/](agents/)、[references/](references/) |
| 自制／修改过的技能 | [skills/](skills/) |
| 单文件扩展、完整插件源码 | [extensions/](extensions/)、[packages/](packages/) |
| 插件的共享偏好 | [plugin-config/](plugin-config/) |
| 链接关系、原版技能来源与 commit | [preset.json](preset.json) |

本地维护版本保留可直接运行的完整组件，不在安装时重新拼装零散改动。原创内容使用 [LICENSE](LICENSE)；收录的第三方内容遵循 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。上游安装目录不属于本仓库。

## 首次安装

需要 Node.js 22.19+、Pi、Git for Windows、Go 1.26+、GNU Make，并加入 PATH。Gemini 协作另需自行安装、登录 agy CLI。账号、Chrome/MCP 服务、代理和远程访问均由各电脑自己配置。

在 PowerShell 执行：

```powershell
git clone https://github.com/stoneedle/pi-preset.git "$HOME\.pi\preset"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\.pi\preset\setup.ps1"
```

脚本先在普通权限下准备上游和依赖，再连接 Pi 用户目录；创建文件符号链接需要时会请求一次管理员确认。只有链接步骤提升权限，下载、依赖安装和 Pi Web 构建不以管理员身份运行。

已有 Pi 配置时先合并独有改动。脚本遇到与仓库不同的文件或目录会停止，不覆盖它们；也不会删除账号、历史记录或运行数据。初始化后重启 Pi，或执行 `/reload`。

## 文件实际在哪里

```text
~/.pi/
├─ preset/       Git 仓库：个人定制本体
├─ upstreams/    按 preset.json 固定 commit 下载的原版技能
└─ agent/        Pi 用户目录
   ├─ 共享配置、角色、参考约定、定制技能 → 链接到 preset
   └─ 凭证、会话、npm 安装树、MCP、数据库、缓存等本机内容
```

Pi 从共享设置直接加载 `preset/extensions` 和本地包；`agent/extensions` 留给插件的本机运行文件，不整体接入 Git。共享设置排除 `~/.agents/skills` 中由本合集管理的同名副本，以及 Codex 专属技能；其他本机技能和工具自带入口保持原样，不因此进入仓库。项目技能仍按 Pi 的项目信任规则加载。

## 日常修改

- 提示词、角色、定制技能和共享偏好：编辑仓库文件，或编辑 Pi 对应的链接路径。
- 自制单文件扩展：放入 `extensions/`；完整插件：放入 `packages/` 并在 `settings.json` 登记本地路径。
- 原版插件：使用 `pi install npm:包名@版本`；声明直接写回仓库中的设置。
- 原版技能：修改 `preset.json` 的上游 commit 和所选目录，再运行 `setup.ps1`。
- 开始修改某个原版组件时：先将它纳入本地维护目录，替换原版加载声明，只保留一个加载来源。

一端提交并推送，另一端拉取：

```powershell
git -C "$HOME\.pi\preset" pull --ff-only
```

仅修改文本或 TypeScript 扩展后执行 `/reload`。安装声明、依赖锁或上游索引变化后重跑 `setup.ps1`；它也会从当前源码构建并安装 Pi Web。Git 不传递依赖安装树或编译产物，也不自动解决两端的 Git 冲突。

## 子代理工具

公共扩展加载由 `settings.json` 的 `subagents.defaultExtensions` 管理；角色工具名单由 `agents/` 管理。原生角色按名单使用公共能力，不加载整套主会话扩展。`implementer`、`luna` 可操作本地文件与命令，`advisor` 保持本地只读；三者均可检索、操作浏览器及联系主代理。工具可用不等于获得超出任务范围的操作授权，也不构成系统级沙箱。

Chrome DevTools 按整个 `chrome-devtools` MCP 服务选择，不固定工具数量；每台电脑仍自行配置该服务。当前子代理将选中工具直接暴露，`tool_search` 不会自动将其转为延迟加载。浏览器操作沿用 `APPEND_SYSTEM.md` 中的约定。数据库、嵌套委派、Goal、图像生成及其他提供者由具体任务另行配置，工具名单不改变项目规则和技能的继承策略。

Impeccable 的三个角色由 `extensions/impeccable-agents.ts` 按需注册，契约直接读取已安装的上游技能，不增加常驻广告。documenter 与 asset-producer 使用共享设置中的模型覆盖；finish-reviewer 通过 agy 执行。它们只加载各自所需工具，权限与材料交接见[接入说明](references/impeccable-agents.md)。

修改后在主会话执行 `/reload`，新启动的子代理使用新配置；已运行的子代理不自动换配置。

## Fast 与手机速度控制

`extensions/codex-fast-shortcut.ts` 提供 Alt+Shift+F，并处理 Windows Tabby 的按键编码。

Fast 仍按共享设置从 npm 安装，不在这里分发完整源码。Pi Web 需要的本地适配由 `packages/pi-web/scripts/enable-fast-state.mjs` 维护，初始化时应用：

- 向网页提供当前速度、可用速度与切换接口。
- 将选择记录在当前 Pi 会话中，恢复会话时恢复速度。
- 网页切换不改其他会话的速度，也不写全局默认值。
- 不改变上游模型支持名单和 Fast／Ultrafast 服务档位。

Pi Web 的服务、构建、更新和数据边界见 [包说明](packages/pi-web/README.md)；Gemini 协作见 [适配器说明](packages/agy-gemini/README.md)。

## 验证

```powershell
npm test
node scripts/setup.mjs check
```

测试在系统临时目录验证真实链接读写、Pi 设置持久化、原版技能的固定版本与资源发现。子代理工具验收使用真实 Pi SDK、实际联网扩展及隔离的 MCP 替身，覆盖角色工具可用性、codemode 调用、数据库隔离、advisor 本地只读与 bash 超时检查；不会调用模型或接触真实账号、会话。文件符号链接测试在权限不足时明确跳过，可在有权限的终端复验。

仓库不保存公司项目专属内容、凭证、会话、数据库、缓存和机器配置。外部工具自带的技能保持其工具自身的安装责任，不复制进本仓库。
