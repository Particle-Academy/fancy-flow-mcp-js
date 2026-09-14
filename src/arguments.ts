/**
 * Tool arguments, checked against the JSON Schema each tool advertises.
 *
 * ## Why this exists, and why it is this small
 *
 * 0.1.0 declared its tool inputs with `zod` and let `@modelcontextprotocol/sdk`
 * turn them into JSON Schema and validate calls. Both are gone: the SDK was
 * refused as a dependency, and without it `zod` would have been a third-party
 * runtime dependency used only to write down fifteen small schemas that go on
 * the wire as JSON Schema anyway.
 *
 * So the schema IS the JSON Schema, and this checks a call against it. It is
 * not a JSON Schema validator. It understands exactly the vocabulary these
 * tools use — an object of named properties, some required, whose values are
 * strings or string-keyed records (optionally of records) — and
 * {@link assertSupportedSchema} refuses, at registration, any schema that uses
 * anything else. A validator that met a keyword it did not understand and
 * silently accepted every value would be a check that does not check.
 *
 * ## The wording is 0.1.0's, on purpose
 *
 * Every message reproduces what 0.1.0 sent (zod 4's issue text, formatted the
 * way the SDK formatted it), so an agent that learned to read and correct these
 * refusals sees the same text. `tests/wire.test.ts` replays a recorded matrix of
 * wrong arguments for every property of every tool against 0.1.0's replies.
 */

/** The JSON Schema subset the tools in this package are written in. */
export type ArgumentSchema = {
  $schema?: string;
  type?: "object" | "string";
  description?: string;
  properties?: Record<string, ArgumentSchema>;
  required?: string[];
  propertyNames?: ArgumentSchema;
  additionalProperties?: ArgumentSchema;
};

const KEYWORDS = new Set(["$schema", "type", "description", "properties", "required", "propertyNames", "additionalProperties"]);

/**
 * Throw if `schema` uses anything {@link argumentIssues} does not check.
 *
 * Called when a tool is registered, so a schema edit that reaches for `enum`,
 * `minLength` or a number type fails the first test that builds a server rather
 * than going unenforced in production.
 */
export function assertSupportedSchema(schema: ArgumentSchema, path = "inputSchema"): void {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`${path}: "${key}" is not checked by this package's argument validator.`);
  }
  if (schema.type !== undefined && schema.type !== "object" && schema.type !== "string") {
    throw new Error(`${path}: type "${String(schema.type)}" is not checked by this package's argument validator.`);
  }
  if (schema.type === "object") {
    if (schema.properties && (schema.additionalProperties || schema.propertyNames)) {
      throw new Error(`${path}: an object with both named properties and a record shape is not supported.`);
    }
    if (schema.propertyNames && !(schema.propertyNames.type === "string" && Object.keys(schema.propertyNames).length === 1)) {
      throw new Error(`${path}: propertyNames must be exactly { type: "string" }.`);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) assertSupportedSchema(child, `${path}.${name}`);
    if (schema.additionalProperties) assertSupportedSchema(schema.additionalProperties, `${path}.*`);
    for (const name of schema.required ?? []) {
      if (!schema.properties || !(name in schema.properties)) throw new Error(`${path}: "${name}" is required but not a property.`);
    }
  } else if (schema.properties || schema.required || schema.additionalProperties || schema.propertyNames) {
    throw new Error(`${path}: object keywords on a non-object schema.`);
  }
}

/** A JSON value's type in zod's words — the words 0.1.0's messages used. */
function received(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function check(schema: ArgumentSchema, value: unknown, path: string[], issues: string[]): void {
  // An empty schema ({}) accepts anything — it is how "any value" is written.
  if (schema.type === undefined) return;

  const at = path.length > 0 ? ` at ${path.join(".")}` : "";

  if (schema.type === "string") {
    if (typeof value !== "string") issues.push(`Invalid input: expected string, received ${received(value)}${at}`);
    return;
  }

  // An object with named properties is an "object"; a string-keyed map is a
  // "record". zod names them differently, so 0.1.0's messages did too.
  const noun = schema.properties ? "object" : "record";
  if (!isPlainObject(value)) {
    issues.push(`Invalid input: expected ${noun}, received ${received(value)}${at}`);
    return;
  }

  if (schema.properties) {
    // Schema order, not argument order: that is the order the issues were reported in.
    const required = new Set(schema.required ?? []);
    for (const [name, child] of Object.entries(schema.properties)) {
      if (value[name] === undefined && !required.has(name)) continue;
      check(child, value[name], [...path, name], issues);
    }
    // Arguments the schema does not name are ignored, as they were in 0.1.0.
    return;
  }

  if (schema.additionalProperties) {
    for (const [key, entry] of Object.entries(value)) check(schema.additionalProperties, entry, [...path, key], issues);
  }
}

/** Every way `args` fails `schema`, in the order a reader of the schema meets them. Empty means valid. */
export function argumentIssues(schema: ArgumentSchema, args: unknown): string[] {
  const issues: string[] = [];
  check(schema, args, [], issues);
  return issues;
}
