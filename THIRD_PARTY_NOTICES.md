# 第三方来源与许可

根目录 MIT 许可证适用于本仓库原创部分，不覆盖或替换下列第三方许可。初次收录以本机现有文件为准，没有用上游最新版本覆盖本机内容；技能来源与已有安装哈希记录在 `config/sources.json`。后续修改第三方文件应保留其声明；Apache-2.0 文件有实质修改时，应标明修改。

## 已收录源码与技能

| 范围 | 来源及版权 | 许可与随附声明 |
|---|---|---|
| `packages/inline-skill-completion` | [CNife/pi-extensions](https://github.com/CNife/pi-extensions)，Copyright 2025 CNife；本地改造来源为 stoneedle fork | 目录内 `LICENSE`，MIT |
| Matt Pocock 技能组 | [mattpocock/skills](https://github.com/mattpocock/skills)，Copyright 2026 Matt Pocock | 各技能内 `LICENSE`，MIT；原文另存 `licenses/mattpocock-MIT.txt` |
| `skills/find-skills` | [vercel-labs/skills](https://github.com/vercel-labs/skills)，Copyright 2026 Vercel, Inc. | 目录内 `LICENSE`，MIT |
| `skills/impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable)，本地技能标注版本 4.7.0 | 目录内 `LICENSE`，Apache-2.0 |
| `skills/impeccable/scripts/modern-screenshot.umd.js` | [qq15725/modern-screenshot](https://github.com/qq15725/modern-screenshot)，Copyright 2021-present wxm | 相邻 `modern-screenshot.LICENSE`，MIT |
| `skills/archify` | [tt-a1i/archify](https://github.com/tt-a1i/archify)，Copyright 2026 tt-a1i、2025 Cocoon AI | 目录内 MIT `LICENSE`、`THIRD_PARTY_NOTICES.md`、`assets/JetBrainsMono-OFL.txt` |

Matt Pocock 技能组是 `config/sources.json` 中来源为 `mattpocock/skills` 的技能。其原安装目录没有完整许可证，本次按上游许可补齐，正文和附属文件保持本机版本。`impeccable` 和 `find-skills` 同样补齐了上游许可证。来源清单中的哈希是原安装器记录，不声明当前整个技能目录未经改动。

Archify 内含字体和第三方品牌标记，已保留原有声明及来源信息。其中部分标记有 CC-BY、CC-BY-SA、CC-BY-NC-SA 等独立条款，品牌商标权也不因代码开源而转移；不能将这些素材统一当作 MIT 或无条件商用资源。

本次整理中，代理 `luna` 原有用户名相关绝对路径改为 `{{agentDir}}` 部署模板；部署时恢复为目标 PC 的实际路径。追加系统提示词初次收录未改写。

## 仅引用的依赖

具体来源和版本以 `config/packages.json` 为准，不在本仓库复制这些 npm 包及其 `node_modules`。

- `pi-web-access`、`pi-subagents`、`pi-compact-transcript`、`pi-goal`：已核对安装包中的 MIT 许可。
- `pi-codex-image-gen`：Apache-2.0，上游安装包包含 `LICENSE`、`NOTICE` 和 OpenAI Codex 衍生文件声明；将来复制源码时须一并保留。
- `pi-web`：MIT，原版权声明为 Copyright 2026 Set Kyar Wa Lar (YGNCode)；以独立 Git 仓库引用，不复制工作区或其私有运行状态。
- `@calesennett/pi-codex-fast`：目前未发现上游许可证，仅提供用户自行从 npm 安装的引用。原版源码、本机改造及补丁均未收录；不能据此推定获得再分发授权。

各依赖及其传递依赖的许可证由原安装包携带。此清单是已收录内容的来源说明，不代表替所有第三方代码、商标或素材授予额外权利。
