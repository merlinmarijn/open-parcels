import { asObject, isObject, UnexpectedResponseError, type Json } from "../../provider/api.js";

/** Read React Router's JSON reference table without executing scripts from the page. */
export function pageData(html: string, route: "OrdersOverviewRoute" | "OrderDetailsRoute"): Json {
  const encoded =
    /window\.__reactRouterContext\.streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/.exec(
      html,
    )?.[1];
  try {
    const parsed: unknown = JSON.parse(JSON.parse(encoded ?? "") as string);
    if (!Array.isArray(parsed)) throw new Error("Missing table");
    const table: unknown[] = parsed;
    const cache = new Map<number, unknown>();
    function read(index: unknown, depth = 0): unknown {
      if (!Number.isInteger(index) || typeof index !== "number" || depth > 100)
        throw new Error("Invalid reference");
      if (index === -5 || index === -7) return null;
      if (index < 0 || index >= table.length) throw new Error("Invalid reference");
      if (cache.has(index)) return cache.get(index);
      const value: unknown = table[index];
      if (value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) {
        const result: unknown[] = [];
        cache.set(index, result);
        for (const entry of value) result.push(read(entry, depth + 1));
        return result;
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      cache.set(index, result);
      for (const [key, ref] of Object.entries(value)) {
        if (!/^_\d+$/.test(key)) throw new Error("Invalid key");
        const name = table[Number(key.slice(1))];
        if (typeof name !== "string") throw new Error("Invalid key");
        result[name] = read(ref, depth + 1);
      }
      return result;
    }
    const data = asObject(asObject(read(0))["loaderData"])[`routes/account/orders/${route}`];
    if (!isObject(data)) throw new Error("Missing route");
    return data;
  } catch {
    throw new UnexpectedResponseError("Bol's order page has an unfamiliar data format.");
  }
}
