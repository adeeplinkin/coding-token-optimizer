/**
 * Filesystem containment for a harness-run OpenCode session (Stage 1V).
 *
 * ## What this is for
 *
 * A coding session is asked to work inside a disposable repository copy. Nothing in
 * the runtime guarantees its tools stay there: the file tools take paths, and the
 * shell tool can write anywhere the process can. The harness therefore cannot treat
 * containment as a property of the environment — it has to be *enforced* and then
 * *evidenced*, per session.
 *
 * ## Two layers, and why both
 *
 * 1. **The native permission policy** (written by the harness as project
 *    configuration, not by this module). The runtime enforces it itself, and
 *    `--auto` only auto-approves permissions that are **not explicitly denied**, so
 *    an explicit `deny` survives `--auto`. That layer is the host's own enforcement.
 * 2. **This guard.** A plugin sees every `execute.before` call and refuses the calls
 *    that no path check can make safe — the shell (an arbitrary command has no
 *    argument that can be trusted), the subagent tool (a nested agent), the fetcher,
 *    patch application — and any file tool whose declared path resolves outside the
 *    workspace. The refusal is a **thrown error**: the host awaits this hook inside
 *    its tool pipeline, so a throw stops the call before it runs.
 *
 * The guard is *fail-closed*: a call that cannot be classified is refused, not
 * allowed, and a host that exposes no tool-hook capability is recorded as missing
 * rather than silently unguarded. It never reads file content, never records a path
 * or an argument value, and emits nothing except content-free evidence lines (tool
 * names, reasons, counts) — through a caller-supplied sink, because this package
 * touches the filesystem only in its opt-in summary sink.
 *
 * ## What it can and cannot promise
 *
 * Everything the *coding agent* can do flows through its tools, and every mutation
 * channel among them is either denied outright or path-checked here. What this
 * module cannot promise is that the runtime itself, or a process it spawns outside
 * the tool pipeline, stays inside the workspace; that needs an OS-level sandbox and
 * is explicitly out of scope for this layer.
 */
import { asRuntimeEvent, readExpectedProject } from './plugin-v2.js';
import { defineOpenCodeV2Plugin } from './types-v2.js';
import type {
  OpenCodeV2Plugin,
  OpenCodeV2PluginContext,
  OpenCodeV2ToolExecuteBeforeEvent,
} from './types-v2.js';

/** Plugin id used in `Plugin.define({ id, setup })`. */
export const CONTAINMENT_GUARD_PLUGIN_ID = 'dr-token-containment-guard';

/**
 * Tool names a contained session may never call, lower-cased.
 *
 * - `shell`/`bash` — an arbitrary command; no argument shape can make it safe.
 * - `task`/`subagent` — a nested agent would run with its own loop; the guard does
 *   not assume the outer policy reaches it.
 * - `webfetch` — a read channel that can carry a `file://` target and move data out.
 * - `patch`/`apply_patch` — a diff whose targets are inside text the guard does not
 *   parse; refusing is the only safe classification.
 */
export const CONTAINMENT_DENIED_TOOLS: readonly string[] = [
  'shell',
  'bash',
  'task',
  'subagent',
  'webfetch',
  'patch',
  'apply_patch',
  'apply-patch',
];

/**
 * Argument keys whose value names a filesystem target, lower-cased.
 *
 * The set is deliberately broad: a tool that renames `filePath` to `path` or `file`
 * is still checked, and a call carrying one of these keys with a value this module
 * cannot read is refused rather than assumed harmless.
 */
export const CONTAINMENT_PATH_ARGUMENT_KEYS: readonly string[] = [
  'path',
  'paths',
  'file',
  'files',
  'filepath',
  'filepaths',
  'dir',
  'dirs',
  'directory',
  'directories',
  'cwd',
];

/**
 * Argument keys that indicate a shell-like command under any name, lower-cased.
 *
 * A tool not named `shell` that carries a raw command is a shell by another name,
 * and is refused.
 */
export const CONTAINMENT_COMMAND_ARGUMENT_KEYS: readonly string[] = [
  'command',
  'cmd',
  'script',
  'shell',
];

/** Why a tool call was refused. Every reason is content-free. */
export type ContainmentBlockReason =
  | 'denied-tool'
  | 'shell-like-arguments'
  | 'unknown-workspace'
  | 'path-outside-workspace'
  | 'unusable-path-argument'
  | 'classifier-error';

/** Outcome of classifying one tool call. */
export interface ContainmentClassification {
  readonly decision: 'allow' | 'block';
  /** Present only when the decision is `block`. */
  readonly reason: ContainmentBlockReason | undefined;
  /** The tool name as the host declared it, lower-cased for the decision. */
  readonly tool: string;
  /** True when at least one argument was recognized as a path to check. */
  readonly hadPathArguments: boolean;
}

/** Where a declared path resolves, relative to the workspace. */
export type ContainmentPathVerdict = 'inside' | 'outside' | 'unusable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize separators only; the path is never touched by the filesystem. */
function unifySeparators(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

/**
 * Fold case on Windows only, where path comparison is case-insensitive.
 *
 * The harness currently runs on Windows; keeping the fold conditional means a
 * POSIX run (where `A` and `a` are different files) is not silently weakened.
 */
function foldCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Resolve `.` and `..` segments without a filesystem.
 *
 * Returns `undefined` when the path climbs above its own root, which is always
 * treated as unusable: the guard must not guess where such a path lands.
 */
function normalizeAbsolute(value: string): string | undefined {
  const segments = value.split('/');
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (result.length === 0) {
        return undefined;
      }
      result.pop();
      continue;
    }
    result.push(segment);
  }
  return result.join('/');
}

/** True when the text contains a glob metacharacter. */
function hasGlobChars(value: string): boolean {
  return /[*?[\]]/.test(value);
}

/**
 * Whether a declared path resolves inside the workspace.
 *
 * Pure by construction: it normalizes text and compares prefixes, and never asks
 * the filesystem anything (a path that does not exist is still classified, because
 * the call would create it).
 *
 * `unusable` covers everything the guard refuses to reason about: `~` expansion,
 * UNC and device paths, drive-relative paths (`C:foo`), empty values, values that
 * climb above their root, and values that are not strings where a path was declared.
 */
export function classifyContainedPath(
  candidate: string,
  workspaceRoot: string,
): ContainmentPathVerdict {
  const raw = unifySeparators(candidate);
  if (raw.length === 0) {
    return 'unusable';
  }
  // `~`, UNC (`//server/share`) and device (`//?/`) prefixes resolve somewhere this
  // module cannot compute; refusing is the only safe classification.
  if (raw.startsWith('~') || raw.startsWith('//')) {
    return 'unusable';
  }
  if (raw.startsWith('/') && process.platform === 'win32') {
    // A leading `/` on Windows is drive-relative (current drive root), which is
    // per-process state this module must not guess at.
    return 'unusable';
  }

  let target = raw;
  if (hasGlobChars(target)) {
    const firstGlob = target.search(/[*?[\]]/);
    target = target.slice(0, firstGlob).replace(/\/+$/, '');
    if (target.length === 0) {
      // A pattern rooted at the workspace (e.g. `**/*.ts`) can only widen inside it.
      return 'inside';
    }
  }

  const root = normalizeAbsolute(unifySeparators(workspaceRoot));
  if (root === undefined) {
    return 'unusable';
  }

  let resolved: string | undefined;
  if (/^[A-Za-z]:[^/]/.test(target)) {
    // Drive-relative (`C:foo`): its base is per-drive state, not the workspace.
    return 'unusable';
  }
  if (/^[A-Za-z]:\//.test(target) || (target.startsWith('/') && process.platform !== 'win32')) {
    resolved = normalizeAbsolute(target);
  } else {
    resolved = normalizeAbsolute(`${root}/${target}`);
  }
  if (resolved === undefined) {
    return 'outside';
  }

  const foldedRoot = foldCase(root);
  const foldedTarget = foldCase(resolved);
  if (foldedTarget === foldedRoot || foldedTarget.startsWith(`${foldedRoot}/`)) {
    return 'inside';
  }
  return 'outside';
}

/**
 * Classify one tool call against the workspace.
 *
 * Order matters: a denied tool is refused whatever its arguments look like; a
 * shell-like argument is refused before any path check, because a command string is
 * not a path; then every declared path is checked. A call with no recognized path
 * argument is allowed — the runtime's own tool set is small, and the mutation
 * channels among it are the denied tools above plus the path-taking file tools this
 * branch checks.
 *
 * `workspaceRoot === undefined` means the host never declared a project directory:
 * then nothing can be checked, and everything that declares a path or a command is
 * refused (fail-closed) instead of being assumed inside.
 */
export function classifyToolCall(call: {
  readonly tool: unknown;
  readonly args: unknown;
  readonly workspaceRoot: string | undefined;
}): ContainmentClassification {
  const tool = String(call.tool ?? '').trim().toLowerCase();
  try {
    if (CONTAINMENT_DENIED_TOOLS.includes(tool)) {
      return { decision: 'block', reason: 'denied-tool', tool, hadPathArguments: false };
    }
    if (!isRecord(call.args)) {
      return { decision: 'allow', reason: undefined, tool, hadPathArguments: false };
    }
    const keys = Object.keys(call.args).map((key) => key.toLowerCase());
    if (keys.some((key) => CONTAINMENT_COMMAND_ARGUMENT_KEYS.includes(key))) {
      return { decision: 'block', reason: 'shell-like-arguments', tool, hadPathArguments: false };
    }

    let hadPathArguments = false;
    for (const [key, value] of Object.entries(call.args)) {
      if (!CONTAINMENT_PATH_ARGUMENT_KEYS.includes(key.toLowerCase())) {
        continue;
      }
      hadPathArguments = true;
      const candidates = Array.isArray(value) ? value : [value];
      if (candidates.length === 0) {
        return { decision: 'block', reason: 'unusable-path-argument', tool, hadPathArguments };
      }
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
          return { decision: 'block', reason: 'unusable-path-argument', tool, hadPathArguments };
        }
        if (call.workspaceRoot === undefined) {
          return { decision: 'block', reason: 'unknown-workspace', tool, hadPathArguments };
        }
        const verdict = classifyContainedPath(candidate, call.workspaceRoot);
        if (verdict !== 'inside') {
          return {
            decision: 'block',
            reason: verdict === 'outside' ? 'path-outside-workspace' : 'unusable-path-argument',
            tool,
            hadPathArguments,
          };
        }
      }
    }
    return { decision: 'allow', reason: undefined, tool, hadPathArguments };
  } catch {
    // A classifier failure must never become an open door.
    return { decision: 'block', reason: 'classifier-error', tool, hadPathArguments: false };
  }
}

/** One content-free evidence line the guard writes. */
export interface ContainmentEvidenceLine {
  readonly kind:
    | 'loaded'
    | 'hook-registered'
    | 'capability-missing'
    | 'blocked'
    | 'allowed'
    | 'permissions';
  readonly at?: string;
  readonly tool?: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly rootKnown?: boolean;
  readonly checkedPathArguments?: number;
  readonly rules?: readonly {
    readonly action: string;
    readonly effect: string;
    readonly resource: 'workspace' | 'other' | 'any' | 'unclassified';
  }[];
}

/** Counters the guard's evidence reduces to. */
export interface ContainmentEvidenceSummary {
  /** True when the guard loaded and registered its tool hook. */
  readonly guardLoaded: boolean;
  /** False when the host never declared a project directory. */
  readonly rootKnown: boolean;
  readonly blockedCalls: number;
  readonly allowedCalls: number;
  /** Blocked calls by tool name; never a path or an argument value. */
  readonly blockedByTool: Readonly<Record<string, number>>;
  /** Permission rules the session itself declared, if the event carried them. */
  readonly permissionRules:
    | readonly {
        readonly action: string;
        readonly effect: string;
        readonly resource: string;
      }[]
    | undefined;
  /** True when the guard reported a capability it could not register. */
  readonly capabilityMissing: boolean;
}

/**
 * Reduce raw evidence lines to the counters a harness reports.
 *
 * Pure and lenient: it reads only declared fields, counts only whole numbers, and
 * never guesses at a line it cannot parse.
 */
export function summarizeContainmentEvidence(
  lines: readonly unknown[],
): ContainmentEvidenceSummary {
  let hookRegistered = false;
  let loaded = false;
  let rootKnown = false;
  let blockedCalls = 0;
  let allowedCalls = 0;
  let capabilityMissing = false;
  let permissionRules: ContainmentEvidenceSummary['permissionRules'];
  const blockedByTool: Record<string, number> = {};

  for (const line of lines) {
    if (!isRecord(line)) {
      continue;
    }
    const kind = line['kind'];
    if (kind === 'loaded') {
      loaded = true;
      rootKnown = line['rootKnown'] === true;
    } else if (kind === 'hook-registered') {
      hookRegistered = true;
    } else if (kind === 'capability-missing') {
      capabilityMissing = true;
    } else if (kind === 'blocked') {
      blockedCalls += 1;
      const tool = typeof line['tool'] === 'string' && line['tool'].length > 0 ? line['tool'] : 'unknown';
      blockedByTool[tool] = (blockedByTool[tool] ?? 0) + 1;
    } else if (kind === 'allowed') {
      allowedCalls += 1;
    } else if (kind === 'permissions' && permissionRules === undefined && Array.isArray(line['rules'])) {
      permissionRules = line['rules'].flatMap((rule) =>
        isRecord(rule) && typeof rule['action'] === 'string' && typeof rule['effect'] === 'string'
          ? [
              {
                action: rule['action'],
                effect: rule['effect'],
                resource: typeof rule['resource'] === 'string' ? rule['resource'] : 'unclassified',
              },
            ]
          : [],
      );
    }
  }

  return {
    guardLoaded: loaded && hookRegistered,
    rootKnown,
    blockedCalls,
    allowedCalls,
    blockedByTool,
    permissionRules,
    capabilityMissing,
  };
}

/** Options for {@link createContainmentGuardPluginV2}. */
export interface ContainmentGuardOptions {
  /**
   * Receives each evidence line.
   *
   * The sink is the caller's, not this package's: the generated project-local plugin
   * file (written by the arm driver, outside this package) appends the lines to its
   * own JSONL file, so the observation package keeps its rule that only its opt-in
   * summary sink touches the filesystem. It is passed explicitly rather than derived
   * from the environment because a session on the background service does not inherit
   * the harness's environment — an option is the only channel that reaches the plugin
   * in both runtime modes.
   */
  readonly onEvidence?: (line: ContainmentEvidenceLine) => void;
  /** Test seam: clock for the `at` field. */
  readonly now?: () => string;
}

/**
 * Create the guard plugin definition.
 *
 * The guard is deliberately not part of the observer: the observer's contract is
 * "never changes agent behaviour", and this plugin's whole purpose is to change it
 * for calls that leave the workspace. Keeping them separate keeps both contracts
 * checkable.
 */
export function createContainmentGuardPluginV2(
  options: ContainmentGuardOptions = {},
): OpenCodeV2Plugin {
  return defineOpenCodeV2Plugin({
    id: CONTAINMENT_GUARD_PLUGIN_ID,
    setup(context: OpenCodeV2PluginContext) {
      const controller = new AbortController();
      const now = options.now ?? (() => new Date().toISOString());

      const emit = (line: ContainmentEvidenceLine): void => {
        try {
          options.onEvidence?.(line);
        } catch {
          // Evidence is best effort; a sink failure must never disturb the session.
        }
      };

      let root: string | undefined;
      try {
        root = readExpectedProject(context?.location)?.directory;
      } catch {
        root = undefined;
      }
      emit({ kind: 'loaded', at: now(), rootKnown: root !== undefined });

      // The tool hook is the enforcement point. A host that cannot register it is
      // recorded as missing; the harness refuses to treat such a session as a valid
      // measurement rather than pretending the guard was active.
      const tool = context?.tool;
      if (typeof tool?.hook !== 'function') {
        emit({ kind: 'capability-missing', at: now(), detail: 'tool.hook' });
      } else {
        void tool
          .hook('execute.before', (event: OpenCodeV2ToolExecuteBeforeEvent) => {
            const classification = classifyToolCall({
              tool: event?.tool,
              args: event?.input,
              workspaceRoot: root,
            });
            if (classification.decision === 'block') {
              emit({
                kind: 'blocked',
                at: now(),
                tool: classification.tool,
                reason: classification.reason ?? 'unknown',
                checkedPathArguments: classification.hadPathArguments ? 1 : 0,
              });
              throw new Error(
                `dr-token containment: the ${classification.tool} tool call was refused (${classification.reason ?? 'policy'}) because it is not provably inside the session workspace.`,
              );
            }
            emit({
              kind: 'allowed',
              at: now(),
              tool: classification.tool,
              checkedPathArguments: classification.hadPathArguments ? 1 : 0,
            });
          })
          .then(() => {
            emit({ kind: 'hook-registered', at: now() });
          })
          .catch(() => {
            emit({ kind: 'capability-missing', at: now(), detail: 'tool.hook registration' });
          });
      }

      // The session's own `session.created` event carries the permission rules the
      // runtime resolved for it. Recording their actions and effects (never their
      // full resource text, only whether a resource points inside the workspace)
      // lets the harness report which layer was actually in force.
      const eventDomain = context?.event;
      if (typeof eventDomain?.subscribe === 'function') {
        try {
          const stream = eventDomain.subscribe({ signal: controller.signal });
          void (async () => {
            try {
              for await (const raw of stream) {
                try {
                  const event = asRuntimeEvent(raw);
                  if (event.type !== 'session.created') {
                    continue;
                  }
                  const data = isRecord(event.data) ? event.data : isRecord(event.properties) ? event.properties : undefined;
                  const permissions = data !== undefined && Array.isArray(data['permissions']) ? data['permissions'] : undefined;
                  if (permissions === undefined) {
                    continue;
                  }
                  const rules = permissions.flatMap((rule) => {
                    if (!isRecord(rule) || typeof rule['action'] !== 'string' || typeof rule['effect'] !== 'string') {
                      return [];
                    }
                    const resource = typeof rule['resource'] === 'string' ? rule['resource'] : undefined;
                    let resourceClass: 'workspace' | 'other' | 'any' | 'unclassified';
                    if (resource === undefined) {
                      resourceClass = 'unclassified';
                    } else if (resource === '*') {
                      resourceClass = 'any';
                    } else if (root === undefined) {
                      resourceClass = 'unclassified';
                    } else {
                      resourceClass = classifyContainedPath(resource, root) === 'inside' ? 'workspace' : 'other';
                    }
                    return [{ action: rule['action'], effect: rule['effect'], resource: resourceClass }];
                  });
                  if (rules.length > 0) {
                    emit({ kind: 'permissions', at: now(), rules });
                  }
                } catch {
                  // One malformed event must not end the subscription.
                }
              }
            } catch {
              // An aborted or failed subscription is the documented end of the stream.
            }
          })();
        } catch {
          emit({ kind: 'capability-missing', at: now(), detail: 'event.subscribe' });
        }
      } else {
        emit({ kind: 'capability-missing', at: now(), detail: 'event.subscribe' });
      }

      return () => {
        try {
          controller.abort();
        } catch {
          // Best effort, exactly like the observer's cleanup.
        }
      };
    },
  });
}
