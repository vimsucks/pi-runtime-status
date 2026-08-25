export const runtimeStates = [
  "starting",
  "running",
  "ready",
  "completed",
  "failed",
  "stopped",
] as const;

export const probeModes = ["none", "auto", "process", "http", "process-and-http"] as const;

export type RuntimeState = (typeof runtimeStates)[number];
export type ProbeMode = (typeof probeModes)[number];
export type HealthState = "pending" | "healthy" | "unhealthy" | "stopped" | "unknown";

export interface RuntimeObservation {
  health: HealthState;
  checkedAt?: string;
  resolvedPid?: number;
  httpStatus?: number;
  summary?: string;
}

export interface RuntimeStatusItem {
  id: string;
  label: string;
  state: RuntimeState;
  detail?: string;
  pid?: number;
  pidFile?: string;
  url?: string;
  probe: ProbeMode;
  probeIntervalSeconds: number;
  createdAt: string;
  updatedAt: string;
  observation: RuntimeObservation;
}

export interface RuntimeStatusSnapshot {
  version: 1;
  action: "upsert" | "remove" | "list" | "clear" | "refresh";
  items: RuntimeStatusItem[];
}

export interface RuntimeStatusInput {
  action: RuntimeStatusSnapshot["action"];
  id?: string;
  label?: string;
  state?: RuntimeState;
  detail?: string;
  pid?: number;
  pidFile?: string;
  url?: string;
  probe?: ProbeMode;
  probeIntervalSeconds?: number;
}
