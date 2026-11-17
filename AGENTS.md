# Using @particle-academy/fancy-flow-mcp-js — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-flow-mcp-js @particle-academy/fancy-flow
```

- **Peer:** `@particle-academy/fancy-flow` `>=0.66 <2.0`.
- **Dependency:** `@particle-academy/agent-integrations` `>=0.45 <2.0` (installed
  for you). If your own code imports agent-integrations, declare it in your own
  dependencies rather than relying on this package to bring it.
- **Node:** `>=22`. No React, no third-party runtime code.
- Stdio server without writing a host: `npx @particle-academy/fancy-flow-mcp-js`
  (bin `fancy-flow-mcp-js`).

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). It is listed as the registry entry `fancy-flow-mcp-js`
(a package entry, not vendorable source). Find it with `search-backend-packages`
(stack `node`). The Laravel twin is `fancy-flow-mcp`.

For node kinds beyond the builtins, the catalog's `search-nodes`, `get-node` and
`node-install-instructions` cover the fancy-flow marketplace; a vendored node
shows up in this server's `list_node_kinds`.

## API essentials

| Import | Gives you |
|---|---|
| `@particle-academy/fancy-flow-mcp-js/authoring` | Graph authoring and validation, no server |
| `@particle-academy/fancy-flow-mcp-js` | `createFlowServer`, `MemoryDraftStore` |

```ts
import { createFlowServer, MemoryDraftStore } from "@particle-academy/fancy-flow-mcp-js";
import { attachStdio } from "@particle-academy/agent-integrations/mcp/stdio";

const server = createFlowServer({
  store: new MemoryDraftStore(),
  admits: (kind) =>
    kind.name.includes("terminal") ? "This host has no terminal sessions." : null,
});

attachStdio(server); // log to stderr, never stdout
```

- `admits(kind)` returns `null` to allow a kind, or a string to refuse it. Name
  the missing capability in the string.
- `store` takes any `DraftStore` (`list` / `get` / `save` / `remove`, sync or
  async). `MemoryDraftStore` forgets on restart; this package never persists
  anything itself.
- Other transports: attach any agent-integrations transport, or implement
  `Transport` (`send`, optional `close`) and pass each incoming frame to
  `server.receive(transport, frame)`.
- Protocol `2025-11-25`, negotiating back to `2024-11-05`. Not `2026-07-28`.

## Using the tools (for an agent connected to this server)

The 15 tools match the PHP twin's names and arguments: `create_workflow`,
`list_workflows`, `get_workflow`, `delete_workflow`, `add_node`, `remove_node`,
`configure_node`, `connect_nodes`, `remove_edge`, `list_node_kinds`,
`describe_node_kind`, `validate_workflow`, `export_workflow`,
`import_workflow`, `run_workflow`.

- Start from `list_node_kinds` / `describe_node_kind`; they read the live
  registry, including host-registered and vendored kinds.
- `configure_node` accepts an incomplete config and reports warnings. Call
  `validate_workflow` to learn whether the graph is finished.
- Every issue carries `source`: `"schema"` means fix the graph; `"host"` means
  the host refused (grant the capability or choose another kind).

## Traps

- **`run_workflow` is a wiring smoke test, not a production run.** It takes no
  executor argument. Only 9 of 31 builtin kinds have a TypeScript executor; the
  rest return `ok: false` with "No executor registered". Kind-level executors a
  host process registered (`registerTerminalHost`, `registerLlmClient`) do run.
- **Do not call `registerBuiltinKinds()`.** The kind registry fills itself on
  first read, and `@particle-academy/fancy-flow/registry` pulls in React.
- On stdio, write logs to stderr. Anything on stdout corrupts the protocol.
