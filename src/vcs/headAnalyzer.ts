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
      (graph) => { if (!settled) { settled = true; resolve(graph); } },
    );
    signal?.addEventListener('abort', () => {
      runner.killAll();
      if (!settled) { settled = true; reject(new Error('Cancelled.')); }
    });
    runner.run(dir, { allowRetry: false });
  });
}
