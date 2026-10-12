/**
 * The frozen Level 2 task pack (design §6.3: "Fixed task list spanning
 * small/medium/large fixtures, defined before the run and not edited
 * afterwards").
 *
 * Every task is a synthetic repository that stands on its own: `node --test` runs
 * the repository's own suite, so coding success is decided by an independent test
 * rather than by anything the agent says. The same instruction, the same starting
 * state and the same tests are used in both arms; the only difference between the
 * arms is the Safe Mode switch.
 *
 * Per task the pack also carries a **correct** solution (the grader must accept
 * it) and a **plausible but wrong** solution (the grader must reject it). Those two
 * are what make the offline verification in `--offline-verify` an actual check of
 * the grader instead of a claim about it.
 *
 * The pack is fingerprinted by `plan.ts`; a different pack is a different
 * experiment and its pairs are not comparable with these.
 */
import type { Level2Task } from './types.js';

const NODE_TEST = 'node';
const TEST_FLAG = '--test';

/** A repository manifest, so each synthetic repo declares its module type. */
function manifest(name: string): string {
  return `${JSON.stringify(
    {
      name: `level2-${name}`,
      private: true,
      version: '0.0.0',
      type: 'module',
    },
    null,
    2,
  )}\n`;
}

/** A README pointing at the repository's own test command. */
function readme(name: string): string {
  return `# level2-${name}\n\nSynthetic Level 2 task repository. Its own test command decides success:\n\n\`\`\`\nnpm test   # node --test\n\`\`\`\n`;
}

/**
 * A large, obviously synthetic catalogue.
 *
 * It exists so the repeated-read task has a tool result well over the pass's
 * 400-character eligibility threshold, and so the *same* bytes are read twice.
 */
const CATALOG_ENTRIES = Array.from({ length: 40 }, (_unused, index) => ({
  id: `entry-${String(index).padStart(2, '0')}`,
  label: `LEVEL2-SYNTHETIC-ENTRY-${String(index).padStart(2, '0')}`,
  detail: `synthetic catalogue row ${index} with padding to keep the payload realistic abcdefghijklmnopqrstuvwxyz 0123456789`,
}));

const CATALOG_JSON = `${JSON.stringify(
  {
    note: 'synthetic level2 catalogue; nothing here is real data',
    entries: CATALOG_ENTRIES,
  },
  null,
  2,
)}\n`;

const TOTAL_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/total.js';

test('sums the numbers in the list', () => {
  assert.equal(total([1, 2, 3]), 6);
});

test('returns zero for an empty list', () => {
  assert.equal(total([]), 0);
});

test('treats non-numeric entries as zero', () => {
  assert.equal(total([4, undefined, 6]), 10);
});
`;

const DISCOUNT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, formatPrice } from '../src/discount.js';

test('applies a percentage discount', () => {
  assert.equal(applyDiscount(100, 25), 75);
});

test('rounds a discounted price to cents', () => {
  assert.equal(formatPrice(applyDiscount(19.99, 10)), '$17.99');
});

test('a zero discount changes nothing', () => {
  assert.equal(applyDiscount(50, 0), 50);
});
`;

const FORMAT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDistance, toKilometres } from '../src/index.js';

test('converts miles to kilometres', () => {
  assert.equal(toKilometres(1), 1.609);
  assert.equal(toKilometres(0), 0);
});

test('keeps the existing distance formatter exported', () => {
  assert.equal(formatDistance(3), '3 miles');
});
`;

const CATALOG_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findEntry } from '../src/catalog.js';

const catalogue = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));

test('finds an entry by id', () => {
  assert.equal(findEntry(catalogue.entries, 'entry-07').label, 'LEVEL2-SYNTHETIC-ENTRY-07');
});

test('returns null for an unknown id', () => {
  assert.equal(findEntry(catalogue.entries, 'entry-nope'), null);
});
`;

const CLAMP_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.js';

test('clamps above the upper bound', () => {
  assert.equal(clamp(5, 1, 3), 3);
});

test('clamps below the lower bound', () => {
  assert.equal(clamp(0, 1, 3), 1);
});

test('leaves an in-range value alone', () => {
  assert.equal(clamp(2, 1, 3), 2);
});
`;

const PARSE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows } from '../src/parse.js';

test('splits trimmed fields', () => {
  assert.deepEqual(parseRows('a, b ,c\\n'), [['a', 'b', 'c']]);
});

test('drops rows with no content', () => {
  assert.deepEqual(parseRows('a,b\\n , ,\\n\\n'), [['a', 'b']]);
});
`;

export const LEVEL2_TASKS: readonly Level2Task[] = [
  {
    id: 'read-and-edit-total',
    category: 'read-and-edit',
    title: 'Implement a missing function after reading the module and its tests',
    prompt:
      'In this repository, implement `total` in src/total.js so that it returns the sum of the numbers in the array it is given, treating non-numeric entries as zero. Read the existing source and tests first, then make the change. This session has no shell tool, so the tests cannot be run from inside it; they are run outside the session against pristine copies. Do not modify any file under test/ or data/.',
    files: {
      'package.json': manifest('read-and-edit-total'),
      'README.md': readme('read-and-edit-total'),
      'src/total.js': `/**
 * Sum an array of numbers, treating non-numeric entries as zero.
 */
export function total(values) {
  // TODO: implement.
  return 0;
}
`,
      'test/total.test.mjs': TOTAL_TEST,
    },
    gradedFiles: ['test/total.test.mjs'],
    gradingCommand: [NODE_TEST, TEST_FLAG],
    goldenFiles: {
      'src/total.js': `/**
 * Sum an array of numbers, treating non-numeric entries as zero.
 */
export function total(values) {
  let sum = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value;
    }
  }
  return sum;
}
`,
    },
    brokenFiles: {
      'src/total.js': `/**
 * Sum an array of numbers, treating non-numeric entries as zero.
 */
export function total(values) {
  return values.length;
}
`,
    },
    expectation: {
      expectsDuplicateReadOpportunity: false,
      minimumToolCalls: 2,
    },
    note: 'Read-and-edit: the smallest useful shape. A correct fix makes the three tests pass.',
  },
  {
    id: 'debug-failing-test-discount',
    category: 'debug-failing-test',
    title: 'Find and fix the cause of three failing unit tests',
    prompt:
      'The test suite in this repository fails. Read src/discount.js and the tests, then fix the source so every test passes. This session has no shell tool, so the suite cannot be run from inside it; it is run outside the session against pristine copies. Do not modify any file under test/. Explain which assertions fail and why before you change anything.',
    files: {
      'package.json': manifest('debug-failing-test-discount'),
      'README.md': readme('debug-failing-test-discount'),
      'src/discount.js': `/**
 * Apply a percentage discount to a price.
 */
export function applyDiscount(price, percent) {
  return price - price / percent;
}

/** Format a price with two decimals and a currency symbol. */
export function formatPrice(value) {
  return \`$\${value.toFixed(2)}\`;
}
`,
      'test/discount.test.mjs': DISCOUNT_TEST,
    },
    gradedFiles: ['test/discount.test.mjs'],
    gradingCommand: [NODE_TEST, TEST_FLAG],
    goldenFiles: {
      'src/discount.js': `/**
 * Apply a percentage discount to a price.
 */
export function applyDiscount(price, percent) {
  return price * (1 - percent / 100);
}

/** Format a price with two decimals and a currency symbol. */
export function formatPrice(value) {
  return \`$\${value.toFixed(2)}\`;
}
`,
    },
    brokenFiles: {
      'src/discount.js': `/**
 * Apply a percentage discount to a price.
 */
export function applyDiscount(price, percent) {
  return price - percent;
}

/** Format a price with two decimals and a currency symbol. */
export function formatPrice(value) {
  return \`$\${value.toFixed(2)}\`;
}
`,
    },
    expectation: {
      expectsDuplicateReadOpportunity: false,
      minimumToolCalls: 3,
    },
    note: 'Debugging: the bug is a wrong formula, so a partial reading of the test still leaves the third assertion failing.',
  },
  {
    id: 'multi-file-add-module',
    category: 'multi-file-change',
    title: 'Add a new module and export it through the package entry point',
    prompt:
      'In this repository, add a new module src/units.js exporting `toKilometres(miles)`, which converts miles to kilometres rounded to three decimals (1 mile = 1.609344 km). Then export `toKilometres` from src/index.js without removing the existing `formatDistance` export. Read the current sources first, then make the change. This session has no shell tool, so the tests cannot be run from inside it; they are run outside the session against pristine copies. Do not modify any file under test/.',
    files: {
      'package.json': manifest('multi-file-add-module'),
      'README.md': readme('multi-file-add-module'),
      'src/format.js': `/** Format a distance in miles. */
export function formatDistance(miles) {
  return \`\${miles} miles\`;
}
`,
      'src/index.js': `export { formatDistance } from './format.js';
`,
      'test/format.test.mjs': FORMAT_TEST,
    },
    gradedFiles: ['test/format.test.mjs'],
    gradingCommand: [NODE_TEST, TEST_FLAG],
    goldenFiles: {
      'src/units.js': `/** Convert miles to kilometres, rounded to three decimals. */
export function toKilometres(miles) {
  return Math.round(miles * 1.609344 * 1000) / 1000;
}
`,
      'src/index.js': `export { formatDistance } from './format.js';
export { toKilometres } from './units.js';
`,
    },
    brokenFiles: {
      'src/units.js': `/** Convert miles to kilometres, rounded to three decimals. */
export function toKilometres(miles) {
  return Math.round(miles * 1.6 * 1000) / 1000;
}
`,
      'src/index.js': `export { toKilometres } from './units.js';
`,
    },
    expectation: {
      expectsDuplicateReadOpportunity: false,
      minimumToolCalls: 3,
    },
    note: 'Multi-file: the fix must add a file and edit the entry point; the wrong solution also drops the existing export, which the tests catch.',
  },
  {
    id: 'repeated-reads-catalogue',
    category: 'repeated-reads',
    title: 'Read a large catalogue twice, then implement a lookup',
    prompt:
      'In this repository, read data/catalog.json in two separate read calls (once to inspect the shape, and once again to confirm the `note` field and the entry ids), then implement `findEntry(entries, id)` in src/catalog.js so it returns the matching entry or null. This session has no shell tool, so the tests cannot be run from inside it; they are run outside the session against pristine copies. Do not modify any file under test/ or data/.',
    files: {
      'package.json': manifest('repeated-reads-catalogue'),
      'README.md': readme('repeated-reads-catalogue'),
      'data/catalog.json': CATALOG_JSON,
      'src/catalog.js': `/**
 * Find one catalogue entry by id.
 */
export function findEntry(entries, id) {
  // TODO: implement.
  return undefined;
}
`,
      'test/catalog.test.mjs': CATALOG_TEST,
    },
    gradedFiles: ['test/catalog.test.mjs'],
    gradingCommand: [NODE_TEST, TEST_FLAG],
    goldenFiles: {
      'src/catalog.js': `/**
 * Find one catalogue entry by id.
 */
export function findEntry(entries, id) {
  const found = entries.find((entry) => entry.id === id);
  return found ?? null;
}
`,
    },
    brokenFiles: {
      'src/catalog.js': `/**
 * Find one catalogue entry by id.
 */
export function findEntry(entries, id) {
  return entries[0] ?? null;
}
`,
    },
    expectation: {
      expectsDuplicateReadOpportunity: true,
      minimumToolCalls: 3,
    },
    note: 'Repeated reads: the task deliberately asks for two identical reads of a >400-character file, which is exactly the shape the pass needs. If the mechanism does not fire here, it will not fire in this benchmark.',
  },
  {
    id: 'no-duplicate-opportunity-clamp',
    category: 'no-duplicate-opportunity',
    title: 'Implement a clamp helper with no repeated reads',
    prompt:
      'In this repository, implement `clamp(value, lower, upper)` in src/clamp.js so it returns the value limited to the inclusive range. Read src/clamp.js and test/clamp.test.mjs once each, then make the change. This session has no shell tool, so the tests cannot be run from inside it; they are run outside the session against pristine copies. Do not modify any file under test/.',
    files: {
      'package.json': manifest('no-duplicate-opportunity-clamp'),
      'README.md': readme('no-duplicate-opportunity-clamp'),
      'src/clamp.js': `/**
 * Limit a value to the inclusive range [lower, upper].
 */
export function clamp(value, lower, upper) {
  // TODO: implement.
  return value;
}
`,
      'test/clamp.test.mjs': CLAMP_TEST,
    },
    gradedFiles: ['test/clamp.test.mjs'],
    gradingCommand: [NODE_TEST, TEST_FLAG],
    goldenFiles: {
      'src/clamp.js': `/**
 * Limit a value to the inclusive range [lower, upper].
 */
export function clamp(value, lower, upper) {
  if (value < lower) {
    return lower;
  }
  if (value > upper) {
    return upper;
  }
  return value;
}
`,
    },
    brokenFiles: {
      'src/clamp.js': `/**
 * Limit a value to the inclusive range [lower, upper].
 */
export function clamp(value, lower, upper) {
  return Math.max(value, lower);
}
`,
    },
    expectation: {
      expectsDuplicateReadOpportunity: false,
      minimumToolCalls: 2,
    },
    note: 'Control task: every file is small, so no eligible duplicate exists. The treatment arm must report `no-opportunity` here rather than a saved byte.',
  },
  {
    id: 'edge-case-parse-rows',
    category: 'edge-case-fix',
    title: 'Handle empty rows and untrimmed fields in a parser',
    prompt:
      'In this repository, src/parse.js is too naive: `parseRows` must split the text into rows on newlines, split each row on commas, trim every field, and drop rows whose fields are all empty. Read the source and tests, then fix the implementation. This session has no shell tool, so the tests cannot be run from inside it; they are run outside the session against pristine copies. Do not modify any file under test/.',
    files: {
      'package.json': manifest('edge-case-parse-rows'),
      'README.md': readme('edge-case-parse-rows'),
      'src/parse.js': `/**
 * Split text into rows of comma-separated, trimmed fields.
 */
export function parseRows(text) {
  return text.split('\\n').map((row) => row.split(','));
}
`,
      'test/parse.test.mjs': PARSE_TEST,
    },
    gradedFiles: ['test/parse.test.mjs'],
    gradingCommand: [NODE_TEST, TEST_FLAG],
    goldenFiles: {
      'src/parse.js': `/**
 * Split text into rows of comma-separated, trimmed fields.
 */
export function parseRows(text) {
  const rows = [];
  for (const line of text.split('\\n')) {
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length === 0 || fields.every((field) => field.length === 0)) {
      continue;
    }
    rows.push(fields);
  }
  return rows;
}
`,
    },
    brokenFiles: {
      'src/parse.js': `/**
 * Split text into rows of comma-separated, trimmed fields.
 */
export function parseRows(text) {
  return text
    .split('\\n')
    .filter((line) => line.length > 0)
    .map((row) => row.split(',').map((field) => field.trim()));
}
`,
    },
    expectation: {
      expectsDuplicateReadOpportunity: false,
      minimumToolCalls: 2,
    },
    note: 'Edge cases: the wrong solution trims fields but keeps the all-empty row, so only a complete fix passes.',
  },
];

/** Look up one task by id. */
export function findTask(id: string): Level2Task | undefined {
  return LEVEL2_TASKS.find((task) => task.id === id);
}

/**
 * The task whose category exists to create an eligible duplicate read.
 *
 * The scripted rehearsal asks a session to read one file **twice**, because two identical tool
 * results in one request are what the pass needs to have anything to elide. Only one task in the
 * pack is built for that (`data/catalog.json`, ~8 KB of synthetic catalogue), so it is the task a
 * rehearsal must run: the default of the first task id would read a file the task does not
 * contain and report `no-opportunity` while looking like a pass that simply found nothing.
 */
export const MECHANISM_TASK_ID = 'repeated-reads-catalogue';

/**
 * The file a scripted session is asked to read twice, chosen from the task's **own** files.
 *
 * Preferring a `data/` file is deliberate — the pack's repeated-read fixture lives there, and the
 * task instruction forbids editing it, so a read of it cannot be confused with work — and the
 * largest remaining file is the fallback so a rehearsal of any task reads something that exists.
 * The returned path is workspace-relative with forward slashes, which is how the pack declares its
 * files and how the scripted provider expects to be told what to read.
 */
export function mechanismReadPath(task: Level2Task): string | undefined {
  const files = Object.entries(task.files)
    .map(([path, content]) => ({ path, bytes: content.length }))
    .sort((left, right) => right.bytes - left.bytes);
  const preferred = files.find((entry) => entry.path.startsWith('data/')) ?? files[0];
  return preferred?.path;
}
