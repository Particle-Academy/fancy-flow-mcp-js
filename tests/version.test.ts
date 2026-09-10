import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The version this server advertises must be the version it ships as.
 *
 * An MCP server's `serverInfo.version` is not decoration: it goes out in every
 * `initialize` response, so it is the number every connecting agent records and
 * may gate behaviour on. Its PHP twin `fancy-flow-mcp` had this exact surface
 * stale at 0.1.0 while shipping 0.4.0 — three minor releases — and nothing
 * compared them.
 *
 * This package agrees today. The test exists so it still agrees after the next
 * release, which is the only moment the defect is ever introduced.
 */
describe("the advertised default version is single-sourced", () => {
  const root = join(__dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

  it("matches package.json", () => {
    const source = readFileSync(join(root, "src", "server.ts"), "utf8");
    const declared = /const DEFAULT_SERVER_VERSION = "([^"]+)"/.exec(source)?.[1];

    expect(declared, "DEFAULT_SERVER_VERSION is not declared as a plain literal any more").toBeDefined();
    expect(
      declared,
      "the advertised version and package.json disagree. Every agent that connects is told this number.",
    ).toBe(pkg.version);
  });

  it("is actually the value the server falls back to", () => {
    // Guard the WIRING, not just the constant. Bumping the constant while the
    // call site keeps its own literal would leave the handshake still lying.
    const source = readFileSync(join(root, "src", "server.ts"), "utf8");

    expect(source).toContain("options.serverInfo?.version ?? DEFAULT_SERVER_VERSION");
  });
});
