/**
 * pi-title-glyphs — title formatting and the external-badge contract.
 *
 * Everything here is pure or reads one small file, with no imports from pi.
 * Event wiring and the agent-directory lookup live in index.ts.
 */

import * as fs from "node:fs";

// ---------------------------------------------------------------- config ---
/** Project (cwd) name in the title — off by default. */
export function showCwd(): boolean {
  const v = (process.env.PI_TITLE_GLYPHS_CWD ?? "").trim().toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

export const GLYPH_WORKING = "⏳"; // actively running tools/thinking
export const GLYPH_NEEDS_YOU = "❗"; // blocked on user input — urgent
export const GLYPH_READ = "✓"; // finished and viewed, or a fresh session
export const GLYPH_UNREAD = "🔵"; // finished while the terminal was unfocused

export const TITLE_BUDGET = 72; // soft cap for the whole title (terminal truncates anyway)

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
  state: "working" | "needs-you" | "resting";
  unread: boolean;
  cwdName?: string;
  title?: string;
  badge?: Badge;
};

export function renderTitle(input: TitleInput): string {
  const { state, unread, title, badge } = input;
  const mid = showCwd() && input.cwdName ? ` ${input.cwdName}` : "";
  const glyph = state === "working" ? GLYPH_WORKING
    : state === "needs-you" ? GLYPH_NEEDS_YOU
    : unread ? GLYPH_UNREAD : GLYPH_READ;
  const badgePrefix = badge ? `${badge.emoji} ` : "";
  const prefix = `${badgePrefix}${glyph}${mid}`;
  if (!title) return ellipsize(prefix, TITLE_BUDGET);

  const nameBudget = TITLE_BUDGET - graphemes(badgePrefix).length - 1 - graphemes(mid).length - 3;
  return ellipsize(`${prefix} · ${ellipsize(title, nameBudget)}`, TITLE_BUDGET);
}
