// Split across two subpaths on purpose, and verified against the BUILT output
// rather than assumed: `importWorkflow` / `exportWorkflow` are NOT on
// `/engine`. They live on `/schema`, which has zero external dependencies at
// all. `/engine` carries the registry and analysis. Both are React-free, which
// is what a queue worker or CLI needs (fancy-flow#11).
import { importWorkflow, exportWorkflow } from "@particle-academy/fancy-flow/schema";
import {
  getNodeKind,
  listNodeKinds,
  defaultConfigFor,
  validateConfig,
  checkGraphConnectivity,
} from "@particle-academy/fancy-flow/engine";
import type { FlowGraph, FlowNode, FlowEdge, NodeKindDefinition } from "@particle-academy/fancy-flow/engine";

/**
 * Graph authoring, with no MCP and no transport.
 *
 * ## The split this package is built around
 *
 * From the consumer whose request created it, and it is the sentence to keep:
 *
 * > **We own whether a graph is well-formed; the host owns whether it is
 * > allowed to run.**
 *
 * So everything here answers the first question only. Whether a host may run a
 * given kind — capabilities, grants, whether a paused run can ever resume — is
 * a policy question this package must never invent an answer to. It takes one
 * from the host instead, as `AdmissionPolicy`.
 *
 * ## Why this file imports `/engine` and not the package root
 *
 * `/engine` is React-free (fancy-flow#11, fixed in 0.66.1 and guarded by a test
 * over the built output). An MCP server runs in a queue worker or a CLI with no
 * DOM, and pulling React into one is the exact failure that issue was about.
 *
 * ## Why nothing here re-implements validation
 *
 * `importWorkflow` already reports issues. A second validator is the shape that
 * bites twice: two hand-written copies of one rule, each with a passing test
 * asserting against itself. And the disagreement would reach an author as *"the
 * editor accepted it and the MCP refused it"*, which reads as a bug in the
 * agent rather than in the pair.
 */

/** A workflow the host is storing, in the shape this package hands around. */
export type WorkflowDraft = {
  id: string;
  name: string;
  graph: FlowGraph;
};

/** Where drafts live. The host owns storage; this package never persists. */
export type DraftStore = {
  list: () => Promise<WorkflowDraft[]> | WorkflowDraft[];
  get: (id: string) => Promise<WorkflowDraft | null> | WorkflowDraft | null;
  save: (draft: WorkflowDraft) => Promise<void> | void;
  remove: (id: string) => Promise<void> | void;
};

/**
 * The host's answer to "may I run this kind here?".
 *
 * Returning a string REFUSES and that string is shown to the author, so it must
 * name the missing capability rather than saying "unsupported". A refusal an
 * author can act on is worth more than a correct one they cannot — which is the
 * rule the consumer arrived at independently and is worth honouring in the
 * type's contract rather than only in prose.
 */
export type AdmissionPolicy = (kind: NodeKindDefinition) => string | null;

/** An issue, tagged by WHO refused. */
export type AuthoringIssue = {
  source: "schema" | "host";
  level: "error" | "warning";
  message: string;
  nodeId?: string;
};

export type AuthoringOptions = {
  store: DraftStore;
  /** Omitted means the host admits everything it has registered. */
  admits?: AdmissionPolicy;
};

/** The kinds an agent may author from, read from the LIVE registry. */
export function authorableKinds(admits?: AdmissionPolicy): Array<{
  kind: string;
  title: string;
  category: string;
  description?: string;
  admitted: boolean;
  refusedBecause?: string;
}> {
  // Sourced from the registry rather than a hand-kept list, deliberately. A
  // mirror of the vocabulary is the defect this kit keeps finding: it agrees
  // for a while, then a kind is added and nothing reports that it is missing.
  return listNodeKinds().map((kind) => {
    const refusal = admits ? admits(kind) : null;
    return {
      kind: kind.name,
      title: kind.label,
      category: kind.category,
      description: kind.description,
      admitted: refusal === null,
      ...(refusal === null ? {} : { refusedBecause: refusal }),
    };
  });
}

/**
 * Validate a draft: OUR issues and the HOST's refusals, tagged by source.
 *
 * Tagging is not cosmetic. "This graph is malformed" and "this host will not
 * run it" have different remedies — one is fixed by editing the graph, the
 * other by not using that kind here or by granting a capability. Collapsing
 * them costs an author real time chasing the wrong fix.
 */
export function checkDraft(draft: WorkflowDraft, admits?: AdmissionPolicy): AuthoringIssue[] {
  const issues: AuthoringIssue[] = [];

  // The engine's own reporting, reused rather than reimplemented.
  const imported = importWorkflow(toDocument(draft));
  for (const issue of imported.issues ?? []) {
    issues.push({
      source: "schema",
      level: issue.level === "error" ? "error" : "warning",
      message: issue.message,
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
    });
  }

  // Connectivity is the engine's too — a node that cannot take part in a run
  // is a schema fact, not a host policy.
  for (const problem of checkGraphConnectivity(draft.graph) ?? []) {
    issues.push({
      source: "schema",
      level: "error",
      message: problem.message,
      ...(problem.nodeId ? { nodeId: problem.nodeId } : {}),
    });
  }

  if (admits) {
    for (const node of draft.graph.nodes) {
      const kind = getNodeKind(node.type ?? "");
      if (!kind) continue; // an unknown kind is the schema's complaint, above
      const refusal = admits(kind);
      if (refusal !== null) {
        issues.push({ source: "host", level: "error", message: refusal, nodeId: node.id });
      }
    }
  }

  return issues;
}

/** The full WorkflowSchema document for a draft. */
export function toDocument(draft: WorkflowDraft): Record<string, unknown> {
  return exportWorkflow(draft.graph) as Record<string, unknown>;
}

/** Add a node, with the kind's own defaults filled in. */
export function addNode(
  draft: WorkflowDraft,
  spec: { id: string; kind: string; config?: Record<string, unknown>; parentId?: string },
): WorkflowDraft {
  const kind = getNodeKind(spec.kind);
  if (!kind) {
    throw new AuthoringError(
      `No node kind "${spec.kind}". Call the kinds tool to list what this host has registered — `
        + "it reads the live registry, so a kind the host added itself is in there too.",
    );
  }

  if (draft.graph.nodes.some((n) => n.id === spec.id)) {
    throw new AuthoringError(`A node with id "${spec.id}" already exists in "${draft.name}".`);
  }

  const node = {
    id: spec.id,
    type: kind.name,
    position: { x: 0, y: 0 },
    data: { label: kind.label, config: { ...defaultConfigFor(kind), ...(spec.config ?? {}) } },
    ...(spec.parentId ? { parentId: spec.parentId } : {}),
  } as unknown as FlowNode;

  return { ...draft, graph: { ...draft.graph, nodes: [...draft.graph.nodes, node] } };
}

/** Set a node's config, validated against its kind's schema. */
export function configureNode(
  draft: WorkflowDraft,
  nodeId: string,
  config: Record<string, unknown>,
): { draft: WorkflowDraft; issues: AuthoringIssue[] } {
  const node = draft.graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new AuthoringError(`No node "${nodeId}" in "${draft.name}".`);

  const kind = getNodeKind(node.type ?? "");
  const merged = { ...((node.data as { config?: Record<string, unknown> })?.config ?? {}), ...config };

  // Reported, not enforced. A half-configured graph is a normal intermediate
  // state for an agent building one step at a time, and refusing the write
  // would make it impossible to get there. `check` is where a caller asks
  // whether it is finished.
  const issues: AuthoringIssue[] = kind
    ? (validateConfig(kind, merged) ?? []).map((i) => ({
        source: "schema" as const,
        level: "warning" as const,
        message: `${i.key}: ${i.message}`,
        nodeId,
      }))
    : [];

  const nodes = draft.graph.nodes.map((n) =>
    n.id === nodeId ? ({ ...n, data: { ...(n.data as object), config: merged } } as FlowNode) : n,
  );

  return { draft: { ...draft, graph: { ...draft.graph, nodes } }, issues };
}

/** Connect two nodes. */
export function connect(
  draft: WorkflowDraft,
  spec: { id?: string; source: string; target: string; sourceHandle?: string; targetHandle?: string },
): WorkflowDraft {
  for (const end of ["source", "target"] as const) {
    if (!draft.graph.nodes.some((n) => n.id === spec[end])) {
      throw new AuthoringError(`Cannot connect: no node "${spec[end]}" in "${draft.name}".`);
    }
  }

  const edge = {
    id: spec.id ?? `${spec.source}->${spec.target}`,
    source: spec.source,
    target: spec.target,
    ...(spec.sourceHandle ? { sourceHandle: spec.sourceHandle } : {}),
    ...(spec.targetHandle ? { targetHandle: spec.targetHandle } : {}),
  } as unknown as FlowEdge;

  return { ...draft, graph: { ...draft.graph, edges: [...draft.graph.edges, edge] } };
}

/** Remove a node and every edge touching it. */
export function removeNode(draft: WorkflowDraft, nodeId: string): WorkflowDraft {
  if (!draft.graph.nodes.some((n) => n.id === nodeId)) {
    throw new AuthoringError(`No node "${nodeId}" in "${draft.name}".`);
  }

  // Edges are removed WITH the node. Leaving them would produce a graph whose
  // edges point at nothing — which importWorkflow reports, but as a second
  // error the author did not cause and cannot act on directly.
  return {
    ...draft,
    graph: {
      nodes: draft.graph.nodes.filter((n) => n.id !== nodeId),
      edges: draft.graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    },
  };
}

/** Named so a caller can tell an authoring refusal from a crash. */
export class AuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoringError";
  }
}
