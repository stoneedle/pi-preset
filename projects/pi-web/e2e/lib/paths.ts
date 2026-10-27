import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(E2E_ROOT, "..");

/** Path to the built pi-web binary. */
export const BINARY = process.env.PI_WEB_E2E_BINARY || join(
  REPO_ROOT,
  process.platform === "win32" ? "pi-web.exe" : "pi-web",
);

/** Committed, sanitized session fixtures copied into the temp dir at setup. */
export const FIXTURES_SESSIONS = join(E2E_ROOT, "fixtures", "sessions");

/** Build cache for the Windows stub launcher. Git-ignored. */
export const TMP_DIR = join(E2E_ROOT, ".tmp");
