import { isAbsolute, resolve } from "node:path";
import type {
  ProbeMode,
  RuntimeStatusInput,
  RuntimeStatusItem,
  RuntimeStatusSnapshot,
} from "./types.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SNAPSHOT_ACTIONS = new Set(["upsert", "remove", "list", "clear", "refresh"]);
const RUNTIME_STATES = new Set(["starting", "running", "ready", "completed", "failed", "stopped"]);
const PROBE_MODES = new Set(["none", "auto", "process", "http", "process-and-http"]);
const HEALTH_STATES = new Set(["pending", "healthy", "unhealthy", "stopped", "unknown"]);

export function createRuntimeItem(
  input: RuntimeStatusInput,
  previous: RuntimeStatusItem | undefined,
  now = new Date(),
): RuntimeStatusItem {
  const id = requireText(input.id, "id", 64);
  if (!ID_PATTERN.test(id)) {
    throw new Error("id must match /^[a-z0-9][a-z0-9._-]{0,63}$/");
  }

  const label = requireText(input.label, "label", 80);
  const state = input.state;
  if (!state) throw new Error("state is required for upsert");

  const detail = optionalText(input.detail, "detail", 200);
  const pidFile = optionalText(input.pidFile, "pidFile", 1024);
  const url = normalizeUrl(input.url);
  const pid = input.pid;
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error("pid must be a positive safe integer");
  }

  const probe = resolveProbeMode(input.probe ?? "auto", {
    hasProcess: pid !== undefined || pidFile !== undefined,
    hasHttp: url !== undefined,
  });
  const probeIntervalSeconds = input.probeIntervalSeconds ?? 5;
  if (
    !Number.isInteger(probeIntervalSeconds) ||
    probeIntervalSeconds < 2 ||
    probeIntervalSeconds > 300
  ) {
    throw new Error("probeIntervalSeconds must be an integer between 2 and 300");
  }

  if ((probe === "http" || probe === "process-and-http") && url && !isLoopbackUrl(url)) {
    throw new Error("automatic HTTP probes are restricted to loopback URLs; use probe=none for display-only links");
  }

  const timestamp = now.toISOString();
  return {
    id,
    label,
    state,
    ...(detail ? { detail } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(pidFile ? { pidFile } : {}),
    ...(url ? { url } : {}),
    probe,
    probeIntervalSeconds,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    observation:
      probe === "none"
        ? { health: "unknown" }
        : {
            health: "pending",
            summary: "Waiting for the first probe",
          },
  };
}

export function resolvePidFile(item: RuntimeStatusItem, cwd: string): string | undefined {
  if (!item.pidFile) return undefined;
  return isAbsolute(item.pidFile) ? item.pidFile : resolve(cwd, item.pidFile);
}

export function parseRuntimeStatusSnapshot(
  value: unknown,
  maxItems = 20,
): RuntimeStatusSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !isSnapshotAction(candidate.action) || !Array.isArray(candidate.items)) {
    return undefined;
  }
  try {
    const items = candidate.items.slice(0, maxItems).map((value) => parseRuntimeItem(value));
    return { version: 1, action: candidate.action, items };
  } catch {
    return undefined;
  }
}

export function isRuntimeStatusSnapshot(value: unknown): value is RuntimeStatusSnapshot {
  return parseRuntimeStatusSnapshot(value) !== undefined;
}

export function cloneItems(items: Iterable<RuntimeStatusItem>): RuntimeStatusItem[] {
  return Array.from(items, (item) => ({
    ...item,
    observation: { ...item.observation },
  }));
}

export function isLoopbackUrl(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function parseRuntimeItem(value: unknown): RuntimeStatusItem {
  if (!value || typeof value !== "object") throw new Error("invalid runtime item");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.label !== "string") {
    throw new Error("invalid runtime item identity");
  }
  if (!isRuntimeState(item.state) || !isProbeMode(item.probe)) {
    throw new Error("invalid runtime item state");
  }
  assertOptionalType(item.detail, "string", "detail");
  assertOptionalType(item.pidFile, "string", "pidFile");
  assertOptionalType(item.url, "string", "url");
  assertOptionalType(item.pid, "number", "pid");
  if (typeof item.probeIntervalSeconds !== "number") {
    throw new Error("invalid probe interval");
  }
  const createdAt = requireTimestamp(item.createdAt, "createdAt");
  const updatedAt = requireTimestamp(item.updatedAt, "updatedAt");
  const normalized = createRuntimeItem(
    {
      action: "upsert",
      id: item.id,
      label: item.label,
      state: item.state,
      ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
      ...(typeof item.pid === "number" ? { pid: item.pid } : {}),
      ...(typeof item.pidFile === "string" ? { pidFile: item.pidFile } : {}),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
      probe: item.probe,
      probeIntervalSeconds: item.probeIntervalSeconds,
    },
    undefined,
    new Date(createdAt),
  );
  return {
    ...normalized,
    createdAt,
    updatedAt,
    observation: parseObservation(item.observation),
  };
}

function parseObservation(value: unknown): RuntimeStatusItem["observation"] {
  if (!value || typeof value !== "object") throw new Error("invalid observation");
  const observation = value as Record<string, unknown>;
  if (!isHealthState(observation.health)) throw new Error("invalid health state");
  assertOptionalType(observation.checkedAt, "string", "checkedAt");
  assertOptionalType(observation.resolvedPid, "number", "resolvedPid");
  assertOptionalType(observation.httpStatus, "number", "httpStatus");
  assertOptionalType(observation.summary, "string", "summary");
  const checkedAt =
    typeof observation.checkedAt === "string"
      ? requireTimestamp(observation.checkedAt, "checkedAt")
      : undefined;
  if (
    typeof observation.resolvedPid === "number" &&
    (!Number.isSafeInteger(observation.resolvedPid) || observation.resolvedPid <= 0)
  ) {
    throw new Error("invalid observed PID");
  }
  if (
    typeof observation.httpStatus === "number" &&
    (!Number.isInteger(observation.httpStatus) ||
      observation.httpStatus < 100 ||
      observation.httpStatus > 599)
  ) {
    throw new Error("invalid HTTP status");
  }
  const summary =
    typeof observation.summary === "string"
      ? optionalText(observation.summary, "summary", 200)
      : undefined;
  return {
    health: observation.health,
    ...(checkedAt ? { checkedAt } : {}),
    ...(typeof observation.resolvedPid === "number"
      ? { resolvedPid: observation.resolvedPid }
      : {}),
    ...(typeof observation.httpStatus === "number"
      ? { httpStatus: observation.httpStatus }
      : {}),
    ...(summary ? { summary } : {}),
  };
}

function isSnapshotAction(value: unknown): value is RuntimeStatusSnapshot["action"] {
  return typeof value === "string" && SNAPSHOT_ACTIONS.has(value);
}

function isRuntimeState(value: unknown): value is RuntimeStatusItem["state"] {
  return typeof value === "string" && RUNTIME_STATES.has(value);
}

function isProbeMode(value: unknown): value is RuntimeStatusItem["probe"] {
  return typeof value === "string" && PROBE_MODES.has(value);
}

function isHealthState(
  value: unknown,
): value is RuntimeStatusItem["observation"]["health"] {
  return typeof value === "string" && HEALTH_STATES.has(value);
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function assertOptionalType(
  value: unknown,
  expected: "string" | "number",
  field: string,
): void {
  if (value !== undefined && typeof value !== expected) {
    throw new Error(`${field} has an invalid type`);
  }
}

function resolveProbeMode(
  requested: ProbeMode,
  targets: { hasProcess: boolean; hasHttp: boolean },
): ProbeMode {
  if (requested === "auto") {
    if (targets.hasProcess && targets.hasHttp) return "process-and-http";
    if (targets.hasProcess) return "process";
    if (targets.hasHttp) return "http";
    return "none";
  }
  if ((requested === "process" || requested === "process-and-http") && !targets.hasProcess) {
    throw new Error(`${requested} requires pid or pidFile`);
  }
  if ((requested === "http" || requested === "process-and-http") && !targets.hasHttp) {
    throw new Error(`${requested} requires url`);
  }
  return requested;
}

function normalizeUrl(value: string | undefined): string | undefined {
  const text = optionalText(value, "url", 2048);
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("url must be an absolute HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
  if (url.username || url.password) throw new Error("url must not contain credentials");
  return url.toString();
}

function requireText(value: string | undefined, field: string, maxLength: number): string {
  const text = optionalText(value, field, maxLength);
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optionalText(
  value: string | undefined,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
  if (CONTROL_CHARACTER_PATTERN.test(text)) throw new Error(`${field} must not contain control characters`);
  return text;
}
