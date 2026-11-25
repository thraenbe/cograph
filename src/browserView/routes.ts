/**
 * Route types of docs/tour-protocol.md section 3 (the private `TourHost.routes`),
 * as the public server consumes them. The private package keeps an identical copy;
 * TypeScript's structural typing makes the two interchangeable.
 */

export interface TourRouteRequest {
  method: 'GET' | 'POST';
  /** Path without query, e.g. '/tour/abc/script'. */
  path: string;
  params: Record<string, string>;
  /** The query without the token. */
  query: Record<string, string>;
  /** Parsed JSON body for POST (capped at 1 MB), undefined for GET. */
  body?: unknown;
}

export interface TourRouteResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export interface TourRoute {
  method: 'GET' | 'POST';
  /** Express-style pattern with :params, e.g. '/tour/:id/script'. */
  pattern: string;
  handler(req: TourRouteRequest): Promise<TourRouteResponse>;
}

export interface CompiledPattern { regex: RegExp; keys: string[] }

/** '/tour/:id/script' → /^\/tour\/([^/]+)\/script$/ with keys ['id']. A param never spans a '/'. */
export function compilePattern(pattern: string): CompiledPattern {
  const keys: string[] = [];
  const source = pattern.split('/').map((seg) => {
    if (seg.startsWith(':') && seg.length > 1) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

/** The params of `path` under `compiled`, or null when it does not match. Values are URI-decoded. */
export function matchPattern(compiled: CompiledPattern, path: string): Record<string, string> | null {
  const m = compiled.regex.exec(path);
  if (!m) { return null; }
  const params: Record<string, string> = {};
  for (let i = 0; i < compiled.keys.length; i++) {
    try { params[compiled.keys[i]] = decodeURIComponent(m[i + 1]); }
    catch { return null; } // malformed escape: not this route
  }
  return params;
}
