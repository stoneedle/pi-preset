import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

type Image = { type: 'image'; data: string; mimeType: string };
type Item = { id: string; message: string; images: Image[]; state: 'queued' | 'delivering' | 'failed'; error?: string };
type QueueData = { items: Item[]; revision: number; listeners: Set<() => void> };

// Preserve data across reloads, not class instances whose methods belong to the old runtime.
const key = Symbol.for('pi-web:remote-queue');
const host = globalThis as typeof globalThis & { [key]?: WeakMap<object, Map<string, QueueData>> };
const queues = host[key] ??= new WeakMap<object, Map<string, QueueData>>();

export function remoteQueue(ctx: ExtensionContext) {
  let sessions = queues.get(ctx.sessionManager);
  if (!sessions) { sessions = new Map(); queues.set(ctx.sessionManager, sessions); }
  const id = ctx.sessionManager.getSessionId();
  let data = sessions.get(id);
  if (!data) { data = { items: [], revision: 0, listeners: new Set() }; sessions.set(id, data); }
  return new RemoteQueue(data);
}

class RemoteQueue {
  constructor(private data: QueueData) {}
  get revision() { return this.data.revision; }
  get count() { return this.data.items.length; }
  subscribe(listener: () => void) {
    this.data.listeners.add(listener);
    return () => { this.data.listeners.delete(listener); };
  }
  private changed() {
    this.data.revision++;
    for (const listener of this.data.listeners) listener();
  }
  list() {
    return { revision: this.revision, items: this.data.items.map(({ images, ...item }) => ({ ...item, imageCount: images.length })) };
  }
  add(message: string, images: Image[]) {
    const item: Item = { id: randomUUID(), message, images, state: 'queued' };
    if (this.count >= 100 || Buffer.byteLength(JSON.stringify([...this.data.items, item]), 'utf8') > 64 * 1024 * 1024)
      throw new Error('排队内容过多，请先处理已有消息');
    this.data.items.push(item);
    this.changed();
    return { status: 'accepted', queueId: item.id };
  }
  read(id: string) {
    const item = this.data.items.find((item) => item.id === id);
    if (!item || item.state === 'delivering') throw new Error('这条消息已开始投递或已被移除，不能撤回');
    return { ...item, images: [...item.images] };
  }
  remove(id: string) {
    const item = this.data.items.find((item) => item.id === id);
    if (!item || item.state === 'delivering') throw new Error('这条消息已开始投递或已被移除，不能撤回');
    this.data.items = this.data.items.filter((entry) => entry !== item);
    this.changed();
    return this.list();
  }
  async deliverNext(pi: ExtensionAPI) {
    const item = this.data.items[0];
    if (!item || item.state !== 'queued') return;
    item.state = 'delivering';
    this.changed();
    try {
      await pi.sendUserMessage(item.images.length ? [{ type: 'text', text: item.message }, ...item.images] : item.message, {
        deliverAs: 'followUp', expandPromptTemplates: true,
      });
      this.data.items = this.data.items.filter((entry) => entry !== item);
    } catch (error) {
      item.state = 'failed';
      item.error = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }
}
