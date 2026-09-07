/**
 * The Node twin offers the same tools as the PHP twin.
 *
 * "Twin" is the entire value proposition: an agent that learned to author
 * graphs against `fancy-flow-mcp` should not have to relearn anything against
 * this package. That claim decays silently — one side gains a tool, nobody
 * notices, and the two servers drift into being merely similar.
 *
 * So the PHP tool names are READ FROM THE PHP SOURCE, never mirrored into a
 * list here. A hand-kept mirror is the defect this kit finds most often, and
 * writing one inside the test that exists to prevent drift would be a
 * particularly good joke at our own expense.
 *
 * ## Why this skips instead of failing when the sibling is absent
 *
 * CI clones one repo. Reading `../fancy-flow-mcp` only works inside the
 * envelope, so outside it there is no comparison to make — and a test that
 * fails because a file it needs is not there teaches people to ignore it. It
 * skips loudly with a reason instead.
 *
 * The one thing it must never do is PASS quietly when the sibling is missing:
 * that is the vacuous green this kit keeps getting bitten by, so the guard
 * asserts the parse found tools before it compares anything.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBuiltinKinds } from "@particle-academy/fancy-flow/registry";
import { createFlowServer, MemoryDraftStore } from "../src/server";

const PHP_TOOLS_DIR = fileURLToPath(new URL("../../fancy-flow-mcp/src/Tools/", import.meta.url));
const HAVE_SIBLING = existsSync(PHP_TOOLS_DIR);

/** Tool names as the PHP server declares them: `#[Name('add_node')]`. */
function phpToolNames(): string[] {
  const names: string[] = [];

  for (const file of readdirSync(PHP_TOOLS_DIR)) {
    if (!file.endsWith(".php")) continue;
    const match = readFileSync(PHP_TOOLS_DIR + file, "utf8").match(/#\[Name\('([a-z_]+)'\)\]/);
    if (match) names.push(match[1]!);
  }

  return names.sort();
}

async function nodeToolNames(): Promise<string[]> {
  registerBuiltinKinds();

  const server = createFlowServer({ store: new MemoryDraftStore() });
  const client = new Client({ name: "parity", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return (await client.listTools()).tools.map((t) => t.name).sort();
}

describe.skipIf(!HAVE_SIBLING)("tool parity with fancy-flow-mcp (PHP)", () => {
  test("offers exactly the tools the PHP server offers", async () => {
    const php = phpToolNames();

    // Vacuity: a regex that stopped matching would make every comparison below
    // trivially true. The PHP server has fifteen.
    expect(php.length, "parsed no tool names out of the PHP source — the matcher broke, not the server").toBeGreaterThan(10);

    const node = await nodeToolNames();

    const missing = php.filter((n) => !node.includes(n));
    const extra = node.filter((n) => !php.includes(n));

    expect({ missing, extra }, [
      `Compared ${node.length} Node tools against ${php.length} PHP tools.`,
      missing.length ? `Only in PHP: ${missing.join(", ")}` : "",
      extra.length ? `Only in Node: ${extra.join(", ")}` : "",
      "",
      "A tool on one side and not the other means an agent that learned one",
      "server cannot drive the other. Add it, or remove it from both.",
    ]
      .filter(Boolean)
      .join("\n")).toEqual({ missing: [], extra: [] });
  });
});

test("the parity check is not silently skipping inside the envelope", () => {
  // A skip is correct outside the envelope and WRONG inside it — and the two
  // are indistinguishable in a test report, which is how a disabled check goes
  // unnoticed. This one fails if the sibling is present but the suite above
  // did not run against it.
  const insideEnvelope = existsSync(fileURLToPath(new URL("../../fancy-flow/package.json", import.meta.url)));

  if (insideEnvelope) {
    expect(HAVE_SIBLING, "in the envelope, but repos/fancy-flow-mcp is missing — parity was not checked").toBe(true);
  }
});
