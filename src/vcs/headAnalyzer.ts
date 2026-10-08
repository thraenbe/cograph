import * as vscode from 'vscode';
import { AnalyzerRunner } from '../analyzerRunner';
import type { TreeAnalyzer } from './engine/treeAnalysis';

/**
 * The engine's analyzer, in VS Code: one AnalyzerRunner per call (the runner
 * is single-flight), resolved from its graph sink, rejected from its error
 * sink, killed on cancellation. The thin layer the engine never sees.
 */
export function createTreeAnalyzer(context: vscode.ExtensionContext, log: (line: string) => void): TreeAnalyzer {
  return (dir, signal) => new Promise((resolve, reject) => {
    let settled = false;
    const runner = new AnalyzerRunner(
      context,
      (message) => { if (!settled) { settled = true; reject(new Error(message)); } },
      () => undefined,
      log,
      () => undefined,
      (graph, _root, meta) => {
        if (settled) { return; }
        settled = true;
        // Nothing found AND an analyzer did not run cleanly: that is a failure, not a tree without
        // functions. Diffing an empty tree would paint every function as added or removed.
        const failed = meta.statuses.filter(s => s.status !== 'ok' && s.status !== 'empty');
        if (graph.nodes.length === 0 && failed.length) {
          reject(new Error(`Analysis failed: ${failed.map(s => `${s.lang} ${s.status}${s.detail ? ` (${s.detail})` : ''}`).join('; ')}`));
          return;
        }
        resolve(graph);
      },
    );
    signal?.addEventListener('abort', () => {
      runner.killAll();
      if (!settled) { settled = true; reject(new Error('Cancelled.')); }
    });
    runner.run(dir, { allowRetry: false });
  });
}
