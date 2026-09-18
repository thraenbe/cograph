/** Shared types for the AI "Annotate Graph" feature. No runtime code, no vscode import. */

export const ANNOTATION_VERSION = 1;

export interface FileAnnotation {
  summary: string;
  role?: string;
  /** sha1 of the file bytes the summary was written for. */
  hash: string;
  /** size + mtimeMs are only a shortcut to skip hashing; `hash` decides staleness. */
  size: number;
  mtimeMs: number;
  at: string;
}

export interface FolderAnnotation {
  summary: string;
  role?: string;
  /** sha1 over the sorted direct children (name + summary) the summary was written from. */
  childrenHash: string;
  at: string;
}

/** On-disk shape of `.cograph/annotations/annotations.json`. Keys are workspace-relative POSIX paths. */
export interface AnnotationFile {
  version: number;
  provider: string;
  model: string;
  generatedAt: string;
  files: Record<string, FileAnnotation>;
  folders: Record<string, FolderAnnotation>;
}

/** What the model returns for one path. */
export interface SummaryEntry {
  summary: string;
  role?: string;
}

/** Locally built description of one file; the only file content sent in digest mode. */
export interface FileDigest {
  path: string;
  language: string;
  loc: number;
  symbols: string[];
  imports: string[];
  calls: string[];
  leadingComment: string;
}

/** One direct child of a folder, as shown to the model for the folder pass. */
export interface FolderChild {
  name: string;
  kind: 'file' | 'folder';
  summary: string;
}

export interface FolderDigest {
  path: string;
  children: FolderChild[];
}

/** Webview message carrying everything the hover card needs. */
export interface AnnotationsMessage {
  type: 'annotations';
  /** Absolute workspace root; the webview strips it to get the relative keys. */
  root: string;
  aiEnabled: boolean;
  files: Record<string, SummaryEntry>;
  folders: Record<string, SummaryEntry>;
  stale: string[];
}

export type AnnotationRunState = 'idle' | 'running';

/** Sidebar card status. */
export interface AnnotationStatus {
  state: AnnotationRunState;
  totalFiles: number;
  totalFolders: number;
  annotated: number;
  stale: number;
  pending: number;
  /** Progress of the current run. */
  done?: number;
  total?: number;
  costUsd?: number;
  /** False when the provider reports no cost (Codex). */
  costKnown?: boolean;
  note?: string;
}
