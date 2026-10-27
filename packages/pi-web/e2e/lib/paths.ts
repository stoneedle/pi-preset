import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(E2E_ROOT, "..");

/** The Makefile owns the normal build output location. */
export function resolveBuildBinary(root = REPO_ROOT): string {
  const result = spawnSync("make", ["--no-print-directory", "-s", "binary-path"], {
    cwd: root, encoding: "utf8",
  });
  if (result.error || result.status !== 0 || !result.stdout.trim())
    throw new Error(`Could not resolve the build output: ${result.error?.message || result.stderr}`);
  return resolve(root, result.stdout.trim());
}

export const BINARY = process.env.PI_WEB_E2E_BINARY || resolveBuildBinary();

/** Committed, sanitized session fixtures copied into the temp dir at setup. */
export const FIXTURES_SESSIONS = join(E2E_ROOT, "fixtures", "sessions");

/** Fixed build output for the Windows test launcher. */
export const TMP_DIR = join(REPO_ROOT, "build", "e2e");
