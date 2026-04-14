// advanced-agent-loop/src/guards.js
// Stall detection, loop guards, and action block builders.
// Extracted from loop.js for isolated testing and reduced blast radius.

import fs from 'node:fs';
import path from 'node:path';
import { getFileFreshnessStatus } from './state.js';
import { inspectStageState } from './stages.js';

// ── Shared Utilities ─────────────────────────────────────────

export function normalizeCommandForComparison(command) {
  return String(command || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^mkdir\s+-p\s+result\s*&&\s*/i, '');
}

function argsAreSimilar(a, b, tool) {
  if (tool === 'edit_file') {
    return (a.path || '') === (b.path || '') && (a.oldString || '') === (b.oldString || '');
  }
  if (tool === 'search_files') {
    return (a.pattern || '') === (b.pattern || '');
  }
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

function actionSignature(action, args) {
  if (action === 'run_command') {
    const cmd = normalizeCommandForComparison(args?.command);
    return `${action}::${cmd}`;
  }
  return `${action}::${JSON.stringify(args ?? {})}`;
}

function normalizeResult(result) {
  const str = String(result || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (str.length > 300) {
    return str.slice(0, 150) + '...' + str.slice(-150);
  }
  return str;
}

// ── Primary Detectors ────────────────────────────────────────

export function detectLoopGuard(memory, parseErrorStreak, stageState = null) {
  if (parseErrorStreak >= 3) {
    return `Parse recovery mode: produce strict JSON only. Keep output minimal and action-focused until parsing stabilizes.`;
  }

  const baselineResetCount = countRecentBaselineEnvRuns(memory);
  if (baselineResetCount >= 2) {
    return `Phase reset detected: baseline environment command was repeated ${baselineResetCount} times recently. Do NOT restart Phase 1. Continue from the next incomplete phase and use a different action/tool now.`;
  }

  const noMatchSearchCount = countRecentSearchNoMatchRuns(memory);
  if (noMatchSearchCount >= 2) {
    return `Search stall detected: search_files returned no matches ${noMatchSearchCount} times in a row. Stop broad retries. Switch to read_file on the target file, extract exact identifiers, then run ONE file-scoped search_files call with path+filePattern.`;
  }

  const failedRetryStreak = countRecentIdenticalFailedRetries(memory);
  if (failedRetryStreak >= 2) {
    return `Retry stall detected: the same failing action was repeated ${failedRetryStreak} times. Do NOT retry unchanged. Read/search the target first, then change arguments before trying again.`;
  }

  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed'].includes(e.action));

  if (recent.length < 3) return '';

  const lastEntry = recent[recent.length - 1];
  const lastAction = lastEntry.action;
  let tailStreak = 1;
  for (let i = recent.length - 2; i >= 0; i--) {
    if (recent[i].action === lastAction) tailStreak++;
    else break;
  }

  // Tight check: same tool + same args for 3+ consecutive steps → immediate stall
  if (tailStreak >= 3) {
    const lastArgs = JSON.stringify(lastEntry.args || {});
    const sameArgsTail = recent.slice(-tailStreak).every(e => JSON.stringify(e.args || {}) === lastArgs);
    if (sameArgsTail) {
      return `Stall detected: \`${lastAction}\` called with identical arguments ${tailStreak} times in a row. STOP. Run the verification commands from the task specification (the python3/node commands under "Verification Commands") with run_command. If they all pass, call finish. If any fail, fix the reported error — do not keep repeating \`${lastAction}\`.`;
    }
  }

  if (tailStreak >= 5) {
    const tail = recent.slice(-tailStreak);
    const similar = tail.every((e) => argsAreSimilar(e.args || {}, lastEntry.args || {}, lastAction));
    if (similar) {
      return `Stall detected: repeated \`${lastAction}\` calls with similar arguments ${tailStreak} times. Re-ground on source state before another retry.`;
    }
  }

  const sameActionTail = recent.slice(-Math.min(6, recent.length));
  const allSameAction = sameActionTail.every(e => e.action === lastAction);
  const normalized = sameActionTail.map(e => normalizeResult(e.result));
  const sameResult = normalized.length >= 4 && normalized.every(r => r === normalized[0]);
  const sameArgsTail = sameActionTail.every(e => JSON.stringify(e.args || {}) === JSON.stringify(lastEntry.args || {}));
  const readOnlyTools = new Set(['read_file', 'list_dir', 'todoread']);

  if (readOnlyTools.has(lastAction) && allSameAction && sameResult && sameArgsTail && sameActionTail.length >= 4) {
    return `Stall detected: repeated read-only checks on the same target with unchanged output. You already know what files exist — stop listing/reading and START VERIFYING. Run the verification commands from the task specification (the python3/node commands under the "Verification" heading) with run_command. If any fail, fix the reported error. Do NOT call list_dir or read_file again.`;
  }

  if (tailStreak >= 6 || (allSameAction && sameResult)) {
    return `Stall detected: repeated \`${lastAction}\` calls with little change. STOP exploring — run the verification commands from the task specification now. Use run_command with the exact python3/node commands listed under "Verification Commands" in the task. If they pass, call finish. If they fail, fix the reported error.`;
  }

  const finalizationChurn = detectFinalizationReadChurn(memory, stageState);
  if (finalizationChurn) return finalizationChurn;

  // File-level write churn: same file written/edited many times even with different content
  const fileChurn = detectFileWriteChurn(memory);
  if (fileChurn) return fileChurn;

  return '';
}

/**
 * Detect when a single file is being rewritten or re-edited repeatedly.
 * Catches cases where the model keeps rewriting the same file with slightly
 * different content (e.g. exceptions.py written 4 times in 12 steps).
 */
function detectFileWriteChurn(memory) {
  const recent = memory.getRecent(16)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));

  // Count writes/edits per file path
  const fileCounts = {};
  for (const e of recent) {
    if (e.action !== 'write_file' && e.action !== 'edit_file') continue;
    const filePath = String(e.args?.path || '');
    if (!filePath || filePath.startsWith('.agent/')) continue;
    fileCounts[filePath] = (fileCounts[filePath] || 0) + 1;
  }

  // Find the worst offender
  let worstFile = '';
  let worstCount = 0;
  for (const [filePath, count] of Object.entries(fileCounts)) {
    if (count > worstCount) { worstFile = filePath; worstCount = count; }
  }

  if (worstCount >= 3) {
    const isTestFile = worstFile.includes('_smoke_test') || worstFile.includes('_test') || worstFile.includes('test_');
    if (isTestFile) {
      return `Write churn detected: \`${worstFile}\` has been written/edited ${worstCount} times. The test file is probably correct — the bug is in your SOURCE CODE. Run the test, read the error traceback carefully, then fix the SOURCE module that is failing (not the test file). Do NOT rewrite \`${worstFile}\` again.`;
    }
    return `Write churn detected: \`${worstFile}\` has been written/edited ${worstCount} times in recent steps. STOP rewriting files you already created. Move on to the NEXT unfinished file in your plan. If you are stuck on this file, run a verification command first to see the actual error, then make ONE targeted fix.`;
  }

  return '';
}

function detectFinalizationReadChurn(memory, stageState) {
  if (stageState?.currentStage !== 'finalization') return '';
  const recent = memory.getRecent(8)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  const tail = recent.slice(-6);
  if (tail.length < 5) return '';

  const readOnlyTools = new Set(['read_file', 'list_dir', 'search_files', 'glob', 'todoread']);
  const allResultReads = tail.every((e) => {
    if (!readOnlyTools.has(e.action)) return false;
    const p = String(e.args?.path || e.args?.filePattern || '');
    return p === 'result' || p === 'result/' || p.startsWith('result/');
  });
  if (!allResultReads) return '';

  return 'FINALIZATION CHURN: you are repeatedly checking result artifacts without changing them. In finalization, do not spend more steps re-reading the same outputs. Either repair the specific missing contract issue with write_file/edit_file, run one concrete validation command, or finish.';
}

export function detectIdenticalStreak(memory) {
  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));

  if (recent.length < 2) return 0;

  const last    = recent[recent.length - 1];
  const lastKey = actionSignature(last.action, last.args);
  let streak    = 0;

  for (let i = recent.length - 1; i >= 0; i--) {
    const key = actionSignature(recent[i].action, recent[i].args);
    if (key === lastKey) streak++;
    else break;
  }
  return streak;
}

// ── Counter Functions ────────────────────────────────────────

function countRecentBaselineEnvRuns(memory) {
  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.action !== 'run_command') break;
    const cmd = normalizeCommandForComparison(e.args?.command || '');
    if (isBaselineEnvCommand(cmd)) count++;
    else break;
  }
  return count;
}

function countRecentSearchNoMatchRuns(memory) {
  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.action !== 'search_files') break;
    if (isSearchNoMatchResult(e.result)) count++;
    else break;
  }
  return count;
}

function countRecentIdenticalFailedRetries(memory) {
  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));

  if (recent.length < 2) return 0;
  const last = recent[recent.length - 1];
  if (!last.error) return 0;

  const targetSig = actionSignature(last.action, last.args);
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (!e.error) break;
    if (actionSignature(e.action, e.args) !== targetSig) break;
    count++;
  }
  return count;
}

// ── Helper Validators ────────────────────────────────────────

function isSearchNoMatchResult(result) {
  const text = String(result || '').toLowerCase();
  return text.includes('no matches found') || text.includes('no_match:');
}

function isBaselineEnvCommand(command) {
  const cmd = String(command || '').toLowerCase();
  // Use OR logic: any combination of baseline env probes counts.
  // The old AND logic required ALL four, missing partial combos.
  const markers = ['node -v', 'npm -v', 'pwd', 'git rev-parse --short head'];
  const matchCount = markers.filter(m => cmd.includes(m)).length;
  return matchCount >= 2; // At least 2 baseline probes → likely an env reset
}

/**
 * Check whether proposed tool+args exactly matches the last non-meta action.
 * Used to avoid repeatedly freezing the same call across consecutive steps.
 */
export function isSameAsLastUserAction(memory, tool, args) {
  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  const last = recent[recent.length - 1];
  if (!last) return false;
  return actionSignature(last.action, last.args) === actionSignature(tool, args);
}

/**
 * Return the most recent non-meta action for user-facing stall summaries.
 */
export function getLastUserAction(memory) {
  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  return recent[recent.length - 1]?.action ?? 'unknown';
}

// ── Block Builders ───────────────────────────────────────────

export function buildRepeatedActionBlock(memory, action, stageState = null) {
  return buildStaleFileEditBlock(action)
    || buildBlockedFinishRetryBlock(memory, action)
    || buildStageMisalignedActionBlock(action, stageState)
    || buildExecutionDiscoveryBlock(action, stageState)
    || buildPlanProgressRereadBlock(memory, action, stageState)
    || buildRepeatedFailureRetryBlock(memory, action)
    || buildRepeatedObservationRetryBlock(memory, action)
    || buildFileEditChurnBlock(memory, action)
    || buildFinalizationReadChurnBlock(memory, action, stageState);
}

export function buildRepeatedFailureRetryBlock(memory, action) {
  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  if (recent.length < 1) return '';

  const last = recent[recent.length - 1];
  const sameAction = actionSignature(last.action, last.args) === actionSignature(action.tool, action.args);
  const diagnosticTools = new Set(['read_file', 'search_files', 'list_dir']);
  if (!(sameAction && last.error)) return '';

  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (actionSignature(e.action, e.args) === actionSignature(action.tool, action.args)) break;
    if (diagnosticTools.has(e.action)) return '';
  }

  return `RETRY_BLOCKED: repeated failed call \`${action.tool}\` with unchanged arguments. Run a diagnostic action first (read_file/search_files/list_dir), then retry with changed arguments.`;
}

export function buildRepeatedObservationRetryBlock(memory, action) {
  const readOnlyTools = new Set(['read_file', 'search_files', 'list_dir', 'glob', 'todoread']);
  if (!readOnlyTools.has(action.tool)) return '';

  const recent = memory.getRecent(12)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  if (recent.length < 2) return '';

  // Same-file read churn: count reads of the same file path regardless of startLine/endLine
  if (action.tool === 'read_file' && action.args?.path) {
    const targetPath = String(action.args.path);
    let sameFileReads = 0;
    for (const e of recent) {
      if (e.action === 'read_file' && String(e.args?.path || '') === targetPath) sameFileReads++;
    }
    if (sameFileReads >= 4) {
      return `RETRY_BLOCKED: \`${targetPath}\` has been read ${sameFileReads} times in recent steps with varying line ranges. You already know this file's content. STOP reading it. Use write_file to rewrite the entire file with your fix, or use a different tool (run_command to test, edit_file with exact content, or move on to another file).`;
    }
  }

  const last = recent[recent.length - 1];
  if (actionSignature(last.action, last.args) !== actionSignature(action.tool, action.args)) return '';
  if (last.error) return '';

  let streak = 0;
  let previousResult = normalizeResult(last.result);
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    if (actionSignature(entry.action, entry.args) !== actionSignature(action.tool, action.args)) break;
    if (entry.error) break;
    if (normalizeResult(entry.result) !== previousResult) break;
    streak++;
  }

  if (streak < 2) return '';

  const recentFailure = memory.getRecent(12)
    .filter((entry) => entry.action === 'run_command' && entry.error)
    .find((entry) => /Cannot read properties of undefined \(reading ['"][^'"]+['"]\)|TypeError:/i.test(String(entry.result || '')));

  if (action.tool === 'read_file' && recentFailure) {
    return `RETRY_BLOCKED: repeated rereads of the same file are not progressing the repair. A recent runtime failure already points to a local interface mismatch. Move from inspection to repair: update the current file or the paired producer/consumer file, then rerun the exact failing command once.`;
  }

  return `RETRY_BLOCKED: repeated identical read-only call \`${action.tool}\` with unchanged arguments and unchanged result. Change arguments or use a different tool (write_file/edit_file/run_command/update_plan/finish) before reading again.`;
}

/**
 * Detect file-level edit churn: the same file has been edited/read many times
 * without the overall task progressing (e.g. flip-flopping imports).
 * Triggers when a single file appears in 5+ of the last 12 edit_file/read_file
 * actions targeting the same path.
 */
function buildFileEditChurnBlock(memory, action) {
  if (!['edit_file', 'read_file', 'write_file'].includes(action.tool)) return '';
  const target = String(action.args?.path || '');
  if (!target || target.startsWith('.agent/')) return '';

  const recent = memory.getRecent(20)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));

  // Count how many times this file was touched (edit/read/write) in recent history
  let touchCount = 0;
  let editCount = 0;
  for (const e of recent) {
    const filePath = String(e.args?.path || '');
    if (filePath === target) {
      touchCount++;
      if (e.action === 'edit_file' || e.action === 'write_file') editCount++;
    }
  }

  // File edited 4+ times AND touched 6+ times total = churn
  if (editCount >= 4 && touchCount >= 6) {
    return `EDIT_CHURN_BLOCKED: file \`${target}\` has been edited ${editCount} times and touched ${touchCount} times in recent steps without resolving the issue. You are likely flip-flopping on the same change. STOP editing this file repeatedly. Instead: (1) run the failing verification command to see the EXACT current error, (2) read the file ONCE to see its current state, (3) decide on ONE correct fix and apply it, (4) if the error is in how the verification command runs (e.g. import style mismatch), fix the verification approach instead of the code.`;
  }

  return '';
}

function buildStaleFileEditBlock(action) {
  if (action.tool !== 'edit_file') return '';
  const target = String(action.args?.path || '');
  if (!target) return '';
  const freshness = getFileFreshnessStatus(target);
  if (!freshness.stale) return '';
  return `RETRY_BLOCKED: ${target} changed after the last trusted read. ${freshness.reason || 'Re-read the current on-disk file before editing.'}`;
}

function buildBlockedFinishRetryBlock(memory, action) {
  if (action.tool !== 'finish') return '';
  const recent = memory.getRecent(8);
  const tail = recent.slice(-4);
  const blocked = tail.filter(e => e.action === 'verification_failed' && e.subStep === 'finish_blocked');
  if (blocked.length < 2) return '';
  return 'RETRY_BLOCKED: finish was already blocked repeatedly. Do not call finish again until you satisfy the stated runtime blocker or advance the stage.';
}

function buildStageMisalignedActionBlock(action, stageState) {
  if (!stageState?.currentStage) return '';
  const pathLike = String(action.args?.path || action.args?.filePattern || '');
  const readOnly = new Set(['read_file', 'list_dir', 'search_files', 'glob']);

  // Allow reads that target locked targets (the project being built)
  const lockedRoots = (stageState.lockedTargets || []).filter(Boolean);
  // If no locked targets are known, we can't judge what's misaligned — allow all reads
  if (lockedRoots.length === 0 && readOnly.has(action.tool)) return '';
  const insideLockedRoot = lockedRoots.some((root) => {
    // Extract directory prefix: "snake_game/main.py" → "snake_game/"
    const dir = root.includes('/') ? root.split('/')[0] + '/' : root;
    return pathLike === dir.replace(/\/$/, '') || pathLike.startsWith(dir);
  });

  if (stageState.currentStage === 'verification' && readOnly.has(action.tool)) {
    if (!insideLockedRoot && (pathLike === '.' || pathLike === './' || pathLike === 'src' || pathLike.startsWith('src/'))) {
      return 'RETRY_BLOCKED: stage-misaligned action. Verification should use concrete validation evidence and targeted file checks, not broad repo rediscovery.';
    }
  }

  if (stageState.currentStage === 'finalization' && readOnly.has(action.tool)) {
    // Always allow reads of locked target paths (the project being built)
    if (insideLockedRoot) return '';
    if (pathLike && !pathLike.startsWith('result/') && pathLike !== 'result' && pathLike !== 'result/' && !pathLike.startsWith('.agent/')) {
      return 'RETRY_BLOCKED: stage-misaligned action. Finalization should repair or confirm final artifacts, not reopen unrelated workspace inspection.';
    }
  }

  return '';
}

function buildExecutionDiscoveryBlock(action, stageState) {
  if (stageState?.currentStage !== 'execution') return '';
  const lockedRoots = (stageState.lockedTargets || []).filter(Boolean);
  if (lockedRoots.length === 0) return '';
  const target = String(
    action.args?.path
    || action.args?.filePattern
    || action.args?.symbol
    || action.args?.command
    || ''
  );
  const isReadOnly = new Set(['read_file', 'list_dir', 'search_files', 'glob']).has(action.tool);
  if (!isReadOnly || !target) return '';
  const allowedPrefixes = ['.agent/', 'result/'];
  const insideLockedRoot = lockedRoots.some((root) => target.startsWith(root));
  const insideAllowedPrefix = allowedPrefixes.some((prefix) => target.startsWith(prefix));
  if (insideLockedRoot || insideAllowedPrefix) return '';
  return `RETRY_BLOCKED: broad discovery is not allowed during execution. Stay within the locked targets (${lockedRoots.join(', ')}) unless you are recovering from a concrete contradiction.`;
}

function buildPlanProgressRereadBlock(memory, action, stageState) {
  if (action.tool !== 'read_file') return '';
  if (!['verification', 'finalization'].includes(stageState?.currentStage)) return '';
  const target = String(action.args?.path || '');
  const watched = new Set(['.agent/plan.md', '.agent/progress.md', '.agent/context-summary.md']);
  if (!watched.has(target)) return '';

  const recent = memory.getRecent(10)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  const tail = recent.slice(-4);
  if (tail.length < 3) return '';
  const sameTargetReads = tail.filter(e => e.action === 'read_file' && String(e.args?.path || '') === target);
  if (sameTargetReads.length < 3) return '';

  return `RETRY_BLOCKED: repeated rereads of \`${target}\` during ${stageState.currentStage}. Plan/progress files are not runtime truth. Use the runtime status, repair the concrete artifact, run one validation command, or finish.`;
}

function buildFinalizationReadChurnBlock(memory, action, stageState) {
  if (stageState?.currentStage !== 'finalization') return '';

  const readOnlyTools = new Set(['read_file', 'list_dir', 'search_files', 'glob', 'todoread']);
  if (!readOnlyTools.has(action.tool)) return '';

  const target = String(action.args?.path || action.args?.filePattern || '');
  if (!(target === 'result' || target === 'result/' || target.startsWith('result/'))) return '';

  const recent = memory.getRecent(8)
    .filter(e => !['parse_error', 'loop_guard', 'verification_failed', 'repeat_guard'].includes(e.action));
  const tail = recent.slice(-5);
  if (tail.length < 4) return '';

  const allResultReads = tail.every((e) => {
    if (!readOnlyTools.has(e.action)) return false;
    const p = String(e.args?.path || e.args?.filePattern || '');
    return p === 'result' || p === 'result/' || p.startsWith('result/');
  });
  if (!allResultReads) return '';

  return 'RETRY_BLOCKED: finalization read-check churn detected on result artifacts. Stop re-checking unchanged output files. Either write/edit the missing or invalid artifact, run one concrete validation command, update the plan, or call finish if contracts are already satisfied.';
}

// ── Diagnostics ──────────────────────────────────────────────

// Parse a Python/JS traceback to find the innermost caller file that is NOT the
// thrashing file. Used by the write-thrash guard to redirect the agent to the real
// root cause instead of letting it keep rewriting the symptom file.
export function extractCallerFromTraceback(errorMsg, thrashPath) {
  if (!errorMsg) return null;
  const thrashBase = thrashPath.replace(/\\/g, '/').replace(/^.*\//, '');
  // Python: File "path/to/file.py", line N
  // JS/Node: at ... (path/to/file.js:N:C)
  const patterns = [
    /File ["']([^"']+\.py)["'],\s*line\s*(\d+)/g,
    /at .+?\(([^)]+\.js):(\d+):\d+\)/g,
  ];
  const matches = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(errorMsg)) !== null) {
      const filePath = m[1].replace(/\\/g, '/');
      const lineNum = m[2];
      const base = filePath.replace(/^.*\//, '');
      if (base !== thrashBase && !filePath.startsWith('<') && !filePath.includes('site-packages') && !filePath.includes('node_modules')) {
        matches.push({ file: filePath, line: lineNum });
      }
    }
  }
  // Return the innermost caller (last in traceback = closest to the error)
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

// Fix C: Cross-file mismatch detector.
// Parses AttributeError / TypeError from a failed run_command output, then
// greps workspace source files to find where the missing attribute is called vs
// defined. Returns a diagnostic hint string for runtimeGuidance, or '' if nothing
// actionable is found.
export function buildCrossFileDiagnostic(errorOutput, workspace) {
  if (!errorOutput || !workspace) return '';
  try {
    // Match Python AttributeError: 'ClassName' object has no attribute 'method'
    const attrMatch = /AttributeError: '(\w+)' object has no attribute '(\w+)'/.exec(errorOutput);
    // Match Python TypeError: method() takes N positional arguments but M were given
    const typeMatch = /TypeError: (\w+)\(\) takes (\d+) positional arguments? but (\d+) (?:was|were) given/.exec(errorOutput);
    // Match Python TypeError: 'type' object is not callable (e.g. attribute set as int instead of method)
    const notCallableMatch = /TypeError: '(\w+)' object is not callable/.exec(errorOutput);

    let missingName = null;
    let className = null;
    let argInfo = null;

    if (attrMatch) {
      className = attrMatch[1];
      missingName = attrMatch[2];
    } else if (typeMatch) {
      missingName = typeMatch[1];
      argInfo = { expected: parseInt(typeMatch[2], 10) - 1, got: parseInt(typeMatch[3], 10) - 1 }; // subtract self
    } else if (notCallableMatch) {
      // e.g. TypeError: 'int' object is not callable — attribute assigned as value, not method
      // Extract the name being called from the traceback (look for .name( pattern near the error)
      const callMatch = /\.(\w+)\s*\(/.exec(errorOutput.split('TypeError')[0].split('\n').slice(-3).join('\n'));
      missingName = callMatch ? callMatch[1] : null;
      // No className needed — the diagnostic will find callers by method name
    }

    if (!missingName) return '';

    // Scan workspace .py and .js files for callers and definitions
    const callers = [];
    const defs = [];
    const ext = /\.(py|js)$/;

    function scanDir(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { scanDir(full); continue; }
        if (!ext.test(e.name)) continue;
        let src;
        try { src = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        const rel = path.relative(workspace, full);
        src.split('\n').forEach((line, i) => {
          const lineNum = i + 1;
          if (attrMatch && new RegExp(`\\.${missingName}\\s*\\(`).test(line)) {
            callers.push(`${rel}:${lineNum}`);
          }
          if (new RegExp(`def\\s+${missingName}\\s*\\(|function\\s+${missingName}\\s*\\(`).test(line)) {
            defs.push(`${rel}:${lineNum}`);
          }
        });
      }
    }
    scanDir(workspace);

    if (callers.length === 0 && defs.length === 0) return '';

    const parts = [];
    if (attrMatch) {
      parts.push(`Cross-file mismatch: \`${className}.${missingName}()\` is called at [${callers.join(', ')}] but ${defs.length === 0 ? 'not defined anywhere in the workspace' : `defined at [${defs.join(', ')}]`}.`);
      if (callers.length > 0 && defs.length === 0) {
        parts.push(`Either add \`${missingName}\` to the \`${className}\` class OR change the caller(s) to use the existing API.`);
      }
    } else if (typeMatch) {
      parts.push(`Argument mismatch: \`${missingName}()\` called with ${argInfo.got} arg(s) but defined to take ${argInfo.expected}. Callers: [${callers.join(', ')}]. Definitions: [${defs.join(', ')}].`);
    } else if (notCallableMatch && missingName) {
      const defLocations = defs.length ? `defined at [${defs.join(', ')}]` : 'not found as a method definition';
      parts.push(`Not-callable: \`${missingName}\` is assigned as a \`${notCallableMatch[1]}\` value (not a method) but called as \`${missingName}()\` at [${callers.join(', ')}]. Fix: change the assignment to \`def ${missingName}(self):\` or a \`@property\`. Current definition: ${defLocations}.`);
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

function normalizeMissingArtifactTarget(t) {
  return String(t || '').replace(/\s*\(empty\)\s*$/, '').trim();
}

export function buildMissingArtifactPriorityBlock(action, stageState, workspace) {
  if (!stageState || !workspace) return '';
  if (!['write_file', 'edit_file'].includes(action?.tool)) return '';
  if (stageState.currentStage !== 'execution') return '';
  const targetPath = String(action.args?.path || '').trim();
  if (!targetPath || targetPath.startsWith('.agent/')) return '';
  const runtime = inspectStageState(stageState, workspace);
  const missingTargets = new Set((runtime.missingWorkspaceArtifacts || []).map(normalizeMissingArtifactTarget));
  if (missingTargets.size === 0) return '';
  if (missingTargets.has(targetPath)) return '';
  return `Missing required workspace artifacts remain (${[...missingTargets].join(', ')}). Do not rewrite unrelated files yet. Create or populate one missing deliverable first, or run one targeted diagnostic against that missing-file interface before editing other files.`;
}
