/**
 * Reading an arm artifact produced by the arm driver.
 *
 * The artifact is written by the driver process, which is untrusted input from this
 * module's point of view: it may be truncated, hand-edited, or produced by a run
 * that never started. So every field is validated, and the two facts that matter
 * most are **recomputed** rather than believed:
 *
 * - the mechanism classification is derived here from the apply counters and the
 *   wire observations, so an artifact cannot claim that the pass fired;
 * - the arm, task and pair identity must agree with the plan, so a mislabelled run
 *   cannot present itself as its counterpart.
 */
import { isFreeOnlyModelConfig, isZeroPriceRow } from './free-model-policy.js';
import { classifyMechanism } from './mechanism.js';
import { digest } from './repos.js';
import type {
  Level2ApplyEvidence,
  Level2Arm,
  Level2ArmObservation,
  Level2BehaviourObservation,
  Level2ContainmentEvidence,
  Level2Grading,
  Level2InSessionGovernorEvidence,
  Level2ModelGuardEvidence,
  Level2ModelPolicyEvidence,
  Level2NativePermissionsEvidence,
  Level2RequestKindEvidence,
  Level2RunIdentity,
  Level2UsageObservation,
  Level2WireEvidence,
  Level2WireRequest,
} from './types.js';

/** Outcome of reading one artifact. */
export interface Level2ArtifactRead {
  readonly observation: Level2ArmObservation | undefined;
  readonly problems: readonly string[];
  /**
   * True when the runtime refused the requested model, so the session never composed
   * a request. A plan that keeps going would spend authorization without producing a
   * measurement, so the caller stops on it.
   */
  readonly modelUnavailable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCount(value: unknown, label: string, problems: string[]): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    problems.push(`${label} must be a whole, non-negative number.`);
    return undefined;
  }
  return value;
}

function readOptionalNumber(value: unknown, label: string, problems: string[]): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    problems.push(`${label} must be a finite, non-negative number.`);
    return undefined;
  }
  return value;
}

function readString(value: unknown, label: string, problems: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    if (value !== undefined && value !== null) {
      problems.push(`${label} must be a non-empty string.`);
    }
    return undefined;
  }
  return value;
}

function readArm(value: unknown, label: string, problems: string[]): Level2Arm | undefined {
  if (value === 'control' || value === 'treatment') {
    return value;
  }
  problems.push(`${label} must be "control" or "treatment".`);
  return undefined;
}

function readWireRequests(value: unknown, problems: string[]): readonly Level2WireRequest[] {
  if (!Array.isArray(value)) {
    problems.push('wire.requests must be an array.');
    return [];
  }
  const requests: Level2WireRequest[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`wire.requests[${index}] must be an object.`);
      return;
    }
    const seq = readCount(entry['seq'], `wire.requests[${index}].seq`, problems);
    const bodyBytes = readCount(entry['bodyBytes'], `wire.requests[${index}].bodyBytes`, problems);
    const markerCount = readCount(
      entry['markerCount'],
      `wire.requests[${index}].markerCount`,
      problems,
    );
    if (seq === undefined || bodyBytes === undefined || markerCount === undefined) {
      return;
    }
    requests.push({
      seq,
      bodyBytes,
      markerCount,
      // Absent when the endpoint could not read an identifier; never defaulted to the
      // requested model, which would make a substitution unobservable.
      ...(typeof entry['model'] === 'string' ? { model: entry['model'] } : {}),
      ...(typeof entry['hasTools'] === 'boolean' ? { hasTools: entry['hasTools'] } : {}),
    });
  });
  return requests;
}

/**
 * Read the runtime's observed request kinds and the models it named.
 *
 * `kindsRegistered` is kept because a zero and a never-registered hook are different facts: a
 * runtime that refused the hook reports no kind at all, and a report of "no title request"
 * must be able to say which of the two it is. An absent block reads as `undefined` rather
 * than as an empty success.
 */
function readRequestKinds(value: unknown, problems: string[]): Level2RequestKindEvidence | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = value['source'];
  if (source !== 'model-request-hooks' && source !== 'loopback-endpoint' && source !== 'none') {
    problems.push('modelPolicy.requests.source must be a known source.');
    return undefined;
  }
  const counts = (input: unknown): Record<string, number> => {
    if (!isRecord(input)) return {};
    const result: Record<string, number> = {};
    for (const [key, entry] of Object.entries(input)) {
      if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0) {
        result[key] = entry;
      }
    }
    return result;
  };
  const kinds = counts(value['kinds']);
  const modelsNamed = counts(value['modelsNamed']);
  const kindsRegistered = Array.isArray(value['kindsRegistered'])
    ? value['kindsRegistered'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const registrationFailures = Array.isArray(value['registrationFailures'])
    ? value['registrationFailures'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const payloadKeys = Array.isArray(value['payloadKeys'])
    ? value['payloadKeys'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const endpointRecord = isRecord(value['endpointKinds']) ? value['endpointKinds'] : undefined;
  const endpointCount = (entry: unknown, field: string): number | undefined => {
    const read = readCount(entry, `modelPolicy.requests.endpointKinds.${field}`, problems);
    return read;
  };
  const endpointKinds =
    endpointRecord === undefined
      ? undefined
      : {
          requests: endpointCount(endpointRecord['requests'], 'requests') ?? 0,
          withToolRegistry: endpointCount(endpointRecord['withToolRegistry'], 'withToolRegistry') ?? 0,
          withoutToolRegistry:
            endpointCount(endpointRecord['withoutToolRegistry'], 'withoutToolRegistry') ?? 0,
        };
  // Everything that is not the primary kind is auxiliary, including a kind this harness does not
  // recognize: a request nobody can name is not a request anyone can rule in.
  const auxiliaryRequests = Object.entries(kinds)
    .filter(([kind]) => kind !== 'primary')
    .reduce((total, [, count]) => total + count, 0);
  return {
    source,
    kindsRegistered,
    kinds,
    modelsNamed,
    registrationFailures,
    payloadKeys,
    endpointKinds,
    auxiliaryRequests,
  };
}

/**
 * Read the free-only policy evidence.
 *
 * The three facts that decide whether the run stayed inside the envelope are **recomputed**
 * here rather than believed: whether the recorded configuration is structurally the approved
 * one, whether the price row is zero in every tier, and how many non-primary requests the
 * runtime composed. A driver that wrote `priceVerifiedFree: true` beside a non-zero row is
 * read as not verified.
 */
function readModelPolicy(value: unknown, problems: string[]): Level2ModelPolicyEvidence | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const priceRecord = isRecord(value['priceRow']) ? value['priceRow'] : undefined;
  const priceRow =
    priceRecord === undefined
      ? undefined
      : {
          input: readOptionalNumber(priceRecord['input'], 'modelPolicy.priceRow.input', problems),
          output: readOptionalNumber(priceRecord['output'], 'modelPolicy.priceRow.output', problems),
          cacheRead: readOptionalNumber(
            priceRecord['cacheRead'],
            'modelPolicy.priceRow.cacheRead',
            problems,
          ),
          cacheWrite: readOptionalNumber(
            priceRecord['cacheWrite'],
            'modelPolicy.priceRow.cacheWrite',
            problems,
          ),
        };
  const catalogueSource = value['catalogueSource'];
  const requests = readRequestKinds(value['requests'], problems);
  const approvedModels = Array.isArray(value['approvedModels'])
    ? value['approvedModels'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const refusals = Array.isArray(value['refusals'])
    ? value['refusals'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    primaryModel: typeof value['primaryModel'] === 'string' ? value['primaryModel'] : '',
    auxiliaryModel: typeof value['auxiliaryModel'] === 'string' ? value['auxiliaryModel'] : '',
    approvedModels,
    config: value['config'],
    configDigest: typeof value['configDigest'] === 'string' ? value['configDigest'] : '',
    configAccepted:
      value['configAccepted'] === true && isFreeOnlyModelConfig(value['config']),
    catalogueSource:
      catalogueSource === 'service' || catalogueSource === 'standalone'
        ? catalogueSource
        : 'not-checked',
    priceVerifiedFree: value['priceVerifiedFree'] === true && isZeroPriceRow(priceRow),
    priceRow,
    priceCheckSkippedReason:
      typeof value['priceCheckSkippedReason'] === 'string'
        ? value['priceCheckSkippedReason']
        : undefined,
    refusals,
    resolved: value['resolved'],
    requests: requests ?? {
      source: 'none',
      kindsRegistered: [],
      kinds: {},
      modelsNamed: {},
      registrationFailures: [],
      payloadKeys: [],
      endpointKinds: undefined,
      auxiliaryRequests: 0,
    },
    titleGenerationSuppressed: value['titleGenerationSuppressed'] === true,
  };
}

/**
 * Read and validate one arm artifact.
 *
 * `expected` is what the plan says this run must be; a mismatch is a problem rather
 * than a silent relabelling.
 */
export function readArmArtifact(
  value: unknown,
  expected?: { readonly taskId?: string; readonly arm?: Level2Arm; readonly pairIndex?: number },
): Level2ArtifactRead {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return {
      observation: undefined,
      problems: ['The arm artifact is not a JSON object.'],
      modelUnavailable: false,
    };
  }
  // Recorded by the driver from the runtime's own output; never inferred from an
  // empty usage record, which is what a real run with an unreported field also looks
  // like.
  const modelUnavailable = value['modelUnavailable'] === true;

  const taskId = readString(value['taskId'], 'taskId', problems);
  const arm = readArm(value['arm'], 'arm', problems);
  const runId = readString(value['runId'], 'runId', problems);
  const pairIndex = readCount(value['pairIndex'], 'pairIndex', problems);
  const attempt = readCount(value['attempt'], 'attempt', problems) ?? 1;
  const startedAt = readString(value['startedAt'], 'startedAt', problems);
  const durationMs = readOptionalNumber(value['durationMs'], 'durationMs', problems) ?? 0;
  const harness = readString(value['harness'], 'harness', problems);
  const optimizerRevision = readString(value['optimizerRevision'], 'optimizerRevision', problems);
  const repositoryRevision = readString(value['repositoryRevision'], 'repositoryRevision', problems);
  const promptHash = readString(value['promptHash'], 'promptHash', problems);
  const model = readString(value['model'], 'model', problems);
  const modelAbsent = value['model'] === undefined || value['model'] === null;

  if (expected?.taskId !== undefined && taskId !== expected.taskId) {
    problems.push(`The artifact is for task "${taskId ?? 'unknown'}", not "${expected.taskId}".`);
  }
  if (expected?.arm !== undefined && arm !== expected.arm) {
    problems.push(`The artifact is for the ${arm ?? 'unknown'} arm, not the ${expected.arm} arm.`);
  }
  if (expected?.pairIndex !== undefined && pairIndex !== expected.pairIndex) {
    problems.push(
      `The artifact is for pair ${pairIndex ?? 'unknown'}, not pair ${expected.pairIndex}.`,
    );
  }

  const gradingRecord = isRecord(value['grading']) ? value['grading'] : undefined;
  if (gradingRecord === undefined) {
    problems.push('grading must be an object.');
  }
  const grading: Level2Grading = {
    passed: gradingRecord?.['passed'] === true,
    command: typeof gradingRecord?.['command'] === 'string' ? gradingRecord['command'] : '',
    exitCode:
      typeof gradingRecord?.['exitCode'] === 'number' ? (gradingRecord['exitCode'] as number) : undefined,
    timedOut: gradingRecord?.['timedOut'] === true,
    durationMs: readOptionalNumber(gradingRecord?.['durationMs'], 'grading.durationMs', problems) ?? 0,
    outputDigest:
      typeof gradingRecord?.['outputDigest'] === 'string'
        ? (gradingRecord['outputDigest'] as string)
        : digest('no grading output recorded'),
    outputExcerpt:
      typeof gradingRecord?.['outputExcerpt'] === 'string'
        ? (gradingRecord['outputExcerpt'] as string)
        : '',
    checks: Array.isArray(gradingRecord?.['checks'])
      ? (gradingRecord?.['checks'] as readonly Record<string, unknown>[])
          .filter((check) => isRecord(check))
          .map((check) => ({
            name: typeof check['name'] === 'string' ? check['name'] : 'unnamed-check',
            passed: check['passed'] === true,
            detail: typeof check['detail'] === 'string' ? check['detail'] : '',
          }))
      : [],
  };

  const usageRecord = isRecord(value['usage']) ? value['usage'] : {};
  const usage: Level2UsageObservation = {
    inputTokens: readOptionalNumber(usageRecord['inputTokens'], 'usage.inputTokens', problems),
    outputTokens: readOptionalNumber(usageRecord['outputTokens'], 'usage.outputTokens', problems),
    cacheReadTokens: readOptionalNumber(
      usageRecord['cacheReadTokens'],
      'usage.cacheReadTokens',
      problems,
    ),
    cacheWriteTokens: readOptionalNumber(
      usageRecord['cacheWriteTokens'],
      'usage.cacheWriteTokens',
      problems,
    ),
    reasoningTokens: readOptionalNumber(
      usageRecord['reasoningTokens'],
      'usage.reasoningTokens',
      problems,
    ),
    costUsd: readOptionalNumber(usageRecord['costUsd'], 'usage.costUsd', problems),
  };

  const behaviourRecord = isRecord(value['behaviour']) ? value['behaviour'] : {};
  const behaviour: Level2BehaviourObservation = {
    toolCalls: readCount(behaviourRecord['toolCalls'], 'behaviour.toolCalls', problems),
    repeatedFileReads: readCount(
      behaviourRecord['repeatedFileReads'],
      'behaviour.repeatedFileReads',
      problems,
    ),
    assistantMessages: readCount(
      behaviourRecord['assistantMessages'],
      'behaviour.assistantMessages',
      problems,
    ),
    observerInternalErrors: readCount(
      behaviourRecord['observerInternalErrors'],
      'behaviour.observerInternalErrors',
      problems,
    ),
    optimizerErrors: readCount(behaviourRecord['optimizerErrors'], 'behaviour.optimizerErrors', problems),
    recoveryAttempts: readCount(
      behaviourRecord['recoveryAttempts'],
      'behaviour.recoveryAttempts',
      problems,
    ),
  };

  let apply: Level2ApplyEvidence | undefined;
  if (isRecord(value['apply'])) {
    const applyRecord = value['apply'];
    const requestsAttempted = readCount(applyRecord['requestsAttempted'], 'apply.requestsAttempted', problems);
    const requestsApplied = readCount(applyRecord['requestsApplied'], 'apply.requestsApplied', problems);
    const elidedOccurrences = readCount(applyRecord['elidedOccurrences'], 'apply.elidedOccurrences', problems);
    const elidedBytes = readCount(applyRecord['elidedBytes'], 'apply.elidedBytes', problems);
    const markerBytes = readCount(applyRecord['markerBytes'], 'apply.markerBytes', problems);
    if (
      requestsAttempted !== undefined &&
      requestsApplied !== undefined &&
      elidedOccurrences !== undefined &&
      elidedBytes !== undefined &&
      markerBytes !== undefined
    ) {
      apply = { requestsAttempted, requestsApplied, elidedOccurrences, elidedBytes, markerBytes };
    }
  }

  /**
   * Read the containment evidence.
   *
   * Deliberately strict about the one flag that decides measurability: an absent or
   * unrecognized `guard` yields `undefined`, and the engagement gate refuses a live
   * run without it. A malformed counter is a problem (and a zero default) rather than
   * a reason to trust the rest.
   */
  const readContainment = (): Level2ContainmentEvidence | undefined => {
    const record = value['containment'];
    if (!isRecord(record)) {
      return undefined;
    }
    const guard = record['guard'];
    if (guard !== 'loaded' && guard !== 'capability-missing' && guard !== 'missing') {
      problems.push('containment.guard must be "loaded", "capability-missing" or "missing".');
      return undefined;
    }
    const blockedByTool: Record<string, number> = {};
    if (isRecord(record['blockedByTool'])) {
      for (const [tool, count] of Object.entries(record['blockedByTool'])) {
        if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
          blockedByTool[tool] = count;
        }
      }
    }
    const permissionRules = Array.isArray(record['permissionRules'])
      ? record['permissionRules'].flatMap((rule) =>
          isRecord(rule) &&
          typeof rule['action'] === 'string' &&
          typeof rule['effect'] === 'string' &&
          typeof rule['resource'] === 'string'
            ? [{ action: rule['action'], effect: rule['effect'], resource: rule['resource'] }]
            : [],
        )
      : undefined;
    return {
      guard,
      rootKnown: record['rootKnown'] === true,
      blockedCalls: readCount(record['blockedCalls'], 'containment.blockedCalls', problems) ?? 0,
      allowedCalls: readCount(record['allowedCalls'], 'containment.allowedCalls', problems) ?? 0,
      blockedByTool,
      permissionRules,
      configDigest: typeof record['configDigest'] === 'string' ? record['configDigest'] : undefined,
    };
  };

  /**
   * Read the runtime's own resolved permission rules.
   *
   * Absent is absent: a run whose artifact predates this evidence reads as `undefined`, and the
   * engagement gate refuses a live run that cannot show the native layer was resolved. A malformed
   * rule list is a problem rather than a partial credit.
   */
  const readNativePermissions = (): Level2NativePermissionsEvidence | undefined => {
    const record = value['nativePermissions'];
    if (!isRecord(record)) {
      return undefined;
    }
    const rules = Array.isArray(record['rules'])
      ? record['rules'].flatMap((rule) =>
          isRecord(rule) &&
          typeof rule['action'] === 'string' &&
          typeof rule['effect'] === 'string'
            ? [
                {
                  action: rule['action'],
                  effect: rule['effect'],
                  resource: typeof rule['resource'] === 'string' ? rule['resource'] : 'unclassified',
                },
              ]
            : [],
        )
      : [];
    if (!Array.isArray(record['rules'])) {
      problems.push('nativePermissions.rules must be an array.');
    }
    const requiredDenies = Array.isArray(record['requiredDenies'])
      ? record['requiredDenies'].filter((entry): entry is string => typeof entry === 'string')
      : [];
    const missingRequiredDenies = Array.isArray(record['missingRequiredDenies'])
      ? record['missingRequiredDenies'].filter((entry): entry is string => typeof entry === 'string')
      : [];
    return {
      // The flag is recomputed: a caller cannot make the layer look observed by asserting it.
      observed: rules.length > 0,
      source: typeof record['source'] === 'string' ? record['source'] : 'unrecorded',
      rules,
      requiredDenies,
      missingRequiredDenies,
      allRequiredPresent:
        rules.length > 0 &&
        requiredDenies.length > 0 &&
        requiredDenies.every((action) =>
          rules.some((rule) => rule.action === action && rule.effect === 'deny'),
        ),
      error: typeof record['error'] === 'string' ? record['error'] : undefined,
    };
  };

  /**
   * Read the pre-transmission model-guard evidence.
   *
   * Same rule as containment: an absent or unrecognized `guard` yields `undefined` and the
   * engagement gate refuses the run, because the alternative — defaulting an unreadable block to
   * "guarded" — is exactly the failure this layer exists to prevent. The flag is recomputed from
   * `loaded` and `hookRegistered` rather than taken from the file, so a driver cannot make an
   * unregistered guard look armed by writing `guard: "loaded"`.
   */
  const readModelGuard = (): Level2ModelGuardEvidence | undefined => {
    const record = value['modelGuard'];
    if (!isRecord(record)) {
      return undefined;
    }
    const declared = record['guard'];
    const loaded = record['loaded'] === true;
    const hookRegistered = record['hookRegistered'] === true;
    const guard: Level2ModelGuardEvidence['guard'] =
      loaded && hookRegistered
        ? 'loaded'
        : declared === 'capability-missing'
          ? 'capability-missing'
          : 'missing';
    if (declared !== 'loaded' && declared !== 'capability-missing' && declared !== 'missing') {
      problems.push('modelGuard.guard must be "loaded", "capability-missing" or "missing".');
    }
    const refusals = Array.isArray(record['refusals'])
      ? record['refusals'].flatMap((entry) => {
          if (!isRecord(entry) || typeof entry['reason'] !== 'string') return [];
          return [
            {
              ...(typeof entry['requestKind'] === 'string' ? { requestKind: entry['requestKind'] } : {}),
              ...(typeof entry['model'] === 'string' ? { model: entry['model'] } : {}),
              reason: entry['reason'],
            },
          ];
        })
      : [];
    const rawEnvelope = record['envelope'];
    const envelope =
      isRecord(rawEnvelope) && typeof rawEnvelope['primary'] === 'string'
        ? {
            primary: rawEnvelope['primary'],
            approved: Array.isArray(rawEnvelope['approved'])
              ? rawEnvelope['approved'].filter((id): id is string => typeof id === 'string')
              : [],
            allowedKinds: Array.isArray(rawEnvelope['allowedKinds'])
              ? rawEnvelope['allowedKinds'].filter((kind): kind is string => typeof kind === 'string')
              : [],
            policyDigest:
              typeof rawEnvelope['policyDigest'] === 'string' ? rawEnvelope['policyDigest'] : '',
          }
        : undefined;
    return {
      guard,
      hook: typeof record['hook'] === 'string' ? record['hook'] : 'unrecorded',
      loaded,
      hookRegistered,
      invocations: readCount(record['invocations'], 'modelGuard.invocations', problems) ?? 0,
      allowed: readCount(record['allowed'], 'modelGuard.allowed', problems) ?? 0,
      refused: readCount(record['refused'], 'modelGuard.refused', problems) ?? 0,
      refusals,
      misconfigured: record['misconfigured'] === true,
      policyDigest: typeof record['policyDigest'] === 'string' ? record['policyDigest'] : '',
      envelope,
      evidenceLines: readCount(record['evidenceLines'], 'modelGuard.evidenceLines', problems) ?? 0,
    };
  };

  /** Read the in-session spending-governor evidence; absent is absent, never a zero. */
  const readGovernor = (): Level2InSessionGovernorEvidence | undefined => {
    const record = value['inSessionGovernor'];
    if (!isRecord(record)) {
      return undefined;
    }
    return {
      armed: record['armed'] === true,
      reason: typeof record['reason'] === 'string' ? record['reason'] : undefined,
      capUsd: readOptionalNumber(record['capUsd'], 'inSessionGovernor.capUsd', problems),
      polls: readCount(record['polls'], 'inSessionGovernor.polls', problems) ?? 0,
      reportedCostUsd: readOptionalNumber(
        record['reportedCostUsd'],
        'inSessionGovernor.reportedCostUsd',
        problems,
      ),
      interrupted: record['interrupted'] === true,
      interruptAttempts:
        readCount(record['interruptAttempts'], 'inSessionGovernor.interruptAttempts', problems) ?? 0,
      killedAfterFailedInterrupt: record['killedAfterFailedInterrupt'] === true,
    };
  };

  const containment = readContainment();
  const nativePermissions = readNativePermissions();
  const inSessionGovernor = readGovernor();
  const modelGuard = readModelGuard();
  // Absent is absent: the intake refuses a run without policy evidence, so nothing is
  // defaulted into looking verified.
  const modelPolicy = readModelPolicy(value['modelPolicy'], problems);

  const wireRecord = isRecord(value['wire']) ? value['wire'] : undefined;
  const requests = wireRecord === undefined ? [] : readWireRequests(wireRecord['requests'], problems);
  const declaredSource = wireRecord?.['source'];
  const source: Level2WireEvidence['source'] =
    declaredSource === 'loopback-endpoint' ||
    declaredSource === 'hook-unmeasurable' ||
    declaredSource === 'none'
      ? declaredSource
      : requests.length > 0
        ? 'loopback-endpoint'
        : 'none';
  const wire: Level2WireEvidence = {
    source,
    requests,
    hookInvocations: readCount(wireRecord?.['hookInvocations'], 'wire.hookInvocations', problems) ?? 0,
    unmeasurableRequests:
      readCount(wireRecord?.['unmeasurableRequests'], 'wire.unmeasurableRequests', problems) ?? 0,
    allRequestsToProvider: wireRecord?.['allRequestsToProvider'] !== false,
  };

  if (
    problems.length > 0 ||
    taskId === undefined ||
    arm === undefined ||
    runId === undefined ||
    pairIndex === undefined ||
    startedAt === undefined ||
    harness === undefined ||
    optimizerRevision === undefined ||
    repositoryRevision === undefined ||
    promptHash === undefined
  ) {
    return { observation: undefined, problems, modelUnavailable };
  }

  const identity: Level2RunIdentity = { taskId, arm, runId, pairIndex, attempt };
  // Recomputed, never trusted: the classification is a function of the counters and
  // the wire, not of anything the driver wrote.
  const mechanism = classifyMechanism(arm, apply, wire);

  return {
    modelUnavailable,
    observation: {
      identity,
      taskId,
      model: modelAbsent || modelUnavailable ? undefined : model,
      harness,
      optimizerRevision,
      repositoryRevision,
      promptHash,
      startedAt,
      durationMs,
      grading,
      usage,
      behaviour,
      apply,
      wire,
      containment,
      nativePermissions,
      inSessionGovernor,
      modelGuard,
      mechanism,
      modelPolicy,
    },
    problems,
  };
}
