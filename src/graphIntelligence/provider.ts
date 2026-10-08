import * as vscode from 'vscode';
import type { ProgressEvent } from './progressParser';

export type { ProgressEvent } from './progressParser';

/**
 * Narrow structured call: a prompt plus a JSON schema in, one parsed object out. It never ships
 * the graph and never runs the CLI in a write-capable mode. Annotate Graph is its only caller,
 * and the only CoGraph feature that runs an AI CLI.
 */
export interface JsonRequest {
  prompt: string;
  /**
   * Replaces the CLI's default system prompt. Measured on Claude Code 2.1: the
   * default prompt plus the user's MCP servers and skills cost ~$0.19 per haiku
   * call; a short replacement costs ~$0.005.
   */
  systemPrompt: string;
  /** JSON Schema the reply must match. */
  schema: Record<string, unknown>;
  workspaceRoot: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** 'none' = the model gets no tools; 'read-only' = it may open and search files. */
  tools: 'none' | 'read-only';
  onProgress?: (ev: ProgressEvent) => void;
}

export interface JsonUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface JsonResult {
  data: unknown;
  /** Undefined when the provider does not report usage (Codex). */
  usage?: JsonUsage;
}

export interface GraphIntelligenceProvider {
  readonly id: string;
  readonly displayName: string;
  runJson(req: JsonRequest, signal?: AbortSignal): Promise<JsonResult>;
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
    case 'codex': {
      const { CodexCliProvider } = require('./codexCliProvider');
      return new CodexCliProvider(outputChannel);
    }
    default:
      throw new Error(`Unknown Graph Intelligence provider: "${id}". Supported: claude-code, codex`);
  }
}
