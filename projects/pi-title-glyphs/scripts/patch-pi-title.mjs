#!/usr/bin/env node
// Pi 1.0.4 writes default titles after extension binding. Give its existing
// setTitle API a persistent override, released by the native UI reset.
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/patch-pi-title.mjs <pi-coding-agent package directory>');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (version !== '1.0.4') throw new Error(`This host patch requires Pi 1.0.4; found ${version}.`);
const file = path.join(root, 'dist', 'modes', 'interactive', 'interactive-mode.js');
const source = fs.readFileSync(file, 'utf8');
const replacements = [
  ['    updateTerminalTitle() {\n', '    updateTerminalTitle() {\n        if (this.extensionTerminalTitle !== undefined) {\n            this.ui.terminal.setTitle(this.extensionTerminalTitle);\n            return;\n        }\n'],
  ['            setTitle: (title) => this.ui.terminal.setTitle(title),', '            setTitle: (title) => {\n                this.extensionTerminalTitle = title;\n                this.updateTerminalTitle();\n            },'],
  ['        this.defaultEditor.onExtensionShortcut = undefined;\n        this.updateTerminalTitle();', '        this.defaultEditor.onExtensionShortcut = undefined;\n        this.extensionTerminalTitle = undefined;\n        this.updateTerminalTitle();'],
];
if (replacements.every(([, next]) => source.includes(next))) {
  console.log(`Pi title owner already installed: ${file}`);
} else {
  let updated = source;
  for (const [before, after] of replacements) {
    if (updated.split(before).length !== 2) throw new Error(`Pi host source does not match the 1.0.4 title seam: ${file}`);
    updated = updated.replace(before, after);
  }
  // The distributed source map describes the original, unpatched line layout.
  updated = updated.replace('\n//# sourceMappingURL=interactive-mode.js.map', '');
  fs.writeFileSync(file, updated);
  console.log(`Installed Pi title owner: ${file}`);
}
