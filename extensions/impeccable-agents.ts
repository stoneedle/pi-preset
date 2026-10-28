import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RuntimeAgentDefinition, RuntimeAgentRegistrationRequest } from '../packages/pi-subagents/src/api/agents.ts';

function rolePrompt(role: string, title: string) {
  const source = new URL(`../../upstreams/impeccable/.pi/skills/impeccable/reference/degraded/${role}.md`, import.meta.url);
  const text = readFileSync(source, 'utf8');
  // Generated references prepend an inline-only preamble to the canonical role.
  const heading = new RegExp(`^# Impeccable ${title}\\r?$`, 'm').exec(text);
  if (!heading) throw new Error(`Impeccable ${role} contract heading missing: ${source.href}`);
  return text.slice(heading.index).trim();
}

export default function impeccableAgents(pi: ExtensionAPI) {
  let registrations: { dispose(): void }[] = [];
  function clear() {
    for (const registration of registrations) registration.dispose();
    registrations = [];
  }

  pi.on('session_start', () => {
    clear();
    const definitions: { name: string; definition: RuntimeAgentDefinition }[] = [
      {
        name: 'impeccable-finish-reviewer',
        definition: {
          description: 'Impeccable new-work 收尾的独立设计审阅与修复复核（Gemini）。技能契约自动注入；调用方提供本次需求、确认决定、设计契约和截图等材料。',
          systemPrompt: rolePrompt('finish-reviewer', 'Finish Reviewer'),
          acceptanceRole: 'read-only',
          inheritProjectContext: false,
          runner: { type: 'external-job', provider: 'agy' },
        },
      },
      {
        name: 'impeccable-documenter',
        definition: {
          description: 'Impeccable 设计系统记录：依据最终实现核对或更新 DESIGN.md 与 design.json。技能契约自动注入；仅写交接材料指定的设计记录。',
          systemPrompt: rolePrompt('documenter', 'Documenter'),
          acceptanceRole: 'writer',
          inheritProjectContext: true,
          tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
          extensions: [],
        },
      },
      {
        name: 'impeccable-asset-producer',
        definition: {
          description: 'Impeccable 素材生产：按方向卡或已批准设计稿组织生图提示、生成并检查真实素材。技能契约自动注入；交付图片与提示侧车，不修改页面或设计规格。',
          systemPrompt: rolePrompt('asset-producer', 'Asset Producer'),
          acceptanceRole: 'writer',
          inheritProjectContext: true,
          tools: ['read', 'bash', 'write', 'grep', 'find', 'ls', 'codex_generate_image'],
          extensions: [],
          subagentOnlyExtensions: [join(getAgentDir(), 'npm', 'node_modules', 'pi-codex-image-gen', 'index.ts')],
        },
      },
    ];

    for (const { name, definition } of definitions) {
      const request: RuntimeAgentRegistrationRequest = {
        version: 1,
        name,
        definition: {
          systemPromptMode: 'replace',
          inheritGlobalContext: false,
          inheritSkills: false,
          defaultContext: 'fresh',
          defaultAsync: true,
          ...definition,
        },
      };
      pi.events.emit('pi-subagents:runtime-agent-register:v1', request);
      if (!request.result) throw new Error('Impeccable agents require pi-subagents to be installed and ready.');
      if (!request.result.ok) throw request.result.error;
      registrations.push(request.result.registration);
    }
  });
  pi.on('session_shutdown', clear);
}
