/**
 * A minimal MCP client for tests, over agent-integrations' in-process transport.
 *
 * It replaced `@modelcontextprotocol/sdk`'s `Client` + `InMemoryTransport` when
 * this package stopped depending on the SDK. It keeps what made those tests
 * worth having: every call goes through JSON-RPC framing and the server's own
 * dispatch, never a direct call into a handler — so a tool that exists but is
 * not registered, or is registered under the wrong name, fails here.
 *
 * Every frame is round-tripped through JSON in both directions, because that is
 * what a real transport does to it. An in-process transport hands over object
 * references, and a reply carrying `undefined`, a class instance or a shared
 * reference would look fine here and different on the wire.
 */
import { InProcessTransport, type JsonRpcMessage, type MicroMcpServer } from "@particle-academy/agent-integrations/mcp";

export type RawReply = { jsonrpc: "2.0"; id?: unknown; result?: any; error?: { code: number; message: string; data?: unknown } };

export class TestClient {
  private readonly transport = new InProcessTransport();
  private readonly inbox: JsonRpcMessage[] = [];
  private nextId = 1;

  constructor(server: MicroMcpServer) {
    this.transport.bindServer(server);
    this.transport.onServerMessage((frame) => this.inbox.push(JSON.parse(JSON.stringify(frame)) as JsonRpcMessage));
    server.attach(this.transport);
  }

  /**
   * Deliver one frame exactly as given and return every frame the server sent
   * while handling it. A notification returns whatever was pushed (usually
   * nothing).
   */
  async exchange(frame: unknown): Promise<RawReply[]> {
    const before = this.inbox.length;
    await this.transport.deliver(JSON.parse(JSON.stringify(frame)) as JsonRpcMessage);
    return this.inbox.slice(before) as RawReply[];
  }

  /** Send a request and return its result, throwing on a JSON-RPC error. */
  async request(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const replies = await this.exchange({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    const reply = replies.find((r) => r.id === id);
    if (!reply) throw new Error(`no reply to ${method} (id ${id})`);
    if (reply.error) throw new Error(`${method} failed: ${reply.error.code} ${reply.error.message}`);
    return reply.result;
  }

  async initialize(protocolVersion = "2025-11-25"): Promise<any> {
    const result = await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    await this.exchange({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }> {
    return this.request("tools/list", {});
  }

  callTool(call: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: unknown; isError?: boolean }> {
    return this.request("tools/call", call);
  }
}

/** A connected, initialized client for `server`. */
export async function connectClient(server: MicroMcpServer): Promise<TestClient> {
  const client = new TestClient(server);
  await client.initialize();
  return client;
}
