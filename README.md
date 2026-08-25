# pi-runtime-status

Let [Pi](https://pi.dev/) agents publish and monitor persistent runtime status items.

When an agent starts or discovers a long-running resource, it can call `runtime_status` to keep the useful operational details visible above the editor:

```text
Runtime (3)
● Frontend  ·  ready    ·  PID 14231  ·  http://127.0.0.1:5173/
● WeCom Bot ·  running  ·  PID 9184
● History   ·  ready    ·  PID 73140  ·  http://127.0.0.1:51327/
```

The extension is deliberately display-only. It can check an existing PID, PID file, or loopback HTTP endpoint, but it never starts, owns, signals, or stops a process.

## Features

- Exposes one LLM-callable `runtime_status` tool.
- Publishes runtime items with stable IDs, lifecycle states, short details, PIDs, PID files, and URLs.
- Keeps a persistent widget above the Pi editor.
- Produces clickable OSC 8 links in terminals that support them.
- Probes existing processes without sending a signal.
- Probes loopback HTTP and HTTPS endpoints with bounded requests and no redirect following.
- Refreshes health in the background while the Pi session is active.
- Restores state from tool-result details on resume, fork, and tree navigation.
- Preserves branch-local state instead of writing a global latest-state file.
- Supports TUI and RPC status surfaces; headless modes still receive structured tool results.

## Installation

Install directly from GitHub:

```bash
pi install git:github.com/vimsucks/pi-runtime-status
```

Install for one project only:

```bash
pi install -l git:github.com/vimsucks/pi-runtime-status
```

Run without installing:

```bash
pi -e git:github.com/vimsucks/pi-runtime-status
```

After the package is published to npm, it can also be installed with:

```bash
pi install npm:pi-runtime-status
```

## Agent tool

The extension registers one tool:

```text
runtime_status
```

### Upsert an item

```json
{
  "action": "upsert",
  "id": "frontend",
  "label": "Frontend",
  "state": "running",
  "detail": "Vite dev server",
  "pid": 14231,
  "url": "http://127.0.0.1:5173",
  "probe": "auto",
  "probeIntervalSeconds": 5
}
```

`auto` selects a probe from the supplied targets:

| Supplied target | Effective probe |
| --- | --- |
| `pid` or `pidFile` | `process` |
| `url` | `http` |
| Process target and `url` | `process-and-http` |
| No probe target | `none` |

### Register an existing process through a PID file

```json
{
  "action": "upsert",
  "id": "wecom-bot",
  "label": "WeCom Bot",
  "state": "running",
  "pidFile": ".data/runtime/bot.pid"
}
```

Relative PID-file paths resolve from the Pi session working directory. Absolute paths are also accepted.

### Display a link without probing it

Automatic HTTP probes are restricted to loopback URLs. An external URL can still be displayed by opting out of probing:

```json
{
  "action": "upsert",
  "id": "build",
  "label": "Remote Build",
  "state": "running",
  "url": "https://ci.example.com/builds/42",
  "probe": "none"
}
```

### Update lifecycle state

Upsert the same stable ID:

```json
{
  "action": "upsert",
  "id": "frontend",
  "label": "Frontend",
  "state": "ready",
  "detail": "HMR enabled",
  "pid": 14231,
  "url": "http://127.0.0.1:5173"
}
```

Supported lifecycle states are:

```text
starting, running, ready, completed, failed, stopped
```

### List, refresh, remove, or clear

```json
{ "action": "list" }
```

```json
{ "action": "refresh" }
```

```json
{ "action": "remove", "id": "frontend" }
```

```json
{ "action": "clear" }
```

A session can contain at most 20 runtime items. IDs must match:

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

## State and health model

Each item contains two independent signals:

- `state` is the lifecycle state declared by the agent.
- `observation.health` is the latest read-only probe result.

This distinction prevents a probe from rewriting the agent's semantic state. For example, a process may be alive while its declared state is still `starting`.

Process probes use Node.js `process.kill(pid, 0)`, which performs an existence/permission check without sending a signal. A PID can be reused by the operating system, so an alive result confirms only that a process currently owns that PID. It does not prove process identity.

HTTP probes:

- accept only `localhost`, `127.0.0.1`, or `::1` targets;
- use `GET` with a two-second timeout;
- do not follow redirects;
- treat responses below HTTP 500 as reachable;
- treat HTTP 500 and above as unhealthy.

## Session behavior

Runtime items are stored in `runtime_status` tool-result details. Pi therefore keeps the state on the session branch:

- resuming a session restores its latest runtime items;
- forking restores the state visible at the fork point;
- tree navigation reconstructs the state for the selected branch;
- starting a new session starts with an empty runtime widget.

Background probe observations are transient. The extension rechecks restored items instead of trusting stale health results.

## Development

Requirements:

- Node.js 22.19 or newer
- pnpm 11 or newer
- public npm registry access

The repository pins the registry in `.npmrc`:

```text
registry=https://registry.npmjs.org/
```

Install and verify:

```bash
pnpm install
pnpm check
pnpm test
pnpm pack:dry-run
```

Run locally without installing:

```bash
pi -e ./extensions/index.ts
```

## Security

Pi extensions run with the user's full system permissions. Review extension source before installation.

`pi-runtime-status`:

- does not spawn or stop processes;
- never sends a process signal other than the signal-free `kill(pid, 0)` existence check;
- reads only explicitly supplied PID files and parses only a positive integer from them;
- restricts automatic HTTP probes to loopback hosts;
- rejects URL credentials and non-HTTP schemes;
- does not follow HTTP redirects;
- bounds text fields, probe intervals, request duration, and item count;
- does not include PID-file contents or HTTP response bodies in tool output.

## License

MIT
