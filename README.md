# Pi Preset

我的 Pi 日常工作配置：追加系统提示词、自写扩展、技能、代理角色，以及第三方插件的固定版本清单。用于自己在两台 PC 间同步，也供他人阅读、取用和改造。

这是通过 Git 管理并部署到 Pi 用户目录的 preset，不是把整个 `~/.pi` 打包，也不使用 `pi install` 安装本仓库。

## 收录范围

- `APPEND_SYSTEM.md`：现用追加系统提示词，初次收录保留原文。
- `extensions/`：`agy-gemini`、bash 超时单位检查、Codex Fast 快捷键。
- `skills/`：30 个现用技能及其脚本、参考资料、素材和许可证。
- `agents/`、`references/`：自定义代理角色和协作约定。
- `packages/inline-skill-completion/`：已改造的行内技能补全，保留上游 MIT。
- `config/settings.json`：明确选出的共享设置，不含登录信息和机器路径。
- `config/packages.json`：第三方插件的固定来源。已有独立开发仓库的 `pi-web` 以固定 Git 提交引用，不复制整个项目。
- `config/sources.json`、[第三方声明](THIRD_PARTY_NOTICES.md)：技能和改造代码的来源。

不收录 agy 技能、whiteboard、Hussar 技能、项目 memory、其他工具的符号链接技能，以及登录凭据、MCP 连接配置、会话、数据库、缓存、运行产物和 `node_modules`。`agy-gemini` 仍需要机器上另行安装并登录 **agy CLI**；排除的是 agy 技能，不是这个运行依赖。

## 首次使用

需要 Node.js 24+、npm、Git，以及已安装的 Pi（本次整理基于 Pi 1.4.0）。模型名称是个人配置，使用者应按自己实际可用的模型调整共享设置和代理定义。Chrome DevTools 等 MCP 工具的连接配置和登录态由各机器自己维护。

```sh
git clone <本仓库地址>
cd pi-preset
npm run status
npm run setup
```

仓库本身没有 npm 运行依赖，无需先在根目录执行 `npm install`。`setup` 会应用受管文件、合并共享设置，安装清单中的第三方 Pi 包和 `agy-gemini` 依赖。安装过程需要网络，不会调用模型或产生 Gemini 请求。

如果本机已有不同内容的同名文件，命令会在写入前停下，列出冲突。先核对 `npm run status`；希望保留本机内容时运行 `npm run capture` 并检查 `git diff`。确定使用仓库版本后才运行：

```sh
npm run apply -- --overwrite
npm run setup
```

完成后重新启动 Pi 或 `/reload`。不在已有运行任务中自动重载或重启 Pi。

### 本机开发仓库

自己开发 `pi-web` 时，将 `config/machine.example.json` 复制为 `config/machine.local.json`，填写这台 PC 上的真实路径。这个文件被 Git 忽略，两台机器可以使用不同盘符或用户名。

`setup` 不安装、构建或重启这些本机开发仓库。`pi-web` 的源码、未提交改动、服务安装与部署仍在它自己的 Git 仓库管理；preset 只保存引用。另一台 PC 需要在那个仓库提交、推送、拉取代码，而不是依赖 preset 带走未提交工作。

没有本机覆盖时，使用共享清单中的固定 Git 提交。首次整理时 `pi-web` 有未提交改动，因此这个引用不等同于当时整个工作区的最新内容。

## 两台 PC 的日常同步

**优先直接修改本仓库，让 Git 保存配置的权威版本。**

PC A：

```sh
# 修改提示词、扩展、技能或共享设置
npm test
npm run apply
git add .
git commit -m "调整我的 Pi 配置"
git push
```

PC B：

```sh
git pull --ff-only
npm run setup
```

若在 Pi 用户目录中直接改过已经收录的文件，先 `npm run capture` 将这些改动采回仓库，再检查 `git diff`。`capture` 只读取明确列入 `config/resources.json` 的文件及共享设置中的字段，不扫描整个个人目录，不采集凭据、未声明文件或包安装目录。包版本和来源变更直接修改 `config/packages.json`；新收录资源需加入 `config/resources.json`。

管理入口：

| 命令 | 行为 |
|---|---|
| `npm run status` | 只读预览文件差异和设置合并 |
| `npm run apply` | 应用文件和设置，不联网安装依赖 |
| `npm run setup` | 应用配置并安装缺少或版本不同的依赖 |
| `npm run capture` | 采回已经受管的本机内容，不推断文件删除 |

共享设置按字段递归合并，其他设置和无关插件保留；同包版本更新保留已有资源筛选。以后删除受管文件，只删除本机登记且未被另行修改的那份，不清空整个目录。安装清单删掉某个包时，不自动卸载它；是否卸载由用户通过 `pi remove` 明确决定。

安装记录位于 Pi 用户目录的 `pi-preset-state.json`，不进入仓库。默认使用 `~/.pi/agent` 和 `~/.agents`，也支持 `PI_CODING_AGENT_DIR`。预览、应用和采集可通过 `--home <目录>` 或 `--agent-dir <目录>` 指向隔离目录。

## Codex Fast 的边界

本机 `@calesennett/pi-codex-fast` 有源码改动，但上游当前没有声明许可证。因此不收录它的原版源码、改造源码或补丁，只保留 npm 依赖引用和我们自己写的快捷键。

`setup` 遇到已经安装的同版本 npm 包时保留原目录，不会覆盖本机改造。新 PC 从 npm 安装的是上游发行版，**不会自动获得该插件的本机修改**。取得明确授权前，这部分不通过公开仓库同步。

## 验证

```sh
npm test
```

测试在系统临时目录模拟两台 PC，覆盖真实仓库 CLI 部署、重复应用、冲突拦截、采集、设置合并、路径替换、受管删除及私人文件保留，并用隔离的假包管理进程验证 setup 的调用和跳过规则；不会写入真实用户目录、安装第三方包或调用模型。

`agy-gemini` 的原有测试与烟测入口保留在其目录中。真实 Gemini 烟测需要单独明确授权，不属于 preset 同步测试。

## 许可证

原创配置、提示词和代码采用 [MIT](LICENSE)。第三方代码、技能、字体、品牌标记和其他素材遵循各自许可证与声明，根许可证不替代它们；详见 [第三方声明](THIRD_PARTY_NOTICES.md)。本仓库尚未自动发布到远端，公开前应检查自己的 Git 差异和文件清单。
