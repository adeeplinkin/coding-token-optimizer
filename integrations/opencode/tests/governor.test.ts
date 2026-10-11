import { describe, expect, it } from 'vitest';
import {
  MAX_INTERRUPT_ATTEMPTS,
  decideCostGovernor,
  latestSessionCostUsd,
  missingGovernorHelpers,
  planGovernorArming,
  startCostGovernor,
} from '../src/index.js';

/**
 * Whether the governor arms **before** a session starts.
 *
 * Stage 1V's canary armed the governor and then crashed inside the start call, because the
 * driver imported the built module and its pick list omitted `startCostGovernor`. The
 * session never started, the spending cap was never enforced, and the run was still
 * reported. These tests pin the decision that has to happen before a live process exists:
 * a capped live session that cannot arm must be refused, not run and recorded.
 */
describe('arming the in-session governor before a session starts', () => {
  const allHelpers = { decide: true, latest: true, start: true };
  const missingStart = { decide: true, latest: true, start: false };

  it('requires arming for a live, capped, service session', () => {
    const plan = planGovernorArming({ mode: 'live', runtime: 'service', capUsd: 0.5, helpers: allHelpers });
    expect(plan.required).toBe(true);
    expect(plan.armed).toBe(true);
    expect(plan.reason).toBeUndefined();
  });

  it('refuses to arm when the loop helper is missing, and names it', () => {
    const plan = planGovernorArming({ mode: 'live', runtime: 'service', capUsd: 0.5, helpers: missingStart });
    // `required` is the fatal part: the driver aborts the run instead of continuing with a
    // spending cap nothing enforces.
    expect(plan.required).toBe(true);
    expect(plan.armed).toBe(false);
    expect(plan.reason).toContain('startCostGovernor');
    expect(missingGovernorHelpers(missingStart)).toEqual(['startCostGovernor']);
  });

  it('names every missing helper, not just the first', () => {
    expect(missingGovernorHelpers({ decide: false, latest: false, start: false })).toEqual([
      'decideCostGovernor',
      'latestSessionCostUsd',
      'startCostGovernor',
    ]);
  });

  it('does not claim an in-session bound for a live session without a cap', () => {
    const plan = planGovernorArming({ mode: 'live', runtime: 'service', capUsd: undefined, helpers: allHelpers });
    expect(plan.required).toBe(false);
    expect(plan.armed).toBe(false);
    expect(plan.reason).toContain('no per-session spending cap');
  });

  it('does not claim an in-session bound on the private server', () => {
    const plan = planGovernorArming({ mode: 'live', runtime: 'standalone', capUsd: 0.5, helpers: allHelpers });
    expect(plan.required).toBe(false);
    expect(plan.armed).toBe(false);
    expect(plan.reason).toContain('background service');
  });

  it('arms the same initialisation path in a rehearsal, at no cost', () => {
    // A rehearsal bills nothing, but it must run the code a live run runs: that is what
    // would have caught the missing helper offline instead of on a paid canary.
    const plan = planGovernorArming({ mode: 'rehearse', runtime: 'standalone', capUsd: undefined, helpers: allHelpers });
    expect(plan.required).toBe(false);
    expect(plan.armed).toBe(true);
    expect(plan.reason).toBeUndefined();
  });

  it('reports an unarmed rehearsal with the missing helpers named', () => {
    const plan = planGovernorArming({ mode: 'rehearse', runtime: 'standalone', capUsd: undefined, helpers: missingStart });
    expect(plan.armed).toBe(false);
    expect(plan.reason).toContain('startCostGovernor');
  });

  it('starts no session in preflight mode', () => {
    const plan = planGovernorArming({ mode: 'preflight', runtime: 'service', capUsd: 0.5, helpers: allHelpers });
    expect(plan.required).toBe(false);
    expect(plan.armed).toBe(false);
    expect(plan.reason).toContain('preflight');
  });
});

/**
 * The in-session cost governor's decision logic.
 *
 * These tests pin the two behaviours the safety story depends on: the governor only
 * interrupts on a **reported** cost that has actually crossed the cap (an unreported
 * cost is not a zero), and a failing interrupt escalates to giving up rather than
 * retrying forever. What the driver does with each action — calling the runtime's
 * `session.interrupt`, then killing the client process on `give-up` — is exercised by
 * the offline rehearsal and, for the interrupt itself, by the native-endpoint probe.
 */

describe('the cost-governor decision', () => {
  const cap = 0.5;

  it('waits while the reported cost is missing or under the cap', () => {
    expect(decideCostGovernor({ capUsd: cap, costUsd: undefined, interrupted: false, failedAttempts: 0 })).toBe('wait');
    expect(decideCostGovernor({ capUsd: cap, costUsd: 0, interrupted: false, failedAttempts: 0 })).toBe('wait');
    expect(decideCostGovernor({ capUsd: cap, costUsd: 0.4999, interrupted: false, failedAttempts: 0 })).toBe('wait');
    expect(decideCostGovernor({ capUsd: cap, costUsd: Number.NaN, interrupted: false, failedAttempts: 0 })).toBe('wait');
  });

  it('interrupts at or above the cap, and not again once the runtime confirmed it', () => {
    expect(decideCostGovernor({ capUsd: cap, costUsd: 0.5, interrupted: false, failedAttempts: 0 })).toBe('interrupt');
    expect(decideCostGovernor({ capUsd: cap, costUsd: 0.87, interrupted: false, failedAttempts: 0 })).toBe('interrupt');
    expect(decideCostGovernor({ capUsd: cap, costUsd: 0.87, interrupted: true, failedAttempts: 0 })).toBe('wait');
  });

  it('gives up after a bounded number of failed interrupt attempts', () => {
    const attempts = Array.from({ length: MAX_INTERRUPT_ATTEMPTS }, (_unused, index) =>
      decideCostGovernor({ capUsd: cap, costUsd: 0.9, interrupted: false, failedAttempts: index }),
    );
    expect(attempts).toEqual(Array.from({ length: MAX_INTERRUPT_ATTEMPTS }, () => 'interrupt'));
    expect(
      decideCostGovernor({ capUsd: cap, costUsd: 0.9, interrupted: false, failedAttempts: MAX_INTERRUPT_ATTEMPTS }),
    ).toBe('give-up');
  });
});

describe('the cost-governor loop', () => {
  /** Wait for a condition, instead of sleeping and hoping the poll landed. */
  const until = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  it('interrupts once the reported cost crosses the cap, then stops', async () => {
    let cost = 0.1;
    let interrupts = 0;
    const governor = startCostGovernor({
      capUsd: 0.5,
      intervalMs: 5,
      readCostUsd: () => cost,
      interrupt: () => {
        interrupts += 1;
        return true;
      },
      abandon: () => {
        throw new Error('must not be called');
      },
    });
    await until(() => governor.state().polls >= 2);
    expect(interrupts).toBe(0);
    expect(governor.state().interrupted).toBe(false);

    cost = 0.51;
    await until(() => governor.state().interrupted);
    expect(interrupts).toBe(1);
    const state = governor.state();
    expect(state.interrupted).toBe(true);
    expect(state.stopped).toBe(true);
    expect(state.reportedCostUsd).toBe(0.51);
    expect(state.polls).toBeGreaterThan(1);
    governor.stop();
  });

  it('abandons the client after repeated interrupts fail, and records it', async () => {
    let abandons = 0;
    const governor = startCostGovernor({
      capUsd: 0.5,
      intervalMs: 5,
      readCostUsd: () => 0.9,
      interrupt: () => false,
      abandon: () => {
        abandons += 1;
      },
    });
    await until(() => abandons > 0);
    const state = governor.state();
    expect(abandons).toBe(1);
    expect(state.killedAfterFailedInterrupt).toBe(true);
    expect(state.interruptAttempts).toBe(MAX_INTERRUPT_ATTEMPTS);
    expect(state.interrupted).toBe(false);
    expect(state.stopped).toBe(true);
    governor.stop();
  });

  it('never interrupts on an unreported cost, and survives a failing read', async () => {
    let interrupts = 0;
    const governor = startCostGovernor({
      capUsd: 0.5,
      intervalMs: 5,
      readCostUsd: () => {
        throw new Error('no summary yet');
      },
      interrupt: () => {
        interrupts += 1;
        return true;
      },
      abandon: () => {},
    });
    await until(() => governor.state().polls >= 3);
    expect(interrupts).toBe(0);
    expect(governor.state().stopped).toBe(false);
    governor.stop();
    // Stopping twice is not an error.
    governor.stop();
  });
});

describe('reading the session cost from observer summaries', () => {
  const line = (sessionId: string, cost: number): Record<string, unknown> => ({
    sessionId,
    usage: { sourceReported: { usableEvents: 2, latest: { cost } } },
  });

  it('takes the last cumulative value for the requested session', () => {
    const lines = [line('ses_a', 0.01), line('ses_a', 0.02), line('ses_b', 0.5), line('ses_a', 0.03)];
    expect(latestSessionCostUsd(lines, 'ses_a')).toBe(0.03);
    expect(latestSessionCostUsd(lines, 'ses_b')).toBe(0.5);
  });

  it('returns undefined when the session never reported a cost', () => {
    expect(latestSessionCostUsd([], 'ses_a')).toBeUndefined();
    expect(latestSessionCostUsd([{ sessionId: 'ses_a' }], 'ses_a')).toBeUndefined();
    expect(latestSessionCostUsd([line('ses_b', 0.5)], 'ses_a')).toBeUndefined();
  });

  it('falls back to the observer aggregate only when it carries an evidence label', () => {
    const calculated = {
      sessionId: 'ses_a',
      measurements: { cost: { evidence: 'calculated', value: 0.04 } },
    };
    const unavailable = {
      sessionId: 'ses_a',
      measurements: { cost: { evidence: 'unavailable', value: 99 } },
    };
    expect(latestSessionCostUsd([calculated], 'ses_a')).toBe(0.04);
    expect(latestSessionCostUsd([unavailable], 'ses_a')).toBeUndefined();
  });

  it('does not let a malformed line erase a reported value', () => {
    const lines = [line('ses_a', 0.02), { sessionId: 'ses_a', usage: { sourceReported: { latest: { cost: 'free' } } } }];
    expect(latestSessionCostUsd(lines, 'ses_a')).toBe(0.02);
  });
});
