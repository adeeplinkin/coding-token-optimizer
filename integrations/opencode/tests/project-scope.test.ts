import { describe, expect, it } from 'vitest';
import { OpenCodeObserver, normalizeProjectDirectory } from '../src/observer.js';
import { readExpectedProject } from '../src/plugin-v2.js';
import type { ObserverDiagnostic, SessionObservationSummary } from '../src/index.js';
import { fnv1aHex } from './helpers.js';

/**
 * Project scoping and session-lifecycle state at the observer level.
 *
 * Stage 1H found that a session created through the user's Desktop service
 * resolved to the user's home directory instead of the project the plugin had
 * been loaded for — and that nothing in the observation said so. The verified V2
 * contracts fix the information problem: `session.created` carries
 * `data.projectID` and `data.location.directory`, and `ctx.location` says which
 * project the instance belongs to. These tests pin the decision table:
 *
 *   - an opaque project id comparison wins when both sides declare one;
 *   - a directory comparison is the fallback and only accepts containment, so a
 *     session in a project subdirectory matches and a same-prefix sibling does
 *     not;
 *   - when either side declares nothing usable the session is still recorded but
 *     reported as unverified, never assigned to a guessed project;
 *   - a session known to be a different project is dropped, and late events for a
 *     deleted session cannot recreate state.
 *
 * These drive the observer's public hook entry points directly, which is the same
 * interface the V1 adapter uses. The adapter path (setup, `ctx.location`, the real
 * subscription) is covered end to end in `v2-lifecycle.test.ts`.
 */

interface ScopeFixture {
  readonly observer: OpenCodeObserver;
  readonly diagnostics: ObserverDiagnostic[];
  readonly deliver: (
    type: string,
    payload: { readonly data?: unknown; readonly properties?: unknown },
  ) => Promise<void>;
  readonly created: (data: Record<string, unknown>) => Promise<void>;
  readonly v1Created: (sessionId: string) => Promise<void>;
  readonly deleted: (sessionId: string) => Promise<void>;
  readonly tool: (sessionID: string, callID: string) => void;
  readonly summary: (sessionID: string) => SessionObservationSummary;
}

function createScopeFixture(): ScopeFixture {
  const diagnostics: ObserverDiagnostic[] = [];
  const observer = new OpenCodeObserver({
    env: {},
    hash: fnv1aHex,
    now: () => 1_700_000_000_000,
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });

  const deliver = (
    type: string,
    payload: { readonly data?: unknown; readonly properties?: unknown },
  ): Promise<void> => observer.observeEvent({ event: { type, ...payload } });

  const summary = (sessionID: string): SessionObservationSummary => {
    const found = observer.getSummary(sessionID);
    if (found === undefined) {
      throw new Error(`expected a summary for session ${sessionID}`);
    }
    return found;
  };

  return {
    observer,
    diagnostics,
    deliver,
    created: (data) => deliver('session.created', { data }),
    v1Created: (sessionId) => deliver('session.created', { properties: { info: { id: sessionId } } }),
    deleted: (sessionId) => deliver('session.deleted', { data: { sessionID: sessionId } }),
    tool: (sessionID, callID) =>
      observer.observeToolBefore({ tool: 'read', sessionID, callID }, { args: { filePath: '/synthetic/a.ts' } }),
    summary,
  };
}

describe('normalizeProjectDirectory', () => {
  it('folds the Windows forms that would otherwise split one project in two', () => {
    expect(normalizeProjectDirectory('C:\\Work\\Project\\')).toBe('c:/work/project');
    expect(normalizeProjectDirectory('c:/work/project')).toBe('c:/work/project');
    expect(normalizeProjectDirectory('C:\\')).toBe('c:');
    expect(normalizeProjectDirectory('C://Work//Project')).toBe('c:/work/project');
    expect(normalizeProjectDirectory('  C:\\Work\\Project  ')).toBe('c:/work/project');
  });

  it('cleans separators without case-folding a case-sensitive POSIX path', () => {
    expect(normalizeProjectDirectory('/opt/project/')).toBe('/opt/project');
    expect(normalizeProjectDirectory('/opt//project')).toBe('/opt/project');
    expect(normalizeProjectDirectory('/Opt/Project')).toBe('/Opt/Project');
  });
});

describe('project scope', () => {
  it('matches by project id even when the directories differ', async () => {
    const fixture = createScopeFixture();
    fixture.observer.setExpectedProject({ projectId: 'prj_a', directory: 'C:\\work\\proj-a' });

    await fixture.created({
      sessionID: 'ses_1',
      projectID: 'prj_a',
      location: { directory: 'C:\\somewhere\\else\\sub' },
    });

    expect(fixture.summary('ses_1').project).toMatchObject({
      basis: 'runtime-declared',
      verification: 'matched',
      projectId: 'prj_a',
    });
    expect(fixture.observer.getSnapshot().sessionsOutOfScope).toBe(0);
  });

  it('lets a mismatched project id win over a matching directory', async () => {
    const fixture = createScopeFixture();
    fixture.observer.setExpectedProject({ projectId: 'prj_a', directory: 'C:\\work\\proj' });

    await fixture.created({
      sessionID: 'ses_1',
      projectID: 'prj_b',
      location: { directory: 'C:\\work\\proj' },
    });

    expect(fixture.observer.getSummary('ses_1')).toBeUndefined();
    expect(fixture.observer.getSnapshot().sessionsOutOfScope).toBe(1);
    expect(fixture.diagnostics.map((diagnostic) => diagnostic.code)).toContain('project-mismatch');
  });

  it('accepts a session working in a subdirectory of the project', async () => {
    const fixture = createScopeFixture();
    fixture.observer.setExpectedProject({ directory: 'C:\\work\\proj' });

    await fixture.created({ sessionID: 'ses_1', location: { directory: 'c:/work/proj/src/app/' } });

    expect(fixture.summary('ses_1').project.verification).toBe('matched');
  });

  it('rejects a sibling directory that only shares a prefix', async () => {
    const fixture = createScopeFixture();
    fixture.observer.setExpectedProject({ directory: 'C:\\work\\proj' });

    await fixture.created({ sessionID: 'ses_1', location: { directory: 'C:\\work\\project-x' } });

    expect(fixture.observer.getSummary('ses_1')).toBeUndefined();
    expect(fixture.observer.getSnapshot().sessionsOutOfScope).toBe(1);
  });

  it('reports runtime attribution as unverified when the instance declared no project', async () => {
    const fixture = createScopeFixture();

    await fixture.created({
      sessionID: 'ses_1',
      projectID: 'prj_a',
      location: { directory: 'C:\\work\\proj', workspaceID: 'ws_1' },
    });

    const summary = fixture.summary('ses_1');
    expect(summary.project).toEqual({
      basis: 'runtime-declared',
      verification: 'unverifiable',
      projectId: 'prj_a',
      workspaceId: 'ws_1',
      directoryHash: fnv1aHex('c:/work/proj'),
    });
    expect(summary.notes.some((note) => note.includes('not verified'))).toBe(true);
    // The directory is hashed, never persisted.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('C:\\work\\proj');
    expect(serialized).not.toContain('C:/work/proj');
  });

  it('reports an unavailable attribution when the runtime declared no facts (V1 shape)', async () => {
    const fixture = createScopeFixture();

    await fixture.v1Created('ses_v1');

    expect(fixture.summary('ses_v1').project).toEqual({
      basis: 'unavailable',
      verification: 'unverifiable',
      projectId: undefined,
      workspaceId: undefined,
      directoryHash: undefined,
    });
  });

  it('drops a retained session when the instance project is declared late and differs', async () => {
    const fixture = createScopeFixture();

    await fixture.created({
      sessionID: 'ses_1',
      projectID: 'prj_b',
      location: { directory: 'C:\\work\\b' },
    });
    // No instance project yet: recorded, and explicitly not attributed.
    expect(fixture.summary('ses_1').project.verification).toBe('unverifiable');

    fixture.observer.setExpectedProject({ projectId: 'prj_a' });

    expect(fixture.observer.getSummary('ses_1')).toBeUndefined();
    expect(fixture.observer.getSnapshot().sessionsOutOfScope).toBe(1);
  });

  it('upgrades a retained session to matched when the instance project is declared late and agrees', async () => {
    const fixture = createScopeFixture();

    await fixture.created({
      sessionID: 'ses_1',
      projectID: 'prj_b',
      location: { directory: 'C:\\work\\b' },
    });
    fixture.observer.setExpectedProject({ projectId: 'prj_b' });

    expect(fixture.summary('ses_1').project.verification).toBe('matched');
    expect(fixture.observer.getSnapshot().sessionsOutOfScope).toBe(0);
  });

  it('never uses a project id as a session key', async () => {
    const fixture = createScopeFixture();

    // The first session's *project id* is the second session's *session id*.
    await fixture.created({
      sessionID: 'ses_a',
      projectID: 'ses_b',
      location: { directory: 'C:\\work\\a' },
    });
    fixture.tool('ses_a', 'call_a');
    await fixture.created({
      sessionID: 'ses_b',
      projectID: 'prj_other',
      location: { directory: 'C:\\work\\b' },
    });

    const a = fixture.summary('ses_a');
    const b = fixture.summary('ses_b');
    expect(a.sessionId).toBe('ses_a');
    expect(a.counts.toolStartsObserved).toBe(1);
    expect(a.project.projectId).toBe('ses_b');
    expect(b.sessionId).toBe('ses_b');
    expect(b.counts.toolStartsObserved).toBe(0);
    expect(b.project.projectId).toBe('prj_other');
  });

  it('does not disturb other sessions when one is refused', async () => {
    const fixture = createScopeFixture();
    fixture.observer.setExpectedProject({ projectId: 'prj_a' });

    await fixture.created({
      sessionID: 'ses_ok',
      projectID: 'prj_a',
      location: { directory: 'C:\\work\\a' },
    });
    await fixture.created({
      sessionID: 'ses_bad',
      projectID: 'prj_b',
      location: { directory: 'C:\\work\\b' },
    });
    fixture.tool('ses_ok', 'c1');
    fixture.tool('ses_bad', 'c2');

    expect(fixture.summary('ses_ok').counts.toolStartsObserved).toBe(1);
    expect(fixture.observer.getSummary('ses_bad')).toBeUndefined();
    expect(fixture.observer.getSnapshot().sessionsOutOfScope).toBe(1);
    expect(fixture.observer.getSnapshot().sessionCount).toBe(1);
  });

  it('drops late tool and usage events for a deleted session without recreating it', async () => {
    const fixture = createScopeFixture();

    await fixture.created({ sessionID: 'ses_1' });
    fixture.tool('ses_1', 'c1');
    await fixture.deleted('ses_1');
    expect(fixture.observer.getSessionIds()).toEqual([]);

    fixture.tool('ses_1', 'c2');
    await fixture.deliver('session.usage.updated', {
      data: { sessionID: 'ses_1', cost: 0, tokens: { input: 5 } },
    });

    expect(fixture.observer.getSessionIds()).toEqual([]);
    expect(fixture.observer.getSummary('ses_1')).toBeUndefined();
    expect(fixture.observer.getSnapshot().lateEventsIgnored).toBe(2);
    expect(fixture.diagnostics.map((diagnostic) => diagnostic.code)).toContain('session-closed');
  });
});

describe('readExpectedProject', () => {
  it('reads the verified Location.Info shape, preferring the project id', () => {
    expect(
      readExpectedProject({
        directory: 'C:\\work\\location',
        project: { id: 'prj_a', directory: 'C:\\work\\proj', canonical: 'C:\\work\\canonical' },
      }),
    ).toEqual({ projectId: 'prj_a', directory: 'C:\\work\\proj' });
  });

  it('falls back to canonical, then to the location directory', () => {
    expect(readExpectedProject({ project: { canonical: 'C:\\work\\canonical' }, directory: 'C:\\d' })).toEqual(
      { directory: 'C:\\work\\canonical' },
    );
    expect(readExpectedProject({ directory: 'C:\\work\\location' })).toEqual({
      directory: 'C:\\work\\location',
    });
  });

  it('returns nothing usable instead of guessing a project', () => {
    expect(readExpectedProject(undefined)).toBeUndefined();
    expect(readExpectedProject(null)).toBeUndefined();
    expect(readExpectedProject('C:\\work\\proj')).toBeUndefined();
    expect(readExpectedProject({})).toBeUndefined();
    expect(readExpectedProject({ directory: '   ' })).toBeUndefined();
    expect(readExpectedProject({ project: { id: 42 } })).toBeUndefined();
  });
});
