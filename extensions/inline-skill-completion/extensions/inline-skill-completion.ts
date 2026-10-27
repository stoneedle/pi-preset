import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ParsedSkillBlock,
  SkillInvocationMessageComponent,
  stripFrontmatter,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  Container,
  fuzzyFilter,
  Spacer,
} from "@earendil-works/pi-tui";

/**
 * Inline skill completion.
 *
 * 在正文空白后或后续行行首输入 `/` 时，补全已安装的技能（`/skill:<name>`）。
 * 消息开头 `/` 委托原生 slash 命令补全；非 `/` token 委托原生文件/路径补全。
 *
 * 选中后插入规范形式 `/skill:<name> `。
 *
 * 提交展开（多技能折叠渲染）：
 * pi 只展开「整段 text 以 /skill: 开头」的单技能（见 agent-session._expandSkillCommand），
 * 且 TUI 只对「单 skill 块 + 可选用户消息」整段匹配的消息渲染成原生折叠块（parseSkillBlock）。
 * 行中 /skill:xxx 与多 /skill:xxx 均不匹配，会退回普通文本。
 *
 * 本扩展改用**自定义消息渲染**绕开此限制：
 *   - input 事件里把所有 /skill:xxx token 全权展开成 skill blocks
 *   - 返回 action: "handled" 阻止 pi 创建普通 user 消息
 *   - 调用 pi.sendMessage 发 customType: "inline-skills" 的自定义消息
 *     （convertToLlm 会把 custom 消息转成 role: user，LLM 收到完整展开文本）
 *   - 注册 messageRenderer 渲染：每个 block → SkillInvocationMessageComponent，
 *     正文 → UserMessageComponent
 *
 * 展开规则（用户敲定）：
 *   - 所有 block 按出现顺序前置（空行连接成 expandedContent）
 *   - 行首第一个 token 连同其尾随分隔符一并删除
 *   - 其余 token 字面保留（维持句子通顺）
 *   - 其余文本原样保留
 */

/** 自定义消息的 details：预解析结果，供 renderer 直接使用。 */
interface InlineSkillsDetails {
  blocks: ParsedSkillBlock[];
  userMessage: string;
}

interface SkillCommand {
  name: string; // 裸技能名，如 "agent-browser"
  description?: string;
  filePath: string; // SKILL.md 绝对路径，用于内联展开
  baseDir: string; // 技能目录，用于 skillBlock 的 References 行
}

/** 消息开头保留原生命令；正文空白后和后续行行首只补技能，不接管路径。 */
function extractInlineSlashToken(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): string | null {
  const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
  const token = beforeCursor.match(/(?:^|\s)(\/[^\s/]*)$/u)?.[1];
  if (!token) return null;
  if (cursorLine === 0 && beforeCursor.slice(0, -token.length).trim() === "") {
    return null;
  }
  return token;
}

/** Pi 1.3 的私有接缝：公开的 triggerCharacters 明确排除了 `/`。 */
interface AutocompleteRequester {
  requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void;
}

class InlineSkillEditor extends CustomEditor {
  override handleInput(data: string): void {
    const before = this.getText();
    super.handleInput(data);
    if (before === this.getText() || this.isShowingAutocomplete()) return;

    const { line, col } = this.getCursor();
    if (extractInlineSlashToken(this.getLines(), line, col) === null) return;
    (this as unknown as AutocompleteRequester).requestAutocomplete({
      force: false,
      explicitTab: false,
    });
  }
}

/**
 * 读取技能 SKILL.md，构造与 pi _expandSkillCommand 逐字等价的 skill block 文本。
 * 复用 pi 导出的 stripFrontmatter 去掉 YAML frontmatter。
 * 同时返回结构化 ParsedSkillBlock 供 renderer 使用。
 */
function buildSkillBlock(
  skill: SkillCommand,
): { text: string; parsed: ParsedSkillBlock } | null {
  try {
    const content = readFileSync(skill.filePath, "utf-8");
    const body = stripFrontmatter(content).trim();
    const text = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    // parseSkillBlock 的 content 字段会去掉 References 行外层的包裹，
    // 但 SkillInvocationMessageComponent 期望的 content 是「References 行 + 空行 + body」
    // （与原生 _expandSkillCommand 产物一致）。这里直接构造，不经 parseSkillBlock 还原。
    const parsed: ParsedSkillBlock = {
      name: skill.name,
      location: skill.filePath,
      content: `References are relative to ${skill.baseDir}.\n\n${body}`,
      userMessage: undefined,
    };
    return { text, parsed };
  } catch {
    return null;
  }
}

interface ParseResult {
  /** 各技能的结构化块（给 renderer） */
  blocks: ParsedSkillBlock[];
  /** 展开 token 后剩余的用户正文（给 renderer 的 UserMessageComponent） */
  userMessage: string;
  /** 给 LLM 的完整展开文本（blocks 用空行连接 + 正文） */
  expandedContent: string;
}

/**
 * 解析提交文本中的所有 `/skill:xxx` token，展开成 skill blocks。
 *
 * 规则：
 *   - 所有 block 按出现顺序前置（空行连接）
 *   - 行首第一个 token 连同其尾随分隔符一并删除
 *   - 其余 token 字面保留（维持句子通顺）
 *   - 其余文本原样保留
 *
 * 无可展开 token（未找到 / 未知技能 / 读文件失败）时返回 null，调用方走原生路径。
 */
function parseInlineSkills(
  text: string,
  skills: SkillCommand[],
): ParseResult | null {
  // 匹配 /skill:<name>，name 为非空白非斜杠序列
  const tokenRe = /\/skill:([^\s/]+)/g;
  const matches: { index: number; name: string; end: number }[] = [];
  let m: RegExpExecArray | null;
  m = tokenRe.exec(text);
  while (m !== null) {
    matches.push({ index: m.index, name: m[1], end: m.index + m[0].length });
    m = tokenRe.exec(text);
  }

  if (matches.length === 0) return null;

  const byName = new Map(skills.map((s) => [s.name, s]));
  const blockTexts: string[] = [];
  const parsedBlocks: ParsedSkillBlock[] = [];
  let result = "";
  let cursor = 0;
  let firstHandled = false;

  for (const mt of matches) {
    const skill = byName.get(mt.name);
    if (!skill) continue; // 未知技能，原样保留 token

    const block = buildSkillBlock(skill);
    if (!block) continue; // 读文件失败，原样保留 token

    blockTexts.push(block.text);
    parsedBlocks.push(block.parsed);

    // 行首第一个成功展开的 token：连同其尾随分隔符（空格/制表符）一并删除
    if (!firstHandled && mt.index === 0) {
      let delEnd = mt.end;
      while (
        delEnd < text.length &&
        (text[delEnd] === " " || text[delEnd] === "\t")
      ) {
        delEnd++;
      }
      cursor = delEnd;
      firstHandled = true;
    }
    // 其余 token：保留字面，cursor 仅推进到 token 起点之前的文本
    // （result += text.slice(cursor) 在循环外统一处理）
  }

  if (parsedBlocks.length === 0) return null; // 全部失败，走原生

  result += text.slice(cursor);
  const userMessage = result.trim();
  const expandedContent =
    blockTexts.join("\n\n") + (result ? `\n${result}` : "");

  return { blocks: parsedBlocks, userMessage, expandedContent };
}

export default function (pi: ExtensionAPI) {
  let skills: SkillCommand[] = [];

  pi.on("session_start", (_event, ctx) => {
    // 快照已安装的技能命令（name 形如 "skill:agent-browser"）
    const commands = pi.getCommands();
    skills = commands
      .filter((c) => c.source === "skill")
      .map((c) => ({
        name: c.name.replace(/^skill:/, ""),
        description: c.description,
        filePath: c.sourceInfo.path,
        baseDir: c.sourceInfo.baseDir ?? dirname(c.sourceInfo.path),
      }));

    if (ctx.mode === "tui") {
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          new InlineSkillEditor(tui, theme, keybindings),
      );
    }

    // 叠加在原生补全之上：非 / 场景全部委托 current
    ctx.ui.addAutocompleteProvider(
      (current: AutocompleteProvider): AutocompleteProvider => ({
        async getSuggestions(
          lines: string[],
          cursorLine: number,
          cursorCol: number,
          options: { signal: AbortSignal; force?: boolean },
        ): Promise<AutocompleteSuggestions | null> {
          const token = extractInlineSlashToken(lines, cursorLine, cursorCol);

          // 消息开头 / 或非技能 token：委托原生（命令 / 文件 / 路径补全）
          if (token === null) {
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
          }

          const query = token.slice(1); // 去掉前导 /
          if (options.signal.aborted) {
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
          }

          const items: AutocompleteItem[] = skills.map((s) => ({
            value: s.name,
            label: s.name,
            ...(s.description && { description: s.description }),
          }));

          const filtered = fuzzyFilter(items, query, (i) => i.label).map(
            (i) => ({
              value: i.value,
              label: i.label,
              ...(i.description && { description: i.description }),
            }),
          );

          // 有匹配 → 返回技能候选；无匹配 → 委托原生（保持原生降级行为）
          if (filtered.length === 0) {
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
          }

          // 不带 `/`，让原生 Enter 只接受技能候选，不把正文当成命令提交。
          return { items: filtered, prefix: query };
        },

        applyCompletion(
          lines: string[],
          cursorLine: number,
          cursorCol: number,
          item: AutocompleteItem,
          prefix: string,
        ): { lines: string[]; cursorLine: number; cursorCol: number } {
          const currentLine = lines[cursorLine] ?? "";
          const token = extractInlineSlashToken(lines, cursorLine, cursorCol);

          // 原生路径补全的 prefix 带 `/`，不会误走技能插入。
          if (token !== null && token.slice(1) === prefix) {
            const before = currentLine.slice(0, cursorCol - token.length);
            const after = currentLine.slice(cursorCol);
            // 规范形式：/skill:<name> + 尾随空格
            const insertion = `/skill:${item.value} `;
            const newLine = `${before}${insertion}${after}`;
            return {
              lines: [
                ...lines.slice(0, cursorLine),
                newLine,
                ...lines.slice(cursorLine + 1),
              ],
              cursorLine,
              cursorCol: before.length + insertion.length,
            };
          }
          // 其余（行首命令、文件路径等）委托原生
          return current.applyCompletion(
            lines,
            cursorLine,
            cursorCol,
            item,
            prefix,
          );
        },

        shouldTriggerFileCompletion(
          lines: string[],
          cursorLine: number,
          cursorCol: number,
        ): boolean {
          // 文件补全（Tab）的触发判断完全交给原生
          return (
            current.shouldTriggerFileCompletion?.(
              lines,
              cursorLine,
              cursorCol,
            ) ?? true
          );
        },
      }),
    );

    // 提交时展开行中 /skill:xxx：拦截 input，发自定义消息并自定义渲染。
    // 见 parseInlineSkills 的规则说明。
    pi.on("input", async (event) => {
      const parsed = parseInlineSkills(event.text, skills);
      // 无可展开 token → 走原生（pi 创建普通 user 消息 + 原生展开/渲染）
      if (!parsed) return;

      const details: InlineSkillsDetails = {
        blocks: parsed.blocks,
        userMessage: parsed.userMessage,
      };

      // 发自定义消息：content 给 LLM（convertToLlm 转成 user role），
      // details 给 renderer。display:true 始终渲染。
      // 流式中按 streamingBehavior 选 deliverAs，否则 triggerTurn 触发 turn。
      // 必须 await：handled 返回前确保消息已入队/turn 已触发；
      // 失败则降级为 continue（让 pi 把原文当普通 user 消息），避免用户输入丢失。
      try {
        await pi.sendMessage(
          {
            customType: "inline-skills",
            content: parsed.expandedContent,
            display: true,
            details,
          },
          { triggerTurn: true },
        );
        // 消费输入：pi 不创建普通 user 消息，也不做原生 skill 展开
        return { action: "handled" };
      } catch {
        // sendMessage 失败（model 未配置等）：降级为 continue，
        // 让 pi 把原始文本当普通 user 消息。不退回 transform/展开后文本，
        // 避免 custom 消息已部分入队时重复发送。
        return { action: "continue" };
      }
    });

    // 自定义消息渲染：复用 pi 原生组件，渲染成多个折叠 skill 块 + 用户正文。
    // CustomMessageComponent 已在外层加了 Spacer(1)，这里只需返回内容容器。
    pi.registerMessageRenderer(
      "inline-skills",
      (message, options): Component | undefined => {
        const details = message.details as InlineSkillsDetails | undefined;
        if (!details) return undefined;

        const container = new Container();
        const expanded = options.expanded;

        for (let i = 0; i < details.blocks.length; i++) {
          if (i > 0) {
            container.addChild(new Spacer(1));
          }
          const block = new SkillInvocationMessageComponent(details.blocks[i]);
          block.setExpanded(expanded);
          container.addChild(block);
        }

        if (details.userMessage) {
          container.addChild(new Spacer(1));
          container.addChild(new UserMessageComponent(details.userMessage));
        }

        return container;
      },
    );
  });
}
