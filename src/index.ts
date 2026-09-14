/**
 * `@particle-academy/fancy-flow-mcp-js` — the Node twin of `fancy-flow-mcp`.
 *
 * ## Two entry points, and the smaller one has no dependencies
 *
 * `./authoring` is the pure core: graph building, validation and the
 * host-admission seam, importing nothing but `@particle-academy/fancy-flow`.
 * A host with its own transport — or none — pays for nothing else.
 *
 * The root adds the MCP server, which is agent-integrations' first-party
 * `MicroMcpServer` from its headless `/mcp` subpath. That subpath imports no
 * package at all, so the server adds no third-party code and no React.
 *
 * 0.1.0 was built on `@modelcontextprotocol/sdk` instead, chosen because it
 * speaks the protocol revisions `laravel/mcp` does. The SDK was refused as a
 * dependency; the port negotiates the same revisions itself, and
 * `tests/wire.test.ts` holds it to 0.1.0's replies, recorded frame by frame.
 *
 * ## The split it is built around
 *
 * > **We own whether a graph is well-formed; the host owns whether it is
 * > allowed to run.**
 *
 * `checkDraft` returns both answers, TAGGED by source. Collapsing them costs an
 * author real time: "this graph is malformed" is fixed by editing the graph,
 * "this host will not run it" by granting a capability or choosing another
 * kind, and a caller that cannot tell them apart chases the wrong one.
 *
 * ## Two things it deliberately does NOT do
 *
 * **It never re-implements validation.** `importWorkflow` already reports
 * issues; a second validator is two copies of one rule, each with a test
 * asserting against itself, and the disagreement reaches an author as "the
 * editor accepted it and the MCP refused it".
 *
 * **It never runs a graph against real executors.** The PHP twin's `run` binds
 * `Builtin::executors()` as a literal at the call site with no injection seam,
 * so the agent-reachable path is structurally incapable of touching a host's
 * real infrastructure. When a run tool lands here it keeps that property the
 * same way — unrepresentable rather than forbidden. A host wanting a real run
 * calls `runFlow` itself, with its own executors, on its own authority.
 */

export { createFlowServer, MemoryDraftStore } from "./server";
export type { FlowServer, FlowServerOptions } from "./server";

export {
  addNode,
  authorableKinds,
  checkDraft,
  configureNode,
  connect,
  describeKind,
  fromDocument,
  removeEdge,
  removeNode,
  toDocument,
  AuthoringError,
} from "./authoring";

export type {
  AdmissionPolicy,
  AuthoringIssue,
  AuthoringOptions,
  DraftStore,
  WorkflowDraft,
} from "./authoring";
