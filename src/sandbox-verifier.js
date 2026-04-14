// advanced-agent-loop/src/sandbox-verifier.js
// Sandbox verification — works for ANY task type (coding, system ops, web, etc.)
//
// Evidence model (3 sources):
//   1. Workspace diff   — what files changed
//   2. Action log       — what the agent actually DID (tool calls + outputs from working memory)
//   3. Spot-checks      — syntax + authoritative tests (only when applicable)
//
// Hard rules (instant decision, no LLM needed):
//   - Pre-existing authoritative test fails → hard reject
//   - Zero changes + zero meaningful actions → hard reject
//
// Everything else → one LLM judge call with all 3 sources.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chatCompletion } from './llm.js';

const SKIP_DIRS = new Set(['.agent', 'node_modules', '.git']);
const TEST_PATTERN = /(_smoke_test\.(js|py)|_test\.(js|py)|\.test\.js|\.spec\.js)$/;

// ── Workspace snapshot helpers ─────────────────────────────────

function walkDir(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function fileHash(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

export function snapshotWorkspace(workspace) {
  const snapshot = {};
  for (const absPath of walkDir(workspace)) {
    const relPath = path.relative(workspace, absPath);
    const hash = fileHash(absPath);
    if (hash !== null) snapshot[relPath] = hash;
  }
  return snapshot;
}

export function diffWorkspace(workspace, snapshot) {
  const current = snapshotWorkspace(workspace);
  const added = [], modified = [], deleted = [];
  for (const relPath of Object.keys(current)) {
    if (!(relPath in snapshot)) added.push(relPath);
    else if (current[relPath] !== snapshot[relPath]) modified.push(relPath);
  }
  for (const relPath of Object.keys(snapshot)) {
    if (!(relPath in current)) deleted.push(relPath);
  }
  return { added, modified, deleted };
}

// ── Task verification command extraction ──────────────────────

/**
 * Extract shell commands from ```bash blocks that appear under a
 * "Verification" or "Done Criteria" heading in the task text.
 * These are the authoritative commands the task author specified.
 */
// Prefixes that indicate a line is the start of a shell command.
const CMD_PREFIXES = ['python3', 'python', 'node', 'npm', 'npx', 'cargo', 'go ', 'java',
  'bash', 'sh ', 'curl', 'wget', 'git ', 'make', 'cd ', 'ls ', 'echo', 'cat ', 'assert'];

function extractTaskVerificationCommands(taskText) {
  if (!taskText) return [];
  const lines = taskText.split('\n');
  const commands = [];
  let inBashBlock = false;
  let nearVerification = false;
  let currentCmd = '';

  const flush = () => {
    const cmd = currentCmd.trim();
    if (cmd) commands.push(cmd);
    currentCmd = '';
  };

  for (const line of lines) {
    if (/^#+\s.*(verif|done criteria)/i.test(line)) {
      nearVerification = true;
    }
    if (nearVerification && /^```(bash|sh)?$/.test(line.trim())) {
      if (inBashBlock) { flush(); inBashBlock = false; }
      else inBashBlock = true;
      continue;
    }
    if (!inBashBlock) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { flush(); continue; }

    // If this line starts a new top-level command, flush the previous one
    const startsNewCmd = CMD_PREFIXES.some(p => trimmed.toLowerCase().startsWith(p));
    if (startsNewCmd && currentCmd) flush();

    // Accumulate — preserve newlines so multi-line commands (e.g. python3 -c "...\n...") stay valid
    // bash -c handles multi-line strings correctly; space-joining breaks indented Python/shell
    currentCmd += (currentCmd ? '\n' : '') + line;
  }
  flush();
  return commands;
}

/**
 * Run the task's own verification commands (from ```bash blocks under
 * Verification heading). These are authoritative — if any fail, the
 * task is not complete regardless of what the LLM judge says.
 */
function runTaskVerificationCommands(taskText, workspace) {
  const commands = extractTaskVerificationCommands(taskText);
  if (commands.length === 0) return [];

  const results = [];
  for (const cmd of commands) {
    const proc = spawnSync('bash', ['-c', cmd], {
      timeout: 30000,
      encoding: 'utf-8',
      cwd: workspace,
    });
    const output = ((proc.stdout || '') + (proc.stderr || '')).trim();
    results.push({
      command: cmd.slice(0, 120),
      type: 'task-verify',
      passed: proc.status === 0 && proc.error == null,
      output: output.slice(0, 600),
    });
  }
  return results;
}

// ── Spot-checks ────────────────────────────────────────────────

/**
 * Syntax check changed source files + run pre-existing authoritative tests.
 * Agent-created test files are NEVER run — they cannot be trusted.
 */
function runSpotChecks(workspace, changedFiles, snapshot) {
  const results = [];
  const preExistingTests = Object.keys(snapshot || {}).filter(f => TEST_PATTERN.test(f));

  for (const relPath of changedFiles) {
    if (relPath.startsWith('.agent/') || relPath.startsWith('.agent\\')) continue;
    const absPath = path.join(workspace, relPath);

    if (/\.(js|mjs)$/.test(relPath) && !TEST_PATTERN.test(relPath)) {
      const proc = spawnSync('node', ['--check', absPath], { timeout: 10000, encoding: 'utf-8' });
      results.push({
        file: relPath,
        type: 'syntax',
        passed: proc.status === 0 && proc.error == null,
        output: ((proc.stdout || '') + (proc.stderr || '')).trim().slice(0, 400),
      });
    }

    if (/\.py$/.test(relPath) && !TEST_PATTERN.test(relPath)) {
      const proc = spawnSync('python3', ['-m', 'py_compile', absPath], { timeout: 10000, encoding: 'utf-8' });
      results.push({
        file: relPath,
        type: 'syntax',
        passed: proc.status === 0 && proc.error == null,
        output: ((proc.stdout || '') + (proc.stderr || '')).trim().slice(0, 400),
      });
    }
  }

  for (const relPath of preExistingTests) {
    const absPath = path.join(workspace, relPath);
    if (!fs.existsSync(absPath)) continue;
    const isJs = /\.(js|mjs)$/.test(relPath);
    const isPy = /\.py$/.test(relPath);
    if (!isJs && !isPy) continue;
    const cmd = isJs ? 'node' : 'python3';
    const proc = spawnSync(cmd, [absPath], { timeout: 30000, encoding: 'utf-8', cwd: workspace });
    const output = ((proc.stdout || '') + (proc.stderr || '')).trim();
    results.push({
      file: relPath,
      type: 'auth-test',
      passed: proc.status === 0 && proc.error == null,
      output: output.slice(0, 1000),
    });
  }

  return results;
}

// ── Action log formatting ──────────────────────────────────────

/**
 * Convert working memory entries into a compact, readable action log for the LLM judge.
 * Shows what the agent actually DID — tool calls + key outputs.
 *
 * @param {Array} actionLog - Array of working memory entries (from mem.getRecent())
 * @returns {string}
 */
function formatActionLog(actionLog) {
  if (!actionLog || actionLog.length === 0) return '(no action log available)';

  const lines = [];
  let chars = 0;
  const CAP = 3000;

  for (const e of actionLog) {
    // Skip pure think steps — they're internal reasoning, not evidence of doing
    if (e.action === 'think' && !e.error) continue;

    const result = (e.result || '').trim();
    const resultSnippet = result.length > 200
      ? result.slice(0, 150) + `... [${result.length - 150} more chars]`
      : result;

    const status = e.error ? 'ERROR' : 'OK';
    const line = `[Step ${e.step}] ${e.action} → [${status}] ${resultSnippet || '(no output)'}`;
    if (chars + line.length > CAP) {
      lines.push('... [log truncated]');
      break;
    }
    lines.push(line);
    chars += line.length;
  }

  return lines.length > 0 ? lines.join('\n') : '(only thinking steps — no concrete actions taken)';
}

// ── Verification output detection ─────────────────────────────

/**
 * Returns true if the command string looks like a real verification/test runner,
 * not an inline one-liner assertion.
 * Examples that pass: "python3 _smoke_test.py", "node --test tests/", "pytest"
 * Examples that fail: "python3 -c \"assert x == 1; print('ok')\""
 */
function isLikelyVerificationCommand(command) {
  const cmd = (command || '').trim();
  // Inline python/node -c one-liners are NOT verification commands
  if (/^python3?\s+-c\b/.test(cmd) || /^node\s+-e\b/.test(cmd)) return false;
  // Real test runners / smoke test scripts
  return (
    /_smoke_test\.(py|js)/.test(cmd) ||
    /\bpytest\b/.test(cmd) ||
    /\bnode\s+--test\b/.test(cmd) ||
    /\bnpm\s+test\b/.test(cmd) ||
    /_test\.(py|js)$/.test(cmd) ||
    /\.test\.(js|ts)/.test(cmd) ||
    /\.spec\.(js|ts)/.test(cmd)
  );
}

/**
 * Returns true if the output text contains a strong, unambiguous verification signal
 * (not just a generic module-level "OK" from a one-liner assertion).
 */
function hasStrongVerificationSignal(text) {
  return /\b(SMOKE OK|all tests? passed?|✓|✔|\d+ (tests?|specs?) passed)\b/i.test(text) ||
    /\bpassed\b.*\d+/.test(text) ||   // "passed 5" / "5 passed"
    /\d+.*\bpassed\b/.test(text);
}

/**
 * Scan the action log for a recent successful run_command that provides strong
 * verification evidence. Requires EITHER:
 *   - a real test-runner command (smoke test / pytest / node --test) with any success output, OR
 *   - a command whose output contains a strong, unambiguous completion signal.
 * Generic "config OK" or "piece OK" from inline -c one-liners do NOT qualify.
 */
function hasVerificationSuccessInLog(actionLog) {
  const entries = (actionLog || []).slice().reverse(); // most recent first
  for (const e of entries) {
    if (e.action !== 'run_command' || e.error) continue;
    const result = (e.result || '').trim();
    if (result.startsWith('Skipped') || result.startsWith('Blocked') || result.startsWith('Exit code')) continue;

    const cmd = (e.args && (e.args.command || e.args.cmd)) || '';
    if (isLikelyVerificationCommand(cmd)) return true;
    if (hasStrongVerificationSignal(result)) return true;
  }
  return false;
}

// ── Main entry point ──────────────────────────────────────────

/**
 * Verify that the agent's task is complete.
 * Works for ANY task type: coding, system ops, web browsing, editing, analysis.
 *
 * @param {string} task
 * @param {string} workspace
 * @param {{ [relPath: string]: string }} snapshot
 * @param {number} [priorFailures]
 * @param {Array} [actionLog] - Working memory entries (mem.getRecent())
 * @returns {Promise<{ verified: boolean, reason: string }>}
 */
export async function sandboxVerify(task, workspace, snapshot, priorFailures = 0, actionLog = []) {
  const diff = diffWorkspace(workspace, snapshot);
  const totalChanges = diff.added.length + diff.modified.length + diff.deleted.length;
  const changedFiles = [...diff.added, ...diff.modified].filter(
    f => !f.startsWith('.agent/') && !f.startsWith('.agent\\')
  );

  // ── Hard rule: nothing happened ───────────────────────────────
  const meaningfulActions = (actionLog || []).filter(e =>
    e.action !== 'think' && !e.error
  );
  if (totalChanges === 0 && meaningfulActions.length === 0) {
    return { verified: false, reason: 'No files changed and no meaningful actions were taken.' };
  }

  // ── Task verification commands (authoritative) ────────────────
  // Run the exact commands the task author specified. These are ground
  // truth — failures here override any other signal.
  const taskVerifyResults = runTaskVerificationCommands(task, workspace);
  const taskVerifyFailed = taskVerifyResults.find(r => !r.passed);
  if (taskVerifyFailed) {
    return {
      verified: false,
      reason: `Task verification command failed:\n$ ${taskVerifyFailed.command}\n${taskVerifyFailed.output}`,
    };
  }
  if (taskVerifyResults.length > 0 && taskVerifyResults.every(r => r.passed)) {
    return {
      verified: true,
      reason: `All ${taskVerifyResults.length} task verification command(s) passed.`,
    };
  }

  // ── Spot-checks ───────────────────────────────────────────────
  const spotChecks = runSpotChecks(workspace, changedFiles, snapshot);

  // Hard rule: authoritative test failed — no LLM override
  const authTestFailed = spotChecks.find(c => c.type === 'auth-test' && !c.passed);
  if (authTestFailed) {
    return {
      verified: false,
      reason: `Authoritative test failed: ${authTestFailed.file}\n${authTestFailed.output}`,
    };
  }

  // ── Hard rule: verified output in action log ──────────────────
  // If spot checks all pass AND the action log shows a recent run_command
  // with explicit success output, trust it — skip the LLM judge to avoid
  // false negatives when the model misreads clear evidence.
  const allSpotChecksPassed = spotChecks.every(c => c.passed);
  if (totalChanges > 0 && allSpotChecksPassed && hasVerificationSuccessInLog(actionLog)) {
    return { verified: true, reason: 'Files changed, all spot checks passed, and action log shows successful verification output.' };
  }

  // ── Build evidence ────────────────────────────────────────────
  const diffSummary = [
    diff.added.length   > 0 ? `Added (${diff.added.length}): ${diff.added.join(', ')}`       : '',
    diff.modified.length > 0 ? `Modified (${diff.modified.length}): ${diff.modified.join(', ')}` : '',
    diff.deleted.length  > 0 ? `Deleted (${diff.deleted.length}): ${diff.deleted.join(', ')}`   : '',
  ].filter(Boolean).join('\n') || '(no file changes)';

  const checksSection = spotChecks.length > 0
    ? spotChecks.map(c => `[${c.passed ? 'PASS' : 'FAIL'}] ${c.file} (${c.type})\n${c.output || '(no output)'}`).join('\n\n')
    : '(no automated checks applicable)';

  const actionLogSection = formatActionLog(actionLog);

  // ── LLM judge ─────────────────────────────────────────────────
  const systemPrompt = `You are a strict, adversarial task completion verifier. Your job is to decide whether an autonomous agent has fully completed the assigned task.

You will be given three evidence sources:
1. WORKSPACE CHANGES — what files the agent created/modified/deleted
2. ACTION LOG — what the agent actually did (tool calls and their outputs)
3. SPOT-CHECK RESULTS — automated syntax/test checks (if applicable)

Be critical. Partial work, placeholder output, or failed attempts are NOT acceptable.
The task may involve coding, system operations, web browsing, file editing, or anything else — judge based on what the evidence shows.

Respond ONLY with JSON: {"verified": boolean, "reason": "one or two sentences"}`;

  const userPrompt = `TASK:
${task.slice(0, 2000)}

WORKSPACE CHANGES:
${diffSummary}

ACTION LOG (what the agent did):
${actionLogSection}

SPOT-CHECK RESULTS:
${checksSection}

Is the task fully and correctly completed? Respond with JSON only.`;

  try {
    const response = await chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.1 }
    );

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*"verified"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const verdict = JSON.parse(jsonMatch[0]);
        return {
          verified: verdict.verified === true,
          reason: String(verdict.reason || '(no reason given)'),
        };
      } catch { /* fall through */ }
    }
    const lower = text.toLowerCase();
    if ((lower.includes('"verified": true') || lower.includes('"verified":true')) &&
        !lower.includes('"verified": false') && !lower.includes('"verified":false')) {
      return { verified: true, reason: 'LLM judge indicated completion (keyword match)' };
    }
    if (lower.includes('"verified": false') || lower.includes('"verified":false')) {
      return { verified: false, reason: 'LLM judge indicated task not complete (keyword match)' };
    }
    // Ambiguous — fall through to rule-based fallback
  } catch { /* LLM unavailable — fall through */ }

  // ── Rule-based fallback (LLM unavailable or ambiguous) ────────
  const allChecksPassed = spotChecks.every(c => c.passed);
  const hasChecks = spotChecks.length > 0;

  if (hasChecks && allChecksPassed && totalChanges > 0) {
    return { verified: true, reason: 'All automated checks passed and files were changed.' };
  }
  if (spotChecks.some(c => !c.passed)) {
    const failed = spotChecks.filter(c => !c.passed).map(c => c.file).join(', ');
    return { verified: false, reason: `Automated checks failed: ${failed}` };
  }
  if (totalChanges > 0 && meaningfulActions.length > 0) {
    return { verified: false, reason: 'Verification inconclusive — LLM judge unavailable. Files changed and actions taken but could not confirm task completion.' };
  }
  return { verified: false, reason: 'Verification inconclusive.' };
}
