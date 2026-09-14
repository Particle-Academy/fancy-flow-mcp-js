# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0:** breaking changes land in MINOR releases. Until 1.0 the minor
> number is not a compatibility promise — read the entry, not the version.

## [Unreleased]

## [0.2.0] - 2026-09-13

**What to do:** if you only run `npx @particle-academy/fancy-flow-mcp-js`, or
reach the server over the wire, **nothing** — the wire is unchanged, and that is
tested rather than asserted (below). If your code calls `createFlowServer` and
connects it to a transport, **one line changes** — see the first entry.

### Changed

- **BREAKING for hosts that attach a transport themselves: `createFlowServer`
  now returns agent-integrations' `MicroMcpServer`, not the SDK's `McpServer`.**
  It has no `connect()`. For stdio, replace

  ```ts
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  await server.connect(new StdioServerTransport());
  ```

  with

  ```ts
  import { attachStdio } from "@particle-academy/agent-integrations/mcp/stdio";
  attachStdio(server);
  ```

  and declare `@particle-academy/agent-integrations` (`>=0.45 <2.0`) in your own
  dependencies, since you now import it. **If you served this over another SDK
  transport (Streamable HTTP, SSE), there is no drop-in replacement:** attach an
  agent-integrations transport, or implement its two-member `Transport` (`send`,
  optional `close`) and pass each incoming frame to
  `server.receive(transport, frame)`. The new `FlowServer` type names the return
  value.

  You can also delete the `registerBuiltinKinds()` call the 0.1.0 README told
  hosts to make. It is harmless, but unnecessary — the registry fills itself on
  first read — and its import, `@particle-academy/fancy-flow/registry`, loads
  React.

- **The server's wire behaviour is 0.1.0's, frame for frame, and a test holds it
  there.** Before the port, 0.1.0 was recorded: 340 JSON-RPC exchanges covering
  every tool's success and refusal paths, a matrix feeding every property of
  every tool each JSON type it does not accept, protocol-version negotiation and
  protocol edges. `tests/wire.test.ts` replays every request against 0.2.0 and
  compares the replies byte for byte inside `result` and `error` — tool
  schemas, reply bodies, validation messages, key order included.

  Six differences are deliberate, all at protocol edges a client that reads
  `tools/list` does not reach, each pinned in that test with its reason:

  - **Calling a tool that does not exist** is now a JSON-RPC error
    (`-32601 Unknown tool: <name>`), not an `isError` result. The spec classes it
    as a protocol error, and the PHP twin answers it that way too.
  - **`tools/call` with no `arguments`** is treated as `{}`, as the spec allows —
    a no-argument tool runs instead of being refused.
  - **`arguments` that is not an object** gets the same validation result every
    other bad argument gets, not a `-32603` carrying a raw issue dump.
  - **`tools/call` with no `name`** is `-32602`, saying so, not `-32603`.
  - **Unsupported methods** keep code `-32601`; the message now names the method.
  - **`initialize` with no `protocolVersion`** is answered with `2025-11-25`, as
    the PHP twin does, not failed with `-32603`.

  **What to do:** nothing, unless a client of yours matched on one of those
  exact replies.

- **Published from CI with npm provenance.** 0.1.0 was published by hand and
  carries none.

### Removed

- **`@modelcontextprotocol/sdk` and `zod` are no longer dependencies.** The SDK
  was refused under the suite's third-party policy. Its replacement is
  first-party (`@particle-academy/agent-integrations`, `>=0.45 <2.0`), and this
  package now has **no third-party runtime dependency**. Per the lockfile, the
  runtime install tree went from 94 packages to 7: four first-party, plus
  `react`, `react-dom` and `scheduler`, which arrive as peers of fancy-flow
  and agent-integrations (see Fixed). `zod` went too: tool schemas are now the literal JSON
  Schema that goes on the wire, checked by a small validator that refuses, at
  registration, any schema keyword it does not enforce.

  **What to do:** nothing — unless your own code imported `zod` or the SDK and
  relied on this package to install it. Declare it yourself if so.

### Fixed

- **The stdio binary could not start without React.** `npx
  @particle-academy/fancy-flow-mcp-js` ran a `registerBuiltinKinds()` imported
  from `@particle-academy/fancy-flow/registry`, which imports React: in a tree
  without React it died at startup with "Cannot find package 'react'", and in a
  tree with it, it loaded a UI library to serve JSON. The call is gone.
  `tests/stdio.e2e.test.ts` spawns the built binary with React made
  unimportable and does `initialize`, `tools/list` and `tools/call` over real
  pipes; against 0.1.0 it fails with the binary importing `react`.

  One thing this does not change: npm still *installs* React alongside this
  package, because `@particle-academy/fancy-flow` and
  `@particle-academy/agent-integrations` both declare it as a non-optional peer.
  Nothing here loads it.

- **The advertised default server version is pinned to `package.json`.** Its
  PHP twin had drifted — stale at 0.1.0 against a 0.4.0 package — and nothing
  here would have noticed the same drift after a release. `version.test.ts` pins
  the constant and checks the call site still uses it.

## [0.1.0] - 2026-09-09

### Added

- **The MCP server itself** — 15 tools, matching `fancy-flow-mcp` (PHP) name for
  name: `create_workflow`, `list_workflows`, `get_workflow`, `delete_workflow`,
  `add_node`, `remove_node`, `configure_node`, `connect_nodes`, `remove_edge`,
  `list_node_kinds`, `describe_node_kind`, `validate_workflow`,
  `export_workflow`, `import_workflow`, `run_workflow`.

  Parity is **asserted, not claimed**: a test reads the tool names out of the
  PHP twin's source (`#[Name('…')]`) and compares. It reports the denominator
  on failure, so "one tool missing" cannot be confused with "the parser broke",
  and it fails rather than skips if the sibling repo is present but unread.

- **`./server` subpath** — `createFlowServer({ store, admits })` for a host
  that brings its own transport, plus `MemoryDraftStore` for hosts that do not
  need drafts to outlive the process.

- **A runnable stdio binary** — `npx @particle-academy/fancy-flow-mcp-js`.
  Diagnostics go to stderr, because stdout carries the JSON-RPC frames and a
  stray `console.log` there corrupts the stream into a parse error.

- **`describeKind`, `fromDocument`, `removeEdge`** on the dependency-free
  `./authoring` core, so the new tools added no logic the core could not
  already express.

### Changed

- **Dependencies: `@modelcontextprotocol/sdk` and `zod`.** The SDK is 17 direct
  and 94 transitive packages, most of them serving an HTTP+SSE transport a
  stdio server never touches. It was still the right call, for one reason that
  outranks the count: **it speaks the protocol revisions `laravel/mcp` speaks**
  (`2025-11-25`, negotiating back to `2024-11-05`), and being the same protocol
  as the PHP twin is the whole point of the package. `zod` was already in the
  tree as the SDK's own dependency; declaring it adds no package.

  **`./authoring` still imports neither.** A host that wants graph authoring
  without a server pays for none of it — that split is why the core was built
  first.

### Known gap

- **`run_workflow` reaches less far here than in the PHP twin, and it is
  pinned rather than described.** PHP's `Builtin::executors()` binds a default
  executor for every builtin kind. The TypeScript runtime ships no equivalent:
  **9 of 31 builtin kinds carry an executor**, so the other 22 return
  `ok: false` with the engine's own "No executor registered" message rather
  than acting.

  That reaches the agent as a *result*, not a transport error — it could not
  run this graph, which is a true and useful answer. A test pins `9 of 31`, so
  when fancy-flow gains default executors the pin fails and this description
  gets corrected in the same breath instead of quietly under-promising forever.

- **Cannot talk to `2026-07-28` clients.** That revision removed `initialize`
  and made the protocol stateless; `prism-mcp` speaks only it. Neither twin can
  reach it today. The fix belongs to **both twins together** — a Node server
  that jumped ahead alone would stop being a twin.

### Security

- **`run_workflow` takes no executor argument, and the registry is bound as a
  literal at the call site** — the same shape the PHP twin uses. An
  agent-reachable run is structurally incapable of being pointed at a host's
  real infrastructure: unrepresentable beats forbidden, because a policy can be
  relaxed by a later edit and an absent parameter cannot be passed. A test
  asserts the tool's input schema holds exactly `workflow_id` and
  `initial_inputs`, and was verified to go red when a third is added.

  **What this does not claim:** kind-level executors still apply, so a host
  *process* that has called `registerTerminalHost` or `registerLlmClient` makes
  those reachable. That is the host's own doing and outside this package's
  reach — stated rather than papered over.
