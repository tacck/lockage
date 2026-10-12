import { minimatch } from 'minimatch';

/**
 * §4.0 shared helpers: glob / file-set intersection decisions.
 *
 * Shared by the advisory warning (§4.3), dirty-set overlap (§4.4), and 3-way precheck (§4.6).
 * Design policy (the asymmetry is the point):
 *   - The advisory side (globsOverlap / globsMatchAny) errs on the safe side of "false positive over
 *     miss" (warn-never-block, so the cost of over-warning is small, while a miss directly leads to a
 *     late discovery of a conflict).
 *   - The merge gate's fileIntersect takes it strictly by exact normalized-path match (a false
 *     positive here would be an unnecessary needs_review send-back and would hurt P-1).
 */

/** Shared minimatch options (§4.0: dot/nocomment/noext). */
const MM_OPTS = { dot: true, nocomment: true, noext: true } as const;

/**
 * Path normalization (preprocessing for all functions).
 * - Normalize to a repo-root-relative POSIX path (`/`-separated).
 * - Strip `./`, resolve `..`, collapse consecutive slashes, strip the leading `/`.
 * - Case-sensitive comparison (git basis; macOS's default FS is case-insensitive but git distinguishes).
 * - Do not follow symlinks (compare by the link's own path) = stay a pure string normalization.
 */
export function normalizePath(p: string): string {
  // Backslash (Windows) → slash, collapse consecutive slashes
  let s = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  // Strip the leading ./ and /
  s = s.replace(/^\.?\//, '');
  // Resolve ./ and ../ per segment
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Keep a .. that goes above the root (outside the relative path = kept as-is as a comparison string)
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

function normalizeAll(items: string[]): string[] {
  return items.map(normalizePath);
}

/** If a glob has a literal directory prefix, return that prefix (null if none). */
function literalDirPrefix(glob: string): string | null {
  const segs = glob.split('/');
  const literal: string[] = [];
  for (const seg of segs) {
    // Cut off at a segment containing a wildcard
    if (/[*?[\]{}]/.test(seg)) break;
    literal.push(seg);
  }
  if (literal.length === 0) return null;
  return literal.join('/');
}

/**
 * Whether 2 glob sets "could point at the same file" (the advisory overlap warning §4.3).
 * glob×glob intersection is generally non-trivial, so Phase 1 uses a conservative approximation
 * (false positive = safe side):
 *   (a) overlap if there is a string-identical glob
 *   (b) one glob's literal prefix directory is contained in / contains the other (e.g. "src/**" and "src/auth/*.ts")
 *   (c) one glob matches the other's literal path
 */
export function globsOverlap(globsA: string[], globsB: string[]): boolean {
  const a = normalizeAll(globsA);
  const b = normalizeAll(globsB);

  for (const ga of a) {
    for (const gb of b) {
      // (a) exact match
      if (ga === gb) return true;

      // (c) if one is a literal path, test it against the other glob
      const gaLiteral = !/[*?[\]{}]/.test(ga);
      const gbLiteral = !/[*?[\]{}]/.test(gb);
      if (gbLiteral && minimatch(gb, ga, MM_OPTS)) return true;
      if (gaLiteral && minimatch(ga, gb, MM_OPTS)) return true;

      // (b) containment relationship of literal prefix directories
      const pa = literalDirPrefix(ga);
      const pb = literalDirPrefix(gb);
      if (pa !== null && pb !== null) {
        if (pa === pb) return true;
        if (pa.startsWith(pb + '/') || pb.startsWith(pa + '/')) return true;
      }
    }
  }
  return false;
}

/**
 * Intersection of two file sets (dirty set vs dirty set §4.4 / 3-way precheck §4.6).
 * Taken strictly by exact normalized-path match.
 */
export function fileIntersect(filesA: string[], filesB: string[]): string[] {
  const setB = new Set(normalizeAll(filesB));
  const out = new Set<string>();
  for (const f of normalizeAll(filesA)) {
    if (setB.has(f)) out.add(f);
  }
  return [...out];
}

/**
 * Whether a glob set matches any of a file set (the overlap of claim(glob) × dirty(file) §4.4).
 */
export function globsMatchAny(globs: string[], files: string[]): boolean {
  const gs = normalizeAll(globs);
  const fs = normalizeAll(files);
  for (const g of gs) {
    for (const f of fs) {
      if (minimatch(f, g, MM_OPTS)) return true;
    }
  }
  return false;
}
