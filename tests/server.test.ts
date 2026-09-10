/**
 * The MCP surface, driven through a REAL client over the SDK's in-memory
 * transport.
 *
 * These do not call the tool handlers directly. A handler that works when
 * invoked as a function proves nothing about whether it is *reachable* — the
 * defect this kit keeps finding is a thing that exists and is wired to nothing,
 * and calling the function by hand is exactly the test that cannot see it. So
 * every assertion here goes through `client.callTool`, which means the tool had
 * to be registered, named correctly, and have a schema the SDK would accept.
 *
 * The twin property is asserted separately in `parity.test.ts`: this file cares
 * that the tools WORK, that one cares that they are the same tools the PHP
 * server offers.
 */
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFlowServer, MemoryDraftStore } from "../src/server";
import type { DraftStore } from "../src/authoring";

/** A connected client/server pair over a paired in-memory transport. */
async function connect(options: { store?: DraftStore; admits?: Parameters<typeof createFlowServer>[0]["admits"] } = {}) {
  const server = createFlowServer({ store: options.store ?? new MemoryDraftStore(), admits: options.admits });
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return { client, server };
}

/** Tool replies are pretty-printed JSON as text, matching the PHP twin. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content as Array<{ type: string; text?: string }>)[0];

  expect(content?.type, `${name} replied with something other than text`).toBe("text");

  return { json: JSON.parse(content?.text ?? "{}"), isError: result.isError === true };
}


describe("the server is reachable at all", () => {
  test("lists its tools over the wire", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    // The denominator, not just the presence of one name. "add_node is missing"
    // reads as a lost tool; "1 tool of 15" says registration broke wholesale.
    expect(tools.length, `only ${tools.length} tools registered`).toBeGreaterThanOrEqual(15);
    expect(tools.map((t) => t.name)).toContain("add_node");
  });

  test("every tool carries a description an agent can act on", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    const bare = tools.filter((t) => !t.description || t.description.length < 40).map((t) => t.name);

    // A tool an agent cannot tell when to use is a tool it will not use, or
    // will use wrongly. The PHP twin describes every one at length.
    expect(bare, `these tools have no usable description: ${bare.join(", ")}`).toEqual([]);
  });
});

describe("authoring a graph end to end", () => {
  test("create → add → connect → validate → export, through the client", async () => {
    const { client } = await connect();

    const created = await call(client, "create_workflow", { name: "Smoke" });
    const id = created.json.workflow_id as string;
    expect(id).toBeTruthy();

    await call(client, "add_node", { workflow_id: id, kind: "manual_trigger", node_id: "t" });
    await call(client, "add_node", { workflow_id: id, kind: "log", node_id: "l" });
    await call(client, "connect_nodes", { workflow_id: id, source: "t", target: "l" });

    const validated = await call(client, "validate_workflow", { workflow_id: id });
    expect(validated.json.issues.filter((i: { level: string }) => i.level === "error")).toEqual([]);

    const exported = await call(client, "export_workflow", { workflow_id: id });
    expect(exported.json.workflow.version).toBe(1);
    expect(exported.json.workflow.graph.nodes).toHaveLength(2);
    expect(exported.json.workflow.graph.edges).toHaveLength(1);
  });

  test("a round trip through export → import preserves the graph", async () => {
    // The property the four runtimes are held to: same schema in, same schema
    // out. If import and export disagree, an agent's work is silently lossy.
    const { client } = await connect();

    const id = (await call(client, "create_workflow", { name: "Round" })).json.workflow_id as string;
    await call(client, "add_node", { workflow_id: id, kind: "terminal_lane", node_id: "lane" });
    await call(client, "add_node", { workflow_id: id, kind: "terminal_run", node_id: "cmd", parent_id: "lane" });

    const exported = await call(client, "export_workflow", { workflow_id: id });
    const imported = await call(client, "import_workflow", { workflow: exported.json.workflow, name: "Copy" });

    const copy = await call(client, "get_workflow", { workflow_id: imported.json.workflow_id });

    expect(copy.json.graph.nodes).toHaveLength(2);
    // parentId is the field ports keep dropping — three runtimes have lost it
    // now, so it is asserted rather than assumed.
    expect(copy.json.graph.nodes.find((n: { id: string }) => n.id === "cmd").parentId).toBe("lane");
  });

  test("carries explicit ports onto the edge", async () => {
    // This existed and was broken: the tool takes source_port/target_port and
    // the graph calls them sourceHandle/targetHandle, and the first version
    // passed the tool's names straight through — so ports were silently
    // dropped. Every test passed, because none of them used a port. `tsc`
    // caught it; a test should hold it.
    //
    // Ports are how a branch's "true" and "false" edges differ. Dropping them
    // turns a routed graph into one where both arms fire.
    const { client } = await connect();
    const id = (await call(client, "create_workflow", { name: "Ports" })).json.workflow_id as string;

    await call(client, "add_node", { workflow_id: id, kind: "branch", node_id: "b" });
    await call(client, "add_node", { workflow_id: id, kind: "log", node_id: "l" });
    await call(client, "connect_nodes", {
      workflow_id: id,
      source: "b",
      target: "l",
      source_port: "true",
    });

    const { json } = await call(client, "get_workflow", { workflow_id: id });

    expect(json.graph.edges[0].sourceHandle).toBe("true");
  });

  test("removing a node takes its edges, over the wire", async () => {
    const { client } = await connect();
    const id = (await call(client, "create_workflow", { name: "Prune" })).json.workflow_id as string;

    await call(client, "add_node", { workflow_id: id, kind: "manual_trigger", node_id: "t" });
    await call(client, "add_node", { workflow_id: id, kind: "log", node_id: "l" });
    await call(client, "connect_nodes", { workflow_id: id, source: "t", target: "l" });
    await call(client, "remove_node", { workflow_id: id, node_id: "l" });

    const after = await call(client, "get_workflow", { workflow_id: id });
    expect(after.json.graph.nodes).toHaveLength(1);
    expect(after.json.graph.edges).toHaveLength(0);
  });
});

describe("errors reach the agent as errors", () => {
  test("an unknown kind is an error result, not a thrown transport failure", async () => {
    // If it throws instead, the agent sees a dead connection rather than a
    // fixable mistake — and cannot tell "I typed the kind wrong" from "the
    // server died".
    const { client } = await connect();
    const id = (await call(client, "create_workflow", { name: "Bad" })).json.workflow_id as string;

    const result = await call(client, "add_node", { workflow_id: id, kind: "not_a_kind" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.json)).toMatch(/list what this host has registered|list_node_kinds/);
  });

  test("an unknown workflow id says so rather than inventing one", async () => {
    const { client } = await connect();
    const result = await call(client, "get_workflow", { workflow_id: "nope" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.json)).toMatch(/nope/);
  });
});

describe("the host's admission policy is carried, and stays tagged", () => {
  test("list_node_kinds marks what the host refuses and why", async () => {
    const { client } = await connect({
      admits: (k) => (k.name.includes("user_input") ? "This host cannot resume a paused run." : null),
    });

    const { json } = await call(client, "list_node_kinds");
    const refused = json.kinds.find((k: { kind: string }) => k.kind === "@particle-academy/user_input");

    expect(refused.admitted).toBe(false);
    expect(refused.refusedBecause).toContain("cannot resume");
  });

  test("validate_workflow keeps host refusals separate from schema issues", async () => {
    const { client } = await connect({
      admits: (k) => (k.name.includes("user_input") ? "No resume support here." : null),
    });

    const id = (await call(client, "create_workflow", { name: "Tagged" })).json.workflow_id as string;
    await call(client, "add_node", { workflow_id: id, kind: "manual_trigger", node_id: "t" });
    await call(client, "add_node", { workflow_id: id, kind: "user_input", node_id: "u" });
    await call(client, "connect_nodes", { workflow_id: id, source: "t", target: "u" });

    const { json } = await call(client, "validate_workflow", { workflow_id: id });
    const host = json.issues.filter((i: { source: string }) => i.source === "host");

    expect(host).toHaveLength(1);
    expect(host[0].message).toBe("No resume support here.");
  });
});

describe("run_workflow cannot reach a host's real infrastructure", () => {
  test("runs a graph the TypeScript runtime can actually execute", async () => {
    const { client } = await connect();
    const id = (await call(client, "create_workflow", { name: "Run" })).json.workflow_id as string;

    await call(client, "add_node", { workflow_id: id, kind: "transform", node_id: "tr" });

    const { json } = await call(client, "run_workflow", {
      workflow_id: id,
      initial_inputs: { tr: { input: { a: 1 } } },
    });

    expect(json.ok).toBe(true);
    expect(json.outputs.tr).toBeDefined();
  });

  test("a kind with no executor fails as a RESULT, not as a broken tool", async () => {
    // 22 of 31 builtin kinds have no TypeScript executor (see the pin below).
    // That has to reach the agent as "this graph could not run and here is the
    // kind that stopped it" — an ok:false with the engine's own message — and
    // not as a transport error, which would read as the server being broken
    // rather than the graph being unrunnable on this runtime.
    const { client } = await connect();
    const id = (await call(client, "create_workflow", { name: "NoExec" })).json.workflow_id as string;

    await call(client, "add_node", { workflow_id: id, kind: "manual_trigger", node_id: "t" });
    await call(client, "add_node", { workflow_id: id, kind: "log", node_id: "l" });
    await call(client, "connect_nodes", { workflow_id: id, source: "t", target: "l" });

    const { json, isError } = await call(client, "run_workflow", { workflow_id: id });

    expect(isError).toBe(false);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/No executor registered/);
  });

  test("refuses outright to run what the HOST has refused", async () => {
    // A host refusal is an error-level issue, so the run never starts. Running
    // anyway would produce a failure deep in the engine for a reason the host
    // already stated up front.
    const { client } = await connect({ admits: (k) => (k.name.includes("log") ? "No logging on this host." : null) });
    const id = (await call(client, "create_workflow", { name: "Refused" })).json.workflow_id as string;

    await call(client, "add_node", { workflow_id: id, kind: "manual_trigger", node_id: "t" });
    await call(client, "add_node", { workflow_id: id, kind: "log", node_id: "l" });
    await call(client, "connect_nodes", { workflow_id: id, source: "t", target: "l" });

    const result = await call(client, "run_workflow", { workflow_id: id });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.json)).toMatch(/No logging on this host/);
  });

  test("takes NO executor argument — the seam does not exist to be abused", async () => {
    // The PHP twin binds its default executors as a literal at the call site so
    // an agent-reachable run is STRUCTURALLY incapable of touching real
    // infrastructure. Unrepresentable beats forbidden: a policy can be relaxed
    // by a later edit, an absent parameter cannot be passed.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const run = tools.find((t) => t.name === "run_workflow");

    const props = Object.keys((run?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {});

    expect(props.sort()).toEqual(["initial_inputs", "workflow_id"]);
  });
});

/**
 * A deliberate ratchet, not a description.
 *
 * The PHP twin's `run_workflow` is BATTERIES-INCLUDED: `Builtin::executors()`
 * binds a default executor for every builtin kind, with fakes for the notifier,
 * memory, data and LLM dependencies. The TypeScript runtime ships no equivalent
 * — only 9 of 31 kinds carry a `kind.executor`, and `runFlow` has no default
 * registry to fall back on.
 *
 * So the two twins' `run_workflow` tools have the same NAME and the same
 * arguments and materially different reach, which is exactly the kind of
 * difference that is invisible until someone depends on it. The parity test
 * compares tool names and cannot see this.
 *
 * This pins the number. When fancy-flow gains default executors the count moves
 * and this fails — which is the point: it forces the Node twin's description to
 * be updated in the same breath rather than continuing to under-promise.
 */
describe("the TS/PHP run gap is pinned rather than described", () => {
  test("9 of 31 builtin kinds can execute on the TypeScript runtime", async () => {
    const { listNodeKinds } = await import("@particle-academy/fancy-flow/engine");

    const all = listNodeKinds();
    const executable = all.filter((k) => k.executor);

    expect(
      { executable: executable.length, total: all.length },
      [
        `${executable.length} of ${all.length} builtin kinds carry an executor.`,
        "",
        "If this moved UP, fancy-flow gained default executors — update run_workflow's",
        "description, which currently warns that most kinds refuse rather than act.",
        "If it moved DOWN, a kind lost its executor and graphs that ran now will not.",
        "",
        `Executable today: ${executable.map((k) => k.name.replace(/^.*\//, "")).sort().join(", ")}`,
      ].join("\n"),
    ).toEqual({ executable: 9, total: 31 });
  });
});
