# @particle-academy/fancy-flow-mcp-js

**MCP server that lets an agent author [fancy-flow](https://github.com/Particle-Academy/fancy-flow) workflows headlessly on a TypeScript host — the Node twin of [`fancy-flow-mcp`](https://github.com/Particle-Academy/fancy-flow-mcp) (Laravel).**

Same 15 tools, same names, same arguments. An agent that learned to build graphs
against the PHP server drives this one without relearning anything — and that
claim is asserted by a test that reads the PHP source, not maintained by hand.

```bash
npx @particle-academy/fancy-flow-mcp-js
```

## The split it is built around

> **We own whether a graph is well-formed; the host owns whether it is allowed to run.**

Every issue crosses the wire **tagged** with which of those refused it:

```json
{ "source": "schema", "level": "error",   "message": "message: Message is required", "nodeId": "log-1" }
{ "source": "host",   "level": "error",   "message": "This host cannot resume a paused run.", "nodeId": "ask-1" }
```

Those have different remedies — one is fixed by editing the graph, the other by
granting a capability or picking another kind. Collapsing them costs an author
real time chasing the wrong fix, so they are never merged.

## Two entry points

| Import | What it costs | Use it when |
|---|---|---|
| `@particle-academy/fancy-flow-mcp-js/authoring` | **nothing** beyond `fancy-flow` | You want graph authoring and validation, no server |
| `@particle-academy/fancy-flow-mcp-js` | + `@particle-academy/agent-integrations` | You want an MCP server |

The core was written first and deliberately depends on nothing, so a host that
only wants to build and validate graphs never pays for a server it will not use.

**No third-party runtime code, and no React.** The server is agent-integrations'
first-party `MicroMcpServer`, imported from its headless `/mcp` subpath, which
imports no package at all. (Until 0.2.0 it was `@modelcontextprotocol/sdk` —
see the changelog for what changed and what did not.)

## Use it from a host

```ts
import { createFlowServer, MemoryDraftStore } from "@particle-academy/fancy-flow-mcp-js";
import { attachStdio } from "@particle-academy/agent-integrations/mcp/stdio";

const server = createFlowServer({
  store: new MemoryDraftStore(),

  // Your answer to "may I run this kind here?". Return a string to REFUSE —
  // and name the missing capability, because a refusal an author can act on is
  // worth more than a correct one they cannot.
  admits: (kind) =>
    kind.name.includes("terminal") ? "This host has no terminal sessions." : null,
});

attachStdio(server); // stdin/stdout; log to stderr, never stdout
```

Importing `@particle-academy/agent-integrations` yourself? Declare it in your own
dependencies (`>=0.45 <2.0`) rather than relying on this package to bring it.

There is no need to call `registerBuiltinKinds()`: the kind registry fills
itself on first read. It is also the wrong import for a headless host —
`@particle-academy/fancy-flow/registry` pulls in React.

`createFlowServer` returns a transport-agnostic server. For anything other than
stdio, attach any agent-integrations transport, or implement its two-member
`Transport` (`send`, optional `close`) and hand each incoming frame to
`server.receive(transport, frame)`.

`MemoryDraftStore` is a convenience. Implement `DraftStore` (`list` / `get` /
`save` / `remove`, sync or async) against your own storage and drafts survive a
restart — **this package never persists anything itself.**

## The tools

| | |
|---|---|
| `create_workflow` `list_workflows` `get_workflow` `delete_workflow` | Drafts |
| `add_node` `remove_node` `configure_node` | Nodes |
| `connect_nodes` `remove_edge` | Edges |
| `list_node_kinds` `describe_node_kind` | The vocabulary |
| `validate_workflow` `export_workflow` `import_workflow` | Checking and portability |
| `run_workflow` | A smoke test of wiring — see below |

`list_node_kinds` reads the **live registry**, so kinds a host registered itself
and kinds vendored from the marketplace are included. It is not a fixed list.

`configure_node` **writes a config that fails validation** and reports warnings
rather than refusing. A half-configured node is a normal intermediate state when
an agent builds a graph one step at a time; `validate_workflow` is the place
that says "not finished".

## `run_workflow` — read this before relying on it

**It is a smoke test of wiring and routing, not a production run.**

It takes **no executor argument**, and the executor registry is bound as a
literal at the call site — the same shape the PHP twin uses. An agent-reachable
run is structurally incapable of being pointed at your real infrastructure.
*Unrepresentable beats forbidden:* a policy can be relaxed by a later edit; an
absent parameter cannot be passed.

**Two honest limits:**

1. **9 of 31 builtin kinds have a TypeScript executor.** The PHP twin's
   `Builtin::executors()` covers every kind; the TS runtime has no equivalent
   yet. The other 22 return `ok: false` with "No executor registered" — a true
   answer about this runtime, delivered as a result rather than an error. A test
   pins the count so the day it improves, this paragraph is forced to change.
2. **Kind-level executors still apply.** A host *process* that has called
   `registerTerminalHost` or `registerLlmClient` makes those reachable from
   here. That is your doing, not this package's, and it is said plainly rather
   than papered over.

## Protocol revision

Speaks **`2025-11-25`**, negotiating back to `2024-11-05` — the same family
`laravel/mcp` speaks, which is what the PHP twin is built on, and what Claude
Code and Codex speak. `initialize` echoes any of those a client asks for and
answers `2025-11-25` otherwise.

It does **not** speak `2026-07-28`, the revision that removed `initialize` and
made the protocol stateless. Neither does the PHP twin. If you need to be
reached by a `2026-07-28`-only client, that gap is open and belongs to both
twins together — a Node server that jumped ahead alone would stop being a twin.

## Licence

MIT
