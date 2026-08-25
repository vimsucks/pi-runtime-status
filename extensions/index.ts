import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  cloneItems,
  createRuntimeItem,
  isRuntimeStatusSnapshot,
  parseRuntimeStatusSnapshot,
} from "../src/model.js";
import { probeRuntimeItem } from "../src/probe.js";
import { probeModes, runtimeStates } from "../src/types.js";
import type {
  RuntimeStatusInput,
  RuntimeStatusItem,
  RuntimeStatusSnapshot,
} from "../src/types.js";
import { renderRuntimeStatusPlain, renderRuntimeStatusWidget } from "../src/widget.js";

const TOOL_NAME = "runtime_status";
const WIDGET_KEY = "pi-runtime-status";
const MAX_ITEMS = 20;
const TICK_INTERVAL_MS = 1_000;

const RuntimeStatusParams = Type.Object({
  action: StringEnum(["upsert", "remove", "list", "clear", "refresh"] as const, {
    description: "Operation to perform on the current session's runtime status items.",
  }),
  id: Type.Optional(
    Type.String({
      description: "Stable lowercase item ID. Required for upsert and remove.",
      maxLength: 64,
    }),
  ),
  label: Type.Optional(
    Type.String({ description: "Human-readable label. Required for upsert.", maxLength: 80 }),
  ),
  state: Type.Optional(
    StringEnum(runtimeStates, {
      description: "Agent-declared lifecycle state. Required for upsert.",
    }),
  ),
  detail: Type.Optional(
    Type.String({ description: "Short contextual detail shown in the widget.", maxLength: 200 }),
  ),
  pid: Type.Optional(
    Type.Integer({ description: "Existing process ID to probe without owning it.", minimum: 1 }),
  ),
  pidFile: Type.Optional(
    Type.String({
      description: "Absolute path or path relative to the session working directory containing a PID.",
      maxLength: 1024,
    }),
  ),
  url: Type.Optional(
    Type.String({
      description: "HTTP or HTTPS link to display. Automatic HTTP probes are loopback-only.",
      maxLength: 2048,
    }),
  ),
  probe: Type.Optional(
    StringEnum(probeModes, {
      description: "Health probe mode. auto selects from pid, pidFile, and url; default: auto.",
    }),
  ),
  probeIntervalSeconds: Type.Optional(
    Type.Integer({
      description: "Background probe interval in seconds; default: 5.",
      minimum: 2,
      maximum: 300,
    }),
  ),
});

export default function piRuntimeStatus(pi: ExtensionAPI) {
  const items = new Map<string, RuntimeStatusItem>();
  const revisions = new Map<string, number>();
  const probing = new Set<string>();
  let activeContext: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let operationQueue: Promise<unknown> = Promise.resolve();

  const render = () => {
    const ctx = activeContext;
    if (!ctx?.hasUI) return;
    const snapshot = cloneItems(items.values());
    if (snapshot.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
        render: (width) => renderRuntimeStatusWidget(snapshot, width, theme),
        invalidate() {},
      }));
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, renderRuntimeStatusPlain(snapshot));
  };

  const restore = (ctx: ExtensionContext) => {
    items.clear();
    revisions.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
      const snapshot = parseRuntimeStatusSnapshot(message.details, MAX_ITEMS);
      if (!snapshot) continue;
      items.clear();
      revisions.clear();
      for (const item of snapshot.items) {
        items.set(item.id, {
          ...item,
          observation:
            item.probe === "none"
              ? { health: "unknown" }
              : { health: "pending", summary: "Waiting for the first probe" },
        });
        revisions.set(item.id, 1);
      }
    }
    render();
  };

  const probeOne = async (id: string, cwd: string) => {
    const item = items.get(id);
    if (!item || item.probe === "none" || probing.has(id)) return;
    const revision = revisions.get(id) ?? 0;
    probing.add(id);
    try {
      const observation = await probeRuntimeItem(item, cwd);
      if (revisions.get(id) !== revision || items.get(id) !== item) return;
      items.set(id, { ...item, observation });
      render();
    } finally {
      probing.delete(id);
    }
  };

  const probeAll = async (cwd: string) => {
    await Promise.all(Array.from(items.keys(), (id) => probeOne(id, cwd)));
  };

  const tick = () => {
    const ctx = activeContext;
    if (!ctx) return;
    const now = Date.now();
    for (const item of items.values()) {
      const checkedAt = item.observation.checkedAt
        ? Date.parse(item.observation.checkedAt)
        : 0;
      if (now - checkedAt >= item.probeIntervalSeconds * 1_000) {
        void probeOne(item.id, ctx.cwd).catch(() => undefined);
      }
    }
  };

  const startTimer = () => {
    if (timer) return;
    timer = setInterval(tick, TICK_INTERVAL_MS);
    timer.unref();
  };

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    restore(ctx);
    startTimer();
    void probeAll(ctx.cwd).catch(() => undefined);
  });

  pi.on("session_tree", (_event, ctx) => {
    activeContext = ctx;
    restore(ctx);
    void probeAll(ctx.cwd).catch(() => undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    probing.clear();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    activeContext = undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Runtime Status",
    description:
      "Publish, update, inspect, or remove persistent runtime status items in the Pi UI. Use this after starting a dev server, bot, watcher, dashboard, or other long-running resource. The tool only displays and probes existing resources; it never starts, owns, or stops processes.",
    promptSnippet:
      "Publish and monitor persistent status for dev servers, bots, watchers, dashboards, and other runtime resources",
    promptGuidelines: [
      "Use runtime_status after starting a long-running resource when its PID, PID file, port, URL, or lifecycle state will remain useful to the user.",
      "Update or remove runtime_status items when their lifecycle changes; do not claim that runtime_status owns or can stop the underlying process.",
    ],
    parameters: RuntimeStatusParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeContext = ctx;
      const run = async () => {
        const input = params as RuntimeStatusInput;
        switch (input.action) {
          case "upsert": {
            if (!input.id) throw new Error("id is required for upsert");
            const previous = items.get(input.id);
            if (!previous && items.size >= MAX_ITEMS) {
              throw new Error(`runtime_status supports at most ${MAX_ITEMS} items per session`);
            }
            const item = createRuntimeItem(input, previous);
            items.set(item.id, item);
            revisions.set(item.id, (revisions.get(item.id) ?? 0) + 1);
            render();
            await probeOne(item.id, ctx.cwd);
            break;
          }
          case "remove": {
            if (!input.id) throw new Error("id is required for remove");
            if (!items.delete(input.id)) throw new Error(`runtime status item not found: ${input.id}`);
            revisions.set(input.id, (revisions.get(input.id) ?? 0) + 1);
            render();
            break;
          }
          case "clear":
            items.clear();
            for (const id of revisions.keys()) revisions.set(id, (revisions.get(id) ?? 0) + 1);
            render();
            break;
          case "refresh":
            await probeAll(ctx.cwd);
            break;
          case "list":
            break;
        }

        const snapshot: RuntimeStatusSnapshot = {
          version: 1,
          action: input.action,
          items: cloneItems(items.values()),
        };
        return {
          content: [{ type: "text" as const, text: formatToolResult(snapshot) }],
          details: snapshot,
        };
      };

      const result = operationQueue.then(run, run);
      operationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("runtime_status "));
      text += theme.fg("muted", args.action);
      if (args.id) text += ` ${theme.fg("accent", args.id)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details;
      if (!isRuntimeStatusSnapshot(details)) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      const count = details.items.length;
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("muted", `${details.action}; ${count} runtime item${count === 1 ? "" : "s"}`),
        0,
        0,
      );
    },
  });
}

function formatToolResult(snapshot: RuntimeStatusSnapshot): string {
  if (snapshot.items.length === 0) return `Runtime status ${snapshot.action}; no items are registered.`;
  const lines = snapshot.items.map((item) => {
    const pid = item.observation.resolvedPid ?? item.pid;
    return [
      item.id,
      item.label,
      item.state,
      item.observation.health,
      pid ? `PID ${pid}` : undefined,
      item.url,
    ]
      .filter(Boolean)
      .join(" | ");
  });
  return `Runtime status ${snapshot.action}; ${snapshot.items.length} item(s):\n${lines.join("\n")}`;
}
