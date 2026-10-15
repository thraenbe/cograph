// The scenario inventory: README's scenario table and uxtest/scenarios/*.spec.ts must be the same set.
// A scenario that is added, renamed or removed must change both, so its arrival or departure is visible in
// review instead of silent (the table was 5 rows stale when this test was written; 95-workflow left with #88).
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const UX = path.resolve(__dirname, '..');

test('README scenario table == scenario files', () => {
  const files = fs.readdirSync(path.join(UX, 'scenarios')).filter(f => f.endsWith('.spec.ts')).map(f => f.replace(/\.spec\.ts$/, '')).sort();
  const readme = fs.readFileSync(path.join(UX, 'README.md'), 'utf8');
  const rows = [...readme.matchAll(/^\| `(\d\d-[a-z0-9-]+)` \|/gm)].map(m => m[1]).sort();
  expect(files.length).toBeGreaterThan(0);
  expect({ inFilesNotReadme: files.filter(f => !rows.includes(f)), inReadmeNotFiles: rows.filter(r => !files.includes(r)) })
    .toEqual({ inFilesNotReadme: [], inReadmeNotFiles: [] });
});
