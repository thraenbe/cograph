import * as fs from 'fs';

export function getFuncSource(file: string, line: number): string {
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const startIdx = line - 1;
  if (startIdx < 0 || startIdx >= lines.length) throw new Error(`Line ${line} out of range`);
  const endIdx = file.endsWith('.py')
    ? findPythonFuncEnd(lines, startIdx)
    : findJsFuncEnd(lines, startIdx);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

export function findPythonFuncEnd(lines: string[], startIdx: number): number {
  const baseIndent = lines[startIdx].match(/^(\s*)/)?.[1].length ?? 0;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if ((lines[i].match(/^(\s*)/)?.[1].length ?? 0) <= baseIndent) return i - 1;
  }
  return lines.length - 1;
}

export function findJsFuncEnd(lines: string[], startIdx: number): number {
  let depth = 0, foundOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; foundOpen = true; }
      else if (ch === '}') depth--;
    }
    if (!foundOpen && i > startIdx) return startIdx; // arrow fn without braces
    if (foundOpen && depth === 0) return i;
  }
  return lines.length - 1;
}

export function saveFuncSource(file: string, line: number, newSource: string): void {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const startIdx = line - 1;
  if (startIdx < 0 || startIdx >= lines.length) throw new Error(`Line ${line} out of range`);
  const endIdx = file.endsWith('.py')
    ? findPythonFuncEnd(lines, startIdx)
    : findJsFuncEnd(lines, startIdx);
  lines.splice(startIdx, endIdx - startIdx + 1, ...newSource.replace(/\r\n/g, '\n').split('\n'));
  const eol = crlf ? '\r\n' : '\n';
  fs.writeFileSync(file, lines.join(eol), 'utf8');
}
