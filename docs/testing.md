# 测试

## 入口

```bash
make check       # 格式、lint、knip、前端/扩展/记忆/Go/安装器测试、前端构建、vet
make build       # 前端与嵌入它的 Go 程序
make e2e-setup   # 首次安装 Playwright 和三种浏览器
make e2e         # 构建、原生集成、生产前端浏览器矩阵
```

直接运行浏览器测试前先构建：

```bash
make build e2e-stub
cd e2e
npx playwright test --project="Mobile Chrome" --workers=1
npx playwright test --workers=2
```

测试不得启动、停止或清理用户日常服务与浏览器。修改代码后的实际部署使用已有安装/重启入口，与临时测试服务分开。

## 隔离与范围

`e2e/global-setup.ts` 每次在系统临时目录创建独立的 `PI_CODING_AGENT_DIR`，复制脱敏会话，在空闲回环端口启动生产二进制，并禁用测试实例的鉴权和 Tailscale 配置。地址通过该次 Playwright 进程的环境传给 worker，不共用 `server.json` 或固定会话目录，避免并行验证互相清理数据。需要鉴权的用例另启隔离实例。测试会关闭自己的进程树、浏览器 Profile 和目录，不改提交的 fixtures。

浏览器矩阵使用 `lib/stub-pi/pi` 模拟确定性原生 RPC 提供方；Windows 的 `make e2e-stub` 生成对应启动程序。它写真实格式 JSONL，通过鉴权快照订阅提供状态，不创建活动心跳文件。静默运行保持连接，关闭套接字才产生未知状态。

| 项目 | 引擎 | 宽度 |
| --- | --- | --- |
| Desktop Chrome | Chromium | 1280 |
| Desktop Firefox | Firefox | 1280 |
| Desktop Safari | WebKit | 1280 |
| Mobile Chrome / Pixel 5 | Chromium | 393 |
| Mobile Safari / iPhone 13 | WebKit | 390 |
| iPad | WebKit | 810 |
| iPad landscape | WebKit | 约 1080 |

这是设备模拟，不等于真机或 Safari.app。维持真实窄屏配置；工具行另检查 360px、320px 和实际设备宽度。键盘通过缩小 visual viewport 而不改变布局宽度模拟，仍需实际设备确认 OS 键盘行为。

## 用例职责

- `blocks.spec.ts`：无边框内容流、无重复角色标签，中文思考与代码摘要、空签名记录过滤、原生块索引、状态图标、展开和键盘交互；过程行高度与正文层级，以及不再出现投递选择器。
- `mobile.spec.ts`：完整项目路径分组、同名文件夹隔离、折叠持久化、搜索展开、折叠项目未读提示；输入框随换行/自动折行增高、删除和发送后收缩，以及 320px 键盘高度限制；抽屉开关、焦点约束与恢复、当前会话高亮、草稿/附件/阅读位置保留、实时未读与被动切换，含 320px 和键盘缩小场景；固定中文，不受浏览器语言影响；七字段信息、长草稿、多图片、技能候选与发送/停止可达；大正文按需加载、完整长回复、历史锚点、分支重置、增量单飞、断线和迟到 HTTP 状态。
- `network.spec.ts`：原生空文本不白屏；抽屉保留内容和搜索、重开不等待网络；同源切换/返回不请求文档，断网时仍显示已读内容并恢复草稿，导航途中发送回执不丢失下一份草稿；连续临时错误与正文悬挂自动恢复；半开 SSE 重建且不伪造完成；发送失败不自动重放。
- `layout.spec.ts`：首页单行入口与全屏草稿、无近期会话的已有目录、发送前无会话／执行器副作用、首轮强度与速度设置、系统浅深色实时切换、320px 布局、项目固定排序与仅完成置顶、重连后的顺序恢复、模型设置浮层的真实控制结果；也覆盖迟到的默认值不覆盖显式选择、分页外项目未读和无文件变化的子任务完成。该文件禁用 Service Worker，确保 WebKit 网络门控能拦截请求；真实 Worker 行为由 `push.spec.ts` 独立验证。
- `control.spec.ts`：被动浏览不创建执行器，明确继续复用 worker，发送文字/图片、选择技能、修改思考、静默运行、停止、创建新会话、崩溃恢复，以及发送途中保留下一份草稿。
- `files.spec.ts`：原文件与图片字节、Unicode 文件名、HTML 相对模块/CSS/JSON、Markdown/GFM、预览能力撤销、符号链接限制与控制权限隔离。
- `hosts.spec.ts`：两个真实隔离 Go 服务分别登录，无预取或聚合，会话与 cookie 独立，书签正确传递。
- `push.spec.ts`：真实平台能力限制与受控订阅交互，中文通知无需上传模板，测试通知接受不冒充设备到达。Chromium 额外通过 DevTools 注入真实 Worker push 事件；其他引擎跳过该注入分支但保留能力/UI 用例。

## 原生集成

`make e2e` 在浏览器矩阵之前运行 `e2e/native/*.test.mjs`：

- `project-options.test.mjs`：真实 Pi 模型目录与项目配置读取、能力级别与目录浏览，不创建原生会话／worker、不泄露凭据、不改写用户设置。
- `background-worker.test.mjs`：真实已安装 Pi CLI，手机被动打开历史、明确继续、PID 复用与新建另一个原生进程。
- `process-lifecycle.test.mjs`：独立 OS Pi 进程、原生 SQLite 并发写、实际崩溃/重启、无执行器的历史确认、扩展重载和原生待处理对话框身份。
- `same-instance.test.mjs`：真实 SDK/资源加载器、唯一扩展入口、原生引导队列和持久化、鉴权 Go 与手机界面、图文投递、状态、共享确认、分支返回、原文件/图片、预览隔离和推送凭据。
- `push-worker.test.mjs`：生产 Worker 的持久去重、重排抑制、精确关闭、点击路由和无语言模板的续订。

模型适配器确定性且离线，不调用商业模型；原生进程、SDK、Go、SQLite 和生产界面都是真实的。`make check` 另运行 `tests/native/` 中的命名、生命周期、原生确认和会话速度设置协议测试；确认成功结算时间不会被已读或分支回访改写，速度变更不制造模型消息。

需要验证实际安装的子任务提供方时，显式传入本地包路径：

```bash
node e2e/integration/subagents.test.mjs /absolute/path/to/pi-subagents
```

它创建隔离的真实子进程与本地模型端点，检查重载、成功/失败终态、候选依赖与错误完成通知抑制，不读取个人模型配置。

实际 Fast 拥有者的独立集成入口：

```bash
node e2e/integration/fast.test.mjs /absolute/path/to/pi-codex-fast
```

使用隔离副本应用经过指纹验证的接口，检查标准→快速、各速度能力、两个真实原生会话的隔离、恢复后的选择、全局设置不变和无模型请求，不改测试所传包的源码。

## 长会话性能

```bash
node e2e/performance/long-session.mjs \
  --session /absolute/path/to/native.jsonl \
  --baseline /absolute/path/to/chinese-ui-baseline/pi-web \
  --output .dev/traffic-comparison.json
```

选择真实语料和同属中文界面的基线构建。工具验证原始语料哈希，在临时真实原生运行时中重放，并用独立鉴权 Go 服务、Profile、回环代理和窄屏进行比较。代理统计整个来源的响应字节，检查未点击的折叠正文/图片没有泄漏、普通正文保持完整，并覆盖空闲、更新突发、重连和历史追加。不报告私有正文或令牌，也不把本地 HTTP 测量当成物理手机/Tailscale 的结果。
