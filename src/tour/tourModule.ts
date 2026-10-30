import * as fs from 'fs';
import * as path from 'path';
import type { CreateTour, TourHost, TourHostApi } from './tourApi';

/**
 * Finds the private PR tour package at runtime (docs/tour-protocol.md section 0).
 * The public build never lists it: without it every tour entry point hides or
 * says STUB_SENTENCE, and the rest of the extension is exactly what it was.
 * No vscode import.
 */

export const STUB_SENTENCE = 'The PR tour is part of the Marketplace build of CoGraph.';
export const TOUR_PACKAGE = '@thraenbe/pr-tour';

export type TourSource = 'bundled' | 'env' | 'node_modules';

export interface TourPackage {
  source: TourSource;
  /** The host entry (CommonJS) to require. */
  hostEntry: string;
}

export interface LoadedTour {
  host: TourHost;
  source: TourSource;
  /** tour.js and tour.css, from the host itself (contract section 3). */
  webAssetsDir: string;
}

export interface ResolveDeps {
  env?: Record<string, string | undefined>;
  /** require.resolve; replaced in tests. */
  resolve?: (request: string, opts: { paths: string[] }) => string;
  exists?: (p: string) => boolean;
}

/** The first rung that exists: the packaged build, COGRAPH_TOUR_PACKAGE, node_modules. Null: the stub. */
export function resolveTourPackage(extensionRoot: string, deps: ResolveDeps = {}): TourPackage | null {
  const exists = deps.exists ?? fs.existsSync;
  const env = deps.env ?? process.env;
  const bundled = path.join(extensionRoot, 'dist', 'tour', 'host', 'index.js');
  if (exists(bundled) && exists(path.join(extensionRoot, 'dist', 'tour', 'web'))) { return { source: 'bundled', hostEntry: bundled }; }
  const dev = env.COGRAPH_TOUR_PACKAGE;
  if (dev) {
    const entry = path.join(path.resolve(dev), 'dist', 'host', 'index.js');
    if (exists(entry) && exists(path.join(path.resolve(dev), 'dist', 'web'))) { return { source: 'env', hostEntry: entry }; }
  }
  try {
    const entry = (deps.resolve ?? require.resolve)(`${TOUR_PACKAGE}/host`, { paths: [extensionRoot] });
    return { source: 'node_modules', hostEntry: entry };
  } catch {
    return null;
  }
}

export interface LoadDeps extends ResolveDeps {
  log: (line: string) => void;
  /** require; replaced in tests. */
  load?: (entry: string) => unknown;
}

/**
 * Load and create the tour host, or null. A package built for another contract version
 * throws TourApiMismatch from createTour: logged, and the extension carries on with the stub.
 */
export function loadTourHost(api: TourHostApi, extensionRoot: string, deps: LoadDeps): LoadedTour | null {
  const pkg = resolveTourPackage(extensionRoot, deps);
  if (!pkg) { return null; }
  let createTour: CreateTour | undefined;
  try {
    const mod = (deps.load ?? require)(pkg.hostEntry) as { createTour?: unknown };
    createTour = typeof mod?.createTour === 'function' ? mod.createTour as CreateTour : undefined;
  } catch (err) {
    deps.log(`[tour] the tour package at ${pkg.hostEntry} could not be loaded: ${(err as Error).message}`);
    return null;
  }
  if (!createTour) { deps.log(`[tour] ${pkg.hostEntry} exports no createTour(); using the stub`); return null; }
  let host: TourHost;
  try {
    host = createTour(api);
  } catch (err) {
    const e = err as Error;
    deps.log(e?.name === 'TourApiMismatch'
      ? `[tour] the tour package speaks another contract version (${e.message}); using the stub`
      : `[tour] the tour package failed to start: ${e?.message ?? String(err)}`);
    return null;
  }
  if (!host || host.version !== 1 || typeof host.prepare !== 'function' || !Array.isArray(host.routes) || typeof host.webAssetsDir !== 'string') {
    deps.log('[tour] the tour package returned no usable host (version 1 with prepare, routes, webAssetsDir); using the stub');
    return null;
  }
  deps.log(`[tour] tour package loaded (${pkg.source})`);
  return { host, source: pkg.source, webAssetsDir: host.webAssetsDir };
}
