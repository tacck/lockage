import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTIONAL_TOOLSETS, type OptionalToolset } from '../src/index.ts';

/**
 * A guard that keeps the README's "provided tools" total count in sync with the actual registered count
 * and the number of tool-table rows.
 *
 * Prevents a recurrence of Issue #39. If you forget to update the README's heading count or the number of
 * table rows when adding/removing a tool, this test fails and catches it. Parsing prioritizes "lenient and
 * robust"; to avoid flakiness from regex jitter, it only reconciles the following.
 *
 *   A. enumerate registered tool names from src/index.ts's `server.registerTool('<name>', ...)`
 *   B. N in the README heading `## Provided tools (N)`
 *   C. rows whose first column is a tool name in the README tool table (the `| \`tool\` | role |` form)
 *   D. the README's "tool sets" table / each tool row's "Set: …" / "`core` tools (N)", and
 *      src/index.ts's OPTIONAL_TOOLSETS (#65)
 *
 * NOTE: the regex literals below match the English README.md. README_ja.md is the Japanese counterpart and
 * is intentionally not verified (the English README is authoritative and ships with npm).
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Pick up all <name> of `server.registerTool('<name>'` from src/index.ts. */
function registeredToolNames(): string[] {
  const src = readFileSync(join(PROJECT_ROOT, 'src', 'index.ts'), 'utf8');
  const names: string[] = [];
  const re = /server\.registerTool\(\s*['"]([a-z_]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/** Read the README body once. */
function readmeText(): string {
  return readFileSync(join(PROJECT_ROOT, 'README.md'), 'utf8');
}

/** Extract N from the heading `## Provided tools (N)` (picks up either full-width or half-width parentheses). */
function headingCount(readme: string): number {
  const m = readme.match(/##\s*Provided tools\s*[（(](\d+)[)）]/);
  assert.ok(m, 'the README heading `## Provided tools (N)` is not found');
  return Number(m![1]);
}

/**
 * Pick up tool names from the "rows whose first column is a tool name" of the tool table.
 * Tool names appearing in the role column or description text (`| ... | role |` 2nd column onward) are not counted.
 */
function tableToolNames(readme: string): string[] {
  const names: string[] = [];
  for (const line of readme.split('\n')) {
    const m = line.match(/^\|\s*`([a-z_]+)`\s*\|/);
    if (m) names.push(m[1]);
  }
  return names;
}

test('README: registered tools and table rows match with no excess or shortfall', () => {
  const expected = new Set(registeredToolNames());

  const tableNames = tableToolNames(readmeText());
  const tableSet = new Set(tableNames);

  // no duplicate rows in the table (the same tool is not listed twice).
  assert.equal(tableNames.length, tableSet.size, 'there is a duplicate tool row in the table');

  // tools that are registered but not in the table.
  const missing = [...expected].filter((n) => !tableSet.has(n)).sort();
  assert.deepEqual(missing, [], `registered tools with no table row: ${missing.join(', ')}`);

  // tools in the table that are not registered.
  const extra = [...tableSet].filter((n) => !expected.has(n)).sort();
  assert.deepEqual(extra, [], `tools listed in the table but not registered: ${extra.join(', ')}`);
});

test('README: the heading count matches the number of table rows', () => {
  const readme = readmeText();
  assert.equal(
    headingCount(readme),
    tableToolNames(readme).length,
    'the heading count and the number of table tool rows diverge (a recurrence of Issue #39)',
  );
});

test('README: the tool-sets table and each tool row\'s "Set: …" match the implementation sets (#65)', () => {
  const readme = readmeText();
  for (const set of Object.keys(OPTIONAL_TOOLSETS) as OptionalToolset[]) {
    const expected = [...OPTIONAL_TOOLSETS[set]].sort();

    const row = readme.split('\n').find((line) => line.startsWith(`| ${set} |`));
    assert.ok(row, `the tool-sets table has no row for ${set}`);
    const listed = [...row.split('|')[3].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
    assert.deepEqual(listed, expected, `the ${set} row of the tool-sets table`);

    const tagged = [...readme.matchAll(new RegExp(`^\\| \`([a-z_]+)\` \\| Set: ${set}\\.`, 'gm'))]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(tagged, expected, `rows tagged with "Set: ${set}" in the tool table`);
  }
});

test('README: the number of core tools in the tool-sets description matches the registered count minus the set tools (#65)', () => {
  const m = readmeText().match(/`core` tools[^（(]*[（(](\d+)[)）]/);
  assert.ok(m, 'the README has no "`core` tools … (N)" description');
  const optional = Object.values(OPTIONAL_TOOLSETS).reduce((n, names) => n + names.length, 0);
  assert.equal(Number(m[1]), registeredToolNames().length - optional);
});
