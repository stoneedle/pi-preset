import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, validateOptions, DEFAULT_MODEL } from '../adapter.mjs';

const envelope = response => JSON.stringify({ status: 'SUCCESS', conversation_id: 'c1', response });
test('reply contract preserves literal text and rejects a different continued conversation', () => {
  const text = '\r\n  model reply  \r\n';
  assert.equal(parseReply(envelope(text), '', 0).body, text);
  assert.throws(() => parseReply(envelope(text), '', 0, 'c2'), { code: 'conversation_mismatch' });
  assert.throws(() => parseReply(envelope(text), 'AGY_ERROR: capacity unavailable', 3), { code: 'cli_failed' });
});
test('structured finish is authoritative and keeps JSON shapes', () => {
  const schema = { type: 'array', items: { type: 'string' } };
  assert.deepEqual(parseReply(envelope('["one"]'), '', 0, undefined, schema).value, ['one']);
  const provider = { status: 'ERROR', conversation_id: 'c1', response: '["one"]\n{"summary":"done"}', json_schema: schema, structured_output: ['one'] };
  assert.deepEqual(parseReply(JSON.stringify(provider), '', 0, undefined, schema).value, ['one']);
  delete provider.structured_output;
  assert.throws(() => parseReply(JSON.stringify(provider), '', 0, undefined, schema), { code: 'ambiguous_json_response' });
});
test('Gemini options retain one explicit model and validate schemas before calling the CLI', () => {
  assert.equal(validateOptions().model, DEFAULT_MODEL);
  assert.equal(validateOptions({ model: 'gemini-3.8-flash-low' }).model, 'gemini-3.8-flash-low');
  assert.throws(() => validateOptions({ model: 'claude-opus-4-6-thinking' }), { code: 'invalid_model' });
  assert.throws(() => validateOptions({ schema: { type: 'imaginary' } }), { code: 'invalid_schema' });
});
