# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0:** breaking changes land in MINOR releases. Until 1.0 the minor
> number is not a compatibility promise — read the entry, not the version.

## [Unreleased]

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
