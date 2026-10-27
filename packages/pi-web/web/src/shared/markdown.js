import { Marked } from 'marked';
import { escapeHtml } from './escape.js';
import { icon, CircleDashed, CircleAlert, Check } from './icons.js';
import { localFileReference, fileLinksHTML, isImageFile, isPreviewFile } from '../remote-files.js';

const callouts = {
  NOTE: ['说明', CircleDashed],
  TIP: ['提示', Check],
  IMPORTANT: ['重要', CircleAlert],
  WARNING: ['警告', CircleAlert],
  CAUTION: ['注意', CircleAlert],
};

export function createMarkdown(sessionId, inline = false) {
  const markdown = new Marked({ breaks: true, gfm: true });
  markdown.use({
    walkTokens(token) {
      // Native summaries flatten paragraphs; block-only markers must not leak into the inline row.
      if (inline && token.type === 'text' && !token.tokens) {
        token.text = token.text
          .replace(/(^|\s)#{1,6}[ \t]+/g, '$1')
          .replace(
            /(?:^|\s)>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/gi,
            (_marker, kind) => ` ${callouts[kind.toUpperCase()][0]}：`,
          );
      }
    },
    renderer: {
      html(token) {
        return escapeHtml(token.text);
      },
      link(token) {
        const label = this.parser.parseInline(token.tokens);
        if (inline) return label;
        const path = localFileReference(token.href);
        if (path) return fileLinksHTML(sessionId, path, label);
        if (
          /^https?:\/\//i.test(token.href || '') &&
          (isImageFile(token.href) || isPreviewFile(token.href))
        )
          return fileLinksHTML(sessionId, token.href, label);
        if (!/^(https?:|mailto:|#)/i.test(token.href || '')) return label;
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noreferrer">${label}</a>`;
      },
      image(token) {
        const label = escapeHtml(token.text || '打开图片');
        if (inline) return label;
        const path = localFileReference(token.href);
        if (path) return fileLinksHTML(sessionId, path, label);
        if (!/^https?:\/\//i.test(token.href || '')) return label;
        return fileLinksHTML(sessionId, token.href, label, true);
      },
      blockquote(token) {
        const marker = token.text.match(
          /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\n]+))?(?:\n|$)/i,
        );
        if (!marker) return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>`;
        const kind = marker[1].toUpperCase();
        const [title, glyph] = callouts[kind];
        const content = this.parser.parse(markdown.lexer(token.text.slice(marker[0].length)));
        return `<aside class="markdown-alert" data-kind="${kind.toLowerCase()}"><div class="markdown-alert-title">${icon(glyph, { size: 16 })}<strong>${escapeHtml(marker[2] || title)}</strong></div>${content}</aside>`;
      },
      code(token) {
        const language = (token.lang || '').split(/\s+/)[0].toLowerCase();
        if (language !== 'mermaid') return false;
        return `<div class="markdown-diagram"><pre class="diagram-source"><code class="language-mermaid">${escapeHtml(token.text)}</code></pre><div class="diagram-output"></div></div>`;
      },
    },
  });
  return markdown;
}

let mermaidModule;
let renderQueue = Promise.resolve();
let nextDiagram = 0;

// Diagrams are enhanced only inside mounted Markdown bodies; folded thinking stays unread.
export function diagrams(node) {
  let disposed = false;
  let revision = 0;
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const showSource = (target) => {
    target.querySelector('.diagram-output').replaceChildren();
    target.querySelector('.diagram-source').hidden = false;
    if (!target.querySelector('.diagram-error')) {
      const hint = document.createElement('p');
      hint.className = 'diagram-error';
      hint.textContent = '图表暂时无法渲染，显示源码。';
      target.append(hint);
    }
  };
  const schedule = () => {
    const current = ++revision;
    queueMicrotask(async () => {
      const targets = [...node.querySelectorAll('.markdown-diagram')];
      if (!targets.length || disposed) return;
      let mermaid;
      try {
        ({ default: mermaid } = await (mermaidModule ||= import('mermaid')));
      } catch {
        mermaidModule = undefined;
        if (!disposed && current === revision) targets.forEach(showSource);
        return;
      }
      for (const target of targets) {
        renderQueue = renderQueue
          .catch(() => {})
          .then(async () => {
            if (disposed || current !== revision) return;
            const source = target.querySelector('.diagram-source');
            const output = target.querySelector('.diagram-output');
            const text = source.textContent;
            const css = getComputedStyle(node);
            const color = (name) => css.getPropertyValue(name).trim();
            const id = `pi-diagram-${++nextDiagram}`;
            try {
              mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                suppressErrorRendering: true,
                theme: 'base',
                fontFamily: color('--font-sans'),
                themeVariables: {
                  darkMode: scheme.matches,
                  background: color('--surface'),
                  primaryColor: color('--surface-2'),
                  primaryTextColor: color('--text'),
                  primaryBorderColor: color('--muted'),
                  secondaryColor: color('--surface'),
                  secondaryTextColor: color('--text'),
                  tertiaryColor: color('--surface-2'),
                  tertiaryTextColor: color('--text'),
                  lineColor: color('--text-soft'),
                  textColor: color('--text'),
                },
                flowchart: { htmlLabels: false },
                maxTextSize: 50000,
                maxEdges: 500,
              });
              const { svg } = await mermaid.render(id, text);
              if (disposed || current !== revision) return;
              output.innerHTML = svg;
              const graphic = output.querySelector('svg');
              const width = graphic.viewBox.baseVal.width;
              graphic.style.maxWidth = 'none';
              graphic.style.width = `max(100%, ${Math.ceil(width)}px)`;
              graphic.style.height = 'auto';
              graphic.setAttribute('role', 'img');
              if (!graphic.hasAttribute('aria-label') && !graphic.hasAttribute('aria-labelledby'))
                graphic.setAttribute('aria-label', 'Mermaid 图表');
              source.hidden = true;
              target.querySelector('.diagram-error')?.remove();
            } catch {
              if (disposed || current !== revision) return;
              showSource(target);
            } finally {
              // Mermaid can leave its temporary render container behind after a parse failure.
              document.getElementById(`d${id}`)?.remove();
            }
          });
        await renderQueue;
      }
    });
  };
  scheme.addEventListener('change', schedule);
  schedule();
  return {
    update: schedule,
    destroy() {
      disposed = true;
      revision++;
      scheme.removeEventListener('change', schedule);
    },
  };
}
