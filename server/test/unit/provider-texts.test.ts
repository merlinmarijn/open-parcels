import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BUILTIN_CARRIERS } from "../../src/engine/builtin-carriers.js";
import { requestLanguage } from "../../src/i18n/language.js";
import { hasProviderText, localizeSchema, providerText } from "../../src/i18n/translate.js";

interface JsonSchema {
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly items?: JsonSchema;
}

/** Every field of a schema as `path → field`, nested objects and alternatives included. */
function fields(schema: JsonSchema, prefix = ""): [string, JsonSchema][] {
  const own = Object.entries(schema.properties ?? {}).flatMap(([name, field]) => [
    [`${prefix}${name}`, field] as [string, JsonSchema],
    ...fields(field, `${prefix}${name}.`),
  ]);
  const alternatives = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap((option) =>
    fields(option, prefix),
  );
  return [
    ...own,
    ...alternatives,
    ...(schema.items === undefined ? [] : fields(schema.items, prefix)),
  ];
}

const jsonSchema = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { unrepresentable: "any" }) as JsonSchema;

const CARRIERS_DIR = fileURLToPath(new URL("../../src/carriers", import.meta.url));
const SIGN_IN_KIT = fileURLToPath(new URL("../../src/provider/sign-in.ts", import.meta.url));

/** String literals written as a `label:` or `message:` (joined with `+`), across the providers. */
function literalTexts(): string[] {
  const files = [
    SIGN_IN_KIT,
    ...readdirSync(CARRIERS_DIR, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => path.join(CARRIERS_DIR, file)),
  ];
  const pattern = /\b(?:label|message)\??:\s*((?:"[^"\n]*"\s*\+\s*)*"[^"\n]*")/gu;
  return files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(pattern)].map((match) =>
      (match[1] ?? "")
        .split(/"\s*\+\s*"/u)
        .join("")
        .replace(/^"|"$/gu, ""),
    ),
  );
}

describe("provider texts", () => {
  it("gives every config, secret and flow field of every provider a title", () => {
    const untitled = BUILTIN_CARRIERS.flatMap(({ info }) =>
      [
        ...fields(jsonSchema(info.configSchema)).map(
          ([name, f]) => [`${info.id} config ${name}`, f] as const,
        ),
        ...fields(jsonSchema(info.secretSchema)).map(
          ([name, f]) => [`${info.id} secret ${name}`, f] as const,
        ),
        ...info.signInFlows.flatMap((flow) =>
          flow.fields === null
            ? []
            : fields(jsonSchema(flow.fields)).map(
                ([name, f]) => [`${info.id} ${flow.id} ${name}`, f] as const,
              ),
        ),
      ]
        .filter(([, field]) => field.title === undefined)
        .map(([where]) => where),
    );
    expect(untitled).toEqual([]);
  });

  it("has a German text for every flow label, action text, field title and description", () => {
    const texts = BUILTIN_CARRIERS.flatMap(({ info }) => [
      ...info.signInFlows.map((flow) => flow.label),
      ...info.actions.flatMap((action) => [
        action.label,
        action.description,
        action.kind === "task" ? action.confirm : undefined,
      ]),
      ...[info.configSchema, info.secretSchema, ...info.signInFlows.map((flow) => flow.fields)]
        .filter((schema): schema is z.ZodType => schema !== null)
        .flatMap((schema) => fields(jsonSchema(schema)))
        .flatMap(([, field]) => [field.title, field.description]),
    ]);
    const missing = [...new Set([...texts, ...literalTexts()])].filter(
      (text): text is string => text !== undefined && !hasProviderText(text),
    );
    expect(missing).toEqual([]);
  });

  it("translates schema texts at every depth and keeps everything else", () => {
    const schema = {
      type: "object",
      title: "Account",
      properties: { title: { type: "string", title: "Username", description: "Postcode" } },
      enum: ["Account"],
    };
    expect(localizeSchema("de", schema)).toEqual({
      type: "object",
      title: "Konto",
      properties: { title: { type: "string", title: "Benutzername", description: "Postleitzahl" } },
      enum: ["Account"],
    });
    expect(localizeSchema("en", schema)).toBe(schema);
    expect(providerText("de", "A carrier's own words")).toBe("A carrier's own words");
  });

  it("reads the language from Accept-Language", () => {
    expect(requestLanguage(undefined)).toBe("en");
    expect(requestLanguage("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(requestLanguage("fr-FR, en;q=0.5, de;q=0.7")).toBe("de");
    expect(requestLanguage("de;q=0, en")).toBe("en");
    expect(requestLanguage("fr")).toBe("en");
  });
});
