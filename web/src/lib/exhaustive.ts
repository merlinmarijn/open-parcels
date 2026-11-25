/**
 * A list that must name every member of `T`: one the server adds later fails to compile until it
 * is listed (the web types are generated from the server's API document).
 */
export function listingEvery<T extends string>() {
  return <const L extends readonly T[]>(
    list: L &
      ([Exclude<T, L[number]>] extends [never] ? unknown : { missing: Exclude<T, L[number]> }),
  ): L => list;
}
