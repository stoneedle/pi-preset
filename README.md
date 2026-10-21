# pi-web

个人自用的 Pi 手机远程界面，只支持中文。手机与电脑控制同一个原生 Pi 会话，不另建工作区或聊天记录。

## 日常使用

- 按项目文件夹分组浏览、搜索会话，支持展开和收起；阅读完整回复，按需展开紧凑的思考、工具和图片。左上角抽屉可切换会话，收起后保留当前草稿与阅读位置，进入对话后同步已读状态。
- 发送文字或图片，固定作为当前任务的引导，不提供下一轮投递；输入框随换行与自动折行增高，长草稿在框内滚动，发送和停止控件始终可达。原生终端对话框仍在电脑处理。
- 弱网时保留已加载内容，抽屉预加载且持续更新；同页切换会话，返回已访问会话先显示内存内容与草稿，再增量同步。读取自动重试，发送不会自动重放。
- 查看项目、分支、上下文、缓存命中、模型、思考等级和原生 Fast 状态；状态不确定时明确显示未知。
- 下载原文件，隔离预览 HTML、Markdown 和相对资源。
- 切换自己的其他主机，各自主机的会话与登录保持独立。
- 在支持的浏览器中启用中文通知。通知只包含主机、会话和状态，不包含回复正文；推送服务接受不等于手机已收到。

会话内容、文件、模型名称和底层错误保留原文，不做自动翻译。界面不含语言选择、语言包或自定义翻译。

## 安装与更新

需要 Pi 1.3.0+、Node.js 22.19+、Go 1.26+、Git 和 GNU Make。Windows 使用 Git Bash；GNU Make 不在 PATH 时，通过 `MAKE` 指定它的路径。远程访问使用已有的 Tailscale。

在本仓库目录执行：

```bash
npm ci --ignore-scripts
pi install .
node scripts/run-lifecycle.mjs install
```

安装入口会先构建前端和 Go 程序，再安装对应平台的程序与登录启动配置。默认地址是 `http://127.0.0.1:31415`。

更新已有安装并保留启动配置：

```bash
PI_WEB_INPLACE_UPDATE=1 node scripts/run-lifecycle.mjs install
```

随后在 Pi 中执行 `/pi-web restart`。扩展代码有变化时，对已打开的 Pi 实例执行 `/reload`。不需要为重启编写额外脚本；代理也可以复用现有平台启动入口自主重启。

| Pi 命令 | 用途 |
| --- | --- |
| `/web` | 打开当前会话 |
| `/remote` | 显示 Tailscale HTTPS 地址和二维码 |
| `/pi-web status` | 查看服务状态和地址 |
| `/pi-web start`、`stop`、`restart` | 管理当前服务 |
| `/pi-web token`、`set-token` | 查看或设置访问令牌 |

远程访问前，在 `~/.config/pi-web/env` 中设置稳定的 `PI_WEB_TOKEN`，然后重启服务。保持令牌不变即可保留浏览器登录。iPhone/iPad 通知需要通过主屏幕 PWA 打开，并使用 HTTPS；真机后台和锁屏接收仍需实际检查。

## 数据与边界

- 原生历史：`~/.pi/agent/sessions/`，由 Pi 写入。
- 共享确认、外观和推送数据：`~/.pi/agent/pi-web.sqlite`。
- 运行地址与锁：`~/.pi/agent/pi-web/pi-web-state.json`。
- 登录与启动环境：`~/.config/pi-web/`。
- 原生命名配置：`~/.pi/agent/extension-data/pi-title-glyphs/config.json`。
- 项目记忆：`~/.pi/agent/pi-web-memory.sqlite`，使用随包安装的 `memory` 技能。

`PI_CODING_AGENT_DIR` 可以指定独立的 Pi 数据目录。浏览历史不会启动执行器；只有明确新建或继续未连接会话时才创建后台 worker。同一会话最多一个 worker，不能与已有终端竞争执行权。

Fast 是原生模式拥有者提供的只读状态，不根据设置或页脚猜测。当前本地接口的维护入口是 `node scripts/enable-fast-state.mjs`；只有需要安装该接口时才使用 `--apply`，未知源码版本会拒绝修改。

## 开发与验证

```bash
make build       # 先构建前端，再构建嵌入它的 Go 程序
make test        # 前端、扩展、记忆、Go 和安装器测试
make check       # lint、格式、knip、测试、前端构建和 vet
make e2e-setup   # 首次安装浏览器测试依赖
make e2e         # 原生集成和七组浏览器/设备模拟
```

不能只运行 `go build`：程序嵌入的是当前 `web/dist`。测试使用独立临时数据和进程，不接管日常浏览器、服务或会话。

实现约束见 [AGENTS.md](AGENTS.md)，模块职责见 [架构](docs/architecture.md)，测试入口见 [测试](docs/testing.md)。不再维护文档站、营销页面、公开发布流程或多语言副本。
