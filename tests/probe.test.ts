import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeItem } from "../src/model.js";
import { probeRuntimeItem } from "../src/probe.js";

const now = new Date("2026-08-25T00:00:00.000Z");

test("probes the current process through a PID", async () => {
  const item = createRuntimeItem(
    {
      action: "upsert",
      id: "self",
      label: "Current process",
      state: "running",
      pid: process.pid,
    },
    undefined,
    now,
  );
  const observation = await probeRuntimeItem(item, process.cwd(), { now: () => now });
  assert.equal(observation.health, "healthy");
  assert.equal(observation.resolvedPid, process.pid);
});

test("reads a PID file without exposing its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-runtime-status-"));
  try {
    await writeFile(join(directory, "service.pid"), `${process.pid}\n`, "utf8");
    const item = createRuntimeItem(
      {
        action: "upsert",
        id: "pid-file",
        label: "PID file",
        state: "running",
        pidFile: "service.pid",
      },
      undefined,
      now,
    );
    const observation = await probeRuntimeItem(item, directory, { now: () => now });
    assert.equal(observation.health, "healthy");
    assert.equal(observation.resolvedPid, process.pid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports malformed and missing PID files without throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-runtime-status-"));
  try {
    await writeFile(join(directory, "bad.pid"), "not-a-pid\n", "utf8");
    const malformed = createRuntimeItem(
      {
        action: "upsert",
        id: "bad",
        label: "Bad PID",
        state: "running",
        pidFile: "bad.pid",
      },
      undefined,
      now,
    );
    const missing = createRuntimeItem(
      {
        action: "upsert",
        id: "missing",
        label: "Missing PID",
        state: "running",
        pidFile: "missing.pid",
      },
      undefined,
      now,
    );
    assert.match((await probeRuntimeItem(malformed, directory)).summary ?? "", /positive integer/);
    assert.equal((await probeRuntimeItem(missing, directory)).summary, "PID file could not be read");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("probes a loopback HTTP endpoint and records its status", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const item = createRuntimeItem(
      {
        action: "upsert",
        id: "http",
        label: "HTTP",
        state: "ready",
        url: `http://127.0.0.1:${address.port}`,
      },
      undefined,
      now,
    );
    const observation = await probeRuntimeItem(item, process.cwd(), { now: () => now });
    assert.equal(observation.health, "healthy");
    assert.equal(observation.httpStatus, 204);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("does not call fetch for display-only external links", async () => {
  const item = createRuntimeItem(
    {
      action: "upsert",
      id: "remote",
      label: "Remote",
      state: "running",
      url: "https://example.com/build/1",
      probe: "none",
    },
    undefined,
    now,
  );
  let called = false;
  const observation = await probeRuntimeItem(item, process.cwd(), {
    fetch: async () => {
      called = true;
      throw new Error("unexpected fetch");
    },
  });
  assert.equal(called, false);
  assert.equal(observation.health, "unknown");
});
