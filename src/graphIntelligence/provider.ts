import * as vscode from 'vscode';
import type { GraphData } from '../graphProvider';
import type { ProgressEvent } from './progressParser';

export type { ProgressEvent } from './progressParser';

export interface GraphIntelligenceRequest {
  prompt: string;
  graph: GraphData;
  workspaceRoot: string;
  /** Existing provider session ID to resume; null/undefined → start a fresh session. */
  sessionId?: string | null;
  model?: string;
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  onProgress?: (ev: ProgressEvent) => void;
}

export interface GraphIntelligenceResult {
  graph: GraphData;
  text: string;
  /** Provider session ID for this conversation (may be a new ID on fresh sessions). */
  sessionId?: string | null;
}

/**
 * Narrow structured call: a prompt plus a JSON schema in, one parsed object out.
 * Unlike `run()` it never ships the graph and never runs in a write-capable mode.
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
  run(req: GraphIntelligenceRequest, signal?: AbortSignal): Promise<GraphIntelligenceResult>;
  runJson?(req: JsonRequest, signal?: AbortSignal): Promise<JsonResult>;
}

export interface ProviderModelInfo {
  id: string;
  label: string;
  desc: string;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  /** Glyph shown in the model chip / menu header (single char). */
  glyph: string;
  models: ProviderModelInfo[];
  defaultModel: string;
  /** Configuration key holding the user's chosen model for this provider. */
  modelSettingKey: string;
}

export const PROVIDER_CATALOG: ProviderInfo[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    glyph: '◆',
    defaultModel: 'sonnet',
    modelSettingKey: 'graphIntelligence.model',
    models: [
      { id: 'default',  label: 'default',  desc: 'Your Claude Code account default' },
      { id: 'opus',     label: 'opus',     desc: 'Deepest reasoning · slowest · most expensive' },
      { id: 'sonnet',   label: 'sonnet',   desc: 'Balanced speed & quality — recommended' },
      { id: 'haiku',    label: 'haiku',    desc: 'Fastest, cheapest · no extended thinking' },
      { id: 'opusplan', label: 'opusplan', desc: 'Opus plans, Sonnet executes' },
    ],
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex',
    glyph: '◇',
    defaultModel: 'gpt-5-codex',
    modelSettingKey: 'graphIntelligence.codex.model',
    models: [
      { id: 'gpt-5-codex', label: 'gpt-5-codex', desc: 'GPT-5 fine-tuned for code — recommended' },
      { id: 'gpt-5',       label: 'gpt-5',       desc: 'GPT-5 general purpose' },
      { id: 'gpt-5-mini',  label: 'gpt-5-mini',  desc: 'Smaller, cheaper, faster' },
    ],
  },
];

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return PROVIDER_CATALOG.find(p => p.id === id);
}

/** Look up which provider a given model id belongs to. Used by the picker. */
export function findProviderForModel(modelId: string): ProviderInfo | undefined {
  return PROVIDER_CATALOG.find(p => p.models.some(m => m.id === modelId));
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
