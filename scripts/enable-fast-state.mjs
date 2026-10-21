#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') continue;
  if (!['--agent-dir', '--package-dir'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error('Expected --apply, --agent-dir <directory>, or --package-dir <directory>');
  index++;
}
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const agentDir = resolve(value('--agent-dir') || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
const directory = resolve(value('--package-dir') || join(agentDir, 'npm', 'node_modules', '@calesennett', 'pi-codex-fast'));
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
if (manifest.name !== '@calesennett/pi-codex-fast' || manifest.version !== '0.1.11')
  throw new Error('This reviewed read-only interface requires pi-codex-fast 0.1.11');
const file = join(directory, 'extensions', 'codex-fast.ts');
const original = readFileSync(file, 'utf8');
const originalMode = statSync(file).mode & 0o777;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const originalHash = '5a24572accd97e97d878d7b3ca76eb57dcabd26f3541ce78fc5163cdc757154e';
const patchedHash = '3e7f049a2ab006d2301a9a99236c6b5c4d1359f9a36c7fa3b225ba6444a8417b';
if (hash(original) === patchedHash) {
  console.log(JSON.stringify({ file, changed: false, applied: false }));
  process.exit(0);
}
if (hash(original) !== originalHash) throw new Error('Fast source differs from the reviewed version; no files were changed');
let patched = original;
for (const [before, after] of [
  ['function supportsSpeedMode(ctx: ExtensionContext, mode: SpeedMode): boolean {\n\tif (mode === SPEED_MODE.OFF) return false;\n\tconst modelName = currentModelName(ctx);',
   'function supportsSpeedMode(modelName: string | undefined, mode: SpeedMode): boolean {\n\tif (mode === SPEED_MODE.OFF) return false;'],
  ['\tlet settingsWriteQueue: Promise<void> = Promise.resolve();', `\tlet settingsWriteQueue: Promise<void> = Promise.resolve();
\tlet stateReady = false;

\tpi.events.on("pi-codex-fast:query", (data) => {
\t\tconst request = asObject(data);
\t\tif (request?.version !== 1 || typeof request.requestId !== "string" ||
\t\t\t(request.model !== null && typeof request.model !== "string")) return;
\t\tconst supported = stateReady ? supportsSpeedMode(typeof request.model === "string" ? request.model : undefined, speedMode) : null;
\t\tpi.events.emit("pi-codex-fast:state", {
\t\t\tversion: 1, requestId: request.requestId, model: request.model,
\t\t\tmode: stateReady ? speedMode : null, supported,
\t\t\tserviceTier: supported ? (speedMode === SPEED_MODE.FAST ? "priority" : SPEED_MODE.ULTRAFAST) : null,
\t\t});
\t});`],
  ['\tfunction updateStatus(ctx: ExtensionContext): void {\n\t\tif (!ctx.hasUI) return;',
   '\tfunction updateStatus(ctx: ExtensionContext): void {\n\t\tpi.events.emit("pi-codex-fast:changed", { version: 1 });\n\t\tif (!ctx.hasUI) return;'],
  ['\t\tspeedMode = SPEED_MODE.OFF;\n\n\t\ttry {',
   '\t\tstateReady = false;\n\t\tpi.events.emit("pi-codex-fast:changed", { version: 1 });\n\t\tspeedMode = SPEED_MODE.OFF;\n\n\t\ttry {'],
  ['\t\tupdateStatus(ctx);\n\t}\n\n\tpi.registerFlag("fast", {',
   '\t\tstateReady = true;\n\t\tupdateStatus(ctx);\n\t}\n\n\tpi.registerFlag("fast", {'],
]) {
  if (patched.split(before).length !== 2) throw new Error('Reviewed Fast interface patch did not match exactly');
  patched = patched.replace(before, after);
}
if (patched.split('supportsSpeedMode(ctx, speedMode)').length !== 3)
  throw new Error('Reviewed Fast model checks did not match exactly');
patched = patched.replaceAll('supportsSpeedMode(ctx, speedMode)', 'supportsSpeedMode(currentModelName(ctx), speedMode)');
if (hash(patched) !== patchedHash) throw new Error('Fast interface patch differs from the reviewed result');
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ file, changed: true, applied: false, originalHash, patchedHash: hash(patched) }));
  process.exit(0);
}
const backupDir = join(agentDir, 'pi-web', 'migration-backups');
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const backup = join(backupDir, `codex-fast-${randomUUID()}.ts`);
writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
const temporary = `${file}.${randomUUID()}.tmp`;
try {
  writeFileSync(temporary, patched, { flag: 'wx', mode: originalMode });
  for (let attempt = 0; ; attempt++) {
    if (readFileSync(file, 'utf8') !== original) throw new Error('Fast source changed during installation; nothing was overwritten');
    try { renameSync(temporary, file); break; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 4) throw error;
      await new Promise((finish) => setTimeout(finish, 50 * (attempt + 1)));
    }
  }
} finally { try { unlinkSync(temporary); } catch {} }
console.log(JSON.stringify({ file, applied: true, backup, next: 'Reload idle Pi instances. Modes, flags, settings and request-tier behavior are unchanged.' }));
