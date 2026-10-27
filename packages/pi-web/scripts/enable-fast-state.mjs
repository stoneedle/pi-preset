#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const originalHash = '5a24572accd97e97d878d7b3ca76eb57dcabd26f3541ce78fc5163cdc757154e';
const previousHash = '3e7f049a2ab006d2301a9a99236c6b5c4d1359f9a36c7fa3b225ba6444a8417b';
const patchedHash = '74d2572f13dc98d75c58e8e1adf8ce5eb9b1b2af6134d841e911bb69c092ba9e';

// A fingerprinted one-way upgrade, not a second owner of speed rules or model allowlists.
export function patchFastInterface(source) {
  const fingerprint = hash(source);
  if (fingerprint === patchedHash) return source;
  if (![originalHash, previousHash].includes(fingerprint))
    throw new Error('Fast source differs from the reviewed version; no files were changed');
  let patched = source;
  const replace = (before, after) => {
    if (patched.split(before).length !== 2) throw new Error('Reviewed Fast interface patch did not match exactly');
    patched = patched.replace(before, after);
  };
  if (fingerprint === originalHash) {
    replace('function supportsSpeedMode(ctx: ExtensionContext, mode: SpeedMode): boolean {\n\tif (mode === SPEED_MODE.OFF) return false;\n\tconst modelName = currentModelName(ctx);',
      'function supportsSpeedMode(modelName: string | undefined, mode: SpeedMode): boolean {\n\tif (mode === SPEED_MODE.OFF) return false;');
    replace('\tlet settingsWriteQueue: Promise<void> = Promise.resolve();', '\tlet settingsWriteQueue: Promise<void> = Promise.resolve();\n\tlet stateReady = false;');
    replace('\tfunction updateStatus(ctx: ExtensionContext): void {\n\t\tif (!ctx.hasUI) return;', '\tfunction updateStatus(ctx: ExtensionContext): void {\n\t\tpi.events.emit("pi-codex-fast:changed", { version: 1 });\n\t\tif (!ctx.hasUI) return;');
    replace('\t\tspeedMode = SPEED_MODE.OFF;\n\n\t\ttry {', '\t\tstateReady = false;\n\t\tpi.events.emit("pi-codex-fast:changed", { version: 1 });\n\t\tspeedMode = SPEED_MODE.OFF;\n\n\t\ttry {');
    replace('\t\tupdateStatus(ctx);\n\t}\n\n\tpi.registerFlag("fast", {', '\t\tstateReady = true;\n\t\tupdateStatus(ctx);\n\t}\n\n\tpi.registerFlag("fast", {');
    if (patched.split('supportsSpeedMode(ctx, speedMode)').length !== 3) throw new Error('Fast model checks did not match exactly');
    patched = patched.replaceAll('supportsSpeedMode(ctx, speedMode)', 'supportsSpeedMode(currentModelName(ctx), speedMode)');
  } else {
    const start = patched.indexOf('\n\tpi.events.on("pi-codex-fast:query",');
    const end = patched.indexOf('\n\t});', start) + '\n\t});'.length;
    if (start < 0 || end <= start) throw new Error('Previous Fast interface did not match');
    patched = patched.slice(0, start) + patched.slice(end);
  }
  patched = patched.replaceAll('pi.events.emit("pi-codex-fast:changed", { version: 1 })', 'pi.events.emit("pi-codex-fast:changed", { version: 2 })');
  replace('\tlet stateReady = false;', `\tlet stateReady = false;
\tlet activeContext: ExtensionContext | undefined;

\tfunction publishState(request: Record<string, unknown>, error?: string): void {
\t\tconst model = typeof request.model === "string" ? request.model : undefined;
\t\tconst availableModes: SpeedMode[] = [SPEED_MODE.OFF];
\t\tif (supportsSpeedMode(model, SPEED_MODE.FAST)) availableModes.push(SPEED_MODE.FAST);
\t\tif (supportsSpeedMode(model, SPEED_MODE.ULTRAFAST)) availableModes.push(SPEED_MODE.ULTRAFAST);
\t\tconst applied = stateReady && supportsSpeedMode(model, speedMode);
\t\tpi.events.emit("pi-codex-fast:state", {
\t\t\tversion: 2, requestId: request.requestId, model: request.model,
\t\t\tmode: stateReady ? speedMode : null, availableModes: stateReady ? availableModes : null,
\t\t\tserviceTier: applied ? (speedMode === SPEED_MODE.FAST ? "priority" : SPEED_MODE.ULTRAFAST) : null,
\t\t\t...(error ? { error } : {}),
\t\t});
\t}
\tfunction validRequest(data: unknown): Record<string, unknown> | null {
\t\tconst request = asObject(data);
\t\treturn request?.version === 2 && typeof request.requestId === "string" &&
\t\t\t(request.model === null || typeof request.model === "string") ? request : null;
\t}
\tpi.events.on("pi-codex-fast:query", (data) => {
\t\tconst request = validRequest(data);
\t\tif (request) publishState(request);
\t});
\tpi.events.on("pi-codex-fast:set", (data) => {
\t\tconst request = validRequest(data);
\t\tif (!request) return;
\t\tif (!stateReady || !activeContext || request.model !== (currentModelName(activeContext) ?? null)) {
\t\t\tpublishState(request, "速度状态尚未就绪"); return;
\t\t}
\t\tconst target = request.mode;
\t\tif ((target !== SPEED_MODE.OFF && target !== SPEED_MODE.FAST && target !== SPEED_MODE.ULTRAFAST) ||
\t\t\t(target !== SPEED_MODE.OFF && !supportsSpeedMode(currentModelName(activeContext), target))) {
\t\t\tpublishState(request, "当前模型不支持所选速度"); return;
\t\t}
\t\tif (target !== speedMode) setSpeedMode(target, activeContext, { persist: false, notify: false });
\t\tpublishState(request);
\t});`);
  replace('\tfunction updateStatus(ctx: ExtensionContext): void {', '\tfunction updateStatus(ctx: ExtensionContext): void {\n\t\tactiveContext = ctx;');
  replace('\t\tspeedMode = mode;\n\t\tif (options?.persist', '\t\tspeedMode = mode;\n\t\tpi.appendEntry("pi-codex-fast:mode", { mode });\n\t\tif (options?.persist');
  replace('\n\t\tif (options?.includeStartupFlag) {', `
\t\tconst branch = ctx.sessionManager.getBranch();
\t\tfor (let index = branch.length - 1; index >= 0; index--) {
\t\t\tconst entry = branch[index];
\t\t\tif (entry.type !== "custom" || entry.customType !== "pi-codex-fast:mode") continue;
\t\t\tconst saved = asObject(entry.data)?.mode;
\t\t\tif (saved === SPEED_MODE.OFF || saved === SPEED_MODE.FAST || saved === SPEED_MODE.ULTRAFAST) {
\t\t\t\tspeedMode = saved; break;
\t\t\t}
\t\t}
\t\tif (options?.includeStartupFlag) {`);
  // Normalize the removed v1 block's blank line so either reviewed input yields one exact output.
  patched = patched.replace('\n\t});\n\n\n\tfunction persistState', '\n\t});\n\n\tfunction persistState');
  if (hash(patched) !== patchedHash) throw new Error('Fast interface patch differs from the reviewed result: ' + hash(patched));
  return patched;
}

async function main() {
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
    throw new Error('This reviewed session-control interface requires pi-codex-fast 0.1.11');
  const file = join(directory, 'extensions', 'codex-fast.ts');
  const original = readFileSync(file, 'utf8');
  const patched = patchFastInterface(original);
  if (patched === original || !args.includes('--apply')) {
    console.log(JSON.stringify({ file, changed: patched !== original, applied: false, patchedHash: hash(patched) })); return;
  }
  const backupDir = join(agentDir, 'pi-web', 'migration-backups');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, 'codex-fast-' + randomUUID() + '.ts');
  writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, patched, { flag: 'wx', mode: statSync(file).mode & 0o777 });
    for (let attempt = 0; ; attempt++) {
      if (readFileSync(file, 'utf8') !== original) throw new Error('Fast source changed during installation; nothing was overwritten');
      try { renameSync(temporary, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 4) throw error;
        await new Promise((finish) => setTimeout(finish, 50 * (attempt + 1)));
      }
    }
  } finally { try { unlinkSync(temporary); } catch {} }
  console.log(JSON.stringify({ file, applied: true, backup, next: 'Reload Pi instances to activate v2 session controls. Global settings are unchanged.' }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
