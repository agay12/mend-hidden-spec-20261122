// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldPath: string, newPath: string, text: string): void {
    this.now.set(oldPath, null);
    this.now.set(newPath, text);
    this.moves.push([oldPath, newPath]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- files, lines

/** A file's text split into its lines, with its break kind and whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------- matching (section 5)

const tierOf = (l: string, tier: number): string =>
  tier === 0 ? l : tier === 1 ? l.replace(/[ \t]+$/, '') : l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

const leading = (s: string): string => /^[ \t]*/.exec(s)![0];

function reindent(l: string, P: string, F: string): string {
  if (l.trim() === '') return l;
  if (l.startsWith(P)) return F + l.slice(P.length);
  return l;
}

/** All positions where O occurs, at the first tier at which it occurs at least once. */
function findOccurrences(lines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 1 : 3;
  for (let tier = 0; tier < maxTier; tier++) {
    const o = O.map((l) => tierOf(l, tier));
    const positions: number[] = [];
    for (let i = 0; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (tierOf(lines[i + j]!, tier) !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface Body {
  t: ' ' | '-' | '+' | '\\';
  text: string;
}

const countO = (body: Body[]): number => body.filter((b) => b.t === ' ' || b.t === '-').length;

/** Write the body's result over the matched lines starting at pos (context from the file, tier-2 re-indent). */
function applyBody(lines: string[], pos: number, body: Body[], tier: number): string[] {
  const oLen = countO(body);
  const ofirst = body.find((b) => b.t === ' ' || b.t === '-')!;
  const P = leading(ofirst.text);
  const F = leading(lines[pos]!);
  const out = lines.slice(0, pos);
  let oi = pos;
  for (const b of body) {
    if (b.t === '\\') continue;
    if (b.t === ' ') {
      out.push(lines[oi]!);
      oi += 1;
    } else if (b.t === '-') {
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(b.text, P, F) : b.text);
    }
  }
  for (let k = pos + oLen; k < lines.length; k++) out.push(lines[k]!);
  return out;
}

/** Replace the oLen lines at pos with nLines (a format with no context marking: all of O is old). */
function replaceRange(lines: string[], pos: number, oLen: number, nLines: string[], tier: number, oFirst: string): string[] {
  const P = leading(oFirst);
  const F = leading(lines[pos]!);
  const mid = nLines.map((l) => (tier === 2 ? reindent(l, P, F) : l));
  return [...lines.slice(0, pos), ...mid, ...lines.slice(pos + oLen)];
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  body: Body[];
  line: number;
}
interface USec {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  sawHunk: boolean;
  pairSeen: boolean;
}

function uniPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.text === '' && hunk.body[hunk.body.length - 1]!.t === ' ') hunk.body.pop();
    cur!.hunks.push(hunk);
    hunk = null;
  };
  const closeSec = (): void => {
    closeHunk();
    if (cur !== null) secs.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (hunk !== null) {
      // inside a hunk body
      if (l.startsWith('diff --git ')) {
        closeSec();
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeSec();
        continue;
      }
      if (l.startsWith('@')) {
        closeHunk();
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        hunk.body.push({ t: l === '' ? ' ' : (l[0] as ' ' | '-' | '+' | '\\'), text: l === '' ? '' : l.slice(1) });
        i += 1;
        continue;
      }
      closeHunk();
      continue;
    }
    // section level
    if (l.startsWith('diff --git ')) {
      closeSec();
      const rest = l.slice('diff --git '.length);
      const at = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || at < 2) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: rest.slice(2, at), newPath: rest.slice(at + 3), newFile: false, deletedFile: false, hunks: [], sawHunk: false, pairSeen: false };
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = uniPath(l.slice(4));
      const newP = uniPath(lines[i + 1]!.slice(4));
      if (cur !== null && !cur.sawHunk && !cur.pairSeen) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pairSeen = true;
      } else {
        closeSec();
        cur = { oldPath: oldP, newPath: newP, newFile: false, deletedFile: false, hunks: [], sawHunk: false, pairSeen: true };
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && !cur.sawHunk) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a: Number(m[1]), body: [], line: i + 1 };
      cur.sawHunk = true;
      i += 1;
      continue;
    }
    if (cur !== null && !cur.sawHunk) {
      if (l.startsWith('rename from ')) {
        if (!cur.pairSeen) cur.oldPath = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (!cur.pairSeen) cur.newPath = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.deletedFile = true;
      }
    }
    i += 1;
  }
  closeSec();

  const edits: Edit[] = [];
  for (const sec of secs) {
    const isCreate = sec.oldPath === null || sec.newFile;
    const isDelete = !isCreate && (sec.newPath === null || sec.deletedFile);
    if (isCreate) {
      const p = sec.newPath!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.t === '+') plus.push(b.text);
        const lastBody = sec.hunks.length > 0 ? sec.hunks[sec.hunks.length - 1]!.body : [];
        const noNl = lastBody.length > 0 && lastBody[lastBody.length - 1]!.t === '\\';
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      });
      continue;
    }
    if (isDelete) {
      const p = sec.oldPath!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const from = sec.oldPath!;
    const to = sec.newPath!;
    const isMove = to !== from;
    edits.push((tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (isMove && !safe(to)) throw new Fail('unsafe', to);
      const text = tree.get(from);
      if (text === null) throw new Fail('missing', from);
      if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
      const st = splitFile(text);
      let d = 0;
      for (const h of sec.hunks) {
        const O = h.body.filter((b) => b.t === ' ' || b.t === '-').map((b) => b.text);
        const oLen = O.length;
        let pos: number;
        let tier: number;
        if (oLen > 0) {
          const occ = findOccurrences(st.lines, O, strict);
          if (occ === null) throw new Fail('no-match', from);
          const target = h.a - 1 + d;
          pos = occ.positions[0]!;
          for (const q of occ.positions) if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
          tier = occ.tier;
        } else {
          pos = Math.max(0, Math.min(h.a + d, st.lines.length));
          tier = 0;
        }
        const nLen = st.lines.length === 0 ? 0 : 0;
        const atEnd = oLen > 0 ? pos + oLen === st.lines.length : pos === st.lines.length;
        let next: string[];
        if (oLen > 0) {
          next = applyBody(st.lines, pos, h.body, tier);
        } else {
          const nLines = h.body.filter((b) => b.t === '+' ).map((b) => b.text);
          next = [...st.lines.slice(0, pos), ...nLines, ...st.lines.slice(pos)];
        }
        const realN = next.length - (st.lines.length - oLen);
        if (atEnd) st.final = lastIsBackslash(h.body) ? false : true;
        st.lines = next;
        d += realN - oLen;
      }
      const out = joinFile(st.lines, st.br, st.final);
      if (isMove) tree.move(from, to, out);
      else tree.now.set(from, out);
    });
  }
  return edits;
}

function lastIsBackslash(body: Body[]): boolean {
  return body.length > 0 && body[body.length - 1]!.t === '\\';
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastPath: string | null = null;
  let after = 0; // first line index after the previous block's REPLACE line
  let s = lines.findIndex((l) => l.trimEnd() === '<<<<<<< SEARCH');
  while (s >= 0) {
    // the path: nearest line before SEARCH, after the previous REPLACE, not blank, not a fence
    let path: string | null = null;
    for (let i = s - 1; i >= after; i--) {
      const l = lines[i]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    lastPath = path;
    const e = lines.findIndex((l, j) => j > s && l.trimEnd() === '=======');
    const r = e < 0 ? -1 : lines.findIndex((l, j) => j > e && l.trimEnd() === '>>>>>>> REPLACE');
    if (e < 0 || r < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, e);
    const newLines = lines.slice(e + 1, r);
    after = r + 1;
    edits.push((tree) => {
      if (!safe(path!)) throw new Fail('unsafe', path!);
      if (oldLines.length === 0) {
        if (tree.get(path!) !== null) throw new Fail('exists', path!);
        tree.now.set(path!, newLines.join('\n') + (newLines.length === 0 ? '' : '\n'));
        return;
      }
      const text = tree.get(path!);
      if (text === null) throw new Fail('missing', path!);
      const st = splitFile(text);
      const occ = findOccurrences(st.lines, oldLines, strict);
      if (occ === null) throw new Fail('no-match', path!);
      if (occ.positions.length > 1) throw new Fail('ambiguous', path!);
      st.lines = replaceRange(st.lines, occ.positions[0]!, oldLines.length, newLines, occ.tier, oldLines[0]!);
      tree.now.set(path!, joinFile(st.lines, st.br, st.final));
    });
    s = lines.findIndex((l, j) => j >= after && l.trimEnd() === '<<<<<<< SEARCH');
  }
  return edits;
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: Body[];
}
interface VSec {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: Chunk[];
  hasChunk: boolean;
  sawContent: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let i = lines.length - 1; i >= 0; i--) if (!blank(lines[i]!)) return i;
    return -1;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const secs: VSec[] = [];
  let cur: VSec | null = null;
  let chunk: Chunk | null = null;
  const closeChunk = (): void => {
    if (chunk === null) return;
    while (chunk.body.length > 0 && chunk.body[chunk.body.length - 1]!.t === ' ' && chunk.body[chunk.body.length - 1]!.text === '') chunk.body.pop();
    cur!.chunks.push(chunk);
    chunk = null;
  };
  const closeSec = (): void => {
    closeChunk();
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop();
    }
    if (cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2('error: parse 1');
    secs.push(cur);
    cur = null;
  };
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      closeSec();
      cur = { kind: 'add', path: l.slice(14).trim(), moveTo: null, addLines: [], chunks: [], hasChunk: false, sawContent: false };
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      closeSec();
      cur = { kind: 'delete', path: l.slice(17).trim(), moveTo: null, addLines: [], chunks: [], hasChunk: false, sawContent: false };
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      closeSec();
      cur = { kind: 'update', path: l.slice(17).trim(), moveTo: null, addLines: [], chunks: [], hasChunk: false, sawContent: false };
      continue;
    }
    if (blank(l)) {
      if (cur !== null && cur.kind === 'add') cur.addLines.push('');
      if (cur !== null && cur.kind === 'update' && chunk !== null) chunk.body.push({ t: ' ', text: '' });
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (cur.kind === 'add') {
      if (l.startsWith('+')) cur.addLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'delete') {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // update
    if (l === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      closeChunk();
      continue;
    }
    if (l.startsWith('*** Move to: ') && !cur.hasChunk && cur.moveTo === null) {
      cur.moveTo = l.slice(13).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk();
      chunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
      cur.hasChunk = true;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (chunk === null) {
        chunk = { anchor: null, eof: false, body: [] };
        cur.hasChunk = true;
      }
      chunk.body.push({ t: l[0] as ' ' | '-' | '+', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSec();

  const edits: Edit[] = secs.map((sec) => {
    if (sec.kind === 'add') {
      return (tree) => {
        const p = sec.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      return (tree) => {
        const p = sec.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    return (tree) => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      const moved = sec.moveTo;
      if (moved !== null && !safe(moved)) throw new Fail('unsafe', moved);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      if (moved !== null && tree.get(moved) !== null) throw new Fail('exists', moved);
      const st = splitFile(text);
      let cursor = 0;
      for (const c of sec.chunks) {
        if (c.anchor !== null && c.anchor !== '') {
          const at = findLineFrom(st.lines, cursor, c.anchor, strict);
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const O = c.body.filter((b) => b.t === ' ' || b.t === '-').map((b) => b.text);
        const oLen = O.length;
        let pos: number;
        let tier: number;
        if (oLen > 0) {
          const occ = findOccFrom(st.lines, cursor, O, strict, c.eof);
          if (occ === null) throw new Fail('no-match', p);
          pos = occ.pos;
          tier = occ.tier;
        } else {
          pos = c.eof ? st.lines.length : cursor;
          tier = 0;
        }
        let next: string[];
        if (oLen > 0) {
          next = applyBody(st.lines, pos, c.body, tier);
        } else {
          const nLines = c.body.filter((b) => b.t === '+').map((b) => b.text);
          next = [...st.lines.slice(0, pos), ...nLines, ...st.lines.slice(pos)];
        }
        st.lines = next;
        cursor = pos + (c.body.filter((b) => b.t === ' ' || b.t === '+').length);
      }
      const out = joinFile(st.lines, st.br, st.final);
      if (moved !== null) tree.move(p, moved, out);
      else tree.now.set(p, out);
    };
  });
  return edits;
}

function findLineFrom(lines: string[], from: number, anchor: string, strict: boolean): number {
  const maxTier = strict ? 1 : 3;
  for (let tier = 0; tier < maxTier; tier++) {
    const a = tierOf(anchor, tier);
    for (let i = from; i < lines.length; i++) if (tierOf(lines[i]!, tier) === a) return i;
  }
  return -1;
}

function findOccFrom(lines: string[], from: number, O: string[], strict: boolean, needEnd: boolean): { tier: number; pos: number } | null {
  const maxTier = strict ? 1 : 3;
  for (let tier = 0; tier < maxTier; tier++) {
    const o = O.map((l) => tierOf(l, tier));
    for (let i = from; i + O.length <= lines.length; i++) {
      if (needEnd && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (tierOf(lines[i + j]!, tier) !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- the run

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const bufCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const rows: Array<{ sort: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort(bufCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of tree.moves) {
    if (tree.now.get(o) === null && tree.now.get(n) !== null && tree.original(o) !== null && tree.original(n) === null) {
      const di = rows.findIndex((r) => r.sort === o && r.line === `D ${o}`);
      if (di >= 0) rows.splice(di, 1);
      const ai = rows.findIndex((r) => r.sort === n && r.line === `A ${n}`);
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ sort: n, line: `R ${o} -> ${n}` });
    }
  }
  rows.sort((a, b) => bufCmp(a.sort, b.sort));
  const out: string[] = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(bufCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
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
