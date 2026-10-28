# 第三方来源与许可

本仓库的许可文件集中在根目录：`LICENSE` 适用于原创内容；本文件保存第三方来源、版权声明、适用范围和完整许可正文。第三方内容不因此改为本仓库的 MIT 许可。

拆出技能、扩展或素材单独分发时，也须携带其适用的版权声明和许可正文。依赖管理器下载的包遵循包内声明，不在这里重复收录。

## 来源与适用范围

| 范围 | 来源 | 许可 |
|---|---|---|
| `packages/inline-skill-completion/` | [CNife/pi-extensions](https://github.com/CNife/pi-extensions)，本地改造来自 [stoneedle fork](https://github.com/stoneedle/pi-extensions) | MIT |
| `packages/pi-subagents/` | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)，包含本地改造 | MIT |
| `packages/pi-web/` | [ygncode/pi-web](https://github.com/ygncode/pi-web)，包含本地改造 | MIT |
| `packages/pi-web/.pi/extensions/lib/title/` | [t0mj/pi-title-glyphs](https://github.com/t0mj/pi-title-glyphs)，作为 Pi Web 内部模块维护 | MIT |
| 下列 Matt Pocock 技能 | [mattpocock/skills](https://github.com/mattpocock/skills)，包含本地修改 | MIT |
| `skills/archify/` 的自有代码和内容 | [tt-a1i/archify](https://github.com/tt-a1i/archify) | MIT |
| Archify 字体和品牌标记 | 见下方素材声明 | OFL-1.1 及各素材独立条款 |

Matt Pocock 技能的范围是：`skills/pr/`、`skills/prototype/`、`skills/research/`、`skills/wizard/`、`skills/writing-for-agents/`。

## MIT 版权声明与许可正文

以下版权声明分别适用于表中范围；每项声明与本节完整 MIT 正文共同构成对应内容的许可通知。

| 范围 | 保留的版权声明 |
|---|---|
| `packages/inline-skill-completion/` | Copyright (c) 2025 CNife |
| `packages/pi-subagents/` | Copyright (c) 2026 Nico Bailon |
| `packages/pi-web/`，除标题模块 | Copyright (c) 2026 Set Kyar Wa Lar (YGNCode) |
| `packages/pi-web/.pi/extensions/lib/title/` | Copyright (c) 2026 t0mj |
| 上列 Matt Pocock 技能 | Copyright (c) 2026 Matt Pocock |
| `skills/archify/` 的自有代码和内容 | Copyright (c) 2026 tt-a1i (Archify)<br>Copyright (c) 2025 Cocoon AI |

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Archify 素材声明

### Archify 原始素材声明

Archify includes optional vector data for third-party brand marks. These marks
are provided only to identify technologies and services in user-authored
diagrams. Their inclusion does not imply sponsorship, endorsement, partnership,
or affiliation with Archify.

The Archify MIT license applies to Archify's own code and content. It does not
replace the copyright licenses, trademark policies, or brand guidelines that
apply to third-party marks. Users are responsible for confirming that their
particular use is permitted.

## Simple Icons

Most of the built-in vector paths and their metadata were generated from
[Simple Icons 16.28.0](https://github.com/simple-icons/simple-icons/tree/16.28.0).
Simple Icons makes its collection work available under
[CC0 1.0 Universal](https://github.com/simple-icons/simple-icons/blob/16.28.0/LICENSE.md).

As Simple Icons explains in its
[disclaimer](https://github.com/simple-icons/simple-icons/blob/16.28.0/DISCLAIMER.md),
CC0 for the collection does not mean that every underlying icon is CC0. License
and brand-guideline metadata may be incomplete or change over time. The absence
of an individual license entry is not a grant of permission.

Archify embeds the selected icons as vector-path data and may render them in a
user-selected color. The following individual licenses were recorded in the
pinned Simple Icons 16.28.0 metadata:

| Mark | Recorded source | Recorded license | Archify treatment |
|---|---|---|---|
| Angular | [Angular press kit](https://angular.dev/press-kit) | [`CC-BY-4.0`](https://creativecommons.org/licenses/by/4.0/) | Embedded as vector-path data; color may be changed by the authored diagram. |
| Apache Airflow | [Apache logos](https://apache.org/logos) | [`Apache-2.0`](https://www.apache.org/licenses/LICENSE-2.0) | Embedded as vector-path data; Apache trademarks remain subject to the [ASF trademark policy](https://www.apache.org/foundation/marks/). |
| Apache Kafka | [Apache logos](https://apache.org/logos) | [`Apache-2.0`](https://www.apache.org/licenses/LICENSE-2.0) | Embedded as vector-path data; Apache trademarks remain subject to the [ASF trademark policy](https://www.apache.org/foundation/marks/). |
| .NET | [.NET brand repository](https://github.com/dotnet/brand/blob/c7d0f51b8ec59531332d05fb27a5b758a7a3d689/logo/dotnet-logo.svg) | [`CC0-1.0`](https://creativecommons.org/publicdomain/zero/1.0/) | Embedded as vector-path data; color may be changed by the authored diagram. |
| JavaScript | [JS community logo](https://github.com/voodootikigod/logo.js/blob/1544bdeed6d618a6cfe4f0650d04ab8d9cfa76d9/js.svg) | [`MIT`](https://github.com/voodootikigod/logo.js/blob/1544bdeed6d618a6cfe4f0650d04ab8d9cfa76d9/LICENSE) | Embedded as vector-path data; color may be changed by the authored diagram. |
| Jenkins | [Jenkins artwork source](https://get.jenkins.io/art/) | [`CC-BY-SA-3.0`](https://creativecommons.org/licenses/by-sa/3.0/) | Embedded as vector-path data; color may be changed by the authored diagram. Jenkins retains its trademark rights. |
| Rust | [Rust project](https://www.rust-lang.org) | [`CC-BY-SA-4.0`](https://creativecommons.org/licenses/by-sa/4.0/) | Embedded as vector-path data; color may be changed by the authored diagram. See the [Rust media guide](https://www.rust-lang.org/policies/media-guide). |
| Vue.js | [Vue logo source](https://github.com/vuejs/art/blob/a1c78b74569b70a25300925b4eacfefcc143b8f6/logo.svg) | [`CC-BY-NC-SA-4.0`](https://creativecommons.org/licenses/by-nc-sa/4.0/) | Embedded as vector-path data; color may be changed by the authored diagram. The non-commercial and share-alike conditions remain applicable; see the [Vue artwork terms](https://github.com/vuejs/art/blob/a1c78b74569b70a25300925b4eacfefcc143b8f6/README.md). |

The source, guideline, and known license fields for every packaged mark are
preserved in `skills/archify/renderers/shared/generated-brand-marks.mjs`.

## OpenAI mark

The OpenAI vector path is recorded from the
[OpenAI brand guidelines](https://openai.com/brand/), not from Simple Icons.
Use remains subject to those current guidelines and any applicable trademark
rights. Its inclusion does not state or imply endorsement by OpenAI.

## JetBrains Mono

Delivered Archify viewer artifacts embed the JetBrains Mono variable font
subsets served by Google Fonts. For characters covered by these subsets, font
selection does not depend on a network request or a locally installed copy.
Uncovered characters (including CJK) still use the system fallback stack;
browser and operating-system rasterization can differ.
JetBrains Mono is maintained at
[github.com/JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono)
and is distributed under the SIL Open Font License 1.1. The complete license
text is preserved in the SIL Open Font License 1.1 section of this root notice
and in the font CSS carried by standalone HTML and SVG exports.

## No additional rights granted

Brand names, logos, and trademarks remain the property of their respective
owners. This notice records provenance and known terms; it does not grant rights
that Archify does not hold, and it does not state that every packaged mark has
been cleared for every commercial, promotional, or redistributive use.

## SIL Open Font License 1.1 — JetBrains Mono

```text
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## 外部依赖与本地集成

- `pi-web-access`、`pi-compact-transcript`、`pi-goal`：MIT；本仓库仅提供安装来源，不复制这些包。
- `pi-codex-image-gen`：Apache-2.0；原包另有 NOTICE 和 OpenAI Codex 衍生文件声明，本仓库不复制该包。
- `@calesennett/pi-codex-fast`：未发现上游声明许可证，本仓库不收录该插件原版源码。自写快捷键位于 `extensions/codex-fast-shortcut.ts`，已安装版本的会话接口适配脚本位于 `packages/pi-web/scripts/enable-fast-state.mjs`。提供链接和集成代码不代表获得上游再分发授权。
