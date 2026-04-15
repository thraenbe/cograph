import * as cp from 'child_process';
import * as path from 'path';

function toFwdSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

interface GraphNode {
  id: string;
  name: string;
  file: string | null;
  line: number;
  language?: 'python' | 'typescript' | 'javascript';
  gitStatus?: { unstaged: 'added' | 'modified' | 'deleted' | null; staged: 'added' | 'modified' | 'deleted' | null };
  isLibrary?: boolean;
  libraryName?: string;
}

type FileStatus = { unstaged: 'added'|'modified'|'deleted'|null; staged: 'added'|'modified'|'deleted'|null };

export class GitService {
  /** File-level git status from the most recent applyGitStatuses() call, keyed by forward-slash absolute path. */
  fileStatuses: Record<string, FileStatus> = {};

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
        const abs = toFwdSlash(path.join(workspaceRoot, rel));
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
          currentFile = toFwdSlash(path.join(workspaceRoot, line.slice(6).trimEnd()));
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

  /**
   * For each node with a file + line, return a Unix timestamp (seconds) for the commit
   * that last touched the definition line, via one `git blame --porcelain` call per file.
   * Nodes whose file is untracked, missing, or outside the repo are omitted.
   */
  getIntroductionTimes(nodes: GraphNode[], workspaceRoot: string): Map<string, number> {
    const result = new Map<string, number>();
    const nodesByFile = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      if (!node.file || !node.line || node.line <= 0) { continue; }
      const key = toFwdSlash(node.file);
      if (!nodesByFile.has(key)) { nodesByFile.set(key, []); }
      nodesByFile.get(key)!.push(node);
    }

    const rootFwd = toFwdSlash(workspaceRoot);
    for (const [absFile, fileNodes] of nodesByFile) {
      let rel: string;
      if (absFile.startsWith(rootFwd + '/')) {
        rel = absFile.slice(rootFwd.length + 1);
      } else {
        rel = path.relative(workspaceRoot, absFile).replace(/\\/g, '/');
        if (rel.startsWith('..')) { continue; }
      }

      let out: string;
      try {
        out = cp.execFileSync('git', ['blame', '--porcelain', '--', rel], {
          cwd: workspaceRoot, timeout: 10000, encoding: 'utf8',
          shell: process.platform === 'win32',
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch { continue; }

      const lineTimes = this.parseBlamePorcelain(out);
      for (const node of fileNodes) {
        const ts = lineTimes.get(node.line);
        if (typeof ts === 'number') { result.set(node.id, ts); }
      }
    }
    return result;
  }

  /**
   * Parse `git blame --porcelain` output into a map of final-file line number -> author-time.
   * Each source line produces an entry beginning with "<sha> <origLine> <finalLine> [<count>]",
   * optional header fields (author-time appears only on the first occurrence of each sha),
   * then a tab-prefixed content line. Subsequent lines reuse cached author-time by sha.
   */
  parseBlamePorcelain(out: string): Map<number, number> {
    const lineTimes = new Map<number, number>();
    const shaToTime = new Map<string, number>();
    const lines = out.split('\n');
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;
    let i = 0;
    while (i < lines.length) {
      const m = header.exec(lines[i]);
      if (!m) { i++; continue; }
      const sha = m[1];
      const finalLine = parseInt(m[3], 10);
      i++;
      let authorTime: number | undefined;
      while (i < lines.length && lines[i].length > 0 && !lines[i].startsWith('\t')) {
        if (lines[i].startsWith('author-time ')) {
          authorTime = parseInt(lines[i].slice('author-time '.length), 10);
        }
        i++;
      }
      if (authorTime !== undefined) {
        shaToTime.set(sha, authorTime);
      } else {
        authorTime = shaToTime.get(sha);
      }
      if (i < lines.length && lines[i].startsWith('\t')) { i++; }
      if (authorTime !== undefined) { lineTimes.set(finalLine, authorTime); }
    }
    return lineTimes;
  }

  applyGitStatuses(nodes: GraphNode[], workspaceRoot: string): boolean {
    const gitMap = this.parseGitStatus(workspaceRoot);
    if (gitMap === null) { this.fileStatuses = {}; return false; }

    this.fileStatuses = Object.fromEntries(gitMap);

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
      const fileStatus = gitMap.get(toFwdSlash(node.file));
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
        unstaged: hunkStatus(unstagedDiff.get(toFwdSlash(node.file)) ?? []),
        staged:   hunkStatus(stagedDiff.get(toFwdSlash(node.file))   ?? []),
      };
    }
    return true;
  }
}
