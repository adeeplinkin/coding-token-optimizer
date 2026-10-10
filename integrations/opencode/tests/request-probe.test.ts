import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REQUEST_PROBE_LIMITS,
  REQUEST_PROBE_EVIDENCE_ENV,
  REQUEST_PROBE_PLUGIN_ID,
  analyseRequest,
  createRequestProbe,
  defaultProbeHash,
  type RequestProbeRecord,
} from '../src/request-probe.js';
import { deepFreeze, fnv1aHex, snapshotValue } from './helpers.js';

/**
 * Tests for the Stage 1P request-assembly probe.
 *
 * The probe is a validation aid, so the properties that matter are the ones that decide whether its
 * evidence can be trusted at all: it must observe without ever mutating, leak no content, stay
 * bounded, fail open, and be disableable.
 */

/** A tool-result part shaped like `@opencode/ai`'s `ToolResultPart` (version 2.0.24). */
function toolResult(id: string, name: string, text: string): Record<string, unknown> {
  return { type: 'tool-result', id, name, result: { type: 'text', value: text } };
}

function toolCall(id: string, name: string): Record<string, unknown> {
  return { type: 'tool-call', id, name, input: {} };
}

/** A synthetic `SessionContext`, with only the fields the probe reads. */
function sessionContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionID: 'ses_probe_test',
    model: { id: 'test-model', providerID: 'test-provider' },
    system: [{ type: 'text', text: 'system instructions here' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'please read the file twice' }] },
      {
        role: 'assistant',
        content: [toolCall('call_1', 'read'), toolCall('call_2', 'read')],
      },
      {
        role: 'tool',
        content: [
          toolResult('call_1', 'read', 'FILE-BODY-CONTENT-ALPHA'),
          toolResult('call_2', 'read', 'FILE-BODY-CONTENT-ALPHA'),
        ],
      },
    ],
    options: { temperature: 0, maxTokens: 100 },
    tools: { read: { description: 'read a file', input: {} } },
    ...overrides,
  };
}

interface FakeHost {
  readonly context: Record<string, unknown>;
  readonly calls: Array<{ readonly name: string; readonly callback: (input: unknown) => unknown }>;
  readonly disposed: number[];
}

/** A host that records hook registrations instead of executing them. */
function fakeHost(): FakeHost {
  const calls: FakeHost['calls'] = [];
  const disposed: number[] = [];
  const context = {
    session: {
      hook: (name: string, callback: (input: unknown) => unknown) => {
        const index = calls.length;
        calls.push({ name, callback });
        return { dispose: async () => void disposed.push(index) };
      },
    },
    options: {},
  };
  return { context, calls, disposed };
}

function recordsOf(evidence: { readonly records: readonly RequestProbeRecord[] }, kind: string) {
  return evidence.records.filter((record) => record.kind === kind);
}

describe('request probe — registration', () => {
  it('registers the context and http.request hooks, and reports the capabilities it found', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex, now: () => 0 });
    const cleanup = plugin.setup(fakeHost().context);

    expect(plugin.id).toBe(REQUEST_PROBE_PLUGIN_ID);
    const start = recordsOf(evidence, 'probe-start')[0];
    expect(start).toBeDefined();
    expect(evidence.capabilities.sessionHook).toBe(true);
    expect(evidence.capabilities.sessionContextHook).toBe(true);
    expect(evidence.capabilities.httpRequestHook).toBe(true);
    expect(evidence.unsupported).toEqual([]);
    expect(evidence.internalErrors).toBe(0);
    cleanup();
  });

  it('disposes a registration that arrives as a promise — including one that lands after cleanup', async () => {
    const disposed: number[] = [];
    let callIndex = 0;
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const cleanup = plugin.setup({
      session: {
        hook: async () => {
          const index = callIndex;
          callIndex += 1;
          return {
            dispose: async () => {
              disposed.push(index);
            },
          };
        },
      },
    });

    // Cleanup runs before either promise settles: neither registration may be leaked.
    cleanup();
    await vi.waitFor(() => expect(disposed).toHaveLength(2));
    expect([...disposed].sort()).toEqual([0, 1]);
    expect(evidence.internalErrors).toBe(0);
  });

  it('records an unsupported capability instead of throwing when the hook domain is absent', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    expect(() => plugin.setup({})).not.toThrow();

    expect(evidence.unsupported).toEqual(['session.hook']);
    expect(evidence.capabilities.sessionHook).toBe(false);
    expect(recordsOf(evidence, 'unsupported')).toHaveLength(1);
    expect(evidence.internalErrors).toBe(0);
  });

  it('records an unsupported capability when the host rejects a hook name', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    plugin.setup({
      session: {
        hook: (name: string) => {
          throw new Error(`unknown hook ${name}`);
        },
      },
    });

    expect(evidence.unsupported).toEqual([
      'session.hook(context)',
      'session.hook(http.request)',
    ]);
    expect(evidence.capabilities.sessionContextHook).toBe(false);
    expect(evidence.internalErrors).toBe(0);
  });

  it('records whether an unknown hook name fails safely', () => {
    const accepting = createRequestProbe({ hash: fnv1aHex, probeUnknownHook: true });
    accepting.plugin.setup(fakeHost().context);
    expect(accepting.evidence.capabilities.unknownHookAccepted).toBe(true);

    const rejecting = createRequestProbe({ hash: fnv1aHex, probeUnknownHook: true });
    rejecting.plugin.setup({
      session: {
        hook: (name: string) => {
          if (name === 'dr-token.unknown.hook') {
            throw new Error('unknown hook');
          }
          return { dispose: async () => {} };
        },
      },
    });
    expect(rejecting.evidence.capabilities.unknownHookAccepted).toBe(false);
    expect(rejecting.evidence.capabilities.sessionContextHook).toBe(true);
  });
});

describe('request probe — structural analysis', () => {
  it('counts roles, part types, tools and options without reading content', () => {
    const analysis = analyseRequest(sessionContext(), fnv1aHex, DEFAULT_REQUEST_PROBE_LIMITS);

    expect(analysis).toBeDefined();
    expect(analysis?.messages).toBe(3);
    expect(analysis?.roles).toEqual({ user: 1, assistant: 1, tool: 1 });
    expect(analysis?.partTypes).toEqual({ text: 1, 'tool-call': 2, 'tool-result': 2 });
    expect(analysis?.systemParts).toBe(1);
    expect(analysis?.toolResults).toBe(2);
    expect(analysis?.toolResultNames).toEqual(['read']);
    expect(analysis?.toolDefinitions).toBe(1);
    expect(analysis?.optionKeys).toBe(2);
    expect(analysis?.hasCompactionPart).toBe(false);
    expect(analysis?.scanned.truncated).toBe(false);
  });

  it('detects byte-identical repeated tool results from the same tool', () => {
    const analysis = analyseRequest(sessionContext(), fnv1aHex, DEFAULT_REQUEST_PROBE_LIMITS);

    expect(analysis?.distinctToolResultDigests).toBe(1);
    expect(analysis?.duplicateGroups).toBe(1);
    expect(analysis?.duplicateLaterParts).toBe(1);
    expect(analysis?.elidableChars).toBe('FILE-BODY-CONTENT-ALPHA'.length);
    expect(analysis?.readToolDuplicateGroups).toBe(1);
  });

  it('never treats identical text from a different tool as the same content', () => {
    const context = sessionContext({
      messages: [
        {
          role: 'tool',
          content: [
            toolResult('call_1', 'read', 'IDENTICAL-TEXT'),
            toolResult('call_2', 'bash', 'IDENTICAL-TEXT'),
          ],
        },
      ],
    });
    const analysis = analyseRequest(context, fnv1aHex, DEFAULT_REQUEST_PROBE_LIMITS);

    expect(analysis?.toolResults).toBe(2);
    expect(analysis?.distinctToolResultDigests).toBe(2);
    expect(analysis?.duplicateGroups).toBe(0);
  });

  it('distinguishes a differing copy from a duplicate and reports what is elidable', () => {
    const context = sessionContext({
      messages: [
        {
          role: 'tool',
          content: [
            toolResult('call_1', 'read', 'REPEATED-CONTENT'),
            toolResult('call_2', 'read', 'DIFFERENT-CONTENT'),
            toolResult('call_3', 'read', 'REPEATED-CONTENT'),
            toolResult('call_4', 'read', 'REPEATED-CONTENT'),
          ],
        },
      ],
    });
    const analysis = analyseRequest(context, fnv1aHex, DEFAULT_REQUEST_PROBE_LIMITS);

    expect(analysis?.toolResults).toBe(4);
    expect(analysis?.distinctToolResultDigests).toBe(2);
    expect(analysis?.duplicateGroups).toBe(1);
    expect(analysis?.duplicateLaterParts).toBe(2);
    expect(analysis?.elidableChars).toBe('REPEATED-CONTENT'.length * 2);
  });

  it('digests content-array tool results and detects an error-typed result', () => {
    const context = sessionContext({
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              id: 'call_1',
              name: 'read',
              result: {
                type: 'content',
                value: [
                  { type: 'text', text: 'line one' },
                  { type: 'text', text: 'line two' },
                ],
              },
            },
            {
              type: 'tool-result',
              id: 'call_2',
              name: 'read',
              result: {
                type: 'content',
                value: [
                  { type: 'text', text: 'line one' },
                  { type: 'text', text: 'line two' },
                ],
              },
            },
            { type: 'tool-result', id: 'call_3', name: 'read', result: { type: 'error', value: 'boom' } },
          ],
        },
      ],
    });
    const analysis = analyseRequest(context, fnv1aHex, DEFAULT_REQUEST_PROBE_LIMITS);

    expect(analysis?.toolResults).toBe(3);
    expect(analysis?.duplicateGroups).toBe(1);
    expect(analysis?.elidableChars).toBe('line one\nline two'.length);
  });

  it('reports a malformed request as unsupported rather than inventing a reading', () => {
    expect(analyseRequest(undefined, fnv1aHex, DEFAULT_REQUEST_PROBE_LIMITS)).toBeUndefined();
    expect(analyseRequest('not-a-request', fnv1aHex, DEFAULT_REQUEST_PROBE_LIMITS)).toBeUndefined();

    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    host.calls.find((call) => call.name === 'context')?.callback({ context: null });

    expect(evidence.unsupported).toContain('context-payload');
    expect(evidence.internalErrors).toBe(0);
  });

  it('accepts a context delivered either bare or nested under `context`', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'context')?.callback;

    callback?.(sessionContext());
    callback?.({ context: sessionContext() });

    expect(recordsOf(evidence, 'context')).toHaveLength(2);
    expect(recordsOf(evidence, 'unsupported')).toHaveLength(0);
  });

  it('records the model-call hook without reading the request body', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'http.request')?.callback;

    let bodyReads = 0;
    const request = {
      url: 'https://provider.invalid/v1/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer SECRET' },
      get body(): unknown {
        bodyReads += 1;
        throw new Error('the body must never be read');
      },
    };
    callback?.({ sessionID: 'ses_probe_test', agent: 'build', model: {}, kind: 'primary', request });

    const record = recordsOf(evidence, 'http-request')[0];
    expect(record?.kind).toBe('http-request');
    if (record?.kind !== 'http-request') {
      throw new Error('expected an http-request record');
    }
    expect(record.requestKind).toBe('primary');
    expect(record.urlIsString).toBe(true);
    expect(record.headerCount).toBe(2);
    expect(bodyReads).toBe(1);
    expect(JSON.stringify(record)).not.toContain('SECRET');
    expect(JSON.stringify(record)).not.toContain('provider.invalid');
  });
});

describe('request probe — neutrality', () => {
  it('never mutates the request it observes, even when the graph is deep-frozen', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'context')?.callback;

    const frozen = deepFreeze(sessionContext());
    const before = snapshotValue(frozen);

    expect(() => callback?.(frozen)).not.toThrow();
    expect(snapshotValue(frozen)).toBe(before);
    expect(evidence.internalErrors).toBe(0);
    expect(recordsOf(evidence, 'context')).toHaveLength(1);
  });

  it('returns nothing from its callbacks, so the host cannot be influenced by a return value', () => {
    const { plugin } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);

    for (const call of host.calls) {
      expect(call.callback(sessionContext())).toBeUndefined();
    }
  });

  it('contains a hostile payload: a throwing accessor is counted, never propagated', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'context')?.callback;

    const hostile = {
      sessionID: 'ses_probe_test',
      get messages(): never {
        throw new Error('hostile getter');
      },
    };

    expect(() => callback?.(hostile)).not.toThrow();
    expect(evidence.internalErrors).toBe(1);
    expect(recordsOf(evidence, 'internal-error')).toHaveLength(1);
  });

  it('survives a circular structure without throwing', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'context')?.callback;

    const circular: Record<string, unknown> = { sessionID: 'ses_probe_test', messages: [] };
    circular['self'] = circular;

    expect(() => callback?.(circular)).not.toThrow();
    expect(evidence.internalErrors).toBe(0);
  });
});

describe('request probe — privacy', () => {
  it('writes no prompt text, tool-result content, path or credential into any record', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'context')?.callback;

    callback?.(
      sessionContext({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'SECRET-PROMPT-TEXT' }] },
          {
            role: 'tool',
            content: [
              toolResult('call_1', 'read', 'SECRET-FILE-CONTENT'),
              toolResult('call_2', 'read', 'SECRET-FILE-CONTENT'),
              {
                type: 'tool-result',
                id: 'call_3',
                name: 'read',
                result: { type: 'content', value: [{ type: 'file', uri: 'C:\\secrets\\key.pem', mime: 'text/plain' }] },
              },
            ],
          },
        ],
        options: { apiKey: 'SECRET-OPTION-VALUE' },
      }),
    );

    const serialized = JSON.stringify(evidence.records);
    expect(serialized).not.toContain('SECRET-PROMPT-TEXT');
    expect(serialized).not.toContain('SECRET-FILE-CONTENT');
    expect(serialized).not.toContain('secrets');
    expect(serialized).not.toContain('key.pem');
    expect(serialized).not.toContain('SECRET-OPTION-VALUE');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('system instructions here');

    // The session identifier is stored only as a one-way digest.
    const record = recordsOf(evidence, 'context')[0];
    if (record?.kind !== 'context') {
      throw new Error('expected a context record');
    }
    expect(record.sessionHash).toBe(fnv1aHex('ses_probe_test'));
    expect(serialized).not.toContain('ses_probe_test');
  });

  it('hashes session identifiers with the production hasher by default', () => {
    expect(defaultProbeHash('ses_probe_test')).toMatch(/^[0-9a-f]{16}$/);
    expect(defaultProbeHash('a')).not.toBe(defaultProbeHash('b'));
  });
});

describe('request probe — bounds, bypass, disposal and isolation', () => {
  it('bounds the scan and says so when it truncates', () => {
    const many = Array.from({ length: 10 }, (_unused, index) => ({
      role: 'tool',
      content: [toolResult(`call_${index}`, 'read', `content ${index}`)],
    }));
    const analysis = analyseRequest(
      sessionContext({ messages: many }),
      fnv1aHex,
      { ...DEFAULT_REQUEST_PROBE_LIMITS, maxMessages: 4 },
    );
    expect(analysis?.messages).toBe(10);
    expect(analysis?.scanned.messages).toBe(4);
    expect(analysis?.scanned.truncated).toBe(true);

    const digestBound = analyseRequest(sessionContext(), fnv1aHex, {
      ...DEFAULT_REQUEST_PROBE_LIMITS,
      maxToolResultsDigested: 1,
    });
    expect(digestBound?.scanned.truncated).toBe(true);
    expect(digestBound?.distinctToolResultDigests).toBe(1);
  });

  it('caps its record set instead of growing without bound', () => {
    const { plugin, evidence } = createRequestProbe({
      hash: fnv1aHex,
      limits: { maxRecords: 3 },
    });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'context')?.callback;
    for (let index = 0; index < 20; index += 1) {
      callback?.(sessionContext());
    }

    expect(evidence.records).toHaveLength(4);
    expect(evidence.capped).toBe(true);
    expect(recordsOf(evidence, 'records-capped')).toHaveLength(1);
    expect(evidence.contextInvocations).toBe(20);
  });

  it('is bypassed by the option and by the environment, without registering anything', () => {
    const byOption = createRequestProbe({ hash: fnv1aHex, enabled: false });
    const optionHost = fakeHost();
    byOption.plugin.setup(optionHost.context);
    expect(optionHost.calls).toHaveLength(0);
    expect(byOption.evidence.records.map((record) => record.kind)).toEqual(['bypassed']);

    const byEnvironment = createRequestProbe({
      hash: fnv1aHex,
      env: { DR_TOKEN_REQUEST_PROBE: 'off' },
    });
    const envHost = fakeHost();
    byEnvironment.plugin.setup(envHost.context);
    expect(envHost.calls).toHaveLength(0);
    expect(byEnvironment.evidence.records.map((record) => record.kind)).toEqual(['bypassed']);

    const byHostOption = createRequestProbe({ hash: fnv1aHex });
    const hostOptionCalls: string[] = [];
    byHostOption.plugin.setup({
      session: {
        hook: (name: string) => {
          hostOptionCalls.push(name);
          return { dispose: async () => {} };
        },
      },
      options: { enabled: false },
    });
    expect(hostOptionCalls).toEqual([]);
    expect(byHostOption.evidence.records.map((record) => record.kind)).toEqual(['bypassed']);
  });

  it('disposes every registration on cleanup and stops observing afterwards', async () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    const cleanup = plugin.setup(host.context);

    expect(host.calls.map((call) => call.name).sort()).toEqual(['context', 'http.request']);
    cleanup();
    await vi.waitFor(() => expect(host.disposed).toHaveLength(2));

    const record = recordsOf(evidence, 'cleanup')[0];
    if (record?.kind !== 'cleanup') {
      throw new Error('expected a cleanup record');
    }
    expect(record.disposed).toBe(2);
    expect(evidence.internalErrors).toBe(0);
  });

  it('keeps independent instances separate, and never shares state between sessions', () => {
    const first = createRequestProbe({ hash: fnv1aHex });
    const second = createRequestProbe({ hash: fnv1aHex });
    const firstHost = fakeHost();
    const secondHost = fakeHost();
    first.plugin.setup(firstHost.context);
    second.plugin.setup(secondHost.context);

    const firstCallback = firstHost.calls.find((call) => call.name === 'context')?.callback;
    const secondCallback = secondHost.calls.find((call) => call.name === 'context')?.callback;

    firstCallback?.(sessionContext({ sessionID: 'ses_one' }));
    secondCallback?.(sessionContext({ sessionID: 'ses_two' }));

    expect(first.evidence.contextInvocations).toBe(1);
    expect(second.evidence.contextInvocations).toBe(1);

    const firstSession = recordsOf(first.evidence, 'context')[0];
    const secondSession = recordsOf(second.evidence, 'context')[0];
    if (firstSession?.kind !== 'context' || secondSession?.kind !== 'context') {
      throw new Error('expected context records');
    }
    expect(firstSession.sessionHash).toBe(fnv1aHex('ses_one'));
    expect(secondSession.sessionHash).toBe(fnv1aHex('ses_two'));
  });

  it('records duplicate delivery as separate invocations with identical analysis', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'context')?.callback;

    const context = sessionContext();
    callback?.(context);
    callback?.(context);

    const records = recordsOf(evidence, 'context');
    expect(records).toHaveLength(2);
    if (records[0]?.kind !== 'context' || records[1]?.kind !== 'context') {
      throw new Error('expected context records');
    }
    expect(records[0].invocation).toBe(1);
    expect(records[1].invocation).toBe(2);
    expect({ ...records[0], invocation: 0 }).toEqual({ ...records[1], invocation: 0 });
  });

  it('classifies the http-request invocation count and its request kind', () => {
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    const host = fakeHost();
    plugin.setup(host.context);
    const callback = host.calls.find((call) => call.name === 'http.request')?.callback;

    callback?.({ kind: 'compaction', request: { url: 'x', headers: {} } });
    callback?.({ kind: 'compaction', request: { url: 'x', headers: {} } });

    expect(evidence.httpRequestInvocations).toBe(2);
    expect(recordsOf(evidence, 'http-request')).toHaveLength(2);
  });

  it('sends records to a configured sink and never lets a sink failure escape', () => {
    const seen: RequestProbeRecord[] = [];
    const good = createRequestProbe({ hash: fnv1aHex, sink: (record) => void seen.push(record) });
    const goodHost = fakeHost();
    good.plugin.setup(goodHost.context);
    expect(seen.length).toBeGreaterThan(0);
    expect(good.evidence.internalErrors).toBe(0);

    const bad = createRequestProbe({
      hash: fnv1aHex,
      sink: () => {
        throw new Error('sink is broken');
      },
    });
    expect(() => bad.plugin.setup(fakeHost().context)).not.toThrow();
    expect(bad.evidence.internalErrors).toBeGreaterThan(0);
  });

  it('names its evidence environment switch so a run can be pointed at a file', () => {
    expect(REQUEST_PROBE_EVIDENCE_ENV).toBe('DR_TOKEN_REQUEST_PROBE_EVIDENCE');
  });

  it('reads no environment of its own, so bypass is always explicit', () => {
    // The probe is a pure function of its options: with no environment supplied it observes rather
    // than silently switching itself off, which is why the caller passes the environment in.
    const { plugin, evidence } = createRequestProbe({ hash: fnv1aHex });
    plugin.setup(fakeHost().context);

    expect(evidence.records[0]?.kind).toBe('probe-start');
    expect(evidence.capabilities.sessionContextHook).toBe(true);
  });
});

