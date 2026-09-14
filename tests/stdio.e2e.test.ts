/**
 * The binary that ships, driven over the transport it ships with.
 *
 * `npx @particle-academy/fancy-flow-mcp-js` launches `dist/stdio.js`. Every
 * other test in this suite exercises the server in-process; none of them can
 * see that the published binary starts, speaks newline-delimited JSON-RPC on
 * stdout, keeps diagnostics off stdout, or loads without React. This one spawns
 * it as an MCP client would and does the handshake over real pipes:
 * `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.
 *
 * ## Why React is blocked in the child
 *
 * The package's promise is a headless server. 0.1.0's binary broke it: it called
 * `registerBuiltinKinds()` from `@particle-academy/fancy-flow/registry`, which
 * imports React, so in a tree without React it died on startup with
 * "Cannot find package 'react'" — and in a tree WITH React (npm installs it as a
 * peer) it silently loaded a UI library to serve JSON. A test that happens to run
 * where React is installed cannot tell those apart, so the child is started with
 * a resolve hook that makes importing `react` or `react-dom` throw.
 *
 * The build runs first, so this always drives the artifact built from this tree
 * rather than whatever `dist/` was left behind.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "stdio.js");
const pkg = createRequire(import.meta.url)("../package.json") as { version: string; bin: Record<string, string> };

/** Loaded into the child with --import. Throws on any attempt to resolve React. */
const BLOCK_REACT = `
import { registerHooks } from "node:module";
if (typeof registerHooks !== "function") {
  throw new Error("module.registerHooks is unavailable on " + process.version + "; the no-React guarantee cannot be checked on this Node.");
}
registerHooks({
  resolve(specifier, context, next) {
    if (/^react(-dom)?(\\/|$)/.test(specifier)) {
      throw new Error("HEADLESS VIOLATION: the binary tried to import " + specifier + " (from " + context.parentURL + ")");
    }
    return next(specifier, context);
  },
});
`;

type Frame = { jsonrpc: "2.0"; id?: number; method?: string; result?: any; error?: { code: number; message: string } };

class StdioSession {
  readonly child: ChildProcessWithoutNullStreams;
  private stdout = "";
  stderr = "";
  readonly frames: Frame[] = [];
  /** Anything on stdout that is not a JSON-RPC frame — which would corrupt a real client's stream. */
  readonly junk: string[] = [];

  constructor() {
    this.child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(BLOCK_REACT)}`, BIN], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdout += chunk;
      let newline = this.stdout.indexOf("\n");
      while (newline !== -1) {
        const line = this.stdout.slice(0, newline);
        this.stdout = this.stdout.slice(newline + 1);
        try {
          this.frames.push(JSON.parse(line) as Frame);
        } catch {
          this.junk.push(line);
        }
        newline = this.stdout.indexOf("\n");
      }
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  send(frame: object): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async reply(id: number, timeoutMs = 15_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find((f) => f.id === id);
      if (hit) return hit;
      if (this.child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `no reply to id ${id} (exit code ${this.child.exitCode}).\n--- stderr ---\n${this.stderr}\n--- stdout junk ---\n${this.junk.join("\n")}`,
    );
  }
}

beforeAll(() => {
  execFileSync(process.execPath, [createRequire(import.meta.url).resolve("tsup/dist/cli-default.js")], { cwd: ROOT, stdio: "pipe" });
}, 180_000);

describe("npx @particle-academy/fancy-flow-mcp-js, over stdio", () => {
  let session: StdioSession;

  beforeAll(() => {
    session = new StdioSession();
  });

  afterAll(() => {
    session.child.kill();
  });

  test("package.json's bin is the file this test drives", () => {
    expect(pkg.bin["fancy-flow-mcp-js"]).toBe("./dist/stdio.js");
  });

  test("initialize negotiates the client's protocol revision and names this release", async () => {
    session.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
    });

    const reply = await session.reply(1);

    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "fancy-flow-mcp-js", version: pkg.version },
    });
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  });

  test("the reply to initialize was the FIRST thing on stdout", () => {
    // A client reads its initialize reply first. A notification or a log line
    // ahead of it is, at best, a frame the client did not expect yet.
    expect(session.frames[0]?.id).toBe(1);
  });

  test("tools/list offers the fifteen tools", async () => {
    session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const { result } = await session.reply(2);
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name).sort();

    expect(names).toEqual([
      "add_node",
      "configure_node",
      "connect_nodes",
      "create_workflow",
      "delete_workflow",
      "describe_node_kind",
      "export_workflow",
      "get_workflow",
      "import_workflow",
      "list_node_kinds",
      "list_workflows",
      "remove_edge",
      "remove_node",
      "run_workflow",
      "validate_workflow",
    ]);
  });

  test("tools/call reaches the live kind registry — populated, with React unavailable", async () => {
    // The registry fills itself on first read through /engine. If the binary
    // needed /registry (and so React) to populate it, this would either crash
    // on the React block or answer with a vocabulary of nothing.
    session.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_node_kinds", arguments: {} } });

    const { result } = await session.reply(3);
    const body = JSON.parse(result.content[0].text) as { count: number; kinds: Array<{ kind: string }> };

    expect(result.isError).toBeUndefined();
    expect(body.count).toBeGreaterThan(25);
    expect(body.kinds.map((k) => k.kind)).toContain("@particle-academy/branch");
  });

  test("a tool call that builds state keeps it for the session", async () => {
    session.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_workflow", arguments: { name: "E2E", workflow_id: "wf-e2e" } } });
    await session.reply(4);
    session.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "add_node", arguments: { workflow_id: "wf-e2e", kind: "log", node_id: "l" } } });
    await session.reply(5);
    session.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "export_workflow", arguments: { workflow_id: "wf-e2e" } } });

    const { result } = await session.reply(6);

    expect(JSON.parse(result.content[0].text).workflow.graph.nodes).toHaveLength(1);
  });

  test("stdout carried protocol frames and nothing else; diagnostics went to stderr", () => {
    expect(session.junk).toEqual([]);
    expect(session.stderr).toContain("ready on stdio");
    expect(session.stderr).not.toMatch(/HEADLESS VIOLATION|Cannot find package/);
  });

  test("the process exits cleanly when the client closes stdin", async () => {
    const exited = new Promise<number | null>((resolve) => session.child.once("exit", (code) => resolve(code)));
    session.child.stdin.end();

    expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 10_000))])).toBe(0);
  });
});
