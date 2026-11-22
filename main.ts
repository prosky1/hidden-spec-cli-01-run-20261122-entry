// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote — a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as
// JSON — to a tree of text files, to the contract in SPEC.md. Every file is
// changed or nothing is. Node 22, standard library alone; run it as
// `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// the last lines below hand over to runner.ts, which runs this file on each
// check in a fresh directory and posts what it did.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the line is the whole of stdout. */
class Halt extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Byte order of paths (UTF-8), for the output rows. */
const byteLess = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// ---------------------------------------------------------------------------
// Files: line breaks and lines (SPEC.md section 3)
// ---------------------------------------------------------------------------

type Break = '\n' | '\r\n';

interface FileState {
  br: Break;
  lines: string[];
  final: boolean;
}

/** Split a file's text into its line break, its lines and whether it ends with a break. */
function readState(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: Break = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

/** Join lines back with a break, and a final one exactly when asked; no lines means empty. */
function writeState(lines: string[], br: Break, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)
// ---------------------------------------------------------------------------

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return stripBoth(a) === stripBoth(b);
}

function occursAt(file: string[], pos: number, old: string[], tier: number): boolean {
  for (let k = 0; k < old.length; k++) {
    if (!tierEqual(file[pos + k]!, old[k]!, tier)) return false;
  }
  return true;
}

/** Every position at or after `from` where `old` occurs in `file` at `tier`. */
function occurrences(file: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > file.length) return out;
  for (let i = Math.max(0, from); i + old.length <= file.length; i++) {
    if (occursAt(file, i, old, tier)) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, 1, 2 — only 0 when strict) at which `old` occurs at or
 * after `from`, with every occurrence at that tier. With eofOnly, only
 * occurrences ending at the file's last line count.
 */
function firstTier(
  file: string[],
  old: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(file, old, t, from);
    if (eofOnly) pos = pos.filter((p) => p + old.length === file.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or an added line. */
type NewItem = { ctx: number } | { add: string };

/**
 * Build the replacement lines for a match at `pos`: context lines are the
 * file's own matched lines, never the patch's; at tier 2 every other line is
 * re-indented from O's first line's leading whitespace to the file's.
 */
function buildNew(file: string[], pos: number, old: string[], items: NewItem[], tier: number): string[] {
  const out: string[] = [];
  const pfx = old.length > 0 ? leadWs(old[0]!) : '';
  const ffx = leadWs(file[pos] ?? '');
  for (const it of items) {
    if ('ctx' in it) {
      out.push(file[pos + it.ctx]!);
    } else {
      const text = it.add;
      if (tier === 2 && !/^[ \t]*$/.test(text) && text.startsWith(pfx)) {
        out.push(ffx + text.slice(pfx.length));
      } else {
        out.push(text);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it
// ---------------------------------------------------------------------------

/** Changed paths live in `now` (null: deleted); the rest are read from disk on demand. */
class Tree {
  private readonly seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  noteMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

/** One edit: a closure that applies itself to the tree or throws EditFailure. */
type Edit = (tree: Tree) => void;

/** Check every path an edit names for safety before anything else about it. */
function checkSafe(paths: Array<string | null>): void {
  for (const p of paths) {
    if (p !== null && !isSafePath(p)) throw new EditFailure('unsafe', p);
  }
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface HunkLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line. */
  slash: boolean;
}

interface Hunk {
  /** A from the header: the 1-based old-file start line. */
  a: number;
  lines: HunkLine[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  /** From the ---/+++ pair: null means /dev/null; undefined means no pair. */
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** A ---/+++ path: after the four characters, up to the first tab, spaces trimmed; /dev/null means no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.lastIndexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep).trim();
  const y = rest.slice(sep + 3).trim();
  if (x === '' || y === '') return null;
  return [x, y];
}

/** Split a hunk into its old lines O and its new lines N (context lines carry their index in O). */
function hunkOldNew(h: Hunk): { old: string[]; items: NewItem[] } {
  const old: string[] = [];
  const items: NewItem[] = [];
  for (const l of h.lines) {
    if (l.kind === 'ctx') {
      items.push({ ctx: old.length });
      old.push(l.text);
    } else if (l.kind === 'old') {
      old.push(l.text);
    } else {
      items.push({ add: l.text });
    }
  }
  return { old, items };
}

/** Does a `\` line follow the hunk's last context or `+` line? No such line means no. */
function hunkEndsBare(h: Hunk): boolean {
  for (let i = h.lines.length - 1; i >= 0; i--) {
    const l = h.lines[i]!;
    if (l.kind === 'ctx' || l.kind === 'new') return l.slash;
  }
  return false;
}

/** Does a `\` line follow the section's last `+` line, over all its hunks? */
function lastPlusSlashed(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const h = hunks[hi]!;
    for (let i = h.lines.length - 1; i >= 0; i--) {
      const l = h.lines[i]!;
      if (l.kind === 'new') return l.slash;
    }
  }
  return false;
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, failPath: string): FileState {
  let lines = [...state.lines];
  let final = state.final;
  let d = 0;
  for (const h of hunks) {
    const { old, items } = hunkOldNew(h);
    if (old.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      const added: string[] = [];
      for (const it of items) if ('add' in it) added.push(it.add);
      lines.splice(at, 0, ...added);
      if (atEnd) final = !hunkEndsBare(h);
      d += added.length;
      continue;
    }
    const found = firstTier(lines, old, strict, 0, false);
    if (found === null) throw new EditFailure('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const touchesEnd = best + old.length === lines.length;
    const replacement = buildNew(lines, best, old, items, found.tier);
    lines.splice(best, old.length, ...replacement);
    if (touchesEnd) final = !hunkEndsBare(h);
    d += items.length - old.length;
  }
  return { br: state.br, lines, final };
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (s.hasPair) {
    oldP = s.oldPath ?? null;
    newP = s.newPath ?? null;
  } else if (s.renameFrom !== null || s.renameTo !== null) {
    oldP = s.renameFrom ?? s.gitOld;
    newP = s.renameTo ?? s.gitNew;
  } else {
    oldP = s.gitOld;
    newP = s.gitNew;
  }
  return (tree) => {
    checkSafe([oldP, newP]);
    if (oldP === null) {
      // A creation: the file is the `+` lines of all its hunks, in order.
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const added: string[] = [];
      for (const h of s.hunks) {
        for (const l of h.lines) if (l.kind === 'new') added.push(l.text);
      }
      const final = added.length > 0 ? !lastPlusSlashed(s.hunks) : false;
      tree.now.set(newP, writeState(added, '\n', final));
      return;
    }
    if (newP === null || s.isDeleted) {
      // A deletion: the hunks are not read.
      if (tree.get(oldP) === null) throw new EditFailure('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (s.isNew) {
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const added: string[] = [];
      for (const h of s.hunks) {
        for (const l of h.lines) if (l.kind === 'new') added.push(l.text);
      }
      const final = added.length > 0 ? !lastPlusSlashed(s.hunks) : false;
      tree.now.set(newP, writeState(added, '\n', final));
      return;
    }
    if (oldP !== newP) {
      // A move: the hunks apply to the old file's lines; the result is written at the new path.
      const text = tree.get(oldP);
      if (text === null) throw new EditFailure('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const out = applyHunks(readState(text), s.hunks, strict, oldP);
      tree.now.set(newP, writeState(out.lines, out.br, out.final));
      tree.now.set(oldP, null);
      tree.noteMove(oldP, newP);
      return;
    }
    const text = tree.get(oldP);
    if (text === null) throw new EditFailure('missing', oldP);
    const out = applyHunks(readState(text), s.hunks, strict, oldP);
    tree.now.set(oldP, writeState(out.lines, out.br, out.final));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  const startSection = (): UniSection => {
    const s: UniSection = {
      gitOld: null,
      gitNew: null,
      oldPath: undefined,
      newPath: undefined,
      renameFrom: null,
      renameTo: null,
      isNew: false,
      isDeleted: false,
      hasPair: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = diffGitPaths(line);
      if (g === null) throw new Halt(`error: parse ${i + 1}`);
      cur = startSection();
      cur.gitOld = g[0];
      cur.gitNew = g[1];
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && !cur.hasPair && cur.hunks.length === 0) {
          cur.oldPath = headerPath(line);
          cur.newPath = headerPath(next);
          cur.hasPair = true;
        } else {
          cur = startSection();
          cur.oldPath = headerPath(line);
          cur.newPath = headerPath(next);
          cur.hasPair = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Halt(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Halt(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Halt(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), lines: [] };
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          raw.push(b);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      for (const b of raw) {
        if (b[0] === '\\') {
          const prev = hunk.lines[hunk.lines.length - 1];
          if (prev !== undefined) prev.slash = true;
          continue;
        }
        if (b === '' || b[0] === ' ') hunk.lines.push({ kind: 'ctx', text: b === '' ? '' : b.slice(1), slash: false });
        else if (b[0] === '-') hunk.lines.push({ kind: 'old', text: b.slice(1), slash: false });
        else hunk.lines.push({ kind: 'new', text: b.slice(1), slash: false });
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i++;
  }
  if (sections.length === 0) throw new Halt('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    checkSafe([path]);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.now.set(path, writeState(newLines, '\n', newLines.length > 0));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new EditFailure('missing', path);
    const state = readState(text);
    const found = firstTier(state.lines, oldLines, strict, 0, false);
    if (found === null) throw new EditFailure('no-match', path);
    if (found.positions.length > 1) throw new EditFailure('ambiguous', path);
    const pos = found.positions[0]!;
    const items: NewItem[] = newLines.map((t) => ({ add: t }));
    const replacement = buildNew(state.lines, pos, oldLines, items, found.tier);
    const lines = [...state.lines];
    lines.splice(pos, oldLines.length, ...replacement);
    tree.now.set(path, writeState(lines, state.br, state.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (!isBlank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Halt(`error: parse ${searchAt + 1}`);
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Halt(`error: parse ${searchAt + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchAt + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Halt('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** The @@ anchor, or null when there is none. */
  anchor: string | null;
  /** Body lines: context and old lines form O, context and new lines form N. */
  body: HunkLine[];
  /** Anchored to the end of the file by a `*** End of File` line. */
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Update sections only. */
  moveTo: string | null;
  /** Add sections: the file's lines. Update sections: the chunks. */
  addLines: string[];
  chunks: V4aChunk[];
  /** The 1-based number of the section's header line, for the no-chunk error. */
  headerLine: number;
}

function v4aChunkOldNew(c: V4aChunk): { old: string[]; items: NewItem[] } {
  const old: string[] = [];
  const items: NewItem[] = [];
  for (const l of c.body) {
    if (l.kind === 'ctx') {
      items.push({ ctx: old.length });
      old.push(l.text);
    } else if (l.kind === 'old') {
      old.push(l.text);
    } else {
      items.push({ add: l.text });
    }
  }
  return { old, items };
}

/** Apply an Update section's chunks in order, with the cursor starting at line 0. */
function applyV4aChunks(lines: string[], chunks: V4aChunk[], strict: boolean, failPath: string): string[] {
  const out = [...lines];
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      let found: number | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        for (let k = cursor; k < out.length; k++) {
          if (tierEqual(out[k]!, c.anchor, t)) {
            found = k;
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new EditFailure('no-match', failPath);
      cursor = found + 1;
    }
    const { old, items } = v4aChunkOldNew(c);
    if (old.length === 0) {
      const at = c.eof ? out.length : cursor;
      const added: string[] = [];
      for (const it of items) if ('add' in it) added.push(it.add);
      out.splice(at, 0, ...added);
      cursor = at + added.length;
      continue;
    }
    const found = firstTier(out, old, strict, cursor, c.eof);
    if (found === null) throw new EditFailure('no-match', failPath);
    const pos = found.positions[0]!;
    const replacement = buildNew(out, pos, old, items, found.tier);
    out.splice(pos, old.length, ...replacement);
    cursor = pos + replacement.length;
  }
  return out;
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      checkSafe([s.path]);
      if (tree.get(s.path) !== null) throw new EditFailure('exists', s.path);
      tree.now.set(s.path, writeState(s.addLines, '\n', s.addLines.length > 0));
      return;
    }
    if (s.kind === 'delete') {
      checkSafe([s.path]);
      if (tree.get(s.path) === null) throw new EditFailure('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    checkSafe([s.path, s.moveTo]);
    const text = tree.get(s.path);
    if (text === null) throw new EditFailure('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new EditFailure('exists', s.moveTo);
    const state = readState(text);
    const lines = applyV4aChunks(state.lines, s.chunks, strict, s.path);
    const out = writeState(lines, state.br, state.final);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      tree.noteMove(s.path, s.moveTo);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aSectionStart(line: string): boolean {
  return line.startsWith(V4A_ADD) || line.startsWith(V4A_DEL) || line.startsWith(V4A_UPD);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Halt('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Halt(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Halt(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (!isV4aSectionStart(line)) throw new Halt(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const kind: V4aSection['kind'] = line.startsWith(V4A_ADD) ? 'add' : line.startsWith(V4A_DEL) ? 'delete' : 'update';
    const prefix = kind === 'add' ? V4A_ADD : kind === 'delete' ? V4A_DEL : V4A_UPD;
    const path = line.slice(prefix.length).trim();
    i++;
    // The section's raw lines run to the next section start or *** End Patch.
    const raw: string[] = [];
    const rawAt: number[] = [];
    while (i < last && !isV4aSectionStart(lines[i]!)) {
      raw.push(lines[i]!);
      rawAt.push(i + 1);
      i++;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) {
      raw.pop();
      rawAt.pop();
    }
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.startsWith('+')) addLines.push(r.slice(1));
        else if (r === '') addLines.push('');
        else throw new Halt(`error: parse ${rawAt[k]!}`);
      }
      edits.push(v4aEdit({ kind, path, moveTo: null, addLines, chunks: [], headerLine }, strict));
      continue;
    }
    if (kind === 'delete') {
      if (raw.length > 0) throw new Halt(`error: parse ${rawAt[0]!}`);
      edits.push(v4aEdit({ kind, path, moveTo: null, addLines: [], chunks: [], headerLine }, strict));
      continue;
    }
    let moveTo: string | null = null;
    let at = 0;
    if (raw.length > 0 && raw[0]!.startsWith(V4A_MOVE)) {
      moveTo = raw[0]!.slice(V4A_MOVE.length).trim();
      at = 1;
    }
    const chunks: V4aChunk[] = [];
    let cur: V4aChunk | null = null;
    for (let k = at; k < raw.length; k++) {
      const r = raw[k]!;
      const no = rawAt[k]!;
      if (r === '*** End of File') {
        if (cur === null) throw new Halt(`error: parse ${no}`);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
        continue;
      }
      if (r.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        const anchor = r.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        continue;
      }
      if (r === '' || r[0] === ' ' || r[0] === '-' || r[0] === '+') {
        if (cur === null) {
          if (chunks.length > 0) throw new Halt(`error: parse ${no}`);
          cur = { anchor: null, body: [], eof: false };
        }
        if (r === '' || r[0] === ' ') cur.body.push({ kind: 'ctx', text: r === '' ? '' : r.slice(1), slash: false });
        else if (r[0] === '-') cur.body.push({ kind: 'old', text: r.slice(1), slash: false });
        else cur.body.push({ kind: 'new', text: r.slice(1), slash: false });
        continue;
      }
      throw new Halt(`error: parse ${no}`);
    }
    if (cur !== null) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) throw new Halt(`error: parse ${headerLine}`);
    edits.push(v4aEdit({ kind, path, moveTo, addLines: [], chunks, headerLine }, strict));
  }
  if (edits.length === 0) throw new Halt('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one (a wrong command or a missing or mistyped key). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    checkSafe([p]);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      checkSafe([p]);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const crlf = readState(before).br === '\r\n';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const at = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = need(tree);
      const state = readState(before);
      if (at < 0 || at > state.lines.length) throw new EditFailure('no-match', p);
      const lines = [...state.lines];
      lines.splice(at, 0, ...add);
      tree.now.set(p, writeState(lines, state.br, state.final));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Halt('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Halt(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Halt(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Halt(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Halt('error: parse 1');
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Halt(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Halt('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The command line (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Halt('error: parse 1');
  } catch (e) {
    if (e instanceof Halt) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (usedOld.has(oldP) || usedNew.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!usedOld.has(p) && !usedNew.has(p)) {
      rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
    if (check) continue;
    if (now === null) {
      rmSync(p, { force: true });
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
