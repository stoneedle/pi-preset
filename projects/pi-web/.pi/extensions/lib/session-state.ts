import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Receipts } from './receipts.ts';
import { readFastState } from './fast-state.ts';

export type ActivityState = 'running' | 'needs-you' | 'background' | 'idle' | 'unknown';
type ChildReply = { success: boolean; data?: { fleet?: { totalActive?: number }; asyncSnapshot?: {
  kind: string; version: number; runs: { id: string; state: string }[];
} } };

type PendingPrompt = { count: number; id: string; kind: string };
type PromptSource = { sessions: Map<string, PendingPrompt>; changed?: (sessionId: string) => void };
const promptKey = Symbol.for('pi-web:pending-native-ui');
const promptHost = globalThis as typeof globalThis & { [promptKey]?: WeakMap<object, PromptSource> };
const pendingPrompts = promptHost[promptKey] ??= new WeakMap<object, PromptSource>();

function promptSource(manager: ExtensionContext['sessionManager']) {
  let source = pendingPrompts.get(manager);
  if (!source) { source = { sessions: new Map() }; pendingPrompts.set(manager, source); }
  return source;
}

/** The only activity/receipt projection. Title and loopback transport share this exact object. */
export class SessionState {
  readonly instanceId = randomUUID();
  readonly sessionId: string;
  readonly id: string;
  private ctx: ExtensionContext;
  private running: boolean;
  private children: number | null = null;
  private childProvider: 'unknown' | 'present' | 'absent' = 'unknown';
  private childRuns: Map<string, string> | null = null;
  private priorChildRuns = new Set<string>();
  private runChildren: Set<string> | null = new Set();
  private closed = false;
  private runBaseline: string | null = null;
  private pendingSettlement: string | undefined;
  private revision = 0;
  private receipts?: Receipts;
  private diagnostic: string | null = null;
  private listeners = new Set<() => void>();
  private unsubscribes: (() => void)[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private cancelQuery?: () => void;
  private lastJSON = '';
  private current!: ReturnType<SessionState['project']> & { revision: number };

  constructor(private pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string) {
    this.ctx = ctx;
    this.running = !ctx.isIdle();
    this.sessionId = ctx.sessionManager.getSessionId();
    this.id = basename(ctx.sessionManager.getSessionFile() || this.sessionId);
    if (this.running) this.runBaseline = this.result().id;
    try { this.receipts = new Receipts(agentDir); }
    catch (error) { this.report(error); }
    for (const event of ['subagents:rpc:v1:ready', 'subagent:async-started', 'subagent:async-complete',
      'subagent:process-terminal', 'subagent:child-status', 'subagent:foreground-complete']) {
      this.unsubscribes.push(pi.events.on(event, () => {
        this.childProvider = 'present';
        void this.refresh();
      }));
    }
    const prompts = promptSource(ctx.sessionManager);
    const promptChanged = (sessionId: string) => { if (sessionId === this.sessionId) this.publish(); };
    prompts.changed = promptChanged;
    this.unsubscribes.push(() => { if (prompts.changed === promptChanged) prompts.changed = undefined; });
    this.unsubscribes.push(pi.events.on('pi-codex-fast:changed', (event) => {
      if (event && typeof event === 'object' && (event as { version?: number }).version === 2) this.publish();
    }));
    this.publish();
  }

  async start() {
    await this.refresh();
    if (this.closed) return;
    this.timer = setInterval(() => {
      if (this.childProvider !== 'absent') void this.refresh();
    }, 3000);
    this.timer.unref();
  }

  updateContext(ctx: ExtensionContext) {
    if (ctx.sessionManager.getSessionId() !== this.sessionId || this.closed) return;
    this.ctx = ctx;
    this.publish();
  }

  agentStarted(ctx: ExtensionContext) {
    if (this.closed || ctx.sessionManager.getSessionId() !== this.sessionId) return;
    this.ctx = ctx;
    this.runBaseline = this.result().id;
    this.priorChildRuns = new Set(this.childRuns?.keys());
    this.runChildren = new Set();
    this.captureChildRuns();
    this.running = true;
    this.publish();
  }

  async agentSettled(ctx: ExtensionContext, aborted: boolean) {
    if (this.closed || ctx.sessionManager.getSessionId() !== this.sessionId) return;
    this.ctx = ctx;
    const result = this.result();
    if (this.runBaseline !== null && result.id && result.id !== this.runBaseline && !aborted && ['stop', 'length'].includes(result.outcome || ''))
      this.pendingSettlement = result.id;
    this.runBaseline = null;
    this.running = false;
    await this.refresh();
  }

  static promptStarted(manager: ExtensionContext['sessionManager'], sessionId: string, kind: string) {
    const source = promptSource(manager);
    const prompt = source.sessions.get(sessionId);
    if (prompt) prompt.count++;
    else source.sessions.set(sessionId, { count: 1, id: randomUUID(), kind });
    source.changed?.(sessionId);
  }
  static promptEnded(manager: ExtensionContext['sessionManager'], sessionId: string) {
    const source = promptSource(manager);
    const prompt = source.sessions.get(sessionId);
    if (!prompt) return;
    if (--prompt.count === 0) source.sessions.delete(sessionId);
    source.changed?.(sessionId);
  }

  private captureChildRuns() {
    if (this.runBaseline === null && !this.pendingSettlement) return;
    if (this.childProvider === 'absent') { this.runChildren = new Set(); return; }
    if (!this.childRuns || !this.runChildren) { this.runChildren = null; return; }
    for (const [id, state] of this.childRuns) {
      if (['running', 'queued'].includes(state) || !this.priorChildRuns.has(id)) this.runChildren.add(id);
      if (this.runChildren.size > 128) { this.runChildren = null; return; }
    }
  }

  private result() {
    const branch = this.ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      if (['stop', 'length', 'error', 'aborted'].includes(entry.message.stopReason)) {
        const content = entry.message.content;
        const readable = typeof content === 'string' ? content.length > 0 : content.some((part) =>
          (part.type === 'text' && part.text.length > 0) || (part.type === 'thinking' && part.thinking.length > 0));
        return { id: readable ? entry.id : '', outcome: entry.message.stopReason };
      }
    }
    return { id: '', outcome: null };
  }

  private project() {
    const mainRunning = this.running || !this.ctx.isIdle() || this.ctx.hasPendingMessages();
    const prompt = promptSource(this.ctx.sessionManager).sessions.get(this.sessionId);
    let state: ActivityState = prompt ? 'needs-you' : mainRunning ? 'running'
      : this.children === null ? 'unknown' : this.children > 0 ? 'background' : 'idle';
    const result = this.result();
    let record: ReturnType<Receipts['read']>;
    let childFailure = false;
    let receiptKnown = Boolean(this.receipts);
    try {
      if (this.pendingSettlement && this.receipts) {
        this.receipts.settled(this.sessionId, this.pendingSettlement, this.runChildren ? [...this.runChildren] : null);
        this.pendingSettlement = undefined;
      }
      if (result.id) record = this.receipts?.read(this.sessionId, result.id);
      if (result.id && record) {
        const dependencies: string[] | null = JSON.parse(record.completion_children);
        childFailure = !record.completed && !record.completion_pending && Boolean(dependencies?.length);
        if (record.completion_pending) {
          const outcomes = dependencies?.map((id) => this.childRuns?.get(id));
          childFailure = Boolean(outcomes?.some((outcome) => outcome && ['failed', 'partial', 'stopped', 'rejected'].includes(outcome)));
          if (childFailure) this.receipts?.cancelCompletion(this.sessionId, result.id);
          else if (state === 'idle') {
            if (!outcomes || outcomes.some((outcome) => outcome !== 'complete')) state = 'unknown';
            else this.receipts?.complete(this.sessionId, result.id);
          }
          if (this.receipts) record = this.receipts.read(this.sessionId, result.id);
        }
      }
    } catch (error) { receiptKnown = false; this.report(error); }
    const usageTotals = { input: 0, output: 0 };
    // Match the native footer: include usage entries, summaries and tool usage across the session.
    for (const entry of this.ctx.sessionManager.getEntries()) {
      const usage = entry.type === 'message'
        ? (entry.message.role === 'assistant' || entry.message.role === 'toolResult' ? entry.message.usage : undefined)
        : (entry.type === 'usage' || entry.type === 'branch_summary' || entry.type === 'compaction' ? entry.usage : undefined);
      if (usage) {
        usageTotals.input += usage.input;
        usageTotals.output += usage.output;
      }
    }
    let cacheHit: number | null = null;
    const branch = this.ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      const usage = entry.message.usage;
      if (usage) {
        const total = usage.input + usage.cacheRead + usage.cacheWrite;
        cacheHit = total > 0 ? usage.cacheRead / total * 100 : null;
      }
      break;
    }
    return {
      id: this.id, name: (this.ctx.sessionManager.getSessionName() || '').slice(0, 160), sessionId: this.sessionId, instanceId: this.instanceId,
      state, mainRunning, children: this.children, replyId: result.id, leafId: this.ctx.sessionManager.getLeafId(),
      unread: result.id ? (receiptKnown ? !record?.acknowledged : null) : false,
      completed: Boolean(record?.completed), outcome: childFailure ? 'error' : result.outcome,
      attentionId: prompt?.id ?? null, attentionKind: prompt?.kind ?? null, availability: 'connected', canControl: true, canQueue: true,
      model: this.ctx.model?.id, modelName: this.ctx.model?.name, provider: this.ctx.model?.provider,
      thinking: this.pi.getThinkingLevel(), context: this.ctx.getContextUsage() ?? null,
      cwd: this.ctx.cwd, chatAvailable: this.ctx.mode === 'tui' || this.ctx.mode === 'rpc',
      usage: usageTotals, cacheHit, fast: readFastState(this.pi, this.ctx.model), diagnostic: this.diagnostic,
    };
  }

  snapshot() { return this.current; }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  acknowledge(resultId: string) {
    if (this.closed || !resultId || resultId !== this.result().id) throw new Error('Result is no longer current');
    if (!this.receipts) throw new Error(this.diagnostic || 'Shared receipts unavailable');
    this.receipts.acknowledge(this.sessionId, resultId);
    this.publish();
  }

  reconcileReceipts() { this.publish(); }

  private report(error: unknown) {
    this.diagnostic = error instanceof Error ? error.message : String(error);
  }

  private publish() {
    if (this.closed) return;
    const projection = this.project();
    const json = JSON.stringify(projection);
    if (json === this.lastJSON) return;
    this.lastJSON = json;
    this.current = { ...projection, revision: ++this.revision };
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { this.report(error); }
    }
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = Promise.resolve().then(async () => {
      do {
        this.refreshAgain = false;
        const reply = await this.query();
        if (this.closed) return;
        const count = reply?.success ? reply.data?.fleet?.totalActive : undefined;
        this.children = typeof count === 'number' && Number.isInteger(count) && count >= 0
          ? count : this.childProvider === 'absent' ? 0 : null;
        const snapshot = reply?.success ? reply.data?.asyncSnapshot : undefined;
        this.childRuns = snapshot?.kind === 'pi-subagents.async-status-snapshot' && snapshot.version === 1 && Array.isArray(snapshot.runs)
          ? new Map(snapshot.runs.filter((run) => typeof run.id === 'string' && run.id.length <= 160 &&
            ['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected'].includes(run.state)).map((run) => [run.id, run.state]))
          : this.childProvider === 'absent' ? new Map() : null;
        this.captureChildRuns();
        this.publish();
      } while (this.refreshAgain && !this.closed);
    }).catch((error) => { this.children = null; this.report(error); this.publish(); })
      .finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private query(): Promise<ChildReply | undefined> {
    if (this.childProvider === 'absent') return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const finish = (reply?: ChildReply) => {
        if (reply) this.childProvider = 'present';
        else if (this.childProvider === 'unknown') {
          this.childProvider = this.pi.getAllTools().some((tool) => tool.name === 'subagent') ? 'present' : 'absent';
        }
        clearTimeout(timeout);
        unsubscribe();
        this.cancelQuery = undefined;
        resolve(reply);
      };
      const unsubscribe = this.pi.events.on(`subagents:rpc:v1:reply:${requestId}`, finish);
      const timeout = setTimeout(finish, 1000);
      this.cancelQuery = finish;
      try { this.pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'status' }); }
      catch { finish(); }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.cancelQuery?.();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.listeners.clear();
    this.receipts?.close();
  }
}
