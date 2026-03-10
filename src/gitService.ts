import * as cp from 'child_process';
import * as path from 'path';

interface GraphNode {
  id: string;
  name: string;
  file: string | null;
  line: number;
  language?: 'python' | 'typescript';
  gitStatus?: { unstaged: 'added' | 'modified' | 'deleted' | null; staged: 'added' | 'modified' | 'deleted' | null };
  isLibrary?: boolean;
  libraryName?: string;
}

export class GitService {
  parseGitStatus(workspaceRoot: string): Map<string, { unstaged: 'added'|'modified'|'deleted'|null; staged: 'added'|'modified'|'deleted'|null }> | null {
    try {
      const out = cp.execFileSync('git', ['status', '--porcelain', '-z'], {
        cwd: workspaceRoot, timeout: 5000, encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      const map = new Map();
      for (const entry of out.split('\0').filter((e: string) => e.length >= 4 && /^[A-Z? ][A-Z? ] /.test(e))) {
        const X = entry[0], Y = entry[1];
        const rel = entry.slice(3);
        const abs = path.join(workspaceRoot, rel);
        let unstaged: 'added'|'modified'|'deleted'|null = null;
        if (X === '?' && Y === '?') { unstaged = 'added'; }
        else if (Y === 'M') { unstaged = 'modified'; }
        else if (Y === 'D') { unstaged = 'deleted'; }
        else if (X === 'A' && Y === ' ') { unstaged = 'added'; }
        let staged: 'added' | 'modified' | 'deleted' | null = null;
        if (X === 'A') { staged = 'added'; }
        else if (X === 'D') { staged = 'deleted'; }
        else if (X !== ' ' && X !== '?') { staged = 'modified'; }
        map.set(abs, { unstaged, staged });
      }
      return map;
    } catch { return null; }
  }

  parseGitDiff(workspaceRoot: string, staged: boolean): Map<string, Array<{start: number; end: number; isNew: boolean}>> {
    try {
      const args = ['diff', '--unified=0'];
      if (staged) { args.push('--cached'); }
      const out = cp.execFileSync('git', args, {
        cwd: workspaceRoot, timeout: 5000, encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      const map = new Map<string, Array<{start: number; end: number; isNew: boolean}>>();
      let currentFile: string | null = null;
      for (const line of out.split('\n')) {
        if (line.startsWith('+++ b/')) {
          currentFile = path.join(workspaceRoot, line.slice(6).trimEnd());
          if (!map.has(currentFile)) { map.set(currentFile, []); }
        } else if (line.startsWith('@@') && currentFile) {
          const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          if (m) {
            const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
            const newStart = parseInt(m[3], 10);
            const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
            const end = newCount > 0 ? newStart + newCount - 1 : newStart;
            map.get(currentFile)!.push({ start: newStart, end, isNew: oldCount === 0 });
          }
        }
      }
      return map;
    } catch { return new Map(); }
  }

  applyGitStatuses(nodes: GraphNode[], workspaceRoot: string): boolean {
    const gitMap = this.parseGitStatus(workspaceRoot);
    if (gitMap === null) { return false; }

    const nodesByFile = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      if (!node.file) continue;
      if (!nodesByFile.has(node.file)) { nodesByFile.set(node.file, []); }
      nodesByFile.get(node.file)!.push(node);
    }
    for (const list of nodesByFile.values()) {
      list.sort((a, b) => a.line - b.line);
    }

    const unstagedDiff = this.parseGitDiff(workspaceRoot, false);
    const stagedDiff   = this.parseGitDiff(workspaceRoot, true);

    for (const node of nodes) {
      if (!node.file) continue;
      const fileStatus = gitMap.get(node.file);
      if (!fileStatus) { node.gitStatus = { unstaged: null, staged: null }; continue; }
      if (fileStatus.unstaged === 'added' || fileStatus.unstaged === 'deleted') {
        node.gitStatus = fileStatus; continue;
      }
      const siblings  = nodesByFile.get(node.file)!;
      const idx       = siblings.indexOf(node);
      const nodeStart = node.line;
      const nodeEnd   = idx + 1 < siblings.length ? siblings[idx + 1].line - 1 : Infinity;
      const hunkStatus = (hunks: Array<{start: number; end: number; isNew: boolean}>): 'added'|'modified'|null => {
        const overlapping = hunks.filter(h => h.start <= nodeEnd && h.end >= nodeStart);
        if (overlapping.length === 0) { return null; }
        const defLineIsNew = overlapping.some(h => h.isNew && h.start <= nodeStart && nodeStart <= h.end);
        return defLineIsNew ? 'added' : 'modified';
      };
      node.gitStatus = {
        unstaged: hunkStatus(unstagedDiff.get(node.file) ?? []),
        staged:   hunkStatus(stagedDiff.get(node.file)   ?? []),
      };
    }
    return true;
  }
}
