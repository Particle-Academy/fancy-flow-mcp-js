#!/usr/bin/env node
/**
 * A ready-to-run stdio MCP server.
 *
 * `npx @particle-academy/fancy-flow-mcp-js` gives an agent a working
 * fancy-flow authoring server with drafts held in memory — enough to design a
 * graph, validate it, and export the WorkflowSchema document that any of the
 * four runtimes will read.
 *
 * ## Why in-memory is the right default for the binary, and wrong for a host
 *
 * Drafts vanish when the process exits. For `npx` that is correct: the agent
 * exports the document, which is the durable artifact. A host that wants
 * drafts to survive implements `DraftStore` against its own storage and calls
 * `createFlowServer` directly — that is the supported path, and this file is
 * deliberately thin enough to copy.
 *
 * ## No React, and no registry call
 *
 * 0.1.0 called `registerBuiltinKinds()` from `@particle-academy/fancy-flow/registry`
 * here, on the belief that the kind registry does not populate itself in a bare
 * process. It does: `/engine` fills it on first read, which is why every tool
 * test in this package passes without that call. And `/registry` imports React,
 * so the published binary could not start in a tree without React — the one
 * place a headless server most needs to run. `tests/stdio.e2e.test.ts` starts
 * this binary with React made unimportable.
 *
 * ## stdout belongs to the protocol
 *
 * JSON-RPC frames go to stdout, so ANYTHING else written there corrupts the
 * stream and the client sees a parse error rather than a message. Diagnostics
 * go to stderr. This is the single most common way a stdio MCP server is
 * broken by an otherwise harmless `console.log`.
 */
import { attachStdio } from "@particle-academy/agent-integrations/mcp/stdio";
import { createFlowServer, MemoryDraftStore } from "./server";

export function main(): void {
  const server = createFlowServer({ store: new MemoryDraftStore() });

  attachStdio(server);

  process.stderr.write("fancy-flow-mcp-js ready on stdio\n");
}

// Only self-start when run as a program, so importing this module in a test or
// a host does not seize stdin.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("stdio.js")) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(`fancy-flow-mcp-js failed to start: ${String(error)}\n`);
    process.exit(1);
  }
}
