import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [binary, base, ...sdkArgs] = process.argv.slice(2);
let packageFile;
for (const directory of [base, dirname(realpathSync(binary)), dirname(binary)]) {
  try { packageFile = findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(join(directory, 'pi-web-resolver.mjs'))); } catch { continue; }
  if (packageFile) break;
}
if (!packageFile) throw new Error('Pi SDK 不可用');
const entry = join(dirname(packageFile), 'dist', 'index.js');
