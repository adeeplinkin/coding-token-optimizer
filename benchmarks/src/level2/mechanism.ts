/**
 * Mechanism evidence for Level 2 (design §6.3).
 *
 * A token delta is not evidence that *this* pass caused it. Before any delta is
 * read, each treatment run must show that the pass fired, and each control run must
 * show that it did not.
 *
 * ## What can be shown, and where
 *
 * For a **single deterministic request** the identity is exact and is asserted by the
 * wire regression (`npm run verify:wire`): the treatment request body is shorter by
 * exactly `elidedBytes - markerBytes`, measured at the endpoint the request was sent
 * to, in both arms of the same scripted request.
 *
 * A **live agent session** is different in two ways, and both are stated rather than
 * smoothed over:
 *
 * 1. Two sessions solving one task produce different requests (different reasoning
 *    text, different tool arguments, different turn counts), so a cross-arm byte
 *    subtraction would silently compare two different requests. The check is
 *    therefore per run: the pass's own counters plus, when available, the marker
 *    count at the endpoint.
 * 2. Stage 1U measured that the runtime hands the outbound body to
 *    `session.hook("http.request")` as a `ReadableStream`. A plugin therefore
 *    **cannot** measure the request it is about to send, and a live run against a
 *    real provider yields no wire observation. Such a run is classified
 *    `fired-counters-only`, which is weaker evidence and is never reported as the
 *    observed-marker case.
 *
 * Anything self-contradictory — a marker at the endpoint with no counter, counters
 * with a controlled arm showing markers — is `unexplained`: a defect signal, not a
 * datapoint.
 */
import type {
  Level2ApplyEvidence,
  Level2Arm,
  Level2MechanismVerdict,
  Level2WireEvidence,
} from './types.js';

/** Statements that must travel with the mechanism classification. */
export const LEVEL2_MECHANISM_NOTES: readonly string[] = [
  'Mechanism classification is a request-shape observation, not a token measurement: it says whether the pass fired and, where observable, whether its marker reached the request the runtime sent. It derives no token figure.',
  'The runtime hands the outbound body to the `http.request` hook as a ReadableStream, so a plugin cannot measure it. Wire lengths and marker counts are therefore only available from a loopback endpoint the run was pointed at; a live run against a real provider is classified from the pass\u2019s own counters and labelled `fired-counters-only` rather than presented as observed.',
  'A live agent session does not produce byte-comparable requests across arms, so this check is per run rather than a cross-arm byte subtraction. The exact byte identity is asserted separately by the wire regression over one deterministic request.',
  'A treatment run classified `no-opportunity` is not a zero-saving datapoint; it is a run where there was nothing eligible to elide, and it is excluded from every size comparison.',
];

/** True for a verdict that means the pass did fire. */
export function mechanismFired(verdict: Level2MechanismVerdict): boolean {
  return verdict === 'fired' || verdict === 'fired-counters-only';
}

/** Total markers observed at the endpoint across a run's requests. */
export function markerCount(wire: Level2WireEvidence): number {
  return wire.requests.reduce((total, request) => total + request.markerCount, 0);
}

/** Total outbound bytes observed at the endpoint across a run's requests. */
export function totalBodyBytes(wire: Level2WireEvidence): number {
  return wire.requests.reduce((total, request) => total + request.bodyBytes, 0);
}

/**
 * Classify one arm run.
 *
 * The control arm is held to the stronger standard: it must show no apply evidence
 * and no marker, because a control that carried a marker would mean the arms were not
 * separated and every comparison drawn from them would be invalid.
 */
export function classifyMechanism(
  arm: Level2Arm,
  apply: Level2ApplyEvidence | undefined,
  wire: Level2WireEvidence,
): Level2MechanismVerdict {
  const markers = markerCount(wire);
  const observed = wire.source === 'loopback-endpoint';

  if (arm === 'control') {
    if (apply !== undefined && (apply.requestsApplied > 0 || apply.elidedBytes > 0)) {
      return 'unexplained';
    }
    return markers === 0 ? 'not-applicable' : 'unexplained';
  }

  const applied = apply !== undefined && apply.requestsApplied > 0;
  const removedSomething = apply !== undefined && apply.elidedBytes > 0;
  // The markers written back must be smaller than the text removed, or the request
  // grew and the classification would be reporting a size increase as the mechanism.
  const shrank = (apply?.markerBytes ?? 0) < (apply?.elidedBytes ?? 0);

  if (applied && removedSomething && shrank) {
    if (!observed) {
      return 'fired-counters-only';
    }
    // Equality with `requestsApplied` is deliberately **not** required: the pass
    // counts one *request assembly* per context-hook invocation (the observer's own
    // note says retries re-count), while the endpoint counts requests that were
    // actually sent. One marker at the endpoint is the claim being made — the pass's
    // marker reached the wire — and both numbers are recorded beside it.
    return markers >= 1 ? 'fired' : 'unexplained';
  }

  const recordedNothing =
    apply === undefined || (apply.requestsApplied === 0 && apply.elidedBytes === 0);
  if (recordedNothing && markers === 0) {
    return 'no-opportunity';
  }

  return 'unexplained';
}

/** A short, content-free explanation of a classification. */
export function describeMechanism(
  verdict: Level2MechanismVerdict,
  apply: Level2ApplyEvidence | undefined,
  wire: Level2WireEvidence,
): string {
  const markers = markerCount(wire);
  const counterSummary = `applied to ${apply?.requestsApplied ?? 0} request(s), replaced ${apply?.elidedBytes ?? 0} byte(s) of duplicate tool-result text with ${apply?.markerBytes ?? 0} byte(s) of marker`;
  switch (verdict) {
    case 'fired':
      return `The pass ${counterSummary}, and ${markers} marker(s) were observed at the loopback endpoint the run was pointed at.`;
    case 'fired-counters-only':
      return `The pass ${counterSummary}. No wire observation exists for this mode (the runtime hands the outbound body to the hook as a ReadableStream, and no loopback endpoint was in the path), so the marker reached the wire is *not* claimed here.`;
    case 'no-opportunity':
      return 'No elision was recorded and no marker reached the wire, so this run had no eligible duplicate to elide.';
    case 'unexplained':
      return `The apply counters and the wire observation disagree (applied=${apply?.requestsApplied ?? 0}, elidedBytes=${apply?.elidedBytes ?? 0}, markersAtEndpoint=${markers}, source=${wire.source}); this is a defect signal rather than a measurement.`;
    case 'not-applicable':
      return `The control arm ran with the pass off: no elision was recorded and no marker reached the wire (${wire.hookInvocations} outbound request(s) observed), so the arms were separated.`;
  }
}
