/**
 * The authoring core — no MCP, no transport, no dependency.
 *
 * These pin the split the package exists for: **we own whether a graph is
 * well-formed; the host owns whether it is allowed to run.** Every test here is
 * on the first half. The second half is a callback the host supplies, and the
 * only thing asserted about it is that its answer is carried through TAGGED,
 * never merged into ours.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { registerBuiltinKinds } from "@particle-academy/fancy-flow/registry";
import {
  addNode,
  authorableKinds,
  checkDraft,
  configureNode,
  connect,
  removeNode,
  toDocument,
  AuthoringError,
  type WorkflowDraft,
} from "../src/authoring";

function draft(): WorkflowDraft {
  return { id: "w1", name: "Test flow", graph: { nodes: [], edges: [] } as never };
}

beforeEach(() => {
  registerBuiltinKinds();
});

describe("authorableKinds", () => {
  test("reads the LIVE registry, not a hand-kept list", () => {
    const kinds = authorableKinds();

    // A mirror of the vocabulary is the defect this kit keeps finding: it
    // agrees for a while, then a kind is added and nothing reports the gap.
    expect(kinds.length).toBeGreaterThan(25);
    expect(kinds.map((k) => k.kind)).toContain("@particle-academy/branch");
  });

  test("marks what the host refuses, and says WHY", () => {
    const kinds = authorableKinds((k) =>
      k.name.includes("user_input") ? "This host cannot resume a paused run yet." : null,
    );

    const refused = kinds.find((k) => k.kind === "@particle-academy/user_input");

    expect(refused?.admitted).toBe(false);
    // A refusal an author can act on beats a correct one they cannot.
    expect(refused?.refusedBecause).toContain("cannot resume");
    // and everything else is still offered
    expect(kinds.find((k) => k.kind === "@particle-academy/branch")?.admitted).toBe(true);
  });
});

describe("building a graph", () => {
  test("adds a node with its kind's defaults filled in", () => {
    const d = addNode(draft(), { id: "b", kind: "branch" });
    const node = d.graph.nodes[0] as { type: string; data: { config: Record<string, unknown> } };

    expect(node.type).toBe("@particle-academy/branch");
    // `match: "all"` is the kind's own default — proof we asked the registry
    // rather than writing an empty config and hoping.
    expect(node.data.config.match).toBe("all");
  });

  test("refuses an unknown kind by NAMING how to find the real ones", () => {
    expect(() => addNode(draft(), { id: "x", kind: "not_a_kind" })).toThrow(AuthoringError);
    expect(() => addNode(draft(), { id: "x", kind: "not_a_kind" })).toThrow(/list what this host has registered/);
  });

  test("refuses a duplicate node id", () => {
    const d = addNode(draft(), { id: "b", kind: "branch" });
    expect(() => addNode(d, { id: "b", kind: "log" })).toThrow(/already exists/);
  });

  test("carries parentId, so an agent can author into a lane", () => {
    let d = addNode(draft(), { id: "lane", kind: "terminal_lane" });
    d = addNode(d, { id: "cmd", kind: "terminal_run", parentId: "lane" });

    const inner = d.graph.nodes.find((n) => n.id === "cmd") as unknown as { parentId?: string };
    expect(inner.parentId).toBe("lane");
  });

  test("connects, and refuses an edge to a node that is not there", () => {
    let d = addNode(draft(), { id: "a", kind: "manual_trigger" });
    d = addNode(d, { id: "b", kind: "log" });

    expect(connect(d, { source: "a", target: "b" }).graph.edges).toHaveLength(1);
    expect(() => connect(d, { source: "a", target: "ghost" })).toThrow(/no node "ghost"/);
  });

  test("removing a node takes its edges with it", () => {
    // Leaving them produces edges pointing at nothing — which the schema
    // reports, but as a second error the author did not cause.
    let d = addNode(draft(), { id: "a", kind: "manual_trigger" });
    d = addNode(d, { id: "b", kind: "log" });
    d = connect(d, { source: "a", target: "b" });

    const after = removeNode(d, "b");

    expect(after.graph.nodes).toHaveLength(1);
    expect(after.graph.edges).toHaveLength(0);
  });
});

describe("configureNode", () => {
  test("merges rather than replaces", () => {
    let d = addNode(draft(), { id: "t", kind: "transform" });
    d = configureNode(d, "t", { mode: "expression" }).draft;
    const node = d.graph.nodes[0] as { data: { config: Record<string, unknown> } };

    expect(node.data.config.mode).toBe("expression");
    // the kind's other defaults survive
    expect(node.data.config.fields).toBeDefined();
  });

  test("REPORTS a bad config rather than refusing the write", () => {
    // A half-configured graph is a normal intermediate state for an agent
    // building one step at a time. Refusing the write makes it impossible to
    // get there; reporting lets `check` be the place that says "not finished".
    let d = addNode(draft(), { id: "r", kind: "api_request" });
    const result = configureNode(d, "r", { method: "TELEPORT" });

    d = result.draft;
    expect((d.graph.nodes[0] as { data: { config: Record<string, unknown> } }).data.config.method).toBe("TELEPORT");
    expect(result.issues.every((i) => i.level === "warning")).toBe(true);
  });
});

describe("checkDraft", () => {
  test("tags schema issues and host refusals SEPARATELY", () => {
    // The whole point. "This graph is malformed" and "this host will not run
    // it" have different remedies, and collapsing them costs an author time
    // chasing the wrong fix.
    let d = addNode(draft(), { id: "u", kind: "user_input" });
    d = addNode(d, { id: "t", kind: "manual_trigger" });
    d = connect(d, { source: "t", target: "u" });

    const issues = checkDraft(d, (k) =>
      k.name.includes("user_input") ? "No resume support on this host." : null,
    );

    const host = issues.filter((i) => i.source === "host");
    expect(host).toHaveLength(1);
    expect(host[0]?.message).toBe("No resume support on this host.");
    expect(host[0]?.nodeId).toBe("u");
  });

  test("a well-formed graph with no policy has nothing to report", () => {
    let d = addNode(draft(), { id: "t", kind: "manual_trigger" });
    d = addNode(d, { id: "l", kind: "log" });
    d = connect(d, { source: "t", target: "l" });

    expect(checkDraft(d).filter((i) => i.level === "error")).toEqual([]);
  });

  test("reuses the engine's own reporting rather than a second validator", () => {
    // A node wired to nothing is the engine's complaint, surfaced through us
    // with source "schema". If this ever stops firing, someone has written a
    // second validator that can disagree with the first.
    let d = addNode(draft(), { id: "t", kind: "manual_trigger" });
    d = addNode(d, { id: "orphan", kind: "log" });

    const schemaIssues = checkDraft(d).filter((i) => i.source === "schema");

    expect(schemaIssues.length).toBeGreaterThan(0);
    expect(schemaIssues.some((i) => i.nodeId === "orphan")).toBe(true);
  });
});

describe("toDocument", () => {
  test("emits a WorkflowSchema the engine can read back", () => {
    let d = addNode(draft(), { id: "t", kind: "manual_trigger" });
    d = addNode(d, { id: "l", kind: "log" });
    d = connect(d, { source: "t", target: "l" });

    const doc = toDocument(d) as { version: number; graph: { nodes: unknown[]; edges: unknown[] } };

    expect(doc.version).toBe(1);
    expect(doc.graph.nodes).toHaveLength(2);
    expect(doc.graph.edges).toHaveLength(1);
  });
});
