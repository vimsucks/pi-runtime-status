import { readFile } from "node:fs/promises";
import type { RuntimeObservation, RuntimeStatusItem } from "./types.js";
import { isLoopbackUrl, resolvePidFile } from "./model.js";

export interface ProbeOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export async function probeRuntimeItem(
  item: RuntimeStatusItem,
  cwd: string,
  options: ProbeOptions = {},
): Promise<RuntimeObservation> {
  if (item.probe === "none") return { health: "unknown" };

  const now = options.now?.() ?? new Date();
  const base: Pick<RuntimeObservation, "checkedAt"> = { checkedAt: now.toISOString() };
  let resolvedPid = item.pid;

  if (item.probe === "process" || item.probe === "process-and-http") {
    const pidFile = resolvePidFile(item, cwd);
    if (pidFile) {
      try {
        resolvedPid = parsePid(await readFile(pidFile, "utf8"));
      } catch (error) {
        return {
          ...base,
          health: "unhealthy",
          summary: error instanceof InvalidPidFileError ? error.message : "PID file could not be read",
        };
      }
    }
    if (!resolvedPid) {
      return { ...base, health: "unhealthy", summary: "No process identifier is available" };
    }
    if (!isProcessAlive(resolvedPid)) {
      return {
        ...base,
        health: "stopped",
        resolvedPid,
        summary: "Process is not running",
      };
    }
  }

  if (item.probe === "http" || item.probe === "process-and-http") {
    if (!item.url || !isLoopbackUrl(item.url)) {
      return {
        ...base,
        ...(resolvedPid ? { resolvedPid } : {}),
        health: "unhealthy",
        summary: "HTTP probe target is not a loopback URL",
      };
    }
    const result = await probeHttp(item.url, options);
    if (!result.reachable) {
      return {
        ...base,
        ...(resolvedPid ? { resolvedPid } : {}),
        health: "unhealthy",
        summary: "HTTP endpoint is not reachable",
      };
    }
    if (result.status >= 500) {
      return {
        ...base,
        ...(resolvedPid ? { resolvedPid } : {}),
        health: "unhealthy",
        httpStatus: result.status,
        summary: `HTTP ${result.status}`,
      };
    }
    return {
      ...base,
      ...(resolvedPid ? { resolvedPid } : {}),
      health: "healthy",
      httpStatus: result.status,
      summary: `HTTP ${result.status}`,
    };
  }

  return {
    ...base,
    ...(resolvedPid ? { resolvedPid } : {}),
    health: "healthy",
    summary: "Process is running",
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function probeHttp(
  url: string,
  options: ProbeOptions,
): Promise<{ reachable: true; status: number } | { reachable: false }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 2_000);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return { reachable: true, status: response.status };
  } catch {
    return { reachable: false };
  }
}

function parsePid(value: string): number {
  const text = value.trim();
  if (!/^\d+$/.test(text)) throw new InvalidPidFileError("PID file does not contain a positive integer");
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new InvalidPidFileError("PID file does not contain a positive integer");
  }
  return pid;
}

class InvalidPidFileError extends Error {}
