import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Inspect exactly what an operator can read on the server, not a browser-side copy.
export function readDiagnostics(agentDir: string): Record<string, any>[] {
  const dir = join(agentDir, 'pi-web', 'diagnostics');
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(name => /^browser(?:\.[12])?\.jsonl$/.test(name)).flatMap(name => {
    let text: string;
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; } // A write may still be in flight.
    });
  });
}
