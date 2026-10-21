import { Marked } from 'marked';
import { escapeHtml } from './shared/escape.js';

export function localFileReference(href) {
  if (!href) return null;
  if (/^[a-z]:[\\/]/i.test(href) || /^file:/i.test(href)) return href;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return null;
  try {
    return decodeURIComponent(href.split(/[?#]/)[0]) || null;
  } catch {
    return null;
  }
}

const markdown = new Marked();

export function linkedFiles(text) {
  const paths = new Set();
  markdown.walkTokens(markdown.lexer(text || ''), (token) => {
    if (token.type !== 'link' && token.type !== 'image') return;
    const path = localFileReference(token.href);
    if (path) paths.add(path);
  });
  return [...paths];
}

export function fileName(path) {
  if (/^file:/i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return path;
    }
  }
  return path.split(/[\\/]/).at(-1) || path;
}

export function fileDownloadURL(sessionId, path) {
  return `/api/session/file?${new URLSearchParams({ id: sessionId, path })}`;
}

export function fileLinksHTML(sessionId, path, label = escapeHtml(fileName(path))) {
  const name = fileName(path);
  const preview = /\.(?:html?|md|markdown|png|jpe?g|gif|webp|svg|avif)$/i.test(name)
    ? `<button type="button" data-preview-path="${escapeHtml(path)}">预览</button>`
    : '';
  return `<span class="remote-file" role="group" aria-label="${escapeHtml(name)}"><span class="remote-file-name">${label}</span><span class="remote-file-actions">${preview}<a href="${escapeHtml(fileDownloadURL(sessionId, path))}" download="${escapeHtml(name)}" target="_blank" rel="noreferrer">下载</a></span></span>`;
}
