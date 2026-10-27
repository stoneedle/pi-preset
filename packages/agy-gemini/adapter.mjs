import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, rmSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { ExternalJobProviderError } from 'pi-subagents/external-job-provider';

export const DEFAULT_MODEL = 'gemini-3.8-flash-high';
const fail = (code, message) => { throw new ExternalJobProviderError(message, { code }); };
function compileSchema(schema) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  try { return { ajv, validate: ajv.compile(schema) }; }
  catch (error) { fail('invalid_schema', error.message); }
}
export function atomicText(path, text) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, text, 'utf8'); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export function validateSchema(schema, value) {
  const { ajv, validate } = compileSchema(schema);
  if (!validate(value)) fail('schema_mismatch', ajv.errorsText(validate.errors));
  return value;
}
export function jsonValues(text) {
  try { return [JSON.parse(text)]; } catch { /* Inspect a possible adjacent-value response. */ }
  const values = [];
  let start = 0, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth === 0 && !quoted && /\s/.test(c)) { start = i + 1; continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (depth === 0 && !quoted) {
      try { values.push(JSON.parse(text.slice(start, i + 1))); start = i + 1; }
      catch { /* A scalar or document is not complete yet. */ }
    }
  }
  if (depth !== 0 || quoted || text.slice(start).trim() || !values.length) fail('invalid_json', 'agy returned incomplete JSON.');
  return values;
}
function stripMetadata(value, schema) {
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.additionalProperties === false) {
    for (const key of ['toolAction', 'toolSummary']) {
      if (!(key in (schema.properties ?? {})) && typeof value[key] === 'string') delete value[key];
    }
  }
  return value;
}
/** The current process outcome is authoritative; historical ERROR summaries can survive a recovered CLI turn. */
export function parseReply(stdout, stderr, exitCode, conversationId, schema) {
  let provider;
  try { provider = JSON.parse(stdout); } catch { /* Process diagnostics take precedence over malformed output. */ }
  if (provider?.denied_actions?.length || /auto-denied|permission.+(?:denied|cannot prompt)/i.test(stderr))
    fail('tool_denied', `agy denied a tool operation: ${JSON.stringify(provider?.denied_actions ?? [])}. ${stderr.trim()}`);
  const diagnostics = stderr.split(/\r?\n/).filter(line => /^\s*AGY_ERROR:/.test(line));
  if (exitCode !== 0 || diagnostics.length)
    fail('cli_failed', `agy exited ${exitCode}: ${diagnostics.join('\n') || stderr.trim() || provider?.error || 'No diagnostics.'}`);
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) fail('invalid_result', 'agy returned no complete result object.');
  if (!['SUCCESS', 'ERROR'].includes(provider.status)) fail('incomplete_result', `agy status: ${provider.status}`);
  if (typeof provider.conversation_id !== 'string' || !provider.conversation_id.trim()) fail('missing_conversation', 'agy did not return a conversation ID.');
  if (conversationId && provider.conversation_id !== conversationId) fail('conversation_mismatch', 'agy returned a different conversation.');
  if (typeof provider.response !== 'string' || !provider.response.trim()) fail('empty_response', 'agy returned no reply.');
  let value = provider.response;
  if (schema) {
    const candidates = jsonValues(provider.response).map(candidate => stripMetadata(candidate, schema));
    if (candidates.length === 1) value = candidates[0];
    else {
      if (!isDeepStrictEqual(provider.json_schema, schema) || !('structured_output' in provider))
        fail('ambiguous_json_response', 'Adjacent JSON has no authoritative finish result for this schema.');
      const finish = stripMetadata(provider.structured_output, schema);
      const matches = candidates.filter(candidate => isDeepStrictEqual(candidate, finish));
      if (!matches.length) fail('ambiguous_json_response', 'The finish result is absent from the response.');
      value = matches[0];
    }
    validateSchema(schema, value);
  }
  return { conversationId: provider.conversation_id, value, body: schema ? JSON.stringify(value) : provider.response };
}
function executable() {
  const names = process.platform === 'win32' ? ['agy.exe'] : ['agy'];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const path = join(directory.replace(/^"|"$/g, ''), name);
      if (existsSync(path)) return path;
    }
  }
  fail('cli_unavailable', 'agy was not found on PATH.');
}
export function validateOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('invalid_options', 'agy options must be an object.');
  if (Object.keys(options).some(key => !['model', 'schema', 'timeoutMs'].includes(key))) fail('invalid_options', 'Supported agy options: model, schema, timeoutMs.');
  const model = options.model === undefined ? DEFAULT_MODEL : options.model;
  if (typeof model !== 'string' || !/^gemini-[A-Za-z0-9._-]+$/.test(model)) fail('invalid_model', 'Choose an exact Gemini ID from agy models.');
  const timeoutMs = options.timeoutMs === undefined ? 1800000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) fail('invalid_timeout', 'timeoutMs must be a positive bounded integer.');
  if (options.schema !== undefined) {
    if (!options.schema || typeof options.schema !== 'object' || Array.isArray(options.schema)) fail('invalid_schema', 'schema must be a JSON Schema object.');
    compileSchema(options.schema);
  }
  return { model, timeoutMs, ...(options.schema !== undefined ? { schema: structuredClone(options.schema) } : {}) };
}
/** Owns agy protocol, subscription process lifetime, and conversation mapping behind the external-job Interface. */
export class AgyAdapter {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    this.root = root;
    this.db = new DatabaseSync(join(root, 'jobs.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT, parent_id TEXT, agent_name TEXT NOT NULL,
        cwd TEXT NOT NULL, model TEXT NOT NULL, timeout_ms INTEGER NOT NULL,
        schema_text TEXT, state TEXT NOT NULL, conversation_id TEXT,
        artifact_path TEXT, failure_code TEXT, failure_message TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_conversation_successor ON jobs(parent_id) WHERE parent_id IS NOT NULL;`);
    this.active = new Map();
    this.cancelledRuns = new Set();
  }
  row(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) fail('job_missing', `agy job ${id} is missing; no new conversation was started.`);
    return row;
  }
  handle(row) {
    return { providerJobId: row.id, state: row.state,
      ...(row.failure_code ? { failureCode: row.failure_code, failureMessage: row.failure_message } : {}) };
  }
  start(input) { return this.launch(input); }
  continuableParent(parent) {
    if (parent.state !== 'completed' || !parent.conversation_id) fail('conversation_missing', 'The completed agy parent conversation is unavailable.');
    const successor = this.db.prepare('SELECT id,state FROM jobs WHERE parent_id=?').get(parent.id);
    if (successor) fail(successor.state === 'completed' ? 'stale_conversation' : 'execution_unknown',
      `agy conversation already advanced or has an unverified outcome in job ${successor.id} (${successor.state}). Continue only a confirmed latest result.`);
    return parent;
  }
  followUp(input) {
    const parent = this.continuableParent(this.row(input.parentProviderJobId));
    if (parent.cwd !== resolve(input.cwd)) fail('workspace_mismatch', 'An agy conversation cannot change workspace.');
    const options = validateOptions(input.options);
    if (parent.model !== options.model || parent.schema_text !== (options.schema ? JSON.stringify(options.schema) : null))
      fail('contract_mismatch', 'Follow-up must retain the parent model and schema.');
    return this.launch(input, parent);
  }
  launch(input, parent) {
    const options = validateOptions(input.options);
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) fail('invalid_request', 'Task must be nonempty.');
    const cwd = resolve(input.cwd);
    if (!statSync(cwd).isDirectory()) fail('invalid_workspace', 'Workspace must be a directory.');
    const id = randomUUID();
    const directory = join(this.root, id);
    mkdirSync(directory);
    const artifact = join(directory, options.schema ? 'reply.json' : 'reply.md');
    const args = ['--output-format', 'json', '--print-timeout', '0', '--disable-slash-commands', '--mode', 'plan', '--dangerously-skip-permissions', '--add-dir', directory, '--model', options.model];
    if (parent) args.push('--conversation', parent.conversation_id);
    if (options.schema) {
      const schemaPath = join(directory, 'schema.json');
      atomicText(schemaPath, JSON.stringify(options.schema));
      args.push('--json-schema', schemaPath);
    }
    const promptPath = join(directory, 'task.md');
    atomicText(promptPath, `Workspace materials are authorized for read-only use. Leave project files and the running environment unchanged.\n\n${input.prompt}${options.schema ? '\n\nReturn the complete JSON value required by the supplied schema.' : ''}`);
    args.push('--print', `Read the complete UTF-8 task at ${JSON.stringify(promptPath)} and carry it out. The file contains the full role, authorized context and current request. Read it in full before answering. Leave workspace files and the running environment unchanged.`);
    const command = executable();
    this.db.prepare('INSERT INTO jobs(id,run_id,session_id,parent_id,agent_name,cwd,model,timeout_ms,schema_text,state,conversation_id,artifact_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.runId, input.sessionId ?? null, parent?.id ?? null, input.agent, cwd, options.model, options.timeoutMs, options.schema ? JSON.stringify(options.schema) : null, 'running', parent?.conversation_id ?? null, artifact);
    let child;
    try { child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      this.db.prepare("UPDATE jobs SET state='failed',failure_code='launch_failed',failure_message=? WHERE id=?").run(error.message, id);
      return this.handle(this.row(id));
    }
    let stdout = '', stderr = '', reason;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => this.cancelJob(id, 'timed_out'), options.timeoutMs);
    const finished = new Promise(resolveFinished => {
      child.on('error', error => { reason = { code: 'launch_failed', message: error.message }; });
      child.on('close', code => {
        clearTimeout(timer);
        const active = this.active.get(id);
        try {
          if (active?.cancelReason) fail(active.cancelReason, `agy process stopped (${active.cancelReason}); remote completion is unverified.`);
          if (reason) fail(reason.code, reason.message);
          const reply = parseReply(stdout, stderr, code, parent?.conversation_id, options.schema);
          atomicText(artifact, reply.body);
          this.db.prepare("UPDATE jobs SET state='completed',conversation_id=? WHERE id=?").run(reply.conversationId, id);
        } catch (error) {
          const errorCode = error.code ?? 'io_error';
          this.db.prepare('UPDATE jobs SET state=?,failure_code=?,failure_message=? WHERE id=?')
            .run(errorCode === 'cancelled' ? 'stopped' : 'failed', errorCode, error.message, id);
        }
        this.active.delete(id);
        resolveFinished();
      });
    });
    this.active.set(id, { child, finished, runId: input.runId });
    if (this.cancelledRuns.has(input.runId)) this.cancelJob(id, 'cancelled');
    return this.handle(this.row(id));
  }
  status(id) { return this.handle(this.row(id)); }
  result(id) {
    const row = this.row(id);
    return { ...this.handle(row), ...(row.state === 'completed' ? {
      output: readFileSync(row.artifact_path, 'utf8').trim(), artifactPath: row.artifact_path,
    } : {}) };
  }
  reattach(id) {
    const row = this.row(id);
    if (row.state === 'running' && !this.active.has(id)) fail('execution_unknown', 'The owning agy process is unavailable. Refusing to redispatch.');
    return this.handle(row);
  }
  cancelJob(id, reason = 'cancelled') {
    const active = this.active.get(id);
    if (!active) return;
    if (active.cancelFailure) throw active.cancelFailure;
    if (active.cancelReason) return;
    active.cancelReason = reason;
    if (!active.child.kill()) {
      active.cancelFailure = new ExternalJobProviderError('Could not terminate the owned agy process.', { code: 'cancel_failed' });
      throw active.cancelFailure;
    }
  }
  ownsRun(runId) { return [...this.active.values()].some(job => job.runId === runId); }
  async ownerTerminated(runId) {
    const row = this.db.prepare('SELECT id FROM jobs WHERE run_id=?').get(runId);
    if (!row || this.ownsRun(runId)) await this.cancelRun(runId);
  }
  async cancelRun(runId) {
    this.cancelledRuns.add(runId);
    const jobs = [...this.active.entries()].filter(([, job]) => job.runId === runId);
    for (const [id] of jobs) this.cancelJob(id);
    await Promise.all(jobs.map(([, job]) => job.finished));
  }
  async close() {
    const active = [...this.active.entries()];
    for (const [id] of active) this.cancelJob(id);
    await Promise.all(active.map(([, job]) => job.finished));
    this.db.close();
  }
}
