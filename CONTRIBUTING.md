# Contributing to @particle-academy/fancy-flow-mcp-js

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

## Layout

- `src/authoring.ts` — the graph-authoring core (the `/authoring` entry). It
  depends on nothing beyond `fancy-flow`; keep it that way, so a host that only
  builds and validates graphs never pays for a server.
- `src/server.ts`, `src/arguments.ts` — the MCP server (`createFlowServer`) on
  agent-integrations' `MicroMcpServer`.
- `src/stdio.ts` — the `fancy-flow-mcp-js` bin.
- `tests/` — vitest suites. `parity.test.ts` reads the PHP twin's tool names
  from `../fancy-flow-mcp` source (inside the envelope) and skips with a reason
  when the sibling is absent. `stdio.e2e.test.ts` drives the built artifact.
  `fixtures/` holds the captured wire format.

## Commands

```bash
npm run build       # tsup
npm run dev         # tsup --watch
npm run lint        # tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest
```

## Changelog

Update `CHANGELOG.md` in the same commit as the change.
