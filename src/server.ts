/**
 * The MCP server — `fancy-flow-mcp-js`, the Node twin of `fancy-flow-mcp`.
 *
 * ## Why the SDK, and why this protocol revision
 *
 * `@modelcontextprotocol/sdk` speaks `2025-11-25` and negotiates back to
 * `2024-11-05`. That is the same family `laravel/mcp` speaks, which is what the
 * PHP twin is built on — and being the same protocol as the twin is the whole
 * point of the package. It is also what Claude Code and Codex speak.
 *
 * It is NOT the only revision that exists: `2026-07-28` removed `initialize`
 * and made the protocol stateless, and at least one first-party client
 * (`prism-mcp`) speaks only that. **We cannot talk to it, and neither can the
 * PHP twin.** That gap belongs to both twins together — a Node server that
 * jumped ahead alone would stop being a twin, which costs more than the gap
 * does. Recorded rather than quietly left as a surprise for whoever tries it.
 *
 * ## The split every tool here preserves
 *
 * > **We own whether a graph is well-formed; the host owns whether it is
 * > allowed to run.**
 *
 * Every issue crosses the wire TAGGED with which of those refused it, because
 * the remedies are different and an agent that cannot tell them apart chases
 * the wrong one.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runFlow } from "@particle-academy/fancy-flow/engine";
import {
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
  type AdmissionPolicy,
  type AuthoringIssue,
  type DraftStore,
  type WorkflowDraft,
} from "./authoring";

/**
 * A `DraftStore` that keeps drafts in memory.
 *
 * For tests, for a CLI, and for a single-process host that does not care about
 * surviving a restart. A real host implements `DraftStore` against its own
 * storage — this package never persists anything on its own.
 */
export class MemoryDraftStore implements DraftStore {
  private drafts = new Map<string, WorkflowDraft>();

  list(): WorkflowDraft[] {
    return [...this.drafts.values()];
  }

  get(id: string): WorkflowDraft | null {
    return this.drafts.get(id) ?? null;
  }

  save(draft: WorkflowDraft): void {
    this.drafts.set(draft.id, draft);
  }

  remove(id: string): void {
    this.drafts.delete(id);
  }
}

export type FlowServerOptions = {
  store: DraftStore;
  /** The host's answer to "may I run this kind here?". Omitted admits everything. */
  admits?: AdmissionPolicy;
  /** Overrides for the advertised server identity. */
  serverInfo?: { name?: string; version?: string };
};

/** Pretty-printed JSON as text — the same reply shape the PHP twin uses. */
function reply(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * An error the AGENT can act on, not a dead transport.
 *
 * A thrown handler reaches the client as a protocol failure, and an agent
 * cannot tell "I named a kind that does not exist" from "the server died" —
 * so it retries the whole session instead of fixing one argument.
 */
function refuse(message: string, extra: Record<string, unknown> = {}) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

/** Run a handler, turning an authoring refusal into a usable error result. */
async function attempt<T>(fn: () => Promise<T> | T) {
  try {
    return { ok: true as const, value: await fn() };
  } catch (error) {
    if (error instanceof AuthoringError) return { ok: false as const, message: error.message };
    throw error;
  }
}

let counter = 0;

/** Ids are readable and unique within a process; a host may pass its own. */
function mintId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function createFlowServer(options: FlowServerOptions): McpServer {
  const { store, admits } = options;

  const server = new McpServer({
    name: options.serverInfo?.name ?? "fancy-flow-mcp-js",
    version: options.serverInfo?.version ?? "0.1.0",
  });

  /** Load a draft or hand the agent an error naming the id it asked for. */
  const load = async (id: string): Promise<WorkflowDraft | null> => (await store.get(id)) ?? null;

  const missing = (id: string) =>
    refuse(
      `No workflow "${id}". Call list_workflows to see what exists on this host, `
        + "or create_workflow to start one.",
      { workflow_id: id },
    );

  const summarize = (draft: WorkflowDraft) => ({
    workflow_id: draft.id,
    name: draft.name,
    nodes: draft.graph.nodes.length,
    edges: draft.graph.edges.length,
  });

  // ── Workflows ──────────────────────────────────────────────────────────────

  server.registerTool(
    "create_workflow",
    {
      title: "Create Workflow",
      description:
        "Start a new, empty workflow draft and return its workflow_id. Every other tool takes that id. "
        + "Nothing is persisted beyond the host's store, and creating a workflow never runs anything.",
      inputSchema: {
        name: z.string().describe("Human-readable name for the workflow, e.g. \"Nightly digest\"."),
        workflow_id: z.string().optional().describe("Optional explicit id. Omit to have one minted."),
      },
    },
    async ({ name, workflow_id }) => {
      const draft: WorkflowDraft = {
        id: workflow_id ?? mintId("wf"),
        name,
        graph: { nodes: [], edges: [] } as never,
      };
      await store.save(draft);

      return reply(summarize(draft));
    },
  );

  server.registerTool(
    "list_workflows",
    {
      title: "List Workflows",
      description:
        "List every workflow draft this host is holding, with node and edge counts. "
        + "Use it to recover a workflow_id you did not keep, before creating a duplicate.",
      inputSchema: {},
    },
    async () => reply({ workflows: (await store.list()).map(summarize) }),
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Get Workflow",
      description:
        "Return one workflow's full graph — every node with its kind, config and parentId, and every edge. "
        + "This is the authoring view; use export_workflow for the portable WorkflowSchema document.",
      inputSchema: { workflow_id: z.string().describe("The workflow id from create_workflow.") },
    },
    async ({ workflow_id }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      return reply({ workflow_id: draft.id, name: draft.name, graph: draft.graph });
    },
  );

  server.registerTool(
    "delete_workflow",
    {
      title: "Delete Workflow",
      description:
        "Remove a workflow draft from this host's store. Irreversible on a store that does not version, "
        + "and it deletes only the draft — nothing that was already exported or run.",
      inputSchema: { workflow_id: z.string().describe("The workflow id to delete.") },
    },
    async ({ workflow_id }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);
      await store.remove(workflow_id);

      return reply({ deleted: workflow_id });
    },
  );

  // ── Nodes and edges ────────────────────────────────────────────────────────

  server.registerTool(
    "add_node",
    {
      title: "Add Node",
      description:
        "Add a node of a given kind to a workflow. The kind is checked against the live registry "
        + "(call list_node_kinds first — a host may have registered its own). Omitting config applies the "
        + "kind's schema defaults. Pass parent_id to place the node inside a lane. Returns the created node.",
      inputSchema: {
        workflow_id: z.string().describe("The workflow id from create_workflow."),
        kind: z.string().describe("Node kind, e.g. \"manual_trigger\", \"llm_call\", \"branch\"."),
        node_id: z.string().optional().describe("Optional explicit node id. Omit to auto-generate."),
        parent_id: z.string().optional().describe("Optional lane node id — puts this node inside that lane."),
        config: z.record(z.string(), z.unknown()).optional().describe("Optional config. See describe_node_kind for the fields."),
      },
    },
    async ({ workflow_id, kind, node_id, parent_id, config }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const id = node_id ?? mintId(kind.replace(/^.*\//, ""));
      const result = await attempt(() =>
        addNode(draft, { id, kind, parentId: parent_id, config: config as Record<string, unknown> | undefined }),
      );
      if (!result.ok) return refuse(result.message);

      await store.save(result.value);

      return reply({
        workflow_id,
        node: result.value.graph.nodes.find((n) => n.id === id),
      });
    },
  );

  server.registerTool(
    "remove_node",
    {
      title: "Remove Node",
      description:
        "Remove a node and every edge touching it. The edges go WITH the node deliberately — leaving them "
        + "would produce edges pointing at nothing, reported as a second error the author did not cause.",
      inputSchema: {
        workflow_id: z.string().describe("The workflow id."),
        node_id: z.string().describe("The node to remove."),
      },
    },
    async ({ workflow_id, node_id }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const result = await attempt(() => removeNode(draft, node_id));
      if (!result.ok) return refuse(result.message);

      await store.save(result.value);

      return reply({ workflow_id, removed_node: node_id, nodes: result.value.graph.nodes.length });
    },
  );

  server.registerTool(
    "configure_node",
    {
      title: "Configure Node",
      description:
        "Merge config into a node, keeping the kind's other defaults. A config that does not satisfy the "
        + "kind's schema is WRITTEN ANYWAY and reported as warnings — a half-configured node is a normal "
        + "intermediate state when building a graph one step at a time, and refusing the write makes it "
        + "impossible to get there. validate_workflow is where 'not finished' is said.",
      inputSchema: {
        workflow_id: z.string().describe("The workflow id."),
        node_id: z.string().describe("The node to configure."),
        config: z.record(z.string(), z.unknown()).describe("Fields to merge into the node's config."),
      },
    },
    async ({ workflow_id, node_id, config }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const result = await attempt(() => configureNode(draft, node_id, config as Record<string, unknown>));
      if (!result.ok) return refuse(result.message);

      await store.save(result.value.draft);

      return reply({ workflow_id, node_id, issues: result.value.issues });
    },
  );

  server.registerTool(
    "connect_nodes",
    {
      title: "Connect Nodes",
      description:
        "Draw an edge from one node's output port to another's input port. Omit the port names to use each "
        + "kind's defaults. Both nodes must already exist — connecting to a node that is not there is an "
        + "error rather than a promise to create it.",
      inputSchema: {
        workflow_id: z.string().describe("The workflow id."),
        source: z.string().describe("Source node id."),
        target: z.string().describe("Target node id."),
        source_port: z.string().optional().describe("Optional output port on the source, e.g. \"true\" on a branch."),
        target_port: z.string().optional().describe("Optional input port on the target."),
      },
    },
    async ({ workflow_id, source, target, source_port, target_port }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      // `sourceHandle`/`targetHandle` is React Flow's vocabulary and the graph's;
      // the TOOL says "port" because that is what the schema and the PHP twin
      // call it, and an agent should not have to know which library named it.
      const result = await attempt(() =>
        connect(draft, { source, target, sourceHandle: source_port, targetHandle: target_port }),
      );
      if (!result.ok) return refuse(result.message);

      await store.save(result.value);

      return reply({ workflow_id, edges: result.value.graph.edges.length });
    },
  );

  server.registerTool(
    "remove_edge",
    {
      title: "Remove Edge",
      description:
        "Remove one edge, named either by its edge id or by the source/target pair it connects. "
        + "Removing an edge never removes the nodes it joined.",
      inputSchema: {
        workflow_id: z.string().describe("The workflow id."),
        edge_id: z.string().optional().describe("The edge id, if you have it."),
        source: z.string().optional().describe("Source node id, if naming the edge by its endpoints."),
        target: z.string().optional().describe("Target node id, if naming the edge by its endpoints."),
      },
    },
    async ({ workflow_id, edge_id, source, target }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      if (!edge_id && !(source && target)) {
        return refuse("Name the edge by edge_id, or by both source and target.");
      }

      const result = await attempt(() => removeEdge(draft, { edgeId: edge_id, source, target }));
      if (!result.ok) return refuse(result.message);

      await store.save(result.value);

      return reply({ workflow_id, removed_edge: edge_id ?? `${source} -> ${target}`, edges: result.value.graph.edges.length });
    },
  );

  // ── The vocabulary ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_node_kinds",
    {
      title: "List Node Kinds",
      description:
        "Every node kind this host has registered, read from the LIVE registry rather than a fixed list — "
        + "so kinds the host added itself, and kinds vendored in from the marketplace, are included. "
        + "Each says whether this host ADMITS it, and a refusal names the missing capability.",
      inputSchema: {
        category: z.string().optional().describe("Optional filter, e.g. \"logic\", \"ai\", \"io\", \"trigger\"."),
      },
    },
    async ({ category }) => {
      const kinds = authorableKinds(admits).filter((k) => !category || k.category === category);

      return reply({ count: kinds.length, kinds });
    },
  );

  server.registerTool(
    "describe_node_kind",
    {
      title: "Describe Node Kind",
      description:
        "One kind in full — its config schema, its default config, and its input and output ports. "
        + "Call this before configure_node rather than guessing field names; the fields are deliberately "
        + "not on list_node_kinds, which would turn a vocabulary query into a payload nobody reads.",
      inputSchema: { kind: z.string().describe("The kind name, e.g. \"llm_call\" or the fully-qualified form.") },
    },
    async ({ kind }) => {
      const result = await attempt(() => describeKind(kind));

      return result.ok ? reply(result.value) : refuse(result.message);
    },
  );

  // ── Validation, portability, and the smoke run ─────────────────────────────

  server.registerTool(
    "validate_workflow",
    {
      title: "Validate Workflow",
      description:
        "Check a workflow and return every issue TAGGED by who refused it: source \"schema\" means the graph "
        + "is malformed and editing it is the fix; source \"host\" means this host will not run that kind and "
        + "the fix is a capability or a different kind. Collapsing the two costs you the wrong fix.",
      inputSchema: { workflow_id: z.string().describe("The workflow id.") },
    },
    async ({ workflow_id }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const issues = checkDraft(draft, admits);

      return reply({
        workflow_id,
        ok: issues.every((i) => i.level !== "error"),
        issues,
      });
    },
  );

  server.registerTool(
    "export_workflow",
    {
      title: "Export Workflow",
      description:
        "Emit the portable WorkflowSchema document — the same JSON the TypeScript, PHP and Python runtimes "
        + "all read. This is what you hand to another runtime, commit to a repo, or pass to import_workflow.",
      inputSchema: { workflow_id: z.string().describe("The workflow id.") },
    },
    async ({ workflow_id }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      return reply({ workflow_id, workflow: toDocument(draft) });
    },
  );

  server.registerTool(
    "import_workflow",
    {
      title: "Import Workflow",
      description:
        "Read a WorkflowSchema document into a NEW draft and return its workflow_id, plus any issues found. "
        + "Import is lenient on purpose: a document referencing a kind this host has not registered still "
        + "imports, with the problem reported — refusing would lose the other forty nodes to fix one.",
      inputSchema: {
        workflow: z.record(z.string(), z.unknown()).describe("A WorkflowSchema document, as export_workflow emits."),
        name: z.string().optional().describe("Optional name for the imported draft."),
        workflow_id: z.string().optional().describe("Optional explicit id for the new draft."),
      },
    },
    async ({ workflow, name, workflow_id }) => {
      const result = await attempt(() => fromDocument(workflow, { id: workflow_id ?? mintId("wf"), name }));
      if (!result.ok) return refuse(result.message);

      await store.save(result.value.draft);

      return reply({
        workflow_id: result.value.draft.id,
        name: result.value.draft.name,
        nodes: result.value.draft.graph.nodes.length,
        issues: result.value.issues,
      });
    },
  );

  server.registerTool(
    "run_workflow",
    {
      title: "Run Workflow",
      description:
        "Execute the graph and return per-node outputs plus ok/error. This is a SMOKE TEST of wiring and "
        + "routing, not a production run: it takes no executors, so nodes fall back to their kind's own "
        + "behaviour and anything needing a host capability (a terminal session, an LLM client) refuses "
        + "rather than acting. Refuses outright to run a graph with validation errors, because a malformed "
        + "graph produces failures that look like engine bugs and are not. Seed entry nodes with "
        + "initial_inputs, keyed by node id then port.",
      inputSchema: {
        workflow_id: z.string().describe("The workflow id."),
        initial_inputs: z
          .record(z.string(), z.record(z.string(), z.unknown()))
          .optional()
          .describe("Inputs seeded to entry nodes: { \"<node_id>\": { \"<port>\": <value> } }."),
      },
    },
    async ({ workflow_id, initial_inputs }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const issues = checkDraft(draft, admits).filter((i) => i.level === "error");
      if (issues.length > 0) {
        return refuse(
          "This workflow does not validate, so running it would produce failures that look like engine "
            + "bugs. Fix the issues and run again.",
          { issues },
        );
      }

      // The executor registry is bound HERE, as a literal, and there is no
      // parameter that could carry another one. The PHP twin does the same, for
      // the same reason: an agent-reachable run should be structurally
      // incapable of being pointed at a host's real infrastructure, and
      // unrepresentable beats forbidden — a policy can be relaxed by a later
      // edit, an absent parameter cannot be passed.
      //
      // What this does NOT claim: kind-level executors still apply, so a host
      // PROCESS that has called registerTerminalHost or registerLlmClient makes
      // those reachable from here. That is the host's own doing and outside this
      // package's reach; it is stated rather than papered over.
      const result = await runFlow(draft.graph, {}, undefined, {
        initialInputs: initial_inputs as Record<string, Record<string, unknown>> | undefined,
      });

      return reply({ workflow_id, ok: result.ok, outputs: result.outputs, ...(result.error ? { error: result.error } : {}) });
    },
  );

  return server;
}

export type { AdmissionPolicy, AuthoringIssue, DraftStore, WorkflowDraft };
