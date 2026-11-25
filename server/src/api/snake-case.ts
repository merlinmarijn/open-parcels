/** `nextRunAt` → `next_run_at`, as a type. */
type SnakeCase<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${SnakeCase<Tail>}`
  : S;

/** Arrays come out as mutable copies, so a readonly list fits a response schema. */
type Copied<V> = V extends readonly (infer E)[] ? E[] : V;

export type SnakeCased<T> = {
  -readonly [K in keyof T as K extends string ? SnakeCase<K> : K]: Copied<T[K]>;
};

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The one camelCase → snake_case mapping between the engine's views and the API's bodies
 * (top-level keys only; nested objects already use the API's names).
 */
export function snakeCased<T extends object>(view: T): SnakeCased<T> {
  return Object.fromEntries(
    Object.entries(view).map(([key, value]) => [
      snakeCase(key),
      Array.isArray(value) ? [...(value as unknown[])] : value,
    ]),
  ) as SnakeCased<T>;
}
