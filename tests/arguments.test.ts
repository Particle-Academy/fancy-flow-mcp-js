/**
 * The two things `register` in src/server.ts took over from the SDK that the
 * wire recording cannot show on its own.
 *
 * 1. **The argument checker refuses schemas it cannot check.** The recording
 *    proves every CURRENT schema is enforced exactly as 0.1.0 enforced it. It
 *    cannot see the next edit: a property given `enum` or `minLength`, which a
 *    small validator would silently not enforce. So an unsupported keyword
 *    fails when the tool is registered — i.e. in every test that builds a
 *    server.
 *
 * 2. **A handler that throws is a result, not a failed request.** The
 *    recording never makes a host's store throw. 0.1.0's behaviour here was
 *    probed directly against commit 4759dfb (the SDK build) on 2026-09-13: a
 *    store that throws produced `{ content: [{ type: "text", text: <message> }],
 *    isError: true }`. That is pinned below.
 */
import { describe, expect, test } from "vitest";
import { argumentIssues, assertSupportedSchema, type ArgumentSchema } from "../src/arguments";
import { createFlowServer } from "../src/server";
import type { DraftStore } from "../src/authoring";
import { connectClient } from "./support/client";

const object = (properties: Record<string, ArgumentSchema>, required: string[] = []): ArgumentSchema => ({
  type: "object",
  properties,
  required,
});

describe("assertSupportedSchema refuses what argumentIssues would not enforce", () => {
  test.each([
    ["an enum", object({ mode: { type: "string", enum: ["a", "b"] } as ArgumentSchema })],
    ["a string length bound", object({ name: { type: "string", minLength: 1 } as ArgumentSchema })],
    ["a number type", object({ count: { type: "number" } as unknown as ArgumentSchema })],
    ["an array type", object({ tags: { type: "array" } as unknown as ArgumentSchema })],
    ["a union", object({ id: { anyOf: [{ type: "string" }] } as ArgumentSchema })],
    ["a required name that is not a property", object({ name: { type: "string" } }, ["nmae"])],
    ["a record keyed by something other than strings", object({ m: { type: "object", propertyNames: { type: "string", pattern: "^x" } as ArgumentSchema, additionalProperties: {} } })],
    ["a record nested inside a record with an unsupported value type", object({ m: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "number" } as unknown as ArgumentSchema } })],
  ])("%s", (_label, schema) => {
    expect(() => assertSupportedSchema(schema)).toThrow();
  });

  test("every schema the server actually registers is supported", () => {
    // createFlowServer calls assertSupportedSchema for each of its tools, so
    // building one is the check. Stated as a test so a failure names itself.
    expect(() => createFlowServer({ store: { list: () => [], get: () => null, save: () => {}, remove: () => {} } })).not.toThrow();
  });
});

describe("argumentIssues", () => {
  const schema = object(
    {
      name: { type: "string" },
      inputs: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} } },
    },
    ["name"],
  );

  test("is empty for valid arguments, and ignores arguments the schema does not name", () => {
    expect(argumentIssues(schema, { name: "x", inputs: { a: { b: 1 } }, extra: [1, 2] })).toEqual([]);
  });

  test("reports in SCHEMA order, whatever order the arguments came in", () => {
    expect(argumentIssues(schema, { inputs: { a: 3 }, name: 5 })).toEqual([
      "Invalid input: expected string, received number at name",
      "Invalid input: expected record, received number at inputs.a",
    ]);
  });

  test("an optional property given null is checked, not skipped", () => {
    // null is a value; only absence means "not given".
    expect(argumentIssues(schema, { name: "x", inputs: null })).toEqual(["Invalid input: expected record, received null at inputs"]);
  });
});

describe("a handler that throws", () => {
  const exploding: DraftStore = {
    list: () => {
      throw new Error("store is down");
    },
    get: async () => {
      throw new Error("store read failed");
    },
    save: () => {},
    remove: () => {},
  };

  test.each([
    ["a synchronous throw", "list_workflows", {}, "store is down"],
    ["a rejected promise", "get_workflow", { workflow_id: "x" }, "store read failed"],
  ])("%s becomes an isError result carrying the message, as in 0.1.0", async (_label, name, args, message) => {
    const client = await connectClient(createFlowServer({ store: exploding }));

    const replies = await client.exchange({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });

    expect(replies).toEqual([{ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: message }], isError: true } }]);
  });
});
