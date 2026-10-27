import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { externalBadge, renderTitle, graphemes, ellipsize, TITLE_BUDGET } from "../src/format.ts";

const states = [
  { state: "working", unread: false, glyph: "⏳" },
  { state: "needs-you", unread: false, glyph: "❗" },
  { state: "resting", unread: false, glyph: "✓" },
  { state: "resting", unread: true, glyph: "🔵" },
] as const;

test("status changes preserve the saved name, including with an external badge", () => {
  const title = "Fix subtitle import";
  for (const { state, unread, glyph } of states) {
    assert.equal(renderTitle({ state, unread, title }), `${glyph} · ${title}`);
    assert.equal(renderTitle({ state, unread }), glyph);
    assert.equal(renderTitle({ state, unread, title, badge: { emoji: "🔓" } }), `🔓 ${glyph} · ${title}`);
  }
});

test("long names keep the same bounded text across status transitions", () => {
  const title = "排查字幕渲染与同步问题".repeat(20);
  for (const badge of [undefined, { emoji: "🔓" }]) {
    const titles = states.map(({ state, unread }) => renderTitle({ state, unread, title, badge }));
    assert.equal(new Set(titles.map((value) => value.split(" · ")[1])).size, 1);
    for (const value of titles) {
      assert.ok(graphemes(value).length <= TITLE_BUDGET);
      assert.ok(value.endsWith("…"));
    }
  }
});

test("project name is opt-in and preserves the saved name", () => {
  const previous = process.env.PI_TITLE_GLYPHS_CWD;
  try {
    delete process.env.PI_TITLE_GLYPHS_CWD;
    assert.equal(renderTitle({ state: "resting", unread: false, cwdName: "myproj", title: "Fix import" }), "✓ · Fix import");
    process.env.PI_TITLE_GLYPHS_CWD = "1";
    assert.equal(renderTitle({ state: "resting", unread: false, cwdName: "myproj", title: "Fix import" }), "✓ myproj · Fix import");
  } finally {
    if (previous === undefined) delete process.env.PI_TITLE_GLYPHS_CWD;
    else process.env.PI_TITLE_GLYPHS_CWD = previous;
  }
});

test("badge files produce a complete glyph only when valid and unexpired", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptg-badge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "badge.json");
  const read = (body: string) => { fs.writeFileSync(file, body); return externalBadge(file); };
  assert.equal(externalBadge(file), undefined);
  for (const body of ["{not json", "null", "{}", '{"emoji":5}']) assert.equal(read(body), undefined);
  assert.deepEqual(read('{"emoji":"🔓"}'), { emoji: "🔓" });
  assert.deepEqual(read(JSON.stringify({ emoji: "🔓", expiresAt: Date.now() + 60_000 })), { emoji: "🔓" });
  assert.equal(read(JSON.stringify({ emoji: "🔓", expiresAt: Date.now() - 1 })), undefined);
  assert.deepEqual(read(JSON.stringify({ emoji: "x".repeat(200) })), { emoji: "x".repeat(8) });
  assert.deepEqual(read(JSON.stringify({ emoji: "👨‍👩‍👧‍👦".repeat(9) })), { emoji: "👨‍👩‍👧‍👦".repeat(8) });
});

test("truncation preserves composite emoji, flags, and combining characters", () => {
  for (const unit of ["😀", "👨‍👩‍👧‍👦", "🇨🇳", "e\u0301"]) {
    const source = "a".repeat(65) + unit + " end".repeat(20);
    const value = renderTitle({ state: "resting", unread: false, title: source });
    assert.ok(value.isWellFormed());
    assert.ok(graphemes(value).length <= TITLE_BUDGET);
    assert.equal(ellipsize(unit.repeat(6), 4), unit.repeat(3) + "…");
    assert.equal(ellipsize(unit.repeat(6), 2), unit.repeat(2));
  }
});
