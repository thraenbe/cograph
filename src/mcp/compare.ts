/**
 * Ordinal (UTF-16 code unit) order. Every tie-break in the MCP replies and the Markdown export uses
 * it instead of `localeCompare`, whose result depends on the process locale and ICU version.
 */
export function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
