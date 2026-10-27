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

export function isWebFile(path) {
  return /^https?:\/\//i.test(path || '');
}

// GitHub file pages are HTML wrappers, not the image/document bytes.
function webFileURL(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.hostname === 'github.com') {
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/);
    if (match) {
      url.hostname = 'raw.githubusercontent.com';
      url.pathname = `/${match[1]}/${match[2].replace(/^refs\/heads\//, '')}`;
      url.search = '';
    }
  }
  return url.href;
}

function resolveFile(href, source, allowRelative) {
  if (!href || href.startsWith('#')) return null;
  if (isWebFile(href)) return webFileURL(href);
  if (source && isWebFile(source)) {
    try {
      const base = new URL(source);
      // A repository landing page represents its root README, not its owner's directory.
      if (base.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/?$/.test(base.pathname)) {
        base.pathname = base.pathname.replace(/\/$/, '') + '/blob/HEAD/README.md';
      }
      const url = new URL(href, base);
      return isWebFile(url.href) ? webFileURL(url.href) : null;
    } catch {
      return null;
    }
  }
  const path = localFileReference(href);
  if (!path) return null;
  if (/^(?:[a-z]:[\\/]|file:|\/)/i.test(path)) return path;
  if (!allowRelative && !source) return null;
  return source ? source.replace(/[^\\/]*$/, '') + path : path;
}

const markdown = new Marked();
const badgeURL = /(?:^https?:\/\/(?:img\.shields\.io|badgen\.net)\/|\/badge\.svg(?:[?#]|$))/i;
const textFileName = /^(?:LICENSE|COPYING|NOTICE)(?:\.[\w-]+)?$/i;

export function toolFiles(body, name) {
  const paths = new Map();
  const calls = body.details?.calls || [];
  const fromWeb =
    /^(?:fetch_content|get_search_content|web_search|source_check)$/.test(name) ||
    calls.some((call) =>
      /^(?:fetch_content|get_search_content|web_search|source_check)$/.test(call.name),
    );
  const collect = (text, source) => {
    if (typeof text !== 'string') return;
    if (/^\s*(?:\{|\[)/.test(text)) {
      try {
        const structured = JSON.parse(text);
        if (structured && typeof structured === 'object') return visit(structured, source);
      } catch {
        // Truncated results still expose absolute links, but cannot invent a relative base.
      }
    }
    const clone = text.match(/^Repository cloned to: (.+)\r?$/m)?.[1]?.trim();
    if (clone) source = clone.replace(/[\\/]$/, '') + '/README.md';
    markdown.walkTokens(markdown.lexer(text), (token) => {
      if (token.type !== 'link' && token.type !== 'image') return;
      // Repository status badges are page chrome, not attachments to read.
      if (badgeURL.test(token.href)) return;
      const path = resolveFile(token.href, source, !fromWeb);
      if (!path) return;
      if (
        token.tokens?.some((child) => child.type === 'image' && badgeURL.test(child.href)) &&
        !isPreviewFile(path) &&
        !textFileName.test(fileName(path))
      )
        return;
      if (
        isWebFile(path) &&
        token.type !== 'image' &&
        !isImageFile(path) &&
        !isPreviewFile(path) &&
        !/\.[a-z\d]{1,12}$/i.test(fileName(path))
      )
        return;
      paths.set(path, paths.get(path) || token.type === 'image' || isImageFile(path));
    });
  };
  const visit = (value, source) => {
    if (typeof value === 'string') return collect(value, source);
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((item) => visit(item, source));
    if (isWebFile(value.url)) source = value.url;
    for (const [key, child] of Object.entries(value)) {
      if (
        ['content', 'text', 'answer', 'value', 'result', 'results', 'urls', 'queries'].includes(key)
      ) {
        visit(child, source);
      }
    }
  };
  const source = name === 'read' ? body.input?.path || body.input?.file_path : null;
  // Codemode prints each structured result on its own line; decode JSON before parsing Markdown.
  const plain = [];
  for (const line of (body.text || '').split('\n')) {
    try {
      visit(JSON.parse(line), source);
    } catch {
      plain.push(line);
    }
  }
  collect(plain.join('\n'), source);
  return [...paths].map(([path, image]) => ({ path, image }));
}

export function fileName(path) {
  if (/^(?:file:|https?:\/\/)/i.test(path)) {
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

export function isImageFile(path) {
  return /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(fileName(path));
}

export function isPreviewFile(path) {
  return (
    /\.(?:html?|md|markdown)$/i.test(fileName(path)) ||
    (isWebFile(path) && (/\.txt$/i.test(fileName(path)) || textFileName.test(fileName(path))))
  );
}

export function fileLinksHTML(sessionId, path, label = escapeHtml(fileName(path)), image = false) {
  if (isWebFile(path)) path = webFileURL(path);
  if (image || isImageFile(path)) return `<span data-image-path="${escapeHtml(path)}"></span>`;
  const name = fileName(path);
  const preview = isPreviewFile(path)
    ? `<button type="button" data-preview-path="${escapeHtml(path)}">预览</button>`
    : '';
  const original = isWebFile(path)
    ? `<a href="${escapeHtml(path)}" target="_blank" rel="noreferrer">原文</a>`
    : '';
  return `<span class="remote-file" role="group" aria-label="${escapeHtml(name)}"><span class="remote-file-name" title="${escapeHtml(path)}">${label}</span><span class="remote-file-actions">${preview}${original}<a href="${escapeHtml(fileDownloadURL(sessionId, path))}" download="${escapeHtml(name)}" target="_blank" rel="noreferrer">下载</a></span></span>`;
}
