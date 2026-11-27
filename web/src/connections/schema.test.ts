import { describe, expect, it } from "vitest";
import { cleanValues, initialValues, isSecretField, unwrap, type JsonSchema } from "./schema";

describe("connection form schemas", () => {
  it("masks only real secrets", () => {
    for (const name of ["postalCode", "postal_code", "countryCode", "trackingCode", "keyword"]) {
      expect(isSecretField(name), name).toBe(false);
    }
    for (const name of [
      "password",
      "apiKey",
      "api_key",
      "refreshToken",
      "pinCode",
      "otp",
      "cookie",
    ]) {
      expect(isSecretField(name), name).toBe(true);
    }
  });

  it("read an optional field, a nullable type and a const list as the plain field (OP-163)", () => {
    expect(unwrap({ anyOf: [{ type: "string" }, { type: "null" }], description: "Code" })).toEqual({
      type: "string",
      description: "Code",
    });
    expect(unwrap({ type: ["integer", "null"] })).toMatchObject({ type: "integer" });
    expect(unwrap({ oneOf: [{ const: "de" }, { const: "at" }] })).toMatchObject({
      type: "string",
      enum: ["de", "at"],
    });
  });

  const schema: JsonSchema = {
    type: "object",
    required: ["country"],
    properties: {
      country: { type: "string", default: "DE" },
      postalCode: { type: "string" },
      options: {
        type: "object",
        properties: { history: { type: "boolean", default: true }, note: { type: "string" } },
      },
    },
  };

  it("start from the stored values, else the defaults, nested objects included (OP-163)", () => {
    expect(initialValues(schema, undefined)).toEqual({
      country: "DE",
      options: { history: true },
    });
    expect(initialValues(schema, { country: "AT", hidden: 1 })).toEqual({
      country: "AT",
      hidden: 1,
      options: { history: true },
    });
  });

  it("drop empty optional fields, keep required and unshown ones (OP-163)", () => {
    expect(
      cleanValues(schema, {
        country: "",
        postalCode: "",
        options: { history: false, note: "" },
        hidden: 1,
      }),
    ).toEqual({ country: "", options: { history: false }, hidden: 1 });
    expect(cleanValues(schema, { country: "DE", options: { note: "" } })).toEqual({
      country: "DE",
    });
  });
});
