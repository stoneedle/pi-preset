import { check, context, finish, linkPreset, prepare } from './preset.mjs';

const ctx = context();
const actions = { prepare, link: linkPreset, finish, check };
const action = actions[process.argv[2]];
if (!action) throw new Error('usage: node scripts/setup.mjs prepare|link|finish|check');
try { await action(ctx); }
catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
