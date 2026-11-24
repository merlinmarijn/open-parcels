// The Unraid template is checked here because the web tests run with a DOM, whose XML parser
// rejects a malformed file before it reaches users. Prettier skips XML.
import { describe, expect, it } from "vitest";
import template from "../../../unraid/open-parcels.xml?raw";

describe("unraid/open-parcels.xml", () => {
  it("is well-formed and names the container", () => {
    const doc = new DOMParser().parseFromString(template, "application/xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.documentElement.tagName).toBe("Container");
    expect(doc.querySelector("Name")?.textContent).toBe("open-parcels");
  });
});
