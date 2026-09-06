/**
 * `@particle-academy/fancy-flow-mcp-js` — the Node twin of `fancy-flow-mcp`.
 *
 * ## State: the authoring core is complete; the MCP transport is not written
 *
 * That is a deliberate ordering, not a half-finished package. The transport is
 * the only part needing a third-party dependency, and this kit requires owner
 * approval before any is added. The decision is open — specifically whether to
 * take `@modelcontextprotocol/sdk` (17 direct deps, most of them for the
 * HTTP+SSE transport a stdio server never uses) or build on a first-party
 * package that may already do the job.
 *
 * Everything below is unaffected by that decision, which is why it exists
 * first. Graph authoring, validation and the host-admission seam depend on
 * nothing but `@particle-academy/fancy-flow`, and a host that wants to author
 * graphs with its OWN transport — or none — can use this today.
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

export {
  addNode,
  authorableKinds,
  checkDraft,
  configureNode,
  connect,
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
