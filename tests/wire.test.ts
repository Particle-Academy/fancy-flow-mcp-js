/**
 * The port speaks the same wire as 0.1.0, frame for frame.
 *
 * 0.1.0 was built on `@modelcontextprotocol/sdk`. 0.2.0 is built on
 * agent-integrations' first-party `MicroMcpServer`, because the SDK was refused
 * as a dependency. "Same 15 tools" is easy to claim and easy to get slightly
 * wrong — a schema key in a different place, a validation message worded
 * differently, an error that used to be a result and is now a protocol failure.
 * Each of those reaches an agent as a behaviour change nobody announced.
 *
 * So the 0.1.0 server was RECORDED — 340 request/response exchanges covering
 * every tool's success and refusal paths, a validation matrix feeding every
 * property of every tool each JSON type it does not accept, protocol-version
 * negotiation, and protocol edge cases — and this replays every request against
 * the port and compares the replies exactly. `fixtures/capture-wire-0.1.0.mjs`
 * is how the recording was made.
 *
 * ## Where the port deliberately differs
 *
 * Not everything was kept. The differences are listed in `DIVERGENCES` below,
 * each with the reply the port gives INSTEAD, so they are pinned rather than
 * skipped: a new, unlisted difference fails, and a listed one that stops
 * happening fails too. All of them are protocol edges a conforming client does
 * not reach in normal use: none is on a path where a tool that exists is called
 * with an object of arguments.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createFlowServer, MemoryDraftStore } from "../src/server";
import { TestClient, type RawReply } from "./support/client";

type Exchange = { request: { id?: number; method: string; params?: Record<string, unknown> }; responses: RawReply[] };
type Recording = { capturedFrom: string; sessions: Array<{ label: string; exchanges: Exchange[] }> };

const recording = JSON.parse(readFileSync(new URL("./fixtures/wire-0.1.0.json", import.meta.url), "utf8")) as Recording;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/**
 * Each entry: the reply the port gives in place of 0.1.0's, and why.
 * Keyed `<session label> #<exchange index>`; each reply takes its request's id.
 */
const DIVERGENCES: Record<string, { because: string; now: Array<Omit<RawReply, "id">> }> = {
  "argument validation #20": {
    because:
      "tools/call with NO `arguments` member. The spec makes `arguments` optional; the SDK refused the call " +
      "(\"expected object, received undefined\") even for a tool that takes none. The port treats a missing " +
      "`arguments` as {}, so a no-argument tool simply runs.",
    now: [{ jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ workflows: [{ workflow_id: "wf-extra", name: "Extra", nodes: 0, edges: 0 }] }, null, 2) }] } }],
  },
  "argument validation #21": {
    because:
      "tools/call with NO `arguments` for a tool that needs some. Same cause as #20: arguments default to {}, " +
      "so the refusal names the missing argument instead of the missing object — the more useful of the two.",
    now: [{ jsonrpc: "2.0", result: { content: [{ type: "text", text: "MCP error -32602: Input validation error: Invalid arguments for tool get_workflow: Invalid input: expected string, received undefined at workflow_id" }], isError: true } }],
  },
  "argument validation #22": {
    because:
      "`arguments` that is not an object. The SDK failed the whole request with -32603 and a raw zod issue dump; " +
      "the port answers with the same tool-level validation result every other bad argument gets.",
    now: [{ jsonrpc: "2.0", result: { content: [{ type: "text", text: "MCP error -32602: Input validation error: Invalid arguments for tool get_workflow: Invalid input: expected object, received string" }], isError: true } }],
  },
  "protocol edges #2": {
    because:
      "An unknown tool. The SDK answered with a tool RESULT (isError). The spec classes an unknown tool as a " +
      "PROTOCOL error, and so does the PHP twin (laravel/mcp: JSON-RPC error, \"Tool [x] not found.\"), so the " +
      "port is closer to the twin here than 0.1.0 was. No client that reads tools/list sends this.",
    now: [{ jsonrpc: "2.0", error: { code: -32601, message: "Unknown tool: no_such_tool" } }],
  },
  "protocol edges #3": {
    because: "Unsupported method: same code (-32601), the message names the method.",
    now: [{ jsonrpc: "2.0", error: { code: -32601, message: "Unsupported method: resources/list" } }],
  },
  "protocol edges #4": {
    because: "Unsupported method: same code (-32601), the message names the method.",
    now: [{ jsonrpc: "2.0", error: { code: -32601, message: "Unsupported method: prompts/list" } }],
  },
  "protocol edges #5": {
    because: "Unsupported method: same code (-32601), the message names the method.",
    now: [{ jsonrpc: "2.0", error: { code: -32601, message: "Unsupported method: no/such/method" } }],
  },
  "protocol edges #6": {
    because: "tools/call with no tool name. Was -32603 with a zod issue dump; now -32602 (invalid params) saying so.",
    now: [{ jsonrpc: "2.0", error: { code: -32602, message: "tools/call requires `name`" } }],
  },
  "initialize (no protocolVersion) #0": {
    because:
      "initialize naming no protocol revision. The SDK failed it with -32603 and a zod dump; the port answers " +
      "with its newest revision — which is what the PHP twin (laravel/mcp) does.",
    now: [{ jsonrpc: "2.0", result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fancy-flow-mcp-js", version: pkg.version } } }],
  },
};

/** The advertised version moves with every release; it is pinned by version.test.ts, not by a recording. */
function normalize(replies: RawReply[]): RawReply[] {
  return replies.map((reply) =>
    reply.result?.serverInfo ? { ...reply, result: { ...reply.result, serverInfo: { ...reply.result.serverInfo, version: pkg.version } } } : reply,
  );
}

/**
 * A reply as bytes, with the ENVELOPE's member order made canonical and
 * everything inside it left exactly as sent.
 *
 * The SDK re-serialised every outgoing frame through its own schemas, so 0.1.0
 * wrote `{"result":…,"jsonrpc":"2.0","id":1}`. The order of a JSON-RPC
 * envelope's members carries nothing and no client reads it. The order INSIDE
 * `result` and `error` — a tool's schema, a reply's fields — is what an agent
 * actually receives, and that is compared byte for byte.
 */
function wire(replies: Array<RawReply>): string[] {
  return replies.map(({ jsonrpc, id, result, error, ...rest }) => JSON.stringify({ jsonrpc, id, result, error, ...rest }));
}

test("the recording is the one this test was written against", () => {
  // If the fixture were regenerated from the port, every comparison below would
  // be the port agreeing with itself. The recording names what produced it.
  expect(recording.capturedFrom).toMatch(/0\.1\.0 \(@modelcontextprotocol\/sdk@1\.30\.0\)/);
  expect(recording.sessions.reduce((n, s) => n + s.exchanges.length, 0)).toBe(340);
});

describe.each(recording.sessions)("replaying 0.1.0: $label", ({ label, exchanges }) => {
  test("every reply matches, or differs exactly as recorded in DIVERGENCES", async () => {
    const client = new TestClient(createFlowServer({ store: new MemoryDraftStore() }));
    const mismatches: string[] = [];

    for (const [index, exchange] of exchanges.entries()) {
      const key = `${label} #${index}`;
      const actual = await client.exchange(exchange.request);
      const divergence = DIVERGENCES[key];
      const expected = divergence
        ? divergence.now.map((reply) => ({ ...reply, id: exchange.request.id }))
        : normalize(exchange.responses);

      const [a, e] = [wire(actual).join("\n"), wire(expected).join("\n")];
      if (a !== e) {
        // Point at the first differing character: these payloads are long and
        // usually differ in one place.
        let at = 0;
        while (at < a.length && a[at] === e[at]) at++;
        mismatches.push(
          [
            `${key}  ${exchange.request.method} ${JSON.stringify(exchange.request.params ?? {}).slice(0, 160)}`,
            `  expected: …${e.slice(Math.max(0, at - 80), at + 300)}`,
            `  actual:   …${a.slice(Math.max(0, at - 80), at + 300)}`,
          ].join("\n"),
        );
      }
    }

    expect(mismatches, `${mismatches.length} of ${exchanges.length} exchanges differ from 0.1.0:\n\n${mismatches.join("\n\n")}`).toEqual([]);
  });
});

test("every listed divergence names an exchange that exists", () => {
  // A stale entry would otherwise sit here forever, excusing nothing.
  const keys = new Set(recording.sessions.flatMap((s) => s.exchanges.map((_, i) => `${s.label} #${i}`)));

  expect(Object.keys(DIVERGENCES).filter((k) => !keys.has(k))).toEqual([]);
});
