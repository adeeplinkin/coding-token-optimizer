/**
 * Stage 1T wire verification — reads the captured outbound bodies of the five experiment runs and
 * checks what actually left the runtime.
 *
 * It answers the Stage 1R question again, this time for a **size change**: with an eligible
 * (> 400-character) duplicate, does the real outbound request become shorter, and is the only
 * difference the elided tool-result text? The disabled run, the ineligible pair and the
 * unverified-kind run are the controls.
 *
 * Every number printed here comes from the capture server's recording of the body the runtime sent,
 * or from the harness's content-free elision record. Nothing is inferred from an in-memory object.
 *
 * Two deltas are reported, and they are deliberately not conflated:
 *
 * - the **parsed** delta: how much the differing `content` value shrank as a JavaScript string. It
 *   must equal `elidedBytes - markerBytes` from the elision record;
 * - the **raw** delta: how many bytes the serialized body lost. It equals the JSON-escaped length of
 *   the removed text minus the escaped length of the marker, because the body is JSON. Reporting it
 *   as anything else would be accounting for a serialization the pass never sees.
 *
 * Usage:
 *   node stage1t-verify-wire.mjs [--base <dir>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAFE_MODE_ELISION_MARKER } from '../dist/safe-mode-elision.js';

const MARKER = '[dr-token/safe-mode/v1:';

function parseArgs(argv) {
  const args = { base: join(process.env.LOCALAPPDATA ?? '.', 'Temp', 'dr-token-stage1t') };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--base') {
      args.base = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

const { base } = parseArgs(process.argv);
const evidence = join(base, 'evidence');

function captures(name) {
  return readFileSync(join(evidence, `${name}-capture.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function summary(name) {
  const lines = readFileSync(join(evidence, `${name}-summary.json`), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

/** The last request of a run: the one assembled with tool results in it. */
function lastBody(name) {
  const all = captures(name);
  return all[all.length - 1].body;
}

/** Recursive structural diff: every path whose value differs. */
function diff(left, right, path = '$', out = []) {
  if (typeof left !== typeof right || left === null || right === null) {
    if (left !== right) out.push({ path, left, right });
    return out;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftArray = Array.isArray(left) ? left : [];
    const rightArray = Array.isArray(right) ? right : [];
    if (leftArray.length !== rightArray.length) {
      out.push({ path: `${path}.length`, left: leftArray.length, right: rightArray.length });
    }
    const length = Math.min(leftArray.length, rightArray.length);
    for (let index = 0; index < length; index += 1) {
      diff(leftArray[index], rightArray[index], `${path}[${index}]`, out);
    }
    return out;
  }
  if (typeof left === 'object') {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      diff(left[key], right[key], `${path}.${key}`, out);
    }
    return out;
  }
  if (left !== right) out.push({ path, left, right });
  return out;
}

/** The printable view of a diff: shapes and lengths, never content. */
function summarizeDiff(entries) {
  return entries.map((entry) => ({
    path: entry.path,
    leftType: typeof entry.left,
    rightType: typeof entry.right,
    leftLength: typeof entry.left === 'string' ? entry.left.length : undefined,
    rightLength: typeof entry.right === 'string' ? entry.right.length : undefined,
  }));
}

/** Bytes this value occupies inside a JSON body: its escaped form, without the surrounding quotes. */
function escapedLength(value) {
  return typeof value !== 'string' ? undefined : JSON.stringify(value).length - 2;
}

const eligible = 'wire-eligible';
const disabled = 'wire-disabled';
const ineligibleApply = 'wire-ineligible-apply';
const ineligibleOff = 'wire-ineligible-off';
const kindUnverified = 'wire-kind-unverified';

const eligibleBody = lastBody(eligible);
const disabledBody = lastBody(disabled);
const ineligibleApplyBody = lastBody(ineligibleApply);
const ineligibleOffBody = lastBody(ineligibleOff);
const kindUnverifiedBody = lastBody(kindUnverified);

const eligibleSummary = summary(eligible);
const ineligibleSummary = summary(ineligibleApply);
const disabledSummary = summary(disabled);
const kindUnverifiedSummary = summary(kindUnverified);
const kindUnverifiedRecord = kindUnverifiedSummary.elisions[kindUnverifiedSummary.elisions.length - 1];

const elisionRecord = eligibleSummary.elisions.find((record) => record.applied === true);
const ineligibleRecord = ineligibleSummary.elisions[ineligibleSummary.elisions.length - 1];

const rawDiff = diff(JSON.parse(disabledBody), JSON.parse(eligibleBody));
const diffEntries = summarizeDiff(rawDiff);
const onlyDifference = rawDiff.length === 1 ? rawDiff[0] : undefined;
const parsedDisabled = JSON.parse(disabledBody);
const parsedEligible = JSON.parse(eligibleBody);

/** How many messages carry exactly this content value. */
function countContent(body, text) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.filter((message) => message?.content === text).length;
}

// Two independent expectations for the same edit, each from the module's own record:
// the parsed string shrinks by `elided - marker`, and the body loses exactly the difference between
// the JSON-escaped forms of the two strings.
const expectedParsedDelta =
  elisionRecord === undefined ? undefined : elisionRecord.elidedBytes - elisionRecord.markerBytes;
const parsedDelta =
  onlyDifference === undefined || typeof onlyDifference.left !== 'string'
    ? undefined
    : onlyDifference.left.length - onlyDifference.right.length;
const expectedRawDelta =
  onlyDifference === undefined
    ? undefined
    : escapedLength(onlyDifference.left) - escapedLength(onlyDifference.right);
const observedRawDelta = disabledBody.length - eligibleBody.length;

const ineligibleDiff = summarizeDiff(diff(JSON.parse(ineligibleOffBody), JSON.parse(ineligibleApplyBody)));
const kindUnverifiedDiff = summarizeDiff(diff(JSON.parse(disabledBody), JSON.parse(kindUnverifiedBody)));

// The removed text must still be present in the very request that carries the marker (E3 + E4).
// Compared on **parsed** values: the raw body is JSON, so an unescaped search would be a
// serialization test rather than a content test.
const removedText = typeof onlyDifference?.left === 'string' ? onlyDifference.left : undefined;
const copiesBefore = removedText === undefined ? 0 : countContent(parsedDisabled, removedText);
const copiesAfter = removedText === undefined ? 0 : countContent(parsedEligible, removedText);
const earlierCopyStillPresent = copiesAfter === 1 && copiesBefore === 2;

const checks = [
  [
    'disabled control: no marker reaches the wire',
    !disabledBody.includes(MARKER) && !ineligibleOffBody.includes(MARKER),
  ],
  [
    'request-kind control: an unverified kind leaves the body byte-identical',
    kindUnverifiedDiff.length === 0 &&
      kindUnverifiedRecord?.attempted === false &&
      kindUnverifiedRecord?.refused['request-kind-unverified'] === 1,
  ],
  ['eligible treatment: the marker reaches the wire exactly once', eligibleBody.split(MARKER).length - 1 === 1],
  [
    'eligible treatment: exactly one attribute of the body differs',
    diffEntries.length === 1 && diffEntries[0].path.endsWith('content'),
  ],
  [
    'eligible treatment: the differing value is replaced by the shipped marker, byte for byte',
    onlyDifference !== undefined && onlyDifference.right === SAFE_MODE_ELISION_MARKER,
  ],
  [
    'eligible treatment: the differing value shrank by the elided-minus-marker bytes',
    parsedDelta !== undefined && parsedDelta === expectedParsedDelta,
  ],
  [
    'eligible treatment: the parsed shrink equals the module record (elided - marker)',
    parsedDelta === elisionRecord?.elidedBytes - elisionRecord?.markerBytes,
  ],
  [
    'the whole serialized body shrank by exactly the escaped difference',
    observedRawDelta === expectedRawDelta && observedRawDelta > 0,
  ],
  [
    'the control body held two identical copies; the treatment kept exactly one and wrote the marker',
    earlierCopyStillPresent,
  ],
  [
    'the applied run recorded a real elision of one occurrence',
    elisionRecord !== undefined &&
      elisionRecord.elidedOccurrences === 1 &&
      elisionRecord.markerWrites === 1,
  ],
  ['ineligible control: identical bytes with apply on and off', ineligibleDiff.length === 0],
  [
    'ineligible control: the pass attempted and refused, and wrote no marker',
    ineligibleRecord?.attempted === true &&
      ineligibleRecord?.applied === false &&
      !ineligibleApplyBody.includes(MARKER),
  ],
  [
    'kind evidence: every context invocation corresponded to a primary model request',
    (disabledSummary.hooks['context'] ?? 0) === (disabledSummary.hooks['model.request:primary'] ?? 0) &&
      (disabledSummary.hooks['context'] ?? 0) > 0 &&
      (disabledSummary.hooks['title'] ?? 0) === (disabledSummary.hooks['model.request:title'] ?? 0),
  ],
];

for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

console.log('\n--- facts ---');
for (const [name, body] of [
  [disabled, disabledBody],
  [eligible, eligibleBody],
  [ineligibleOff, ineligibleOffBody],
  [ineligibleApply, ineligibleApplyBody],
  [kindUnverified, kindUnverifiedBody],
]) {
  console.log(`${name.padEnd(22)} bytes=${body.length} marker=${body.split(MARKER).length - 1}`);
}
console.log(`expected parsed delta (elided - marker): ${expectedParsedDelta}`);
console.log(`observed parsed delta (differing content value): ${parsedDelta}`);
console.log(`expected raw delta (escaped minus escaped): ${expectedRawDelta}`);
console.log(`observed raw delta (disabled - eligible body bytes): ${observedRawDelta}`);
console.log(`eligible body diff: ${JSON.stringify(diffEntries)}`);
console.log(`ineligible body diff: ${JSON.stringify(ineligibleDiff)}`);
console.log(`kind-unverified body diff: ${JSON.stringify(kindUnverifiedDiff)}`);
console.log(`copies of the elided text — control: ${copiesBefore}, treatment: ${copiesAfter}`);
console.log(`kind-unverified elision record: ${JSON.stringify(kindUnverifiedRecord)}`);
console.log(`eligible elision record: ${JSON.stringify(elisionRecord)}`);
console.log(`ineligible elision record: ${JSON.stringify(ineligibleRecord)}`);

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${failed === 0 ? 'ALL WIRE CHECKS PASSED' : `${failed} WIRE CHECK(S) FAILED`}`);
process.exitCode = failed === 0 ? 0 : 1;
