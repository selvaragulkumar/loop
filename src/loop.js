// advanced-agent-loop/src/loop.js
// THE core execution loop — the longest-running, most stable autonomous agent.
//
// Architecture (from research):
//   - 5-layer context assembly (identity → knowledge → state → session → guidance)
//   - Pre-compaction memory flush (save critical context before destruction)
//   - Post-compaction identity recovery (re-orient after context compression)
//   - Dynamic skill system (agent creates its own tools)
//   - Heartbeat memory checks (periodic persistent memory saves)
//   - Focus chain (human-editable priority steering)
//   - Crash recovery via checkpoint.json
//
// The simplest loop that can run for HUNDREDS of steps stably.
// No framework. No graph. Just step → decide → execute → record → persist.

import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { chatCompletion, countMessageChars } from './llm.js';
import { snapshotWorkspace, sandboxVerify } from './sandbox-verifier.js';
import { buildMessages, buildVerificationMessages } from './context.js';
import { executeTool } from './tools.js';
import { WorkingMemory } from './memory.js';
import { route } from './routing/router.js';
import { getToolCategory } from './routing/toolRegistry.js';
import { getExposedTools } from './routing/toolManager.js';
import { compactMemory, shouldCompactByInterval } from './compaction.js';
import { getCurrentSubtask } from './plan.js';
import { bootstrapIdentity, isFirstRun } from './identity.js';
import { loadSkills } from './skills.js';
import { heartbeatMemoryCheck, saveMemory } from './memory-store.js';
import {
  initAgentDir,
  writeTask,
  readTask,
  readPlan,
  getWorkspace,
  appendProgress,
  saveCheckpoint,
  loadCheckpoint,
  restoreFilesTracking,
  setCommandTrackingContext,
  trackRecoveryEvent,
  readRecoveryEvents,
  readCommandsRun,
  getFileFreshnessStatus,
  markFileRequiresReread,
  clearCommandDedup,
} from './state.js';
import {
  createInitialStageState,
  tickAndAdvanceStage,
  getStageGuidance,
  filterToolsByStage,
  completionGuard,
  ensureStageArtifacts,
  inspectStageState,
} from './stages.js';

// ── Extracted modules ────────────────────────────────────────
import { parseAction, safeSlice } from './parser.js';
import {
  normalizeCommandForComparison,
  detectLoopGuard,
  detectIdenticalStreak,
  isSameAsLastUserAction,
  getLastUserAction,
  buildRepeatedActionBlock,
  buildCrossFileDiagnostic,
  buildMissingArtifactPriorityBlock,
  extractCallerFromTraceback,
} from './guards.js';
import {
  buildParseRecoveryGuidance,
  applyVerificationRepairToolFilter,
  buildPrematureSuccessArtifactBlock,
  buildToolFailureGuidance,
  getRequiredVerificationFailure,
  buildCompletionGuardRecoveryGuidance,
} from './recovery.js';

// ── Backward-compatible re-exports (tests import from loop.js) ──
export { parseAction } from './parser.js';
export {
  buildRepeatedFailureRetryBlock,
  buildRepeatedActionBlock,
  buildRepeatedObservationRetryBlock,
} from './guards.js';
export {
  buildParseRecoveryGuidance,
  buildToolFailureGuidance,
  buildPrematureSuccessArtifactBlock,
  applyVerificationRepairToolFilter,
  buildCompletionGuardRecoveryGuidance,
} from './recovery.js';

/**
 * @typedef {Object} LoopResult
 * @property {'completed'|'max_steps'|'budget_exceeded'|'error'|'interrupted'} exitReason
 * @property {string} summary
 * @property {number} totalSteps
 * @property {number} totalCharsUsed
 * @property {number} compactionCount
 * @property {number} memoriesFlushed
 * @property {number} skillsCreated
 */

/**
 * Run the agent loop.
 * @param {Object} opts
 * @param {string} opts.task - The task to accomplish
 * @param {string} [opts.workspace] - Workspace directory
 * @param {boolean} [opts.resume] - Resume from checkpoint
 * @param {function} [opts.onStep] - Callback per step: (step, action, result) => void
 * @returns {Promise<LoopResult>}
 */
export async function runLoop({ task, workspace, resume = false, onStep }) {
  // ── Setup ──────────────────────────────────────────────────

  // Initialize directory structure
  initAgentDir();

  // Bootstrap identity layer (SOUL.md, AGENTS.md, USER.md, MEMORY.md)
  const firstRun = isFirstRun();
  bootstrapIdentity();
  if (firstRun) {
    log('First run — identity layer bootstrapped (SOUL.md, AGENTS.md, USER.md, MEMORY.md)');
  }

  // Load dynamic skills from .agent/skills/
  const skills = loadSkills();
  if (skills.length > 0) {
    log(`Loaded ${skills.length} custom skill(s): ${skills.map(s => s.name).join(', ')}`);
  }

  // Snapshot workspace state so the sandbox verifier can diff what actually changed
  const workspaceSnapshot = resume
    ? loadWorkspaceSnapshot()   // restore from .agent/workspace-snapshot.json
    : snapshotWorkspace(getWorkspace());

  if (!resume) {
    saveWorkspaceSnapshot(workspaceSnapshot);
  }

  // Record pre-existing test/smoke files — the agent must NOT overwrite these.
  // They are the authoritative ground-truth tests provided by the task author.
  const protectedFiles = new Set(
    Object.keys(workspaceSnapshot).filter(f =>
      /(_smoke_test\.|_test\.|\btest_|\bspec_|\.test\.|\.spec\.)/.test(f) &&
      !f.startsWith('.agent/')
    )
  );
  if (protectedFiles.size > 0) {
    log(`Protected test files (agent may not overwrite): ${[...protectedFiles].join(', ')}`);
  }

  // Loop state variables
  let step, totalCharsUsed, consecutiveErrors, lastErrorTool;
  let lastErrorMessage;
  let lastCompactionStep, compactionCount, memoriesFlushed, skillsCreated;
  let memory, postCompaction, runtimeGuidance, parseErrorStreak, verificationFailures;
  let stageState, stageMisalignedStreak = 0;
  // Session-level write counter: tracks how many times each file has been written
  // this session, surviving across compaction boundaries. Used for write-thrash detection.
  let fileWriteCounters = {};
  // Fix A: last failed run_command output — persists across non-error tool successes
  // so write-thrash guard always has a traceback to parse even after a successful think/read.
  let lastFailedCommandOutput = '';
  // Fix B: thrash-path hard block — prevents agent from writing the thrash file for N steps
  // after a write-thrash redirect fires, enforcing the redirect rather than just suggesting it.
  let thrashBlock = { path: '', stepsRemaining: 0 };
  // Routing state: pendingFreeze holds the tool chosen last step so next step
  // exposes only that tool + finish (single-step freeze mechanism).
  let pendingFreeze = null;
  const stageBudgetMaxSteps = config.maxSteps > 0 ? config.maxSteps : 500;
  const hardMaxSteps = config.maxSteps > 0 ? config.maxSteps : Number.POSITIVE_INFINITY;

  if (resume) {
    const cp = loadCheckpoint();
    restoreFilesTracking();
    step = cp.step || 0;
    totalCharsUsed = cp.totalCharsUsed || 0;
    consecutiveErrors = 0;  // reset on resume: crash-point streak doesn't carry over
    lastErrorTool = cp.lastErrorTool || '';
    lastErrorMessage = cp.lastErrorMessage || '';
    lastCompactionStep = cp.lastCompactionStep || 0;
    compactionCount = cp.compactionCount || 0;
    memoriesFlushed = cp.memoriesFlushed || 0;
    skillsCreated = cp.skillsCreated || 0;
    fileWriteCounters = cp.fileWriteCounters || {};
    lastFailedCommandOutput = cp.lastFailedCommandOutput || '';
    thrashBlock = cp.thrashBlock || { path: '', stepsRemaining: 0 };
    memory = WorkingMemory.fromJSON(cp.workingMemory || []);
    postCompaction = false;
    runtimeGuidance = cp.runtimeGuidance || '';
    parseErrorStreak = 0;  // reset on resume: fresh start, don't re-exit immediately
    stageMisalignedStreak = cp.stageMisalignedStreak || 0;
    verificationFailures = cp.verificationFailures || 0;
    stageState = cp.stageState || createInitialStageState(readTask(), stageBudgetMaxSteps, config.stageBudgetRatios);
    ensureStageArtifacts(stageState, getWorkspace(), readTask());
    if (cp.lastErrorContext && !runtimeGuidance) {
      runtimeGuidance = `Resumed from error state: ${cp.lastErrorContext.type} (streak: ${cp.lastErrorContext.streak}). ${cp.lastErrorContext.lastErrorMessage || ''}`.trim();
    }

    // Annotate unknown-tool error entries so resumed session is not confused about
    // which tools exist.  These are entries where the model called a non-existent
    // tool name (e.g. list_directory, ask_user) — keep them in context so the model
    // sees what happened, but prefix with a correction note.
    const INTERNAL_ACTIONS = new Set(['parse_error', 'llm_error', 'verification_failed', 'loop_guard']);
    for (const entry of memory.entries) {
      if (entry.error && !INTERNAL_ACTIONS.has(entry.action) && getToolCategory(entry.action) === null) {
        entry.result = `[RESUME NOTE: "${entry.action}" is not a registered tool — use the exact names in the Tool Name Quick Reference above.] ${entry.result}`;
      }
    }
    log(`Resuming from step ${step} (${compactionCount} compactions, ${memoriesFlushed} memories flushed)`);

    // Save a memory about the resume event
    saveMemory(
      `Session resumed from step ${step}. Compaction count: ${compactionCount}.`,
      'experience',
      ['session', 'resume']
    );
  } else {
    step = 0;
    totalCharsUsed = 0;
    consecutiveErrors = 0;
    lastErrorTool = '';
    lastErrorMessage = '';
    lastCompactionStep = 0;
    compactionCount = 0;
    memoriesFlushed = 0;
    skillsCreated = 0;
    fileWriteCounters = {};
    lastFailedCommandOutput = '';
    thrashBlock = { path: '', stepsRemaining: 0 };
    memory = new WorkingMemory();
    postCompaction = false;
    runtimeGuidance = '';
    parseErrorStreak = 0;
    verificationFailures = 0;
    stageState = createInitialStageState(task, stageBudgetMaxSteps, config.stageBudgetRatios);
    writeTask(task);
    ensureStageArtifacts(stageState, getWorkspace(), task, { reset: true });
    appendProgress(`# Task: ${task}\nStarted: ${new Date().toISOString()}\n`);
    log(`Starting new task: ${task.slice(0, 100)}...`);

    // Save initial memory
    saveMemory(`New task started: ${task.slice(0, 200)}`, 'experience', ['task', 'start']);
  }

  // ── Graceful Shutdown ──────────────────────────────────────
  let shuttingDown = false;
  const handleShutdownSignal = (signal) => {
    if (shuttingDown) {
      log(`Second ${signal} received — force exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    log(`${signal} received — will save checkpoint and exit after current step.`);
  };
  process.on('SIGTERM', handleShutdownSignal);
  process.on('SIGINT', handleShutdownSignal);

  // ── Main Loop ──────────────────────────────────────────────
  try {
  while (step < hardMaxSteps) {
    step++;

    // Graceful shutdown check
    if (shuttingDown) {
      log(`Graceful shutdown at step ${step}.`);
      saveMemory(`Session interrupted at step ${step}`, 'experience', ['session', 'interrupted']);
      saveState();
      return result('interrupted', `Interrupted by signal at step ${step}`);
    }

    // Budget check
    if (config.maxTotalChars > 0 && totalCharsUsed > config.maxTotalChars) {
      log(`Budget exceeded (${totalCharsUsed} chars). Stopping.`);
      saveMemory(`Session ended: budget exceeded at step ${step}`, 'experience', ['session', 'end']);
      saveState();
      return result('budget_exceeded', `Exceeded character budget at step ${step}`);
    }

    // ── 1. Compaction Check ──────────────────────────────────
    const needsCompaction = memory.needsCompaction() ||
      shouldCompactByInterval(step, lastCompactionStep, config.compactionIntervalSteps);

    if (needsCompaction && memory.getOld().length > 0) {
      log(`Compacting memory (step ${step}, ${memory.getOld().length} old entries)...`);
      try {
        const oldEntries = memory.getOld();
        const formatted = memory.formatForCompaction(oldEntries);
        const fromStep = oldEntries[0].step;
        const toStep = oldEntries[oldEntries.length - 1].step;

        // Call compactMemory with raw entries for pre-compaction flush + compression
        const compactionAnchor = buildCompactionAnchor(stageState, memory);
        const { usage, flushedCount, mode } = await compactMemory(formatted, fromStep, toStep, oldEntries, compactionAnchor);
        totalCharsUsed += (usage.prompt_tokens || 0) * 4 + (usage.completion_tokens || 0) * 4;
        memory.trimToWindow();
        lastCompactionStep = step;
        compactionCount++;
        memoriesFlushed += flushedCount;
        postCompaction = true; // Flag for next context build
        fileWriteCounters = {}; // Reset per compaction window — prevents pre-compaction writes blocking post-compaction work

        log(`Compacted steps ${fromStep}-${toStep} | mode=${mode} | flushed ${flushedCount} memories | compaction #${compactionCount}`);
      } catch (err) {
        log(`Compaction failed: ${err.message} (continuing without compaction)`);
        lastCompactionStep = step; // cooldown: prevent retry-thrashing every step
      }
    }

    // ── 2. Heartbeat Memory Check ────────────────────────────
    const currentTask = getCurrentSubtask();
    heartbeatMemoryCheck(step, currentTask?.task);

    let stageGuidance = '';
    if (config.enableStages) {
      const advanced = tickAndAdvanceStage(stageState, step, getWorkspace(), readPlan());
      stageState = advanced.stageState;
      ensureStageArtifacts(stageState, getWorkspace(), readTask());
      if (advanced.changed) {
        appendProgress(`\n## Stage Transition\n${advanced.reason}\n`);
      }
      stageGuidance = getStageGuidance(stageState.currentStage, step, stageState.stageStep);

      const remainingSteps = config.maxSteps > 0 ? Math.max(0, config.maxSteps - step) : Number.POSITIVE_INFINITY;
      const runtime = inspectStageState(stageState, getWorkspace());
      if (config.maxSteps > 0 && remainingSteps <= Math.max(15, Math.floor(config.maxSteps * 0.08)) && runtime.finalizationReady && stageState.currentStage !== 'finalization') {
        stageState = {
          ...stageState,
          currentStage: 'finalization',
          stageStartedAt: new Date().toISOString(),
          stageCompletedAt: new Date().toISOString(),
          stageStep: 1,
          stageBlockedReason: runtime.stageBlockedReason,
          finishAllowed: runtime.finishAllowed,
          finalizationReady: runtime.finalizationReady,
          nextRequiredActionHint: runtime.nextRequiredActionHint,
          missingDeliverables: [...runtime.missingWorkspaceArtifacts, ...runtime.missingOutputs],
          missingCommandEvidence: runtime.missingCommandEvidence,
          recentRecoveryRule: 'late_step_finalization_rescue',
          lastStageTransitionReason: `late_step_rescue:${advanced.stageState?.currentStage || 'verification'}->finalization`,
        };
        trackRecoveryEvent(
          'late_step_finalization_rescue',
          `remaining_steps=${remainingSteps}`,
          'Advance directly to finalization and prioritize artifact repair/finish.',
          { stage: stageState.currentStage, step }
        );
        appendProgress(`\n## Stage Transition\nlate_step_rescue:${advanced.stageState?.currentStage || 'verification'}->finalization\n`);
        stageGuidance = getStageGuidance(stageState.currentStage, step, stageState.stageStep);
      }
    }

    // ── 3. Route tools + Build Context ───────────────────────
    // Apply freeze from previous step, then route to a category.
    const frozenTool = pendingFreeze;
    pendingFreeze = null;

    const lastEntry   = memory.getRecent(1)[0] ?? null;
    const taskText    = readTask();
    const category    = frozenTool
      ? null                                              // freeze: skip routing
      : route(taskText, lastEntry ? { action: lastEntry.action, error: lastEntry.error } : null, step - 1);
    let routedTools = getExposedTools(frozenTool ? 'planning' : category, frozenTool);
    if (config.enableStages) {
      const filtered = filterToolsByStage(routedTools, stageState.currentStage);
      if (filtered.length > 0) routedTools = filtered;
      const repairFiltered = applyVerificationRepairToolFilter(routedTools, stageState);
      if (repairFiltered.length > 0) routedTools = repairFiltered;
    }

    const effectiveGuidance = [stageGuidance, runtimeGuidance].filter(Boolean).join('\n');

    const messages = buildMessages({
      step,
      memory,
      consecutiveErrors,
      lastErrorTool,
      postCompaction,
      preCompactionFlush: false,
      runtimeGuidance: effectiveGuidance,
      routedTools,
      stageGuidance,
      stageState,
      workspace: getWorkspace(),
      lastCompactionStep,
      compactionCount,
    });

    // Clear post-compaction flag immediately after building messages (consumed)
    postCompaction = false;

    const contextChars = countMessageChars(messages);
    log(`Step ${step}: context=${contextChars} chars, memory=${memory.entries.length} entries, compactions=${compactionCount}`);

    // ── 4. LLM Decision + Parse ──────────────────────────────
    // Forced-tool injection: when the model has produced malformed JSON 3+ times
    // consecutively, skip the LLM call entirely and inject a synthetic `think`
    // action. This breaks the 10-20 step stall caused by models drifting into
    // prose/reasoning text that can't be parsed. The think result appears in
    // working memory, the think-guard fires next step forcing a concrete action,
    // and runtimeGuidance primes the model to emit clean JSON.
    let action;
    let llmResponse;
    forceInject: {
      if (parseErrorStreak >= 3) {
        const injectedThought = `I have produced malformed JSON ${parseErrorStreak} times consecutively. I must stop generating prose. My next response must be exactly one JSON object: {"thought":"brief reason","tool":"tool_name","args":{}}. Nothing before or after the JSON.`;
        action = { thought: injectedThought, tool: 'think', args: { thought: injectedThought } };
        log(`Step ${step}: [FORCED-THINK] injecting recovery action (parseErrorStreak was ${parseErrorStreak})`);
        appendProgress(`\n## Step ${step} — FORCED-THINK (parse error streak=${parseErrorStreak})\n${injectedThought}\n`);
        // Give partial credit — reduce but don't zero consecutiveErrors so threshold still guards
        consecutiveErrors = Math.max(0, consecutiveErrors - 1);
        parseErrorStreak = 0;
        runtimeGuidance = 'PARSE RECOVERY: Your last outputs were malformed and were auto-recovered. Your NEXT response MUST be a single valid JSON object — no text before or after it. Use the exact format: {"thought":"...","tool":"...","args":{...}}';
        trackRecoveryEvent(
          'forced_think_injection',
          'parse_error_burst',
          'Auto-injected think action to break parse error loop. Next step must emit clean JSON.',
          { stage: stageState?.currentStage || '', step }
        );
        break forceInject;
      }

      // Session write-thrash guard: fires when the same file has been rewritten many
      // times across compaction boundaries (memory-based churn detection misses this).
      // Evaluated BEFORE the repeat-guard so it isn't short-circuited by the lower-threshold
      // repeat-guard firing first via break forceInject.
      // Threshold 5 means the agent has tried and failed 5 full rewrites — time to stop.
      if (Object.keys(fileWriteCounters).length > 0) {
        const [thrashPath, thrashCount] = Object.entries(fileWriteCounters)
          .reduce((a, b) => b[1] > a[1] ? b : a, ['', 0]);
        if (thrashCount >= 5) {
          const isTestFile = /(_smoke_test|_test\.|test_)/.test(thrashPath);
          const caller = !isTestFile ? extractCallerFromTraceback(lastFailedCommandOutput || lastErrorMessage, thrashPath) : null;
          const callerHint = caller
            ? ` The error is caused by \`${caller.file}\` line ${caller.line} calling a method/attribute that does not exist in \`${thrashPath}\`. I must fix the CALLER (\`${caller.file}\`) — not add the missing thing to \`${thrashPath}\`.`
            : '';
          const injectedThought = isTestFile
            ? `I have rewritten \`${thrashPath}\` ${thrashCount} times this session. Rewriting the test file is not fixing the problem. The bug is in my SOURCE CODE. I must run the test with run_command to see the actual error traceback, then fix the SOURCE module that is failing — NOT rewrite the test.`
            : `I have rewritten \`${thrashPath}\` ${thrashCount} times this session without resolving the issue.${callerHint} I must stop touching \`${thrashPath}\` and instead fix the file that is CALLING the broken method.`;
          action = { thought: injectedThought, tool: 'think', args: { thought: injectedThought } };
          log(`Step ${step}: [FORCED-THINK] session write-thrash on ${thrashPath} (${thrashCount} writes)${caller ? ` — caller: ${caller.file}:${caller.line}` : ''}`);
          appendProgress(`\n## Step ${step} — FORCED-THINK (session write-thrash ×${thrashCount} on ${thrashPath})\n${injectedThought}\n`);
          runtimeGuidance = isTestFile
            ? `STALL RECOVERY: You have rewritten \`${thrashPath}\` ${thrashCount} times this session. STOP rewriting the test. Run it with run_command, read the error output carefully, find which SOURCE module is broken, fix that file, then rerun the test.`
            : caller
              ? `STALL RECOVERY: You have rewritten \`${thrashPath}\` ${thrashCount} times without fixing the issue. The root cause is in \`${caller.file}\` line ${caller.line} — that file calls a method that does not exist in \`${thrashPath}\`. Read \`${caller.file}\` and fix the CALLER. Do NOT touch \`${thrashPath}\` again.`
              : `STALL RECOVERY: You have rewritten \`${thrashPath}\` ${thrashCount} times without fixing the issue. Run a validation command NOW to see the current error traceback. Find which file is calling the broken method, then fix THAT file — not \`${thrashPath}\`.`;
          // Halve the counter so this fires again if thrashing resumes, but doesn't trigger every step
          fileWriteCounters[thrashPath] = Math.floor(thrashCount / 2);
          // Fix B: hard-block the thrash file for 3 steps if a caller was identified
          if (caller) thrashBlock = { path: thrashPath, stepsRemaining: 3 };
          trackRecoveryEvent(
            'session_write_thrash',
            `${thrashPath} written ${thrashCount} times`,
            injectedThought,
            { stage: stageState?.currentStage || '', step, target: thrashPath }
          );
          break forceInject;
        }
      }

      // Repeat-guard stall breaker: when the same action has been blocked 4+ consecutive
      // times (read/edit on the same file), the model is ignoring guidance. Force a
      // write_file rewrite instead of letting it try the same read_file again.
      // Placed AFTER write-thrash guard so the stronger session-level signal fires first.
      if (consecutiveErrors >= 4 && lastErrorTool) {
        const recentBlocked = memory.getRecent(6)
          .filter(e => e.error && (String(e.result || '').includes('RETRY_BLOCKED') || String(e.result || '').includes('EDIT_CHURN')));
        if (recentBlocked.length >= 3) {
          const targetFile = recentBlocked.map(e => e.args?.path).filter(Boolean)[0] || '';
          const isTestFile = targetFile.includes('_smoke_test') || targetFile.includes('_test') || targetFile.includes('test_');
          const injectedThought = isTestFile
            ? `I have been blocked ${recentBlocked.length} times on \`${targetFile}\`. The test file is probably correct. The bug is in my SOURCE CODE. I must run the test with run_command to see the error traceback, then fix the SOURCE module that is failing — NOT rewrite the test file.`
            : `I have been blocked ${recentBlocked.length} times trying to read/edit \`${targetFile}\`. My edit_file calls keep failing because I cannot match the exact whitespace. I MUST use write_file to completely rewrite this file instead of trying edit_file again. If the file has a syntax error, I should write the entire corrected file content.`;
          action = { thought: injectedThought, tool: 'think', args: { thought: injectedThought } };
          log(`Step ${step}: [FORCED-THINK] breaking repeat-guard stall (${recentBlocked.length} blocks on ${targetFile})`);
          appendProgress(`\n## Step ${step} — FORCED-THINK (repeat guard stall on ${targetFile})\n${injectedThought}\n`);
          consecutiveErrors = Math.max(0, consecutiveErrors - 2);
          runtimeGuidance = isTestFile
            ? `STALL RECOVERY: You are stuck on \`${targetFile}\`. Do NOT rewrite it. The bug is in your source code. Run the test to see the error, then fix the broken source module.`
            : `STALL RECOVERY: You have been stuck reading/editing \`${targetFile}\` for multiple steps. Your edit_file calls fail because the oldString does not match. You MUST use write_file to rewrite the entire file with corrected content. Do NOT use edit_file or read_file on this file again — write the complete fixed file now.`;
          trackRecoveryEvent(
            'forced_think_injection',
            'repeat_guard_stall',
            `Broke repeat-guard stall on ${targetFile}. Forcing write_file rewrite.`,
            { stage: stageState?.currentStage || '', step, target: targetFile }
          );
          break forceInject;
        }
      }

      // ── Normal path: call LLM ─────────────────────────────
      try {
        llmResponse = await chatCompletion(messages);
        totalCharsUsed += (llmResponse.usage.prompt_tokens || 0) * 4 + (llmResponse.usage.completion_tokens || 0) * 4;
      } catch (err) {
        log(`LLM error: ${err.message}`);
        consecutiveErrors++;
        trackRecoveryEvent(
          'llm_error',
          err.message,
          'Retry the loop with preserved runtime state and avoid repeating the same failing prompt path.',
          { stage: stageState?.currentStage || '', step }
        );
        memory.push({
          step,
          action: 'llm_error',
          args: {},
          result: `LLM request failed: ${err.message}`,
          error: true,
          timestamp: Date.now(),
        });
        appendProgress(`\n## Step ${step} — LLM ERROR\n${err.message}\n`);
        lastErrorMessage = err.message;
        saveState();

        if (consecutiveErrors >= config.maxConsecutiveErrors) {
          saveMemory(`Session ended: LLM failed ${consecutiveErrors} times`, 'experience', ['session', 'error']);
          return result('error', `LLM failed ${consecutiveErrors} times in a row: ${err.message}`);
        }
        continue;
      }

      // ── Parse LLM response into a structured action ───────
      try {
        action = parseAction(llmResponse.content);
        parseErrorStreak = 0;
      } catch (err) {
        log(`Parse error: ${err.message}`);
        consecutiveErrors++;
        parseErrorStreak++;
        runtimeGuidance = buildParseRecoveryGuidance(llmResponse.content, err.message, parseErrorStreak);
        trackRecoveryEvent(
          'parse_error',
          err.message,
          'Return exactly one valid JSON tool call. Do not repeat prose or malformed protocol output.',
          { stage: stageState?.currentStage || '', step }
        );
        if (parseErrorStreak >= 3) {
          trackRecoveryEvent(
            'parse_error_burst',
            `streak=${parseErrorStreak}`,
            'Stop repeating malformed output. Use the runtime blocker and emit one exact JSON tool call.',
            { stage: stageState?.currentStage || '', step }
          );
        }

        // Push a minimal parse_error entry to working memory so:
        //   (a) memory.entries.length advances (visible in the step log)
        //   (b) the LLM sees its own failed output in Recent Actions and
        //       understands why the recovery guidance is being injected
        const rawSnippet = safeSlice(String(llmResponse.content || ''), 200).replace(/\s+/g, ' ').trim();
        memory.push({
          step,
          action: 'parse_error',
          args: {},
          result: `Parse failed (${err.message}). Raw snippet: ${rawSnippet}`,
          error: true,
          timestamp: Date.now(),
        });

        appendProgress(`\n## Step ${step} — PARSE ERROR\n${err.message}\nRaw: ${llmResponse.content.slice(0, 300)}\n`);
        saveState();

        if (consecutiveErrors >= config.maxConsecutiveErrors) {
          saveMemory(`Session ended: parse failed ${consecutiveErrors} times in a row`, 'experience', ['session', 'error']);
          return result('error', `Parse failed ${consecutiveErrors} consecutive times. Last error: ${err.message}`);
        }
        continue;
      }
    } // end forceInject

    log(`Step ${step}: [${action.tool}] ${action.thought?.slice(0, 80) || ''}`);

    const blockedRetry = buildRepeatedActionBlock(memory, action, stageState);
    if (blockedRetry) {
      appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);
      appendProgress(`**Result:** ❌ ${blockedRetry}\n`);
      memory.push({
        step,
        action: action.tool,
        args: action.args,
        result: blockedRetry,
        error: true,
        timestamp: Date.now(),
      });
      consecutiveErrors++;
      lastErrorTool = action.tool;
      runtimeGuidance = blockedRetry;
      trackRecoveryEvent(
        'repeat_guard',
        `${action.tool}:${JSON.stringify(action.args || {})}`,
        blockedRetry,
        { stage: stageState?.currentStage || '', step, target: action.args?.path || action.args?.command || '' }
      );
      if (blockedRetry.includes('stage-misaligned action')) {
        stageMisalignedStreak = (stageMisalignedStreak || 0) + 1;
        trackRecoveryEvent(
          'stage_misaligned_action',
          `${stageState?.currentStage || 'unknown'}:${action.tool}`,
          blockedRetry,
          { stage: stageState?.currentStage || '', step, target: action.args?.path || action.args?.command || '' }
        );
        // Safety valve: if blocked 4+ consecutive times, force stage back to execution
        // so the agent can continue its work instead of being stuck.
        if (stageMisalignedStreak >= 4 && stageState.currentStage !== 'execution') {
          const streakCount = stageMisalignedStreak;
          log(`Step ${step}: [STAGE-RESET] forcing stage back to execution after ${streakCount} consecutive stage-misaligned blocks`);
          stageState.currentStage = 'execution';
          stageState.stageStep = 1;
          stageState.stageStartedAt = new Date().toISOString();
          stageMisalignedStreak = 0;
          runtimeGuidance = 'STAGE RESET: The stage system was blocking your actions. Stage has been reset to execution. Continue building the required files.';
          appendProgress(`\n## Stage Reset (forced)\nReset to execution after ${streakCount} consecutive stage-misaligned blocks.\n`);
        }
      } else {
        stageMisalignedStreak = 0;
      }
      saveState();
      continue;
    }

    const prematureArtifactWrite = buildPrematureSuccessArtifactBlock(action, stageState, getWorkspace());
    if (prematureArtifactWrite) {
      appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);
      appendProgress(`**Result:** ❌ ${prematureArtifactWrite}\n`);
      memory.push({
        step,
        action: action.tool,
        args: action.args,
        result: prematureArtifactWrite,
        error: true,
        timestamp: Date.now(),
      });
      consecutiveErrors++;
      lastErrorTool = action.tool;
      lastErrorMessage = prematureArtifactWrite;
      runtimeGuidance = prematureArtifactWrite;
      trackRecoveryEvent(
        'premature_success_artifact_block',
        `${action.tool}:${action.args?.path || ''}`,
        prematureArtifactWrite,
        { stage: stageState?.currentStage || '', step, target: action.args?.path || '' }
      );
      saveState();
      continue;
    }

    // ── 5b. Thrash-block guard (Fix B) ──────────────────────
    // After a write-thrash redirect fires pointing to a caller file, the thrash
    // file is hard-blocked for N steps so the agent cannot immediately undo the
    // redirect by writing it again.
    if (thrashBlock.stepsRemaining > 0) {
      thrashBlock.stepsRemaining--;
      if (['write_file', 'edit_file'].includes(action.tool)) {
        const targetPath = String(action.args?.path || '');
        if (targetPath === thrashBlock.path) {
          const blockMsg = `RETRY_BLOCKED: \`${targetPath}\` is temporarily blocked for ${thrashBlock.stepsRemaining + 1} more step(s). You were redirected away from this file because the error originates in its CALLER. Fix the caller file instead — do NOT write \`${targetPath}\` until the block expires.`;
          log(`Step ${step}: [THRASH-BLOCK] blocked write to ${targetPath} (${thrashBlock.stepsRemaining + 1} steps remaining)`);
          appendProgress(`\n## Step ${step} — ${action.tool}\n**Result:** ❌ ${blockMsg}\n`);
          memory.push({ step, action: action.tool, args: action.args, result: blockMsg, error: true, timestamp: Date.now() });
          consecutiveErrors++;
          lastErrorTool = action.tool;
          runtimeGuidance = blockMsg;
          saveState();
          continue;
        }
      }
    }

    // ── 5c. Protected file guard ─────────────────────────────
    // Block write_file / edit_file on pre-existing test files. These were provided
    // by the task author as authoritative tests and must not be modified by the agent.
    if (['write_file', 'edit_file'].includes(action.tool) && protectedFiles.size > 0) {
      const targetPath = String(action.args?.path || '');
      const targetBase = targetPath.split('/').pop(); // basename only
      if (protectedFiles.has(targetPath) || protectedFiles.has(targetBase)) {
        const guardMsg = `PROTECTED: \`${targetPath}\` is an authoritative test file provided by the task author. You MUST NOT modify it. Fix your SOURCE CODE to make this test pass instead. Run \`node ${targetPath}\` to see the exact failure, then edit the source module.`;
        log(`Step ${step}: [PROTECTED-FILE] blocked write to ${targetPath}`);
        appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);
        appendProgress(`**Result:** ❌ ${guardMsg}\n`);
        memory.push({ step, action: action.tool, args: action.args, result: guardMsg, error: true, timestamp: Date.now() });
        consecutiveErrors++;
        lastErrorTool = action.tool;
        runtimeGuidance = guardMsg;
        trackRecoveryEvent('protected_file_blocked', targetPath, guardMsg, { stage: stageState?.currentStage || '', step, target: targetPath });
        saveState();
        continue;
      }
    }

    // ── 5c. Missing artifact priority guard ──────────────────
    // Block writes to unrelated files while required deliverables are still missing.
    // Fail-safe: returns '' when no locked targets or all artifacts exist.
    const missingArtifactBlock = buildMissingArtifactPriorityBlock(action, stageState, getWorkspace());
    if (missingArtifactBlock) {
      log(`Step ${step}: [MISSING-ARTIFACT-PRIORITY] blocked ${action.tool} on ${action.args?.path || ''}`);
      appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);
      appendProgress(`**Result:** ❌ ${missingArtifactBlock}\n`);
      memory.push({ step, action: action.tool, args: action.args, result: missingArtifactBlock, error: true, timestamp: Date.now() });
      consecutiveErrors++;
      lastErrorTool = action.tool;
      runtimeGuidance = missingArtifactBlock;
      trackRecoveryEvent('missing_artifact_priority_block', `${action.tool}:${action.args?.path || ''}`, missingArtifactBlock, { stage: stageState?.currentStage || '', step, target: action.args?.path || '' });
      saveState();
      continue;
    }

    // ── 6. Execute Tool ──────────────────────────────────────
    // Log action BEFORE execution (crash safety)
    appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);

    setCommandTrackingContext({
      stage: stageState?.currentStage || '',
      step,
      retryCount: Math.max(0, consecutiveErrors),
    });
    const { result: toolResult, error: toolError } = executeTool(action.tool, action.args);

    // Log result AFTER execution
    appendProgress(`**Result:** ${toolError ? '❌ ' : ''}${toolResult.slice(0, 500)}\n`);

    // Track skill creation (createSkill() already calls loadSkills() internally)
    if (action.tool === 'create_skill' && !toolError) {
      skillsCreated++;
    }

    // Track session-level write counts for write-thrash detection (survives compaction)
    if (action.tool === 'write_file' && !toolError) {
      const writePath = String(action.args?.path || '');
      if (writePath && !writePath.startsWith('.agent/')) {
        fileWriteCounters[writePath] = (fileWriteCounters[writePath] || 0) + 1;
      }
    }

    // Schedule tool freeze for next step (expose only this tool + finish).
    // Don't freeze on meta-tools or on errors — let the router re-route freely.
    // If this call repeats the previous user action with identical args, skip
    // freezing so the next step can re-route and escape the local loop.
    const repeatedSameCall = isSameAsLastUserAction(memory, action.tool, action.args);
    if (!toolError && !repeatedSameCall && !['finish', 'think', 'loop_guard', 'update_plan'].includes(action.tool)) {
      pendingFreeze = action.tool;
    } else {
      pendingFreeze = null;
    }

    // ── 8. Record in Memory ──────────────────────────────────
    memory.push({
      step,
      action: action.tool,
      args: action.args,
      result: toolResult,
      error: toolError,
      timestamp: Date.now(),
    });

    // Track errors
    if (toolError) {
      consecutiveErrors++;
      lastErrorTool = action.tool;
      lastErrorMessage = String(toolResult || '').slice(0, 240);
      // Fix A: persist run_command failure output separately so write-thrash guard
      // always has a traceback even after the agent does a successful think/read_file.
      if (action.tool === 'run_command') {
        lastFailedCommandOutput = String(toolResult || '').slice(0, 600);
        // Fix C: cross-file mismatch detection — append caller/definition diagnosis to guidance
        const crossFileDiag = buildCrossFileDiagnostic(lastFailedCommandOutput, getWorkspace());
        if (crossFileDiag) {
          runtimeGuidance = (runtimeGuidance ? runtimeGuidance + ' ' : '') + crossFileDiag;
        }
      }
      if (action.tool === 'run_command' && stageState?.currentStage === 'verification') {
        const requiredFailure = getRequiredVerificationFailure(action, stageState, toolResult);
        if (requiredFailure) {
          stageState.lastFailedRequiredCommand = requiredFailure.command;
          stageState.relatedRepairTargets = requiredFailure.targets;
          stageState.expectedRepairScope = 'local_verification_repair';
          stageState.repairModeActive = true;
          stageState.narrativeRecoverySuppressed = true;
        }
      }
      const toolAdvice = buildToolFailureGuidance(action, toolResult, stageState);
      runtimeGuidance = toolAdvice
        ? `Previous tool call failed (${action.tool}). ${toolAdvice}`
        : `Previous tool call failed (${action.tool}). Inspect the exact error result and change arguments/tool choice before retrying.`;
      trackRecoveryEvent(
        'tool_error',
        `${action.tool}: ${lastErrorMessage}`,
        runtimeGuidance,
        { stage: stageState?.currentStage || '', step, target: action.args?.path || action.args?.command || '' }
      );
      if (action.tool === 'edit_file' && /EDIT_ERROR_STRING_NOT_FOUND/i.test(String(toolResult || ''))) {
        markFileRequiresReread(
          String(action.args?.path || ''),
          'Previous edit target no longer matched the current file. Re-read the exact current file contents before another edit.',
          { step }
        );
      }
    } else {
      consecutiveErrors = 0;
      lastErrorTool = '';
      lastErrorMessage = '';
      if (action.tool === 'run_command' && stageState?.repairModeActive) {
        const normalizedCommand = normalizeCommandForComparison(action.args?.command || '');
        const repairedTarget = normalizeCommandForComparison(stageState.lastFailedRequiredCommand || '');
        if (!repairedTarget || normalizedCommand === repairedTarget || normalizedCommand.includes(repairedTarget) || repairedTarget.includes(normalizedCommand)) {
          stageState.lastFailedRequiredCommand = '';
          stageState.relatedRepairTargets = [];
          stageState.expectedRepairScope = '';
          stageState.repairModeActive = false;
          stageState.narrativeRecoverySuppressed = false;
        }
      }
      if (parseErrorStreak === 0) {
        runtimeGuidance = '';
      }
    }

    const guardMessage = detectLoopGuard(memory, parseErrorStreak, stageState);
    if (guardMessage) {
      if (runtimeGuidance !== guardMessage) {
        appendProgress(`\n## Loop Guard\n${guardMessage}\n`);
        memory.push({
          step,
          subStep: 'loop_guard',
          action: 'loop_guard',
          args: {},
          result: guardMessage,
          error: false,
          timestamp: Date.now(),
        });
      }
      runtimeGuidance = guardMessage;
      trackRecoveryEvent(
        'loop_guard',
        guardMessage,
        'Switch to a different action and stop repeating the same stalled pattern.',
        { stage: stageState?.currentStage || '', step, target: action.args?.path || action.args?.command || '' }
      );

      // Hard stop: if same-tool-same-args stall persists for 4+ steps, terminate.
      // This gives one additional step for recovery after guidance injection.
      const identicalStreak = detectIdenticalStreak(memory);
      if (identicalStreak >= 4) {
        const lastAct = getLastUserAction(memory);
        saveMemory(`Session ended: stall on ${lastAct} × ${identicalStreak}`, 'experience', ['session', 'stall']);
        saveState();
        return result('error', `Stall: \`${lastAct}\` called ${identicalStreak} times with identical args. Stopping.`);
      }
    } else if (!toolError && parseErrorStreak === 0) {
      runtimeGuidance = '';
    }

    // ── Tool Failure Rate Guard (FLAW 7) ─────────────────────
    // Alternating success/fail hides chronic failures from consecutiveErrors.
    // If ≥6 of the last 10 real actions errored, inject soft recovery guidance.
    if (!runtimeGuidance && step >= 10) {
      const recentWindow = memory.getRecent(10).filter(e => !['loop_guard', 'parse_error', 'llm_error'].includes(e.action));
      if (recentWindow.length >= 5) {
        const errorCount = recentWindow.filter(e => e.error).length;
        if (errorCount >= Math.ceil(recentWindow.length * 0.6)) {
          runtimeGuidance = `High tool failure rate: ${errorCount}/${recentWindow.length} recent actions failed. Re-read key files, verify paths and arguments, or try a completely different approach.`;
        }
      }
    }

    // ── 8. Check Finish ──────────────────────────────────────
    if (toolResult.startsWith('__FINISH__:')) {
      if (config.enableStages && stageState.currentStage !== 'finalization') {
        runtimeGuidance = `Finish blocked: current stage is "${stageState.currentStage}". Advance to finalization stage first.`;
        trackRecoveryEvent(
          'finish_blocked',
          `stage=${stageState.currentStage}`,
          runtimeGuidance,
          { stage: stageState.currentStage, step }
        );
        memory.push({
          step,
          subStep: 'finish_blocked',
          action: 'verification_failed',
          args: {},
          result: runtimeGuidance,
          error: true,
          timestamp: Date.now(),
        });
        saveState();
        continue;
      }

      if (config.enableStages) {
        const guard = completionGuard(stageState, getWorkspace());
        if (guard) {
          runtimeGuidance = buildCompletionGuardRecoveryGuidance(guard);
          trackRecoveryEvent(
            'completion_guard',
            guard,
            runtimeGuidance,
            { stage: stageState.currentStage, step }
          );
          memory.push({
            step,
            subStep: 'completion_guard',
            action: 'verification_failed',
            args: {},
            result: runtimeGuidance,
            error: true,
            timestamp: Date.now(),
          });
          saveState();
          continue;
        }
      }

      const summary = toolResult.replace('__FINISH__:', '');
      log(`Agent signaled finish: ${summary.slice(0, 100)}`);

      // ── Hard smoke test gate ──────────────────────────────────
      // For application tasks, require evidence that a smoke test was actually run.
      // This prevents the model from bypassing the LLM-based verification by finishing
      // repeatedly until the force-accept threshold kicks in.
      // Require SMOKE OK in the result — just running the smoke test isn't enough,
      // it must actually pass. Check both current memory and compacted context.
      // Disable with AGENT_REQUIRE_SMOKE_TEST=false for chatbot / non-build tasks.
      const smokeTestEvidence = !config.requireSmokeTest || memory.entries.some(e =>
        e.action === 'run_command' && !e.error &&
        String(e.result || '').includes('SMOKE OK') &&
        // Reject console.assert-style fake passes: assert failure is printed to stderr
        // but the process still exits 0 and prints "SMOKE OK" at the end.
        !String(e.result || '').includes('Assertion failed:')
      );
      if (!smokeTestEvidence) {
        // Prefer pre-existing authoritative test files (from snapshot) — direct agent to run those first.
        const authTests = [...protectedFiles].filter(f => /(_smoke_test\.(js|py)|_test\.(js|py)|\.test\.js|\.spec\.js)$/.test(f));
        const smokeTestRan = memory.entries.some(e =>
          e.action === 'run_command' &&
          (String(e.args?.command || '').includes('_smoke_test') || String(e.args?.command || '').includes('_test'))
        );
        let smokeMsg;
        if (authTests.length > 0) {
          const testList = authTests.map(f => `\`node ${f}\``).join(', ');
          smokeMsg = smokeTestRan
            ? `Finish BLOCKED: No passing test detected. Pre-existing authoritative tests exist: ${testList}. Run them with run_command. If they fail, your SOURCE CODE has a bug — fix the source, not the test. The test must print "SMOKE OK" at the end.`
            : `Finish BLOCKED: You must verify your work before finishing. Run the pre-existing test file(s): ${testList}. If all pass, they will print "SMOKE OK". Do NOT write new test files — use the ones already in the workspace.`;
        } else {
          smokeMsg = smokeTestRan
            ? 'Finish BLOCKED: Your smoke test ran but did NOT produce a clean "SMOKE OK" (either it never printed it, or it printed assertion failures before it). Do NOT rewrite the smoke test file. Your SOURCE CODE has a bug. Run the smoke test with run_command, read the error output carefully, find which source module is failing, fix THAT file, then rerun the smoke test.'
            : 'Finish BLOCKED: No passing smoke test detected. Write a _smoke_test.js (or _smoke_test.py) that: (1) imports the key exported functions/classes, (2) calls them with known inputs, (3) uses throw-based assertions — NOT console.assert, which exits 0 even on failure — so the process exits with a non-zero code when a check fails, (4) prints "SMOKE OK" only after ALL checks pass. Run it with run_command. It must exit 0 and print "SMOKE OK" with no assertion errors before it.';
        }
        log(`Smoke test gate: BLOCKED (attempt ${verificationFailures + 1})`);
        runtimeGuidance = smokeMsg;
        memory.push({
          step,
          subStep: 'smoke_test_gate',
          action: 'verification_failed',
          args: {},
          result: smokeMsg,
          error: true,
          timestamp: Date.now(),
        });
        verificationFailures++;
        consecutiveErrors++;
        saveState();
        continue;
      }

      // Sandbox verification — diffs workspace changes and runs an LLM judge
      const sandboxResult = await sandboxVerify(readTask(), getWorkspace(), workspaceSnapshot, verificationFailures, memory.getRecent(30));
      if (sandboxResult.verified) {
        // Save completion memory
        saveMemory(
          `Task completed: ${summary.slice(0, 300)}`,
          'experience',
          ['task', 'complete']
        );
        appendProgress(`\n## COMPLETED\n${summary}\n`);
        saveState();
        return result('completed', summary);
      } else {
        log(`Sandbox verification failed: ${sandboxResult.reason}`);
        trackRecoveryEvent(
          'finish_verification_failed',
          summary.slice(0, 200),
          'Repair missing evidence, update artifacts, and only then call finish again.',
          { stage: stageState?.currentStage || '', step }
        );
        const escalation = config.requireSmokeTest
          ? (verificationFailures >= 2
            ? `CRITICAL (attempt ${verificationFailures + 1}): Your finish was rejected AGAIN. Verifier reason: ${sandboxResult.reason}. You MUST: 1) Write _smoke_test.py that imports key classes using package imports, 2) Run it with run_command, 3) Fix any errors until it prints "SMOKE OK", 4) ONLY THEN call finish.`
            : `Your completion was not verified. Verifier reason: ${sandboxResult.reason}. Before calling finish again: 1) Write and run a _smoke_test.py, 2) Update the plan to mark completed subtasks with [x], 3) Verify your work actually produced the expected output, 4) Include specific evidence in your finish summary.`)
          : (verificationFailures >= 2
            ? `CRITICAL (attempt ${verificationFailures + 1}): Your finish was rejected AGAIN. Verifier reason: ${sandboxResult.reason}. Re-read the original task requirements, check which deliverables are missing or broken, fix them, then call finish with specific evidence of what you fixed.`
            : `Your completion was not verified. Verifier reason: ${sandboxResult.reason}. Before calling finish again: 1) Re-read the original task requirements, 2) Check that all required files exist and are correct, 3) Run any relevant commands to confirm the work is done, 4) Include specific evidence in your finish summary.`);
        memory.push({
          step,
          subStep: 'verification_failed',
          action: 'verification_failed',
          args: {},
          result: escalation,
          error: true,
          timestamp: Date.now(),
        });
        verificationFailures++;
        consecutiveErrors++;
        // Clear command dedup so the agent can re-run the same verification
        // commands as fresh evidence on the next attempt.
        clearCommandDedup();
        // Don't break — continue the loop
      }
    }

    // ── 10. Save Checkpoint ──────────────────────────────────
    saveState();

    // ── 10. Callback ─────────────────────────────────────────
    if (onStep) {
      try { onStep(step, action, toolResult); } catch {}
    }
  }

  // Loop exhausted
  if (config.maxSteps > 0) {
    log(`Max steps reached (${config.maxSteps})`);
    saveMemory(`Session ended: reached max ${config.maxSteps} steps`, 'experience', ['session', 'max-steps']);
    saveState();
    return result('max_steps', `Reached maximum ${config.maxSteps} steps`);
  }

  throw new Error('Unreachable: unbounded loop exited unexpectedly.');
  } finally {
    process.removeListener('SIGTERM', handleShutdownSignal);
    process.removeListener('SIGINT', handleShutdownSignal);
  }

  // ── Helpers ────────────────────────────────────────────────
  function saveWorkspaceSnapshot(snapshot) {
    try {
      const p = path.join(getWorkspace(), config.agentDir, 'workspace-snapshot.json');
      fs.writeFileSync(p, JSON.stringify(snapshot), 'utf-8');
    } catch { /* non-fatal */ }
  }

  function loadWorkspaceSnapshot() {
    try {
      const p = path.join(getWorkspace(), config.agentDir, 'workspace-snapshot.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch { /* ignore */ }
    return {};
  }

  function saveState() {
    const recentRecoveryEvent = readRecoveryEvents().slice(-1)[0] || null;
    saveCheckpoint({
      step,
      totalCharsUsed,
      consecutiveErrors,
      lastErrorTool,
      lastErrorMessage,
      lastCompactionStep,
      compactionCount,
      memoriesFlushed,
      skillsCreated,
      fileWriteCounters,
      lastFailedCommandOutput,
      thrashBlock,
      parseErrorStreak,
      stageMisalignedStreak,
      runtimeGuidance,
      verificationFailures,
      stageState: stageState ? {
        ...stageState,
        recentRecoveryRule: recentRecoveryEvent
          ? `${recentRecoveryEvent.type}: ${recentRecoveryEvent.correctiveAction}`
          : (stageState.recentRecoveryRule || ''),
      } : stageState,
      lastErrorContext: consecutiveErrors > 0 ? {
        type: parseErrorStreak > 0 ? 'parse_error' : 'tool_or_llm_error',
        streak: parseErrorStreak > 0 ? parseErrorStreak : consecutiveErrors,
        lastErrorMessage: String(lastErrorMessage || lastErrorTool || ''),
      } : null,
      workingMemory: memory.toJSON(),
      currentSubtask: getCurrentSubtask(),
    });
  }

  function result(exitReason, summary) {
    return { exitReason, summary, totalSteps: step, totalCharsUsed, compactionCount, memoriesFlushed, skillsCreated };
  }

  function buildCompactionAnchor(currentStageState, workingMemory) {
    if (!currentStageState) return null;
    const runtime = inspectStageState(currentStageState, getWorkspace());
    const lockedRoot = (currentStageState.lockedTargets || []).find((item) => !/\/[^/]+\.[A-Za-z0-9]+$/.test(String(item || ''))) || '';
    const recentRecoveryEvent = readRecoveryEvents().slice(-1)[0] || null;
    const recentSuccess = [...workingMemory.getRecent(12)]
      .reverse()
      .find((entry) => !entry.error && !['loop_guard', 'verification_failed', 'parse_error'].includes(entry.action));

    // Fix D: verification snapshot — ground-truth of which checks currently pass/fail.
    // Prevents compaction LLM from summarising a wrong diagnosis (e.g. "board.py is broken"
    // when board.py actually passes and game.py is the failing file).
    let verificationSnapshot = '';
    try {
      const cmdHistory = readCommandsRun();
      // Collect the most recent result for each unique verification command
      const seen = new Map();
      for (const entry of cmdHistory.slice().reverse()) {
        if (entry.skipped) continue;
        const cmd = String(entry.command || '').trim();
        if (!cmd || seen.has(cmd)) continue;
        // Include python3/node test/check commands (not pure install/setup)
        const isCheck = /^python3?\s+\S+\.py\b/.test(cmd) ||
                        /^python3?\s+-c\b/.test(cmd) ||
                        /^node\s+(--test|src\/|tests?\/)/.test(cmd) ||
                        /^pytest\b/.test(cmd) ||
                        /^npm\s+test\b/.test(cmd);
        if (isCheck) seen.set(cmd, entry);
      }
      if (seen.size > 0) {
        const lines = [...seen.entries()].map(([cmd, entry]) => {
          const status = Number(entry.exitCode) === 0 ? 'PASS' : 'FAIL';
          const snippet = String(entry.outputSnippet || '').replace(/\s+/g, ' ').trim().slice(0, 100);
          return `  ${status}: ${cmd.slice(0, 80)}${snippet ? ` → ${snippet}` : ''}`;
        });
        verificationSnapshot = lines.join('\n');
      }
    } catch { /* non-critical */ }

    return {
      currentStage: currentStageState.currentStage,
      lockedRoot,
      blockedReason: runtime.stageBlockedReason,
      missingOutputs: [...runtime.missingWorkspaceArtifacts, ...runtime.missingOutputs],
      nextRequiredAction: runtime.nextRequiredActionHint,
      lastSuccessfulMilestone: recentSuccess
        ? `Step ${recentSuccess.step}: ${recentSuccess.action}`
        : '',
      recentRecoveryRule: recentRecoveryEvent
        ? `${recentRecoveryEvent.type}: ${recentRecoveryEvent.correctiveAction}`
        : '',
      verificationSnapshot,
    };
  }
}

// ── Completion Verification ──────────────────────────────────
// Parser, guards, and recovery functions extracted to parser.js, guards.js, recovery.js

async function verifyCompletion(summary, memory, priorFailures = 0) {
  const MAX_RETRIES = 2;
  const MAX_TOTAL_FAILURES = parseInt(process.env.AGENT_VERIFY_MAX_FAILURES || '6', 10);
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const messages = buildVerificationMessages(summary, memory);
      const response = await chatCompletion(messages, { temperature: 0.1 });
      // Truncated output is never trustworthy — count as failure and retry
      if (response.finishReason === 'length') {
        throw new Error('Verification response truncated (finish_reason=length) — output budget exceeded');
      }
      const text = response.content.trim();

      // Try to parse verification JSON
      try {
        const jsonMatch = text.match(/\{[\s\S]*"verified"[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          log(`Verification: ${result.verified ? 'PASSED' : 'FAILED'} — ${result.reason || 'no reason'}`);
          return result.verified === true;
        }
      } catch {}

      // Fallback: keyword check — require positive signal WITHOUT negation nearby
      const lower = text.toLowerCase();
      const hasPositive = lower.includes('verified') || lower.includes('complete') || lower.includes('true');
      const hasNegative = lower.includes('not verified') || lower.includes('not complete') || lower.includes('incomplete')
        || lower.includes('false') || lower.includes('fail') || lower.includes('missing')
        || lower.includes('not true') || lower.includes('rejected');
      return hasPositive && !hasNegative;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const delay = 2000 * (attempt + 1);
        log(`Verification attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  log(`Verification failed after ${MAX_RETRIES + 1} attempts: ${lastErr?.message || 'unknown error'} — rejecting completion.`);
  // Force-accept only when: (a) LLM verification itself keeps failing (network/parse),
  // NOT when the LLM says the task is genuinely incomplete. The threshold is high
  // enough that the agent must have retried many times. With smoke test enabled,
  // the hard gate already blocks unverified completions, so this is a last resort.
  if ((priorFailures + 1) >= MAX_TOTAL_FAILURES) {
    log(`Verification forced-accept after ${priorFailures + 1} total failures (verification LLM unreliable).`);
    saveMemory('Forced task completion after repeated verification failures — LLM verification was unreliable, not necessarily task complete', 'experience', ['verification', 'forced']);
    return true;
  }
  return false;
}

// ── Logger ───────────────────────────────────────────────────

function log(msg) {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.error(`[${timestamp}] ${msg}`);
}
