import * as fs from 'fs';
import * as path from 'path';

/** A regular file of a commit: its blob, and its repository-relative POSIX path. */
export interface TreeFile { oid: string; file: string }

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/**
 * Writes what `git cat-file --batch` prints for `files`, in that order, under `dir`. An answer is
 * `<oid> blob <size>\n`, then the bytes, then `\n`; a chunk of the stream may end anywhere in it.
 * The bytes are the commit's own, so no attribute, filter or line-ending rule has a say. Only
 * plain files are made, without the execute bit: nothing in a copy is ever run.
 *
 * Throws on anything but the expected blob, and on a write that fails: two tree entries that
 * need one name as a file and as a folder, a full disk. `close` releases the file in progress.
 */
export class BlobWriter {
  private readonly dir: string;
  private readonly made = new Set<string>();
  private next = 0;
  private header = EMPTY;
  /** Bytes of the current answer still to come, its closing newline included; 0 between answers. */
  private left = 0;
  private fd: number | null = null;

  constructor(dir: string, private readonly files: TreeFile[]) {
    this.dir = path.resolve(dir);
  }

  /** Every file has arrived whole. */
  get complete(): boolean { return this.next === this.files.length && this.left === 0; }

  push(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length) {
      at = this.left > 0 ? this.readBody(chunk, at) : this.readHeader(chunk, at);
    }
  }

  close(): void {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
  }

  private readHeader(chunk: Buffer, at: number): number {
    const end = chunk.indexOf(NEWLINE, at);
    if (end < 0) { this.header = Buffer.concat([this.header, chunk.subarray(at)]); return chunk.length; }
    const line = Buffer.concat([this.header, chunk.subarray(at, end)]).toString('latin1');
    this.header = EMPTY;
    const wanted = this.files[this.next];
    const blob = /^(\S+) blob (\d+)$/.exec(line);
    if (!wanted || blob?.[1] !== wanted.oid) { throw new Error(`git answered "${line.slice(0, 120)}" for ${wanted?.file ?? 'nothing'}`); }
    this.open(wanted.file);
    this.next++;
    this.left = Number(blob[2]) + 1;
    return end + 1;
  }

  private readBody(chunk: Buffer, at: number): number {
    const take = Math.min(this.left, chunk.length - at);
    const bytes = take === this.left ? take - 1 : take; // the last byte of an answer is its closing newline
    if (bytes > 0) { fs.writeFileSync(this.fd as number, chunk.subarray(at, at + bytes)); }
    this.left -= take;
    if (this.left === 0) { this.close(); }
    return at + take;
  }

  private open(file: string): void {
    const target = path.resolve(this.dir, file);
    if (!target.startsWith(this.dir + path.sep)) { throw new Error(`"${file}" would land outside the copy`); }
    const parent = path.dirname(target);
    if (!this.made.has(parent)) { fs.mkdirSync(parent, { recursive: true }); this.made.add(parent); }
    this.fd = fs.openSync(target, 'w');
  }
}
