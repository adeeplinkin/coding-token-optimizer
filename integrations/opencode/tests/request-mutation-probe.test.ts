import { describe, expect, it } from 'vitest';
import * as entryPoint from '../src/index.js';
import {
  DEFAULT_MUTATION_PROBE_LIMITS,
  MUTATION_PROBE_PLUGIN_ID,
  createMutationProbe,
  resolveMutationProbeMode,
  type MutationProbeEvidence,
  type MutationProbeOptions,
  type MutationProbeRecord,
} from '../src/request-mutation-probe.js';
import { deepFreeze, expectNoSecrets, fnv1aHex, snapshotValue } from './helpers.js';

/**
 * Tests for the Stage 1R request-mutation probe.
 *
 * The probe is the only module in this package that can write to a request, so the properties that
 * matter are gating (mutation only when explicitly enabled), scope (exactly one `text` tool result,
 * nothing else), honesty (a refusal is recorded, never hidden), and fail-open behaviour.
 */

const MARKER_ORIGINAL = 'DRTOKEN-M2-ORIGINAL-7f3a';
const MARKER_REPLACEMENT = 'DRTOKEN-M2-MODIFIED-7f3a';
const FILE_BODY = 'synthetic file body alpha';

/** A tool-result part shaped like `@opencode/ai`'s `ToolResultPart` (version 2.0.24). */
function toolResult(
  id: string,
  name: string,
  text: string,
  result: Record<string, unknown> = { type: 'text', value: text },
): Record<string, unknown> {
  return { type: 'tool-result', id, name, result };
}

function toolCall(id: string, name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'tool-call', id, name, input };
}

/** A synthetic `SessionContext`, with only the fields the probe reads. */
function sessionContext(
  content: readonly unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionID: 'ses_m2_mutation_test',
    model: { id: 'test-model', providerID: 'test-provider' },
    system: [{ type: 'text', text: 'system instructions here' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read the file twice' }] },
      { role: 'assistant', content: [toolCall('call_1', 'read', { path: 'fixtures/x.txt' }), toolCall('call_2', 'read', { path: 'fixtures/x.txt' })] },
      { role: 'tool', content: [...content] },
    ],
    options: { temperature: 0, maxTokens: 100 },
    tools: { read: { description: 'read a file', input: {} } },
    ...overrides,
  };
}

/** One marker-bearing text result beside one without it: exactly one eligible target. */
function uniqueTargetContext(): Record<string, unknown> {
  return sessionContext([
    toolResult('call_1', 'read', `${FILE_BODY} ${MARKER_ORIGINAL} TARGET-ONE`),
    toolResult('call_2', 'read', `${FILE_BODY} NO-MARKER-HERE`),
  ]);
}

interface ProbeHarness {
  readonly evidence: MutationProbeEvidence;
  readonly disposed: number[];
  readonly cleanup: () => void;
  readonly invokeContext: (input: unknown) => void;
  readonly invokeHttp: (input: unknown) => void;
  readonly registered: readonly string[];
}

function harness(options: MutationProbeOptions): ProbeHarness {
  const registered: string[] = [];
  const disposed: number[] = [];
  const calls: Array<{ readonly name: string; readonly callback: (input: unknown) => unknown }> = [];
  const context = {
    session: {
      hook: (name: string, callback: (input: unknown) => unknown) => {
        const index = calls.length;
        registered.push(name);
        calls.push({ name, callback });
        return { dispose: async () => void disposed.push(index) };
      },
    },
    options: {},
  };
  const { plugin, evidence } = createMutationProbe(options);
  const cleanup = plugin.setup(context);
  const find = (name: string) => calls.find((call) => call.name === name)?.callback;
  return {
    evidence,
    disposed,
    cleanup,
    registered,
    invokeContext: (input) => {
      const callback = find('context');
      expect(callback, 'expected a context hook to be registered').toBeDefined();
      void callback?.(input);
    },
    invokeHttp: (input) => {
      const callback = find('http.request');
      expect(callback, 'expected an http.request hook to be registered').toBeDefined();
      void callback?.(input);
    },
  };
}

function recordsOf<K extends MutationProbeRecord['kind']>(
  evidence: MutationProbeEvidence,
  kind: K,
): Array<Extract<MutationProbeRecord, { kind: K }>> {
  return evidence.records.filter(
    (record): record is Extract<MutationProbeRecord, { kind: K }> => record.kind === kind,
  );
}

const MUTATION = { original: MARKER_ORIGINAL, replacement: MARKER_REPLACEMENT } as const;

/** The value of the `result.value` of the part that carried the marker. */
function valueOf(part: Record<string, unknown>): unknown {
  return (part['result'] as Record<string, unknown>)['value'];
}

describe('mutation probe — registration and gating', () => {
  it('registers the context and http.request hooks and reports the capabilities it found', () => {
    const probe = harness({ hash: fnv1aHex, now: () => 0 });

    expect(probe.registered).toEqual(['context', 'http.request']);
    expect(probe.evidence.capabilities).toEqual({
      sessionHook: true,
      sessionContextHook: true,
      httpRequestHook: true,
    });
    expect(probe.evidence.unsupported).toEqual([]);
    expect(probe.evidence.internalErrors).toBe(0);
    const start = recordsOf(probe.evidence, 'probe-start')[0] as { mode: string } | undefined;
    expect(start?.mode).toBe('observe');
    expect(probe.evidence.mode).toBe('observe');
  });

  it('records why the probe is not running, and registers nothing, when disabled by option', () => {
    const probe = harness({ enabled: false, hash: fnv1aHex, mutation: MUTATION });

    expect(probe.registered).toEqual([]);
    expect(recordsOf(probe.evidence, 'bypassed')).toHaveLength(1);
    expect(probe.evidence.capabilities.sessionContextHook).toBe(false);
  });

  it('treats each documented disable value as a bypass, and never as mutation', () => {
    for (const value of ['off', 'false', '0', 'no', 'disabled', ' OFF ']) {
      const probe = harness({ hash: fnv1aHex, env: { DR_TOKEN_M2_PROBE: value }, mutation: MUTATION });
      expect(probe.registered, `expected ${value} to disable the probe`).toEqual([]);
      expect(probe.evidence.mode).toBe('observe');
    }
  });

  it('records an unsupported capability instead of throwing when the hook domain is absent', () => {
    const { plugin, evidence } = createMutationProbe({ hash: fnv1aHex });
    expect(() => plugin.setup({})).not.toThrow();

    expect(evidence.unsupported).toEqual(['session.hook']);
    expect(evidence.capabilities.sessionHook).toBe(false);
  });

  it('resolves the mode from the switch, and requires a configuration for mutation', () => {
    expect(resolveMutationProbeMode({}, MUTATION)).toBe('observe');
    expect(resolveMutationProbeMode({}, undefined)).toBe('observe');
    expect(resolveMutationProbeMode({ DR_TOKEN_M2_PROBE: 'mutate' }, MUTATION)).toBe('mutate');
    expect(resolveMutationProbeMode({ DR_TOKEN_M2_PROBE: ' MUTATE ' }, MUTATION)).toBe('mutate');
    // The switch alone is not enough: without a configuration there is nothing to substitute.
    expect(resolveMutationProbeMode({ DR_TOKEN_M2_PROBE: 'mutate' }, undefined)).toBe('observe');
    expect(resolveMutationProbeMode({ DR_TOKEN_M2_PROBE: 'observe' }, MUTATION)).toBe('observe');
  });

  it('disposes both registrations and records the cleanup', () => {
    const probe = harness({ hash: fnv1aHex });
    probe.cleanup();

    expect([...probe.disposed].sort()).toEqual([0, 1]);
    const cleanup = recordsOf(probe.evidence, 'cleanup')[0];
    expect(cleanup?.disposed).toBe(2);
  });
});

describe('mutation probe — observation only', () => {
  it('counts the request structure and finds the marker without touching anything', () => {
    const probe = harness({ hash: fnv1aHex, now: () => 0, mutation: MUTATION });
    const payload = uniqueTargetContext();
    const before = snapshotValue(payload);

    probe.invokeContext(payload);

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mode).toBe('observe');
    expect(record?.mutationAttempted).toBe(false);
    expect(record?.mutationApplied).toBe(false);
    expect(record?.refusalReason).toBeNull();
    expect(record?.targetParts).toBe(1);
    expect(record?.targetOccurrences).toBe(1);
    expect(record?.toolResultParts).toBe(2);
    expect(record?.stringTextResults).toBe(2);
    expect(record?.messages).toBe(3);
    expect(record?.analysis.systemParts).toBe(1);
    expect(record?.analysis.toolDefinitions).toBe(1);
    expect(snapshotValue(payload)).toBe(before);
    expect(probe.evidence.mutationsAttempted).toBe(0);
  });

  it('leaves a deep-frozen payload untouched in observe mode', () => {
    const probe = harness({ hash: fnv1aHex, mutation: MUTATION });
    const payload = deepFreeze(uniqueTargetContext());
    const before = snapshotValue(payload);

    expect(() => probe.invokeContext(payload)).not.toThrow();

    expect(snapshotValue(payload)).toBe(before);
    expect(probe.evidence.internalErrors).toBe(0);
    expect(recordsOf(probe.evidence, 'internal-error')).toHaveLength(0);
  });

  it('records the payload key names, and that the context payload carries no request kind', () => {
    const probe = harness({ hash: fnv1aHex, mutation: MUTATION });
    probe.invokeContext(uniqueTargetContext());

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.outerKeys).toEqual([
      'sessionID',
      'model',
      'system',
      'messages',
      'options',
      'tools',
    ]);
    expect(record?.outerKind).toBeNull();
    expect(record?.outerHasContext).toBe(false);
  });

  it('accepts a payload whose request is nested under a `context` member', () => {
    const probe = harness({ hash: fnv1aHex });
    probe.invokeContext({ context: uniqueTargetContext() });

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.outerHasContext).toBe(true);
    expect(record?.messages).toBe(3);
    expect(record?.targetParts).toBe(0);
  });

  it('records an http-request invocation with body length and marker booleans only', () => {
    const probe = harness({ hash: fnv1aHex, mutation: MUTATION });
    const body = `{"messages":[{"content":"${MARKER_ORIGINAL}"}]}`;
    probe.invokeHttp({ kind: 'primary', request: { url: 'http://127.0.0.1:1/v1/chat/completions', headers: { entries: () => [] }, body } });

    const record = recordsOf(probe.evidence, 'http-request')[0];
    expect(record?.requestKind).toBe('primary');
    expect(record?.urlIsString).toBe(true);
    expect(record?.bodyType).toBe('string');
    expect(record?.bodyLength).toBe(body.length);
    expect(record?.bodyHasOriginal).toBe(true);
    expect(record?.bodyHasReplacement).toBe(false);
  });

  it('takes no content reading when the caller did not name any markers', () => {
    const probe = harness({ hash: fnv1aHex });
    probe.invokeHttp({ kind: 'primary', request: { url: 'http://127.0.0.1:1/v1', headers: {}, body: MARKER_ORIGINAL } });

    const record = recordsOf(probe.evidence, 'http-request')[0];
    expect(record?.bodyLength).toBe(MARKER_ORIGINAL.length);
    expect(record?.bodyHasOriginal).toBeNull();
    expect(record?.bodyHasReplacement).toBeNull();
  });

  it('keeps every synthetic string out of its records', () => {
    const probe = harness({ hash: fnv1aHex, mutation: MUTATION });
    probe.invokeContext(uniqueTargetContext());
    probe.invokeHttp({
      kind: 'primary',
      request: { url: 'http://127.0.0.1:1/v1', headers: {}, body: `${FILE_BODY}${MARKER_ORIGINAL}` },
    });

    expectNoSecrets(JSON.stringify(probe.evidence.records), [
      MARKER_ORIGINAL,
      MARKER_REPLACEMENT,
      FILE_BODY,
      'fixtures/x.txt',
    ]);
  });
});

describe('mutation probe — mutation', () => {
  const mutateOptions = { hash: fnv1aHex, now: () => 0, env: { DR_TOKEN_M2_PROBE: 'mutate' }, mutation: MUTATION };

  it('applies the single substitution in mutate mode, and only to the eligible part', () => {
    const probe = harness(mutateOptions);
    const payload = uniqueTargetContext();
    const parts = (payload['messages'] as Array<Record<string, unknown>>)[2]?.['content'] as Array<
      Record<string, unknown>
    >;
    const untouched = snapshotValue(parts[1]);

    probe.invokeContext(payload);

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mode).toBe('mutate');
    expect(record?.mutationAttempted).toBe(true);
    expect(record?.mutationApplied).toBe(true);
    expect(record?.refusalReason).toBeNull();
    expect(record?.textBeforeLength).toBe(`${FILE_BODY} ${MARKER_ORIGINAL} TARGET-ONE`.length);
    expect(record?.textAfterLength).toBe(`${FILE_BODY} ${MARKER_REPLACEMENT} TARGET-ONE`.length);
    expect(valueOf(parts[0] as Record<string, unknown>)).toBe(
      `${FILE_BODY} ${MARKER_REPLACEMENT} TARGET-ONE`,
    );
    expect(snapshotValue(parts[1])).toBe(untouched);
    expect(probe.evidence.mutationsApplied).toBe(1);
    expect(probe.evidence.internalErrors).toBe(0);
  });

  it('is the switch, not the configuration, that decides between the control and the treatment', () => {
    const control = harness({ hash: fnv1aHex, mutation: MUTATION });
    const treatment = harness({ ...mutateOptions });
    const controlPayload = uniqueTargetContext();
    const treatmentPayload = uniqueTargetContext();

    control.invokeContext(controlPayload);
    treatment.invokeContext(treatmentPayload);

    expect(snapshotValue(controlPayload)).toContain(MARKER_ORIGINAL);
    expect(snapshotValue(treatmentPayload)).not.toContain(MARKER_ORIGINAL);
    expect(snapshotValue(treatmentPayload)).toContain(MARKER_REPLACEMENT);
    expect(recordsOf(control.evidence, 'context')[0]?.mutationApplied).toBe(false);
    expect(recordsOf(treatment.evidence, 'context')[0]?.mutationApplied).toBe(true);
  });

  it('never touches system, options, tools or tool-call inputs, even when they are frozen', () => {
    const probe = harness(mutateOptions);
    const payload = uniqueTargetContext();
    deepFreeze(payload['system']);
    deepFreeze(payload['options']);
    deepFreeze(payload['tools']);
    const assistantParts = (payload['messages'] as Array<Record<string, unknown>>)[1]?.['content'] as Array<
      Record<string, unknown>
    >;
    deepFreeze(assistantParts);
    const systemBefore = snapshotValue(payload['system']);
    const optionsBefore = snapshotValue(payload['options']);
    const toolsBefore = snapshotValue(payload['tools']);
    const toolCallsBefore = snapshotValue(assistantParts);

    expect(() => probe.invokeContext(payload)).not.toThrow();

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mutationApplied).toBe(true);
    expect(snapshotValue(payload['system'])).toBe(systemBefore);
    expect(snapshotValue(payload['options'])).toBe(optionsBefore);
    expect(snapshotValue(payload['tools'])).toBe(toolsBefore);
    expect(snapshotValue(assistantParts)).toBe(toolCallsBefore);
    expect(probe.evidence.internalErrors).toBe(0);
  });

  it('refuses when the marker is absent, and records the refusal', () => {
    const probe = harness(mutateOptions);
    const payload = sessionContext([toolResult('call_1', 'read', FILE_BODY)]);
    const before = snapshotValue(payload);

    probe.invokeContext(payload);

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mutationAttempted).toBe(true);
    expect(record?.mutationApplied).toBe(false);
    expect(record?.refusalReason).toBe('target-absent');
    expect(record?.targetParts).toBe(0);
    expect(snapshotValue(payload)).toBe(before);
    expect(probe.evidence.mutationsApplied).toBe(0);
  });

  it('refuses when more than one part carries the marker, rather than editing both', () => {
    const probe = harness(mutateOptions);
    const payload = sessionContext([
      toolResult('call_1', 'read', `${FILE_BODY} ${MARKER_ORIGINAL}`),
      toolResult('call_2', 'read', `${FILE_BODY} ${MARKER_ORIGINAL}`),
    ]);
    const before = snapshotValue(payload);

    probe.invokeContext(payload);

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mutationApplied).toBe(false);
    expect(record?.refusalReason).toBe('target-ambiguous');
    expect(record?.targetParts).toBe(2);
    expect(snapshotValue(payload)).toBe(before);
  });

  it('refuses when the marker occurs more than once inside one part', () => {
    const probe = harness(mutateOptions);
    const payload = sessionContext([
      toolResult('call_1', 'read', `${MARKER_ORIGINAL} and ${MARKER_ORIGINAL}`),
    ]);
    const before = snapshotValue(payload);

    probe.invokeContext(payload);

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mutationApplied).toBe(false);
    expect(record?.refusalReason).toBe('target-occurrences-not-unique');
    expect(record?.targetOccurrences).toBe(2);
    expect(snapshotValue(payload)).toBe(before);
  });

  it('refuses an invalid configuration instead of guessing', () => {
    for (const mutation of [
      { original: '', replacement: MARKER_REPLACEMENT },
      { original: MARKER_ORIGINAL, replacement: MARKER_ORIGINAL },
    ]) {
      const probe = harness({
        hash: fnv1aHex,
        env: { DR_TOKEN_M2_PROBE: 'mutate' },
        mutation,
      });
      const payload = uniqueTargetContext();
      const before = snapshotValue(payload);

      probe.invokeContext(payload);

      const record = recordsOf(probe.evidence, 'context')[0];
      expect(record?.mutationApplied).toBe(false);
      expect(record?.refusalReason).toBe('invalid-config');
      expect(snapshotValue(payload)).toBe(before);
    }
  });

  it('contains an assignment failure instead of throwing into the host', () => {
    const probe = harness(mutateOptions);
    const payload = uniqueTargetContext();
    const parts = (payload['messages'] as Array<Record<string, unknown>>)[2]?.['content'] as Array<
      Record<string, unknown>
    >;
    Object.freeze(parts[0]?.['result']);
    deepFreeze(parts[0]?.['result']);

    expect(() => probe.invokeContext(payload)).not.toThrow();

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mutationApplied).toBe(false);
    expect(record?.refusalReason).toBe('assignment-failed');
    expect(probe.evidence.mutationsApplied).toBe(0);
    expect(recordsOf(probe.evidence, 'internal-error')).toHaveLength(0);
  });

  it('never edits text that is not a plain `text` tool result', () => {
    const cases: Array<Record<string, unknown>> = [
      // A `content`-type result (the shape a file read can also take).
      toolResult('call_1', 'read', '', { type: 'content', value: [{ type: 'text', text: MARKER_ORIGINAL }] }),
      // A json result.
      toolResult('call_1', 'read', '', { type: 'json', value: { note: MARKER_ORIGINAL } }),
      // A text result whose value is not a string.
      toolResult('call_1', 'read', '', { type: 'text', value: 42 }),
    ];
    for (const part of cases) {
      const probe = harness(mutateOptions);
      const payload = sessionContext([part]);
      const before = snapshotValue(payload);

      probe.invokeContext(payload);

      const record = recordsOf(probe.evidence, 'context')[0];
      expect(record?.mutationApplied).toBe(false);
      expect(record?.refusalReason).toBe('target-absent');
      expect(snapshotValue(payload)).toBe(before);
    }
  });

  it('ignores the marker when it appears only in system text, a tool-call input or a user message', () => {
    const probe = harness(mutateOptions);
    const payload = sessionContext(
      [toolCall('call_1', 'read', { path: MARKER_ORIGINAL }), toolResult('call_1', 'read', FILE_BODY)],
      {
        system: [{ type: 'text', text: `instructions ${MARKER_ORIGINAL}` }],
      },
    );
    const before = snapshotValue(payload);

    probe.invokeContext(payload);

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mutationApplied).toBe(false);
    expect(record?.refusalReason).toBe('target-absent');
    expect(snapshotValue(payload)).toBe(before);
  });

  it('does not re-edit on a retry: the second invocation no longer finds the marker', () => {
    const probe = harness(mutateOptions);
    const payload = uniqueTargetContext();

    probe.invokeContext(payload);
    probe.invokeContext(payload);

    const records = recordsOf(probe.evidence, 'context');
    expect(records).toHaveLength(2);
    expect(records[0]?.mutationApplied).toBe(true);
    expect(records[1]?.mutationApplied).toBe(false);
    expect(records[1]?.refusalReason).toBe('target-absent');
    expect(probe.evidence.mutationsApplied).toBe(1);
  });

  it('does not edit text outside the per-payload bound', () => {
    const probe = harness({
      ...mutateOptions,
      limits: { maxCharsPerPayload: 32 },
    });
    const payload = sessionContext([toolResult('call_1', 'read', `${'x'.repeat(64)}${MARKER_ORIGINAL}`)]);
    const before = snapshotValue(payload);

    probe.invokeContext(payload);

    const record = recordsOf(probe.evidence, 'context')[0];
    expect(record?.mutationApplied).toBe(false);
    expect(record?.refusalReason).toBe('target-absent');
    expect(snapshotValue(payload)).toBe(before);
  });
});

describe('mutation probe — bounds and containment', () => {
  it('contains a throwing accessor and still records the invocation', () => {
    const probe = harness({ hash: fnv1aHex });
    const payload: Record<string, unknown> = {
      sessionID: 'ses_throw',
      get messages(): never {
        throw new Error('boom');
      },
    };

    expect(() => probe.invokeContext(payload)).not.toThrow();

    const errors = recordsOf(probe.evidence, 'internal-error');
    expect(errors.map((record) => record.code)).toEqual(['context-callback']);
    expect(probe.evidence.internalErrors).toBe(1);
  });

  it('contains a sink that throws, and keeps the records', () => {
    const probe = harness({
      hash: fnv1aHex,
      sink: () => {
        throw new Error('sink');
      },
    });
    probe.invokeContext(uniqueTargetContext());

    expect(probe.evidence.internalErrors).toBeGreaterThan(0);
    expect(recordsOf(probe.evidence, 'context')).toHaveLength(1);
  });

  it('caps the record set once', () => {
    const probe = harness({ hash: fnv1aHex, limits: { maxRecords: 3 } });
    for (let index = 0; index < 6; index += 1) {
      probe.invokeContext(uniqueTargetContext());
    }

    // The cap plus the single `records-capped` marker that reports it.
    expect(probe.evidence.records.length).toBeLessThanOrEqual(4);
    expect(probe.evidence.capped).toBe(true);
    expect(recordsOf(probe.evidence, 'records-capped')).toHaveLength(1);
  });

  it('reports a payload that is not request-shaped instead of inventing a reading', () => {
    const probe = harness({ hash: fnv1aHex });
    for (const input of [null, 42, [], { context: 'nope' }, { messages: 'not-an-array' }]) {
      expect(() => probe.invokeContext(input)).not.toThrow();
    }

    expect(recordsOf(probe.evidence, 'context')).toHaveLength(0);
    expect(recordsOf(probe.evidence, 'unsupported')).toHaveLength(5);
  });

  it('does not attempt a mutation on a payload it cannot read', () => {
    const probe = harness({
      hash: fnv1aHex,
      env: { DR_TOKEN_M2_PROBE: 'mutate' },
      mutation: MUTATION,
    });
    probe.invokeContext({ context: 'nope' });

    expect(probe.evidence.mutationsAttempted).toBe(0);
    expect(probe.evidence.mutationsApplied).toBe(0);
  });

  it('keeps the default limits intact for callers that override one field', () => {
    const probe = harness({ hash: fnv1aHex, limits: { maxRecords: 10 } });
    expect(DEFAULT_MUTATION_PROBE_LIMITS.maxRecords).toBe(2_000);
    expect(probe.evidence.capped).toBe(false);
  });
});

describe('mutation probe — production activation', () => {
  it('is not reachable from the package entry point', () => {
    const exported = Object.keys(entryPoint).join(',');
    expect(exported).not.toContain('Mutation');
    expect(exported).not.toContain('mutate');
  });

  it('is not exported under any name a consumer could import', () => {
    for (const [name, value] of Object.entries(entryPoint)) {
      expect(name).not.toContain('Mutation');
      if (typeof value === 'function') {
        expect((value as { name?: string }).name ?? '').not.toContain('Mutation');
      }
    }
  });

  it('ships an id that is distinct from every product identity', () => {
    expect(MUTATION_PROBE_PLUGIN_ID).toBe('dr-token-m2-mutation-probe');
    expect(entryPoint.OBSERVER_V2_PLUGIN_ID).not.toBe(MUTATION_PROBE_PLUGIN_ID);
  });
});
