import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePath,
  globsOverlap,
  fileIntersect,
  globsMatchAny,
} from '../src/lockage/globs.ts';

test('normalizePath: folds ./ and leading / and consecutive slashes', () => {
  assert.equal(normalizePath('./src//a.ts'), 'src/a.ts');
  assert.equal(normalizePath('/src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath('src/./b/../a.ts'), 'src/a.ts');
  assert.equal(normalizePath('src\\win\\a.ts'), 'src/win/a.ts');
});

test('normalizePath: case sensitive (distinguishes case per git)', () => {
  assert.notEqual(normalizePath('src/A.ts'), normalizePath('src/a.ts'));
});

test('globsOverlap: overlap on an exact match', () => {
  assert.equal(globsOverlap(['src/**'], ['src/**']), true);
});

test('globsOverlap: overlap on the containment relation of literal prefixes (fail-safe)', () => {
  // "src/**" and "src/auth/*.ts" can point to the same file
  assert.equal(globsOverlap(['src/**'], ['src/auth/*.ts']), true);
});

test('globsOverlap: unrelated directories do not overlap', () => {
  assert.equal(globsOverlap(['src/a/**'], ['src/b/**']), false);
  assert.equal(globsOverlap(['docs/**'], ['src/**']), false);
});

test('globsOverlap: overlap if a literal path matches the other\'s glob', () => {
  assert.equal(globsOverlap(['src/auth/login.ts'], ['src/**']), true);
});

test('fileIntersect: strictly returns only exact matches after normalization', () => {
  const inter = fileIntersect(
    ['./src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/c.ts'],
  );
  assert.deepEqual(inter, ['src/a.ts']);
});

test('fileIntersect: no intersection is an empty array', () => {
  assert.deepEqual(fileIntersect(['src/a.ts'], ['src/b.ts']), []);
});

test('globsMatchAny: true if the glob matches a file', () => {
  assert.equal(globsMatchAny(['src/**'], ['src/auth/login.ts']), true);
  assert.equal(globsMatchAny(['*.md'], ['README.md']), true);
});

test('globsMatchAny: false if it matches no file', () => {
  assert.equal(globsMatchAny(['src/**'], ['docs/x.md']), false);
});
