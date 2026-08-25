import type { Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth } from "@earendil-works/pi-tui";
import type { RuntimeStatusItem } from "./types.js";

export function renderRuntimeStatusWidget(
  items: readonly RuntimeStatusItem[],
  width: number,
  theme: Theme,
): string[] {
  if (items.length === 0 || width <= 0) return [];

  const lines = [
    truncateToWidth(
      theme.fg("accent", theme.bold("Runtime")) + theme.fg("dim", ` (${items.length})`),
      width,
    ),
  ];
  for (const item of items) {
    lines.push(truncateToWidth(renderItem(item, theme), width));
  }
  return lines;
}

export function renderRuntimeStatusPlain(items: readonly RuntimeStatusItem[]): string[] {
  if (items.length === 0) return [];
  return ["Runtime", ...items.map((item) => renderPlainItem(item))];
}

function renderItem(item: RuntimeStatusItem, theme: Theme): string {
  const presentation = presentationFor(item);
  const parts = [
    theme.fg(presentation.color, presentation.icon),
    theme.fg("text", item.label),
    theme.fg(presentation.color, presentation.status),
  ];
  const pid = item.observation.resolvedPid ?? item.pid;
  if (pid) parts.push(theme.fg("dim", `PID ${pid}`));
  if (item.detail) parts.push(theme.fg("muted", item.detail));
  if (item.url) parts.push(theme.fg("mdLink", hyperlink(item.url, item.url)));
  return parts.join(theme.fg("dim", "  ·  "));
}

function renderPlainItem(item: RuntimeStatusItem): string {
  const presentation = presentationFor(item);
  const parts = [presentation.icon, item.label, presentation.status];
  const pid = item.observation.resolvedPid ?? item.pid;
  if (pid) parts.push(`PID ${pid}`);
  if (item.detail) parts.push(item.detail);
  if (item.url) parts.push(item.url);
  return parts.join(" · ");
}

function presentationFor(item: RuntimeStatusItem): {
  icon: string;
  status: string;
  color: "success" | "error" | "warning" | "muted";
} {
  if (item.state === "failed" || item.observation.health === "unhealthy") {
    return { icon: "×", status: item.state === "failed" ? "failed" : "unhealthy", color: "error" };
  }
  if (item.state === "completed") {
    return { icon: "✓", status: "completed", color: "success" };
  }
  if (item.state === "stopped" || item.observation.health === "stopped") {
    return { icon: "○", status: "stopped", color: "muted" };
  }
  if (item.observation.health === "healthy") {
    return { icon: "●", status: item.state === "starting" ? "healthy" : item.state, color: "success" };
  }
  if (item.state === "starting" || item.observation.health === "pending") {
    return { icon: "◌", status: item.state, color: "warning" };
  }
  return { icon: "●", status: item.state, color: "success" };
}
