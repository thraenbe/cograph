import * as vscode from 'vscode';
import type { GraphData } from '../graphProvider';
import type { ProgressEvent } from './progressParser';

export type { ProgressEvent } from './progressParser';

export interface GraphIntelligenceRequest {
  prompt: string;
  graph: GraphData;
  workspaceRoot: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  onProgress?: (ev: ProgressEvent) => void;
}

export interface GraphIntelligenceResult {
  graph: GraphData;
  text: string;
}

export interface GraphIntelligenceProvider {
  readonly id: string;
  readonly displayName: string;
  run(req: GraphIntelligenceRequest, signal?: AbortSignal): Promise<GraphIntelligenceResult>;
}

export function createProvider(
  id: string,
  outputChannel: vscode.OutputChannel,
): GraphIntelligenceProvider {
  switch (id) {
    case 'claude-code': {
      const { ClaudeCodeProvider } = require('./claudeCodeProvider');
      return new ClaudeCodeProvider(outputChannel);
    }
    default:
      throw new Error(`Unknown Graph Intelligence provider: "${id}". Supported: claude-code`);
  }
}
