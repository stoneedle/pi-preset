import {
  Code,
  ArrowDown,
  Menu,
  ChevronDown,
  Folder,
  Plus,
  Paperclip,
  Send,
  Square,
  Bell,
  X,
  Brain,
  Terminal,
  Wrench,
  Check,
  CircleDashed,
  CircleAlert,
  ChevronRight,
} from 'lucide';

export function icon(node, { size = 20 } = {}) {
  const children = node
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .map(([key, value]) => `${key}="${value}"`)
          .join(' ')} />`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

export {
  Code,
  ArrowDown,
  Menu,
  ChevronDown,
  Folder,
  Plus,
  Paperclip,
  Send,
  Square,
  Bell,
  X,
  Brain,
  Terminal,
  Wrench,
  Check,
  CircleDashed,
  CircleAlert,
  ChevronRight,
};
