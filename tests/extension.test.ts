import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/index.js";

interface Harness {
  handlers: Map<string, Array<(event: unknown, ctx: any) => unknown>>;
  tool: any;
  setWidgetCalls: unknown[][];
}

function createHarness(): Harness {
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  const tools: any[] = [];
  const setWidgetCalls: unknown[][] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
  };
  extension(pi as any);
  assert.equal(tools.length, 1);
  return { handlers, tool: tools[0], setWidgetCalls };
}

function createContext(getBranch: () => unknown[], setWidgetCalls: unknown[][]) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    sessionManager: { getBranch },
    ui: {
      setWidget(...args: unknown[]) {
        setWidgetCalls.push(args);
      },
    },
  };
}

async function emit(harness: Harness, event: string, ctx: any) {
  for (const handler of harness.handlers.get(event) ?? []) await handler({}, ctx);
}

test("registers an agent-callable tool that publishes and clears a widget", async () => {
  const harness = createHarness();
  let branch: unknown[] = [];
  const ctx = createContext(() => branch, harness.setWidgetCalls);
  await emit(harness, "session_start", ctx);

  const added = await harness.tool.execute(
    "call-1",
    {
      action: "upsert",
      id: "self",
      label: "Current process",
      state: "running",
      pid: process.pid,
    },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(added.details.items.length, 1);
  assert.equal(added.details.items[0].observation.health, "healthy");
  assert.ok(harness.setWidgetCalls.some((call) => typeof call[1] === "function"));

  const cleared = await harness.tool.execute(
    "call-2",
    { action: "clear" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(cleared.details.items.length, 0);
  assert.deepEqual(harness.setWidgetCalls.at(-1), ["pi-runtime-status", undefined]);

  branch = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "runtime_status",
        details: added.details,
      },
    },
  ];
  await emit(harness, "session_tree", ctx);
  const restored = await harness.tool.execute(
    "call-3",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(restored.details.items[0].id, "self");

  await emit(harness, "session_shutdown", ctx);
  assert.deepEqual(harness.setWidgetCalls.at(-1), ["pi-runtime-status", undefined]);
});

test("serializes concurrent mutations and rejects missing action fields", async () => {
  const harness = createHarness();
  const ctx = createContext(() => [], harness.setWidgetCalls);
  await emit(harness, "session_start", ctx);

  await Promise.all([
    harness.tool.execute(
      "call-1",
      { action: "upsert", id: "one", label: "One", state: "running" },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    harness.tool.execute(
      "call-2",
      { action: "upsert", id: "two", label: "Two", state: "starting" },
      new AbortController().signal,
      undefined,
      ctx,
    ),
  ]);
  const listed = await harness.tool.execute(
    "call-3",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.deepEqual(
    listed.details.items.map((item: { id: string }) => item.id),
    ["one", "two"],
  );
  await assert.rejects(
    harness.tool.execute(
      "call-4",
      { action: "remove" },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /id is required/,
  );

  await emit(harness, "session_shutdown", ctx);
});
