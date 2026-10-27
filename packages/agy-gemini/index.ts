import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgentViaEvents } from 'pi-subagents/agents';
import { registerExternalJobProvider } from 'pi-subagents/external-job-provider';
import { AgyAdapter, validateOptions } from './adapter.mjs';

const ROLE_NAME = 'gemini';
const INVOCATION = 'Gemini uses external-job execution: omit async or use async:true. Continue a completed run with resume and its latest runId; live steer, clarify and foregroundOnly are unsupported.';

export default function (pi: ExtensionAPI) {
  let adapter: AgyAdapter | undefined;
  let disposeRole: (() => void) | undefined;
  let disposeProvider: (() => void) | undefined;
  let disposeStops: (() => void) | undefined;
  const owner = createHash('sha256').update(userInfo().username).digest('hex').slice(0, 12);
  const root = join(tmpdir(), `pi-agy-subagent-${owner}`);
  const collaboration = readFileSync(new URL('./collaboration.md', import.meta.url), 'utf8').trim();

  async function close() {
    disposeRole?.(); disposeRole = undefined;
    disposeStops?.(); disposeStops = undefined;
    if (adapter) { await adapter.close(); adapter = undefined; }
    disposeProvider?.(); disposeProvider = undefined;
  }
  pi.on('before_agent_start', event => {
    // Establish the scoped collaboration identity before the host can compose a Gemini task.
    event.systemPromptOptions.sections.gemini_collaboration = collaboration;
    // Keep the execution contract visible when subagent is enabled later in the same run.
    event.systemPromptOptions.sections.gemini_execution = INVOCATION;
  });
  pi.on('session_start', async () => {
    await close();
    adapter = new AgyAdapter(root);
    disposeProvider = registerExternalJobProvider({
      name: 'agy',
      start: input => adapter!.start(input),
      followUp: input => adapter!.followUp(input),
      status: id => adapter!.status(id),
      result: id => adapter!.result(id),
      reattach: id => adapter!.reattach(id),
    });
    const role = registerAgentViaEvents({
      pi, name: ROLE_NAME,
      definition: {
        description: `探索、产品与体验设计及面向人类写作的独立创作者；主代理提供上下文、事实与工程支撑，调用授权由用户级 APPEND_SYSTEM.md 确定。 ${INVOCATION}`,
        systemPrompt: `${collaboration}\n\n${readFileSync(new URL('./role.md', import.meta.url), 'utf8').trim()}`,
        inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
        defaultContext: 'fresh', defaultAsync: true, acceptanceRole: 'read-only',
        runner: { type: 'external-job', provider: 'agy', options: validateOptions() },
      },
    });
    disposeRole = () => role.dispose();
    const knownRuns = new Set<string>();
    const removeChildStop = pi.events.on('subagent:child-status', async event => {
      const runId = event.childRunId ?? event.runId;
      if ((event.agent === ROLE_NAME || adapter?.ownsRun(runId)) && (event.status === 'stopping' || event.status === 'stopped'))
        await adapter?.cancelRun(runId);
    });
    const removeStart = pi.events.on('subagent:async-started', event => {
      if (event.agent === ROLE_NAME) knownRuns.add(event.id);
    });
    const removeTerminal = pi.events.on('subagent:process-terminal', async proof => {
      if (proof.state === 'observed' && knownRuns.delete(proof.runId)) await adapter?.ownerTerminated(proof.runId);
    });
    disposeStops = () => { removeChildStop(); removeStart(); removeTerminal(); knownRuns.clear(); };
  });
  pi.on('session_shutdown', close);
}
