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
| 下列 Matt Pocock 技能 | [mattpocock/skills](https://github.com/mattpocock/skills)，保留本地使用版本 | MIT |
| `skills/find-skills/` | [vercel-labs/skills](https://github.com/vercel-labs/skills) | MIT |
| `skills/impeccable/`，除下列独立许可脚本 | [pbakaus/impeccable](https://github.com/pbakaus/impeccable)，技能标注版本 4.7.0 | Apache-2.0 |
| `skills/impeccable/scripts/modern-screenshot.umd.js` | [qq15725/modern-screenshot](https://github.com/qq15725/modern-screenshot) | MIT |
| `skills/archify/` 的自有代码和内容 | [tt-a1i/archify](https://github.com/tt-a1i/archify) | MIT |
| Archify 字体和品牌标记 | 见下方素材声明 | OFL-1.1 及各素材独立条款 |

Matt Pocock 技能的范围是：`skills/ask-matt/`、`skills/code-review/`、`skills/codebase-design/`、`skills/diagnosing-bugs/`、`skills/domain-modeling/`、`skills/grill-me/`、`skills/grill-with-docs/`、`skills/grilling/`、`skills/handoff/`、`skills/implement-spec/`、`skills/implement/`、`skills/improve-codebase-architecture/`、`skills/pr/`、`skills/prototype/`、`skills/research/`、`skills/retro/`、`skills/setup-matt-pocock-skills/`、`skills/tdd/`、`skills/teach/`、`skills/to-questionnaire/`、`skills/to-spec/`、`skills/to-tickets/`、`skills/triage/`、`skills/wait-what/`、`skills/wayfinder/`、`skills/wizard/`、`skills/writing-for-agents/`。

技能正文及辅助资源不声明与上游最新版本完全一致。`luna` 代理的个人绝对路径已改为用户目录写法。修改 Apache-2.0 内容时，仍应按其条款标明修改。

## MIT 版权声明与许可正文

以下版权声明分别适用于表中范围；每项声明与本节完整 MIT 正文共同构成对应内容的许可通知。

| 范围 | 保留的版权声明 |
|---|---|
| `packages/inline-skill-completion/` | Copyright (c) 2025 CNife |
| `packages/pi-subagents/` | Copyright (c) 2026 Nico Bailon |
| `packages/pi-web/`，除标题模块 | Copyright (c) 2026 Set Kyar Wa Lar (YGNCode) |
| `packages/pi-web/.pi/extensions/lib/title/` | Copyright (c) 2026 t0mj |
| 上列 Matt Pocock 技能 | Copyright (c) 2026 Matt Pocock |
| `skills/find-skills/` | Copyright (c) 2026 Vercel, Inc. |
| `skills/archify/` 的自有代码和内容 | Copyright (c) 2026 tt-a1i (Archify)<br>Copyright (c) 2025 Cocoon AI |
| `skills/impeccable/scripts/modern-screenshot.umd.js` | Copyright (c) 2021-present wxm |

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

## Apache License 2.0 — Impeccable

以下完整保留原许可及 Copyright 2025 Paul Bakaus 声明。

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to the Licensor for inclusion in the Work by the copyright
      owner or by an individual or Legal Entity authorized to submit on
      behalf of the copyright owner. For the purposes of this definition,
      "submitted" means any form of electronic, verbal, or written
      communication sent to the Licensor or its representatives, including
      but not limited to communication on electronic mailing lists, source
      code control systems, and issue tracking systems that are managed by,
      or on behalf of, the Licensor for the purpose of discussing and
      improving the Work, but excluding communication that is conspicuously
      marked or otherwise designated in writing by the copyright owner as
      "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2025 Paul Bakaus

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
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
