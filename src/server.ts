/**
 * The MCP server — `fancy-flow-mcp-js`, the Node twin of `fancy-flow-mcp`.
 *
 * ## Built on agent-integrations, not on the SDK
 *
 * 0.1.0 was built on `@modelcontextprotocol/sdk`. That dependency was refused
 * (it is not on the suite's third-party allowlist, and brings 17 direct
 * dependencies of its own), so the server is now agent-integrations'
 * first-party `MicroMcpServer`, imported from its headless `/mcp` subpath —
 * which imports no package at all, React included.
 *
 * What the SDK had been doing on our behalf is now done here, in the open:
 *
 * - **Protocol negotiation.** `initialize` echoes any revision in
 *   {@link PROTOCOL_VERSIONS} and answers the newest otherwise — the same list,
 *   and so the same answers, as 0.1.0.
 * - **Argument checking.** Each tool's input schema is literal JSON Schema, and
 *   calls are checked against it by `./arguments`, with 0.1.0's messages.
 * - **A thrown handler becomes a result, not a dead request.** See `register`.
 *
 * `tests/wire.test.ts` replays 340 exchanges recorded from 0.1.0 against this
 * server and compares every reply exactly; the handful of deliberate
 * differences are listed there, each with its reason.
 *
 * ## Which protocol revisions, and which not
 *
 * `2025-11-25`, negotiating back to `2024-11-05` — the family `laravel/mcp`
 * speaks, which is what the PHP twin is built on, and what Claude Code and Codex
 * speak.
 *
 * It does NOT speak `2026-07-28`, the revision that removed `initialize` and
 * made the protocol stateless, and at least one first-party client
 * (`prism-mcp`) speaks only that. **Neither does the PHP twin.** That gap
 * belongs to both twins together — a Node server that jumped ahead alone would
 * stop being a twin, which costs more than the gap does.
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
import { MicroMcpServer, type CallToolResult, type JsonValue, type ToolDefinition } from "@particle-academy/agent-integrations/mcp";
import { runFlow } from "@particle-academy/fancy-flow/engine";
import { argumentIssues, assertSupportedSchema, type ArgumentSchema } from "./arguments";
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

/**
 * The server `createFlowServer` returns: agent-integrations' `MicroMcpServer`.
 *
 * Serve it by attaching a transport — `attachStdio(server)` from
 * `@particle-academy/agent-integrations/mcp/stdio`, or any other
 * agent-integrations transport.
 */
export type FlowServer = MicroMcpServer;

/**
 * The protocol revisions this server speaks, newest first.
 *
 * Exactly the list `@modelcontextprotocol/sdk@1.30.0` negotiated for 0.1.0, so
 * every client gets the answer it got before. The PHP twin's `laravel/mcp`
 * speaks the same family (it stops at 2024-11-05; the extra 2024-10-07 is
 * 0.1.0's, kept rather than silently dropped).
 */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;

/** Pretty-printed JSON as text — the same reply shape the PHP twin uses. */
function reply(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * An error the AGENT can act on, not a dead transport.
 *
 * A thrown handler reaches the client as a protocol failure, and an agent
 * cannot tell "I named a kind that does not exist" from "the server died" —
 * so it retries the whole session instead of fixing one argument.
 */
function refuse(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  // `content` before `isError`: the order 0.1.0's replies reached the wire in.
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }],
    isError: true,
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

/**
 * The version this server advertises when the host does not name one.
 *
 * It goes out in the `serverInfo` of every `initialize` response, so it is the
 * number every connecting agent records and may gate on. It is a literal
 * because this package builds to BOTH ESM and CJS: `import.meta.url` does not
 * exist in the CommonJS output, so the runtime `package.json` read used by the
 * CLI packages in this estate is not available here.
 *
 * `version.test.ts` pins it to `package.json` instead. That leaves the copy in
 * place but removes its ability to drift unnoticed, which is the whole defect —
 * every other version surface in this estate had gone stale exactly this way,
 * and one of them told a user 0.1.0 from a 0.4.0 install for three releases.
 */
const DEFAULT_SERVER_VERSION = "0.2.0";

// ── Input schemas ────────────────────────────────────────────────────────────
//
// Literal JSON Schema: what goes out in tools/list IS what is written here.
// The key order inside each property reproduces what 0.1.0 put on the wire
// (description first on an optional property, last on a required one), so
// tools/list is byte-identical to 0.1.0's — asserted by tests/wire.test.ts.

type Field = { optional: boolean; schema: ArgumentSchema };

const string = (description: string): Field => ({ optional: false, schema: { type: "string", description } });
const optionalString = (description: string): Field => ({ optional: true, schema: { description, type: "string" } });

const RECORD: ArgumentSchema = { type: "object", propertyNames: { type: "string" }, additionalProperties: {} };
const record = (description: string): Field => ({ optional: false, schema: { ...RECORD, description } });
const optionalRecord = (description: string, values: ArgumentSchema = {}): Field => ({
  optional: true,
  schema: { description, ...RECORD, additionalProperties: values },
});

function input(fields: Record<string, Field>): ArgumentSchema {
  const required = Object.entries(fields).filter(([, f]) => !f.optional).map(([name]) => name);

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.schema])),
    ...(required.length > 0 ? { required } : {}),
  };
}

type FlowTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: ArgumentSchema;
  // Arguments arrive checked against `inputSchema`, so each handler may read
  // them at the types that schema promises.
  handle: (args: any) => Promise<CallToolResult>;
};

/**
 * Register one tool: its arguments checked first, its failures kept as results.
 *
 * - **Arguments that fail the schema** are refused before the handler runs,
 *   with 0.1.0's wording. The `MCP error -32602:` prefix inside the text is
 *   0.1.0's too (the SDK formatted its validation errors that way); it is kept
 *   because agents have been reading exactly this text.
 * - **A handler that throws** — a host store failing, say — becomes an
 *   `isError` result carrying the message, as it was in 0.1.0. Left to the
 *   server it would be a JSON-RPC internal error, which an agent reads as the
 *   server being broken rather than the call having failed.
 */
function register(server: MicroMcpServer, tool: FlowTool): void {
  assertSupportedSchema(tool.inputSchema);

  const definition: ToolDefinition = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as ToolDefinition["inputSchema"],
    // 2025-11-25 tool execution: these run inline, never as tasks. 0.1.0
    // advertised the same.
    execution: { taskSupport: "forbidden" },
  };

  server.registerTool(definition, async (args) => {
    const issues = argumentIssues(tool.inputSchema, args as JsonValue);
    if (issues.length > 0) {
      return {
        content: [{ type: "text", text: `MCP error -32602: Input validation error: Invalid arguments for tool ${tool.name}: ${issues.join("\n")}` }],
        isError: true,
      };
    }

    try {
      return await tool.handle(args);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}

export function createFlowServer(options: FlowServerOptions): FlowServer {
  const { store, admits } = options;

  const server = new MicroMcpServer({
    info: {
      name: options.serverInfo?.name ?? "fancy-flow-mcp-js",
      version: options.serverInfo?.version ?? DEFAULT_SERVER_VERSION,
    },
    protocolVersions: PROTOCOL_VERSIONS,
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

  register(server, {
    name: "create_workflow",
    title: "Create Workflow",
    description:
      "Start a new, empty workflow draft and return its workflow_id. Every other tool takes that id. "
      + "Nothing is persisted beyond the host's store, and creating a workflow never runs anything.",
    inputSchema: input({
      name: string("Human-readable name for the workflow, e.g. \"Nightly digest\"."),
      workflow_id: optionalString("Optional explicit id. Omit to have one minted."),
    }),
    handle: async ({ name, workflow_id }: { name: string; workflow_id?: string }) => {
      const draft: WorkflowDraft = {
        id: workflow_id ?? mintId("wf"),
        name,
        graph: { nodes: [], edges: [] } as never,
      };
      await store.save(draft);

      return reply(summarize(draft));
    },
  });

  register(server, {
    name: "list_workflows",
    title: "List Workflows",
    description:
      "List every workflow draft this host is holding, with node and edge counts. "
      + "Use it to recover a workflow_id you did not keep, before creating a duplicate.",
    inputSchema: input({}),
    handle: async () => reply({ workflows: (await store.list()).map(summarize) }),
  });

  register(server, {
    name: "get_workflow",
    title: "Get Workflow",
    description:
      "Return one workflow's full graph — every node with its kind, config and parentId, and every edge. "
      + "This is the authoring view; use export_workflow for the portable WorkflowSchema document.",
    inputSchema: input({ workflow_id: string("The workflow id from create_workflow.") }),
    handle: async ({ workflow_id }: { workflow_id: string }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      return reply({ workflow_id: draft.id, name: draft.name, graph: draft.graph });
    },
  });

  register(server, {
    name: "delete_workflow",
    title: "Delete Workflow",
    description:
      "Remove a workflow draft from this host's store. Irreversible on a store that does not version, "
      + "and it deletes only the draft — nothing that was already exported or run.",
    inputSchema: input({ workflow_id: string("The workflow id to delete.") }),
    handle: async ({ workflow_id }: { workflow_id: string }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);
      await store.remove(workflow_id);

      return reply({ deleted: workflow_id });
    },
  });

  // ── Nodes and edges ────────────────────────────────────────────────────────

  register(server, {
    name: "add_node",
    title: "Add Node",
    description:
      "Add a node of a given kind to a workflow. The kind is checked against the live registry "
      + "(call list_node_kinds first — a host may have registered its own). Omitting config applies the "
      + "kind's schema defaults. Pass parent_id to place the node inside a lane. Returns the created node.",
    inputSchema: input({
      workflow_id: string("The workflow id from create_workflow."),
      kind: string("Node kind, e.g. \"manual_trigger\", \"llm_call\", \"branch\"."),
      node_id: optionalString("Optional explicit node id. Omit to auto-generate."),
      parent_id: optionalString("Optional lane node id — puts this node inside that lane."),
      config: optionalRecord("Optional config. See describe_node_kind for the fields."),
    }),
    handle: async ({ workflow_id, kind, node_id, parent_id, config }: {
      workflow_id: string;
      kind: string;
      node_id?: string;
      parent_id?: string;
      config?: Record<string, unknown>;
    }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const id = node_id ?? mintId(kind.replace(/^.*\//, ""));
      const result = await attempt(() => addNode(draft, { id, kind, parentId: parent_id, config }));
      if (!result.ok) return refuse(result.message);

      await store.save(result.value);

      return reply({
        workflow_id,
        node: result.value.graph.nodes.find((n) => n.id === id),
      });
    },
  });

  register(server, {
    name: "remove_node",
    title: "Remove Node",
    description:
      "Remove a node and every edge touching it. The edges go WITH the node deliberately — leaving them "
      + "would produce edges pointing at nothing, reported as a second error the author did not cause.",
    inputSchema: input({
      workflow_id: string("The workflow id."),
      node_id: string("The node to remove."),
    }),
    handle: async ({ workflow_id, node_id }: { workflow_id: string; node_id: string }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const result = await attempt(() => removeNode(draft, node_id));
      if (!result.ok) return refuse(result.message);

      await store.save(result.value);

      return reply({ workflow_id, removed_node: node_id, nodes: result.value.graph.nodes.length });
    },
  });

  register(server, {
    name: "configure_node",
    title: "Configure Node",
    description:
      "Merge config into a node, keeping the kind's other defaults. A config that does not satisfy the "
      + "kind's schema is WRITTEN ANYWAY and reported as warnings — a half-configured node is a normal "
      + "intermediate state when building a graph one step at a time, and refusing the write makes it "
      + "impossible to get there. validate_workflow is where 'not finished' is said.",
    inputSchema: input({
      workflow_id: string("The workflow id."),
      node_id: string("The node to configure."),
      config: record("Fields to merge into the node's config."),
    }),
    handle: async ({ workflow_id, node_id, config }: { workflow_id: string; node_id: string; config: Record<string, unknown> }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const result = await attempt(() => configureNode(draft, node_id, config));
      if (!result.ok) return refuse(result.message);

      await store.save(result.value.draft);

      return reply({ workflow_id, node_id, issues: result.value.issues });
    },
  });

  register(server, {
    name: "connect_nodes",
    title: "Connect Nodes",
    description:
      "Draw an edge from one node's output port to another's input port. Omit the port names to use each "
      + "kind's defaults. Both nodes must already exist — connecting to a node that is not there is an "
      + "error rather than a promise to create it.",
    inputSchema: input({
      workflow_id: string("The workflow id."),
      source: string("Source node id."),
      target: string("Target node id."),
      source_port: optionalString("Optional output port on the source, e.g. \"true\" on a branch."),
      target_port: optionalString("Optional input port on the target."),
    }),
    handle: async ({ workflow_id, source, target, source_port, target_port }: {
      workflow_id: string;
      source: string;
      target: string;
      source_port?: string;
      target_port?: string;
    }) => {
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
  });

  register(server, {
    name: "remove_edge",
    title: "Remove Edge",
    description:
      "Remove one edge, named either by its edge id or by the source/target pair it connects. "
      + "Removing an edge never removes the nodes it joined.",
    inputSchema: input({
      workflow_id: string("The workflow id."),
      edge_id: optionalString("The edge id, if you have it."),
      source: optionalString("Source node id, if naming the edge by its endpoints."),
      target: optionalString("Target node id, if naming the edge by its endpoints."),
    }),
    handle: async ({ workflow_id, edge_id, source, target }: {
      workflow_id: string;
      edge_id?: string;
      source?: string;
      target?: string;
    }) => {
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
  });

  // ── The vocabulary ─────────────────────────────────────────────────────────

  register(server, {
    name: "list_node_kinds",
    title: "List Node Kinds",
    description:
      "Every node kind this host has registered, read from the LIVE registry rather than a fixed list — "
      + "so kinds the host added itself, and kinds vendored in from the marketplace, are included. "
      + "Each says whether this host ADMITS it, and a refusal names the missing capability.",
    inputSchema: input({
      category: optionalString("Optional filter, e.g. \"logic\", \"ai\", \"io\", \"trigger\"."),
    }),
    handle: async ({ category }: { category?: string }) => {
      const kinds = authorableKinds(admits).filter((k) => !category || k.category === category);

      return reply({ count: kinds.length, kinds });
    },
  });

  register(server, {
    name: "describe_node_kind",
    title: "Describe Node Kind",
    description:
      "One kind in full — its config schema, its default config, and its input and output ports. "
      + "Call this before configure_node rather than guessing field names; the fields are deliberately "
      + "not on list_node_kinds, which would turn a vocabulary query into a payload nobody reads.",
    inputSchema: input({ kind: string("The kind name, e.g. \"llm_call\" or the fully-qualified form.") }),
    handle: async ({ kind }: { kind: string }) => {
      const result = await attempt(() => describeKind(kind));

      return result.ok ? reply(result.value) : refuse(result.message);
    },
  });

  // ── Validation, portability, and the smoke run ─────────────────────────────

  register(server, {
    name: "validate_workflow",
    title: "Validate Workflow",
    description:
      "Check a workflow and return every issue TAGGED by who refused it: source \"schema\" means the graph "
      + "is malformed and editing it is the fix; source \"host\" means this host will not run that kind and "
      + "the fix is a capability or a different kind. Collapsing the two costs you the wrong fix.",
    inputSchema: input({ workflow_id: string("The workflow id.") }),
    handle: async ({ workflow_id }: { workflow_id: string }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      const issues = checkDraft(draft, admits);

      return reply({
        workflow_id,
        ok: issues.every((i) => i.level !== "error"),
        issues,
      });
    },
  });

  register(server, {
    name: "export_workflow",
    title: "Export Workflow",
    description:
      "Emit the portable WorkflowSchema document — the same JSON the TypeScript, PHP and Python runtimes "
      + "all read. This is what you hand to another runtime, commit to a repo, or pass to import_workflow.",
    inputSchema: input({ workflow_id: string("The workflow id.") }),
    handle: async ({ workflow_id }: { workflow_id: string }) => {
      const draft = await load(workflow_id);
      if (!draft) return missing(workflow_id);

      return reply({ workflow_id, workflow: toDocument(draft) });
    },
  });

  register(server, {
    name: "import_workflow",
    title: "Import Workflow",
    description:
      "Read a WorkflowSchema document into a NEW draft and return its workflow_id, plus any issues found. "
      + "Import is lenient on purpose: a document referencing a kind this host has not registered still "
      + "imports, with the problem reported — refusing would lose the other forty nodes to fix one.",
    inputSchema: input({
      workflow: record("A WorkflowSchema document, as export_workflow emits."),
      name: optionalString("Optional name for the imported draft."),
      workflow_id: optionalString("Optional explicit id for the new draft."),
    }),
    handle: async ({ workflow, name, workflow_id }: { workflow: Record<string, unknown>; name?: string; workflow_id?: string }) => {
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
  });

  register(server, {
    name: "run_workflow",
    title: "Run Workflow",
    description:
      "Execute the graph and return per-node outputs plus ok/error. This is a SMOKE TEST of wiring and "
      + "routing, not a production run: it takes no executors, so nodes fall back to their kind's own "
      + "behaviour and anything needing a host capability (a terminal session, an LLM client) refuses "
      + "rather than acting. Refuses outright to run a graph with validation errors, because a malformed "
      + "graph produces failures that look like engine bugs and are not. Seed entry nodes with "
      + "initial_inputs, keyed by node id then port.",
    inputSchema: input({
      workflow_id: string("The workflow id."),
      initial_inputs: optionalRecord(
        "Inputs seeded to entry nodes: { \"<node_id>\": { \"<port>\": <value> } }.",
        RECORD,
      ),
    }),
    handle: async ({ workflow_id, initial_inputs }: {
      workflow_id: string;
      initial_inputs?: Record<string, Record<string, unknown>>;
    }) => {
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
      const result = await runFlow(draft.graph, {}, undefined, { initialInputs: initial_inputs });

      return reply({ workflow_id, ok: result.ok, outputs: result.outputs, ...(result.error ? { error: result.error } : {}) });
    },
  });

  return server;
}

export type { AdmissionPolicy, AuthoringIssue, DraftStore, WorkflowDraft };
