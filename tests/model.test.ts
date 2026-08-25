import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneItems,
  createRuntimeItem,
  isLoopbackUrl,
  isRuntimeStatusSnapshot,
} from "../src/model.js";

const now = new Date("2026-08-25T00:00:00.000Z");

test("auto selects process-and-http and preserves creation time on update", () => {
  const first = createRuntimeItem(
    {
      action: "upsert",
      id: "frontend",
      label: "Frontend",
      state: "running",
      pid: 123,
      url: "http://127.0.0.1:5173",
    },
    undefined,
    now,
  );
  const updated = createRuntimeItem(
    {
      action: "upsert",
      id: "frontend",
      label: "Frontend",
      state: "ready",
      pid: 123,
      url: "http://127.0.0.1:5173",
    },
    first,
    new Date("2026-08-25T00:01:00.000Z"),
  );

  assert.equal(first.probe, "process-and-http");
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.updatedAt, "2026-08-25T00:01:00.000Z");
  assert.equal(updated.observation.health, "pending");
});

test("external links require display-only probe mode", () => {
  assert.throws(
    () =>
      createRuntimeItem(
        {
          action: "upsert",
          id: "build",
          label: "Build",
          state: "running",
          url: "https://ci.example.com/build/1",
        },
        undefined,
        now,
      ),
    /loopback URLs/,
  );

  const item = createRuntimeItem(
    {
      action: "upsert",
      id: "build",
      label: "Build",
      state: "running",
      url: "https://ci.example.com/build/1",
      probe: "none",
    },
    undefined,
    now,
  );
  assert.equal(item.probe, "none");
});

test("validates IDs, text, PIDs, intervals, and URLs", () => {
  const base = { action: "upsert" as const, label: "Service", state: "running" as const };
  assert.throws(() => createRuntimeItem({ ...base, id: "Bad ID" }, undefined, now), /id must match/);
  assert.throws(() => createRuntimeItem({ ...base, id: "service", pid: 0 }, undefined, now), /positive/);
  assert.throws(
    () => createRuntimeItem({ ...base, id: "service", detail: "bad\ntext" }, undefined, now),
    /control characters/,
  );
  assert.throws(
    () => createRuntimeItem({ ...base, id: "service", probeIntervalSeconds: 1 }, undefined, now),
    /between 2 and 300/,
  );
  assert.throws(
    () =>
      createRuntimeItem(
        { ...base, id: "service", url: "http://user:password@127.0.0.1" },
        undefined,
        now,
      ),
    /credentials/,
  );
});

test("recognizes loopback URLs and clones observations", () => {
  assert.equal(isLoopbackUrl("http://localhost:3000"), true);
  assert.equal(isLoopbackUrl("http://127.0.0.1:3000"), true);
  assert.equal(isLoopbackUrl("http://[::1]:3000"), true);
  assert.equal(isLoopbackUrl("https://example.com"), false);

  const item = createRuntimeItem(
    { action: "upsert", id: "service", label: "Service", state: "running" },
    undefined,
    now,
  );
  const cloned = cloneItems([item]);
  cloned[0]!.observation.health = "healthy";
  assert.equal(item.observation.health, "unknown");
  assert.equal(isRuntimeStatusSnapshot({ version: 1, action: "list", items: cloned }), true);
});

test("rejects malformed restored session snapshots", () => {
  const item = createRuntimeItem(
    { action: "upsert", id: "service", label: "Service", state: "running" },
    undefined,
    now,
  );
  assert.equal(
    isRuntimeStatusSnapshot({
      version: 1,
      action: "list",
      items: [{ ...item, label: "unsafe\u001b]8;;https://example.com" }],
    }),
    false,
  );
  assert.equal(
    isRuntimeStatusSnapshot({
      version: 1,
      action: "list",
      items: [{ ...item, observation: { health: "invented" } }],
    }),
    false,
  );
});
