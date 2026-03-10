import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type OutputChannel = { appendLine: (s: string) => void };

export class LibraryDescriber {
  constructor(
    private readonly extensionPath: string,
    private readonly resolvePythonBin: () => string | null,
    private readonly getOutputChannel: () => OutputChannel,
  ) {}

  fetchLibDescription(libraryName: string, functionName: string, language: string, workspaceRoot: string): Promise<string> {
    if (language === 'python') {
      return this.fetchPythonDescription(libraryName, functionName);
    }
    return Promise.resolve(this.fetchTsDescription(libraryName, functionName, workspaceRoot));
  }

  private fetchPythonDescription(libraryName: string, functionName: string): Promise<string> {
    const pythonBin = this.resolvePythonBin();
    if (!pythonBin) { return Promise.resolve(''); }
    this.getOutputChannel().appendLine(`[CoGraph] Using Python: ${pythonBin}`);
    const script = path.join(this.extensionPath, 'scripts', 'describe_lib.py');
    return new Promise(resolve => {
      let resolved = false;
      const done = (val: string) => { if (!resolved) { resolved = true; resolve(val); } };
      let proc: cp.ChildProcess;
      try {
        proc = cp.spawn(pythonBin, [script, libraryName, functionName]);
      } catch {
        done('');
        return;
      }
      let stdout = '';
      proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr!.on('data', (chunk: Buffer) => {
        this.getOutputChannel().appendLine(`[describe_lib] ${chunk.toString().trim()}`);
      });
      proc.on('close', () => done(stdout.trim()));
      proc.on('error', () => done(''));
      setTimeout(() => { proc.kill(); done(''); }, 5000);
    });
  }

  private fetchTsDescription(libraryName: string, functionName: string, workspaceRoot: string): string {
    const nmDir = path.join(workspaceRoot, 'node_modules');
    const pkgDirs = [
      path.join(nmDir, '@types', libraryName),
      path.join(nmDir, libraryName),
    ];
    const candidates: string[] = [];
    for (const pkgDir of pkgDirs) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        const typesFile = pkg.types || pkg.typings;
        if (typesFile) { candidates.push(path.join(pkgDir, typesFile)); }
      } catch { /* no package.json */ }
      candidates.push(path.join(pkgDir, 'index.d.ts'));
    }
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`/\\*\\*([\\s\\S]*?)\\*/[\\s\\S]{0,300}?\\b${escaped}\\s*[(<]`, 'g');
    for (const filePath of candidates) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(content)) !== null) {
          const desc = match[1]
            .split('\n')
            .map((l: string) => l.replace(/^\s*\*\s?/, '').trim())
            .filter((l: string) => l && !l.startsWith('@'))
            .join('\n')
            .trim();
          if (desc) { return desc; }
        }
      } catch { /* skip */ }
    }
    return '';
  }
}
