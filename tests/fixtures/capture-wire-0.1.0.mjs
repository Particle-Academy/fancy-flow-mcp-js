// PROVENANCE for wire-0.1.0.json. This is how that fixture was made, and it is
// kept for that reason only — it CANNOT run against this tree any more.
//
// It records the JSON-RPC wire behaviour of fancy-flow-mcp-js 0.1.0, when the
// server was built on @modelcontextprotocol/sdk@1.30.0, one frame at a time, so
// the first-party port can be replayed against it (tests/wire.test.ts).
//
// To re-run it you need the 0.1.0 tree, not this one:
//
//   git checkout 4759dfb && npm ci && npm run build
//   node tests/fixtures/capture-wire-0.1.0.mjs tests/fixtures/wire-0.1.0.json
//
// (then re-apply the one-exchange-per-line layout, which is cosmetic).
//
// NEVER regenerate the fixture from the ported server. The fixture's only value
// is that it came from the implementation being replaced; recorded from the port
// it would compare the port with itself and pass forever.
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const { createFlowServer, MemoryDraftStore } = await import(pathToFileURL(`${REPO}/dist/index.js`).href);
const { InMemoryTransport } = await import(
  pathToFileURL(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js`).href
);

async function openSession() {
  const server = createFlowServer({ store: new MemoryDraftStore() });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox = [];
  clientSide.onmessage = (m) => inbox.push(m);
  await server.connect(serverSide);
  await clientSide.start();

  return {
    async exchange(frame) {
      const before = inbox.length;
      await clientSide.send(frame);
      // let the server settle
      for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
      return inbox.slice(before);
    },
    close: () => clientSide.close(),
  };
}

let nextId = 1;
const req = (method, params) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
const call = (name, args) => req("tools/call", args === undefined ? { name } : { name, arguments: args });
const note = (method) => ({ jsonrpc: "2.0", method });
const init = (protocolVersion) =>
  req("initialize", {
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    capabilities: {},
    clientInfo: { name: "wire-capture", version: "0" },
  });

async function record(label, frames) {
  nextId = 1;
  const s = await openSession();
  const exchanges = [];
  for (const f of frames) {
    const frame = typeof f === "function" ? f(exchanges) : f;
    exchanges.push({ request: frame, responses: await s.exchange(frame) });
  }
  await s.close();
  return { label, exchanges };
}

const text = (exchanges, i) => JSON.parse(exchanges[i].responses[0].result.content[0].text);

const sessions = [];

sessions.push(
  await record("authoring session", [
    init("2025-11-25"),
    note("notifications/initialized"),
    req("tools/list", {}),
    req("ping"),
    call("create_workflow", { name: "Golden", workflow_id: "wf-golden" }),
    call("list_workflows", {}),
    call("add_node", { workflow_id: "wf-golden", kind: "manual_trigger", node_id: "t" }),
    call("add_node", { workflow_id: "wf-golden", kind: "log", node_id: "l" }),
    call("add_node", { workflow_id: "wf-golden", kind: "branch", node_id: "b", config: { match: "any" } }),
    call("add_node", { workflow_id: "wf-golden", kind: "terminal_lane", node_id: "lane" }),
    call("add_node", { workflow_id: "wf-golden", kind: "terminal_run", node_id: "cmd", parent_id: "lane" }),
    call("add_node", { workflow_id: "wf-golden", kind: "not_a_kind" }),
    call("connect_nodes", { workflow_id: "wf-golden", source: "t", target: "l" }),
    call("connect_nodes", { workflow_id: "wf-golden", source: "b", target: "l", source_port: "true" }),
    call("connect_nodes", { workflow_id: "wf-golden", source: "t", target: "ghost" }),
    call("configure_node", { workflow_id: "wf-golden", node_id: "l", config: { message: 42 } }),
    call("configure_node", { workflow_id: "wf-golden", node_id: "ghost", config: {} }),
    call("get_workflow", { workflow_id: "wf-golden" }),
    call("validate_workflow", { workflow_id: "wf-golden" }),
    call("export_workflow", { workflow_id: "wf-golden" }),
    (ex) => call("import_workflow", { workflow: text(ex, ex.length - 1).workflow, name: "Copy", workflow_id: "wf-copy" }),
    call("import_workflow", { workflow: { version: 1, graph: { nodes: [{ id: "x", type: "no_such_kind", position: { x: 0, y: 0 }, data: {} }], edges: [] } }, workflow_id: "wf-lenient" }),
    call("remove_edge", { workflow_id: "wf-golden", source: "t", target: "l" }),
    call("remove_edge", { workflow_id: "wf-golden", edge_id: "b->l" }),
    call("remove_edge", { workflow_id: "wf-golden" }),
    call("remove_edge", { workflow_id: "wf-golden", edge_id: "nope" }),
    call("remove_node", { workflow_id: "wf-golden", node_id: "b" }),
    call("remove_node", { workflow_id: "wf-golden", node_id: "nope" }),
    call("list_node_kinds", {}),
    call("list_node_kinds", { category: "logic" }),
    call("describe_node_kind", { kind: "branch" }),
    call("describe_node_kind", { kind: "nope" }),
    call("create_workflow", { name: "Run", workflow_id: "wf-run" }),
    call("add_node", { workflow_id: "wf-run", kind: "transform", node_id: "tr" }),
    call("run_workflow", { workflow_id: "wf-run", initial_inputs: { tr: { input: { a: 1 } } } }),
    call("run_workflow", { workflow_id: "wf-golden" }),
    call("run_workflow", { workflow_id: "wf-lenient" }),
    call("list_workflows", {}),
    call("delete_workflow", { workflow_id: "wf-copy" }),
    call("delete_workflow", { workflow_id: "wf-copy" }),
    call("get_workflow", { workflow_id: "wf-copy" }),
  ]),
);

sessions.push(
  await record("argument validation", [
    init("2025-11-25"),
    note("notifications/initialized"),
    call("create_workflow", {}),
    call("create_workflow", { name: 5 }),
    call("create_workflow", { name: null }),
    call("create_workflow", { name: "x", workflow_id: null }),
    call("create_workflow", { name: "Extra", workflow_id: "wf-extra", bogus: 1 }),
    call("create_workflow", { name: ["a"], workflow_id: 7 }),
    call("add_node", { workflow_id: "wf-extra", kind: "log", config: "str" }),
    call("add_node", { workflow_id: "wf-extra", kind: "log", config: [1, 2] }),
    call("add_node", { workflow_id: "wf-extra", kind: "log", config: null }),
    call("configure_node", { workflow_id: "wf-extra", node_id: "l" }),
    call("connect_nodes", { workflow_id: "wf-extra", source: 1, target: true }),
    call("run_workflow", { workflow_id: "wf-extra", initial_inputs: { a: 5 } }),
    call("run_workflow", { workflow_id: "wf-extra", initial_inputs: { a: { b: 1 }, c: "x" } }),
    call("run_workflow", { workflow_id: "wf-extra", initial_inputs: [] }),
    call("import_workflow", { workflow: [] }),
    call("import_workflow", { workflow: "doc" }),
    call("list_node_kinds", { category: 3 }),
    call("describe_node_kind", {}),
    call("list_workflows"),
    call("get_workflow"),
    call("get_workflow", "not-an-object"),
  ]),
);

// A validation matrix: every property of every tool, fed each JSON type it does
// not accept, with the other arguments valid and every id explicit (a minted id
// carries a timestamp and would not replay).
{
  const valid = {
    create_workflow: { name: "M", workflow_id: "wf-m" },
    list_workflows: {},
    get_workflow: { workflow_id: "wf-m" },
    delete_workflow: { workflow_id: "wf-none" },
    add_node: { workflow_id: "wf-m", kind: "log", node_id: "n1", parent_id: "p", config: {} },
    remove_node: { workflow_id: "wf-m", node_id: "n-none" },
    configure_node: { workflow_id: "wf-m", node_id: "n-none", config: {} },
    connect_nodes: { workflow_id: "wf-m", source: "a", target: "b", source_port: "x", target_port: "y" },
    remove_edge: { workflow_id: "wf-m", edge_id: "e-none", source: "a", target: "b" },
    list_node_kinds: { category: "logic" },
    describe_node_kind: { kind: "log" },
    validate_workflow: { workflow_id: "wf-m" },
    export_workflow: { workflow_id: "wf-none" },
    import_workflow: { workflow: { version: 1, graph: { nodes: [], edges: [] } }, name: "I", workflow_id: "wf-i" },
    run_workflow: { workflow_id: "wf-none", initial_inputs: {} },
  };
  const stringBad = [null, 5, 1.5, true, [], {}, ["s"]];
  const recordBad = [null, 5, true, "s", [], [{}]];
  const nestedBad = [{ k: null }, { k: 5 }, { k: "s" }, { k: [] }, { ok: {}, k: false }];

  const frames = [init("2025-11-25"), note("notifications/initialized"), call("create_workflow", { name: "M", workflow_id: "wf-m" })];
  const listed = (await record("probe", [init("2025-11-25"), req("tools/list", {})])).exchanges[1].responses[0].result.tools;

  for (const t of listed) {
    const props = t.inputSchema.properties;
    const required = t.inputSchema.required ?? [];
    for (const key of Object.keys(props)) {
      const isRecord = props[key].type === "object";
      if (required.includes(key)) {
        const { [key]: _dropped, ...rest } = valid[t.name];
        frames.push(call(t.name, rest));
      }
      for (const bad of isRecord ? recordBad : stringBad) frames.push(call(t.name, { ...valid[t.name], [key]: bad }));
      if (isRecord && props[key].additionalProperties?.type === "object") {
        for (const bad of nestedBad) frames.push(call(t.name, { ...valid[t.name], [key]: bad }));
      }
    }
    // several wrong at once: the ORDER issues are reported in is part of the text
    const allBad = Object.fromEntries(Object.keys(props).reverse().map((k) => [k, props[k].type === "object" ? "s" : 7]));
    frames.push(call(t.name, allBad));
  }

  sessions.push(await record("validation matrix", frames));
}

sessions.push(
  await record("protocol edges", [
    init("2025-11-25"),
    note("notifications/initialized"),
    call("no_such_tool", {}),
    req("resources/list", {}),
    req("prompts/list", {}),
    req("no/such/method", {}),
    req("tools/call", {}),
  ]),
);

for (const v of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07", "2026-07-28", undefined]) {
  sessions.push(await record(`initialize ${v ?? "(no protocolVersion)"}`, [init(v)]));
}

const out = process.argv[2];
writeFileSync(out, JSON.stringify({ capturedFrom: "@particle-academy/fancy-flow-mcp-js@0.1.0 (@modelcontextprotocol/sdk@1.30.0)", sessions }, null, 2) + "\n");
console.log(`wrote ${sessions.length} sessions, ${sessions.reduce((n, s) => n + s.exchanges.length, 0)} exchanges to ${out}`);
