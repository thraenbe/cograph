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

export interface GraphIntelligenceProvider {
  readonly id: string;
  readonly displayName: string;
  run(req: GraphIntelligenceRequest, signal?: AbortSignal): Promise<GraphIntelligenceResult>;
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
