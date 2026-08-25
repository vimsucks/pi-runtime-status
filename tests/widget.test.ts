import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRuntimeItem } from "../src/model.js";
import { renderRuntimeStatusPlain, renderRuntimeStatusWidget } from "../src/widget.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

test("renders process details and an OSC 8 hyperlink", () => {
  const item = createRuntimeItem(
    {
      action: "upsert",
      id: "frontend",
      label: "Frontend",
      state: "ready",
      pid: 12345,
      url: "http://127.0.0.1:5173",
      probe: "none",
    },
    undefined,
    new Date("2026-08-25T00:00:00.000Z"),
  );
  const lines = renderRuntimeStatusWidget([item], 200, theme);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /Frontend/);
  assert.match(lines[1]!, /PID 12345/);
  assert.match(lines[1]!, /\u001b\]8;;http:\/\/127\.0\.0\.1:5173\//);

  const plain = renderRuntimeStatusPlain([item]);
  assert.match(plain[1]!, /http:\/\/127\.0\.0\.1:5173\//);
});

test("uses health precedence and never exceeds available width", () => {
  const item = createRuntimeItem(
    {
      action: "upsert",
      id: "frontend",
      label: "A very long frontend development server label",
      state: "running",
      detail: "A long detail that must be truncated",
      pid: 12345,
    },
    undefined,
    new Date("2026-08-25T00:00:00.000Z"),
  );
  item.observation = { health: "unhealthy", summary: "not reachable" };
  const lines = renderRuntimeStatusWidget([item], 32, theme);
  assert.match(lines[1]!, /unhealthy|A very long/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 32));
});
