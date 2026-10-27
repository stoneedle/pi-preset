/**
 * pi-title-glyphs — title formatting and the external-badge contract.
 *
 * Everything here is pure or reads one small file, with no imports from pi.
 * Event wiring and the agent-directory lookup live in index.ts.
 */

import * as fs from "node:fs";
import type { ActivityState } from "../session-state.ts";
import { sessionPresentation } from "../../../../shared/session-presentation.js";

// ---------------------------------------------------------------- config ---
/** Project (cwd) name in the title — off by default. */
export function showCwd(): boolean {
  const v = (process.env.PI_TITLE_GLYPHS_CWD ?? "").trim().toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

export const TITLE_BUDGET = 72; // soft cap for the whole title (terminal truncates anyway)

const titleGlyphs: Record<string, string> = {
  running: "⏳",
  background: "🧩",
  "needs-you": "❗",
  idle: "⚪",
  completed: "✅",
  failed: "❌",
  stopped: "⏹️",
  unknown: "❓",
  disconnected: "🔌",
  reconnecting: "📴",
};

// -------------------------------------------------- external status badge ---
/**
 * One optional JSON file, written by any other extension. See the header for the
 * contract. Read fresh per render (a few hundred bytes); every failure mode —
 * missing, unreadable, malformed, expired — is the same silent "no badge".
 */
export type Badge = { emoji: string };

export function externalBadge(file: string): Badge | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return undefined;
    if (typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) && Date.now() > raw.expiresAt) {
      return undefined;
    }
    const emoji = typeof raw.emoji === "string" ? graphemes(oneLine(raw.emoji)).slice(0, 8).join("") : "";
    return emoji ? { emoji } : undefined;
  } catch {
    return undefined; // absent / unreadable / malformed — by design
  }
}

// --------------------------------------------------------------- helpers ---
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (part) => part.segment);
}

export function ellipsize(s: string, max: number): string {
  const parts = graphemes(s);
  if (max < 4) return parts.slice(0, Math.max(0, max)).join("");
  return parts.length <= max ? s : `${parts.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The saved name identifies the session; state and badges affect only the prefix. */
export type TitleInput = {
  state: ActivityState;
  unread: boolean | null;
  completed?: boolean;
  outcome?: string | null;
  cwdName?: string;
  title?: string;
  badge?: Badge;
};

export function renderTitle(input: TitleInput): string {
  const { title, badge } = input;
  const visual = sessionPresentation(input);
  const mid = showCwd() && input.cwdName ? ` ${input.cwdName}` : "";
  const glyph = `${titleGlyphs[visual.kind]}${visual.unread ? " 🔵" : ""}`;
  const badgePrefix = badge ? `${badge.emoji} ` : "";
  const prefix = `${badgePrefix}${glyph}${mid}`;
  if (!title) return ellipsize(prefix, TITLE_BUDGET);

  // Reserve the unread dot even when absent, so state changes never truncate a different name.
  const nameBudget = TITLE_BUDGET - graphemes(badgePrefix).length - 3 - graphemes(mid).length - 3;
  return ellipsize(`${prefix} · ${ellipsize(title, nameBudget)}`, TITLE_BUDGET);
}
