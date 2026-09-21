// Structured logger: one JSON object per line on stderr (and into run.log when
// a sink is attached). No console.log anywhere in uxtest.
import * as fs from 'fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let sinkPath: string | null = null;

/** Mirror every log line into a file (the run's run.log). */
export function attachLogFile(filePath: string): void {
  sinkPath = filePath;
}

function write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }) + '\n';
  if (level !== 'debug' || process.env.UXTEST_DEBUG) { process.stderr.write(line); }
  if (sinkPath) {
    try { fs.appendFileSync(sinkPath, line); }
    catch (err) { process.stderr.write(`{"level":"error","event":"log-sink-failed","error":${JSON.stringify(String(err))}}\n`); sinkPath = null; }
  }
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => write('debug', event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => write('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => write('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => write('error', event, fields),
};
