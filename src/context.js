// advanced-agent-loop/src/context.js
// 5-Layer Context Assembly — builds the structured prompt the LLM sees each step.
//
// The LLM NEVER sees raw conversation history. It sees a prompt assembled from files.
// This is the key to long-running stability: rebuild context from truth (files), not memory.
//
// Context Layers (inspired by OpenClaw SOUL.md research):
//   Layer 1: Identity    — SOUL.md (who I am) + AGENTS.md (how I work)
//   Layer 2: Knowledge   — MEMORY.md + learnings + user profile
//   Layer 3: State       — Plan, progress, context summary, focus chain
//   Layer 4: Session     — Working memory (recent steps), stale file alerts
//   Layer 5: Guidance    — Focus prompts, error warnings, step instructions

import config from './config.js';
import { readTask, readContextSummary, readLearnings, readFilesTouched, readFocusChain, readRecoveryEvents } from './state.js';
import { getPlanStatusSummary, getCurrentSubtask } from './plan.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { getSkillToolDefinitions, getSkillsSummary } from './skills.js';
import { buildIdentityBlock, buildRecoveryPrompt, buildFlushPrompt } from './identity.js';
import { getRecentMemories, getMemorySummary } from './memory-store.js';
import { getRuntimeStatusBlock } from './stages.js';

// ── System Prompt ──────────────────────────────────────────────

function buildSystemPrompt(identityBlock, routedTools = null) {
  // Use routed tool subset if provided by the router, otherwise inject all tools.
  // Routed tools cap at 4 per step, keeping the prompt within the context budget.
  const allTools = routedTools ?? [...TOOL_DEFINITIONS, ...getSkillToolDefinitions()];
  const toolDocs = allTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));

  return `${identityBlock}

---

# Autonomous Agent — Operating Instructions

## Rules
1. Execute ONE tool per step. Think before acting.
2. Always read files before editing them.
3. Verify your changes work (run tests, check output).
4. Update the plan as you progress (mark tasks done, add new ones).
5. Record learnings and save memories when you discover something important.
6. If stuck for 3+ steps on the same issue, try a completely different approach.
7. When finished, use the \`finish\` tool with a summary.
8. **Write it down** — If it matters, save it to a file. Mental notes don't survive compaction.
9. Use \`save_memory\` to persist important discoveries to your memory system.
10. Use \`create_skill\` ONLY to create reusable JS tool extensions (requires a JavaScript "implementation" field). NEVER use it to create project source files — for those, use \`write_file\` once per file.
11. **ES Modules**: This workspace uses \`"type": "module"\` in package.json. Always use \`import\`/\`export\` syntax. NEVER use \`require()\` or \`module.exports\`. Use \`.js\` extensions in relative imports (e.g. \`import { x } from './math.js'\`).
12. Keep your "thought" field brief (1-2 sentences). Do NOT write long explanations inside \`<think>\` blocks — the output token budget is limited.
13. \`think\` is for hard problems only. Use it ONLY in these three cases:
    (a) Debugging a non-obvious error that spans multiple files or systems — when the root cause is not immediately clear.
    (b) Choosing between two mutually exclusive approaches before a destructive or hard-to-reverse action (e.g., overwriting a file, running a migration).
    (c) Planning a chain of 5+ tightly interdependent steps before starting any of them.
    NEVER use \`think\` for: reading a file, writing a file, running a command, listing a directory, updating the plan, or any task you can complete in under 3 steps. The \`thought\` field in your JSON already covers those cases — it is free reasoning that costs no extra step.
    HARD RULE: You may NEVER call \`think\` twice in a row. After one \`think\` step, the very next step MUST be a concrete action (read_file, write_file, run_command, update_plan, finish, etc.). If you catch yourself wanting to think again, you are stalling — act instead.
14. Finalization discipline: once you are verifying final artifacts, do not keep re-reading the same output files. After one or two checks, you must do one of these: (a) repair a specific artifact with \`write_file\` or \`edit_file\`, (b) run one concrete validation command, (c) update the plan with the exact blocker, or (d) call \`finish\` if contracts are already satisfied.
15. Evidence discipline: never claim a command, test, package, framework, or artifact succeeded unless it is supported by actual file content or a successful command result in the current run. If the evidence is missing, gather it or report the uncertainty as WARN/FAIL.
16. Runtime smoke test: after creating an application, ALWAYS write a file called \`_smoke_test.py\` (or \`_smoke_test.js\`) in the workspace root and run it. The smoke test must:
    - Import modules using PACKAGE imports (e.g. \`from snake_game.snake import Snake\`), NOT relative imports from inside the package directory
    - Instantiate key classes and call their main methods
    - NOT use any interactive features (no GUI, no curses.wrapper, no input(), no blocking I/O)
    - Print "SMOKE OK" at the end if everything passes
    - Run from the workspace root: \`python3 _smoke_test.py\` (NOT \`cd package && python3 ...\`)
    If the smoke test crashes, read the traceback, fix the bug with \`edit_file\`, and re-run until it prints "SMOKE OK". Never call \`finish\` until the smoke test passes.

## Available Tools
${JSON.stringify(toolDocs, null, 2)}

## Tool Name Quick Reference
Exact names only — the model may not see all categories on every step:
- **Files**: \`read_file\`, \`write_file\`, \`edit_file\`, \`list_dir\`, \`search_files\`, \`glob\`, \`patch\`
- **Shell**: \`run_command\`
- **Plan/Finish**: \`think\`, \`finish\`, \`update_plan\`, \`todowrite\`, \`todoread\`, \`add_learning\`
- **Memory**: \`save_memory\`, \`search_memory\`
- **Web**: \`webfetch\`, \`websearch\`, \`lsp\`
- **Skills**: \`create_skill\`

## Tool Usage Examples (use EXACTLY these argument names)

edit_file — replace exact text in a file:
{"thought":"Fix the import","tool":"edit_file","args":{"path":"src/app.py","oldString":"from config import X","newString":"from .config import X"}}

write_file — create or overwrite a file:
{"thought":"Create config","tool":"write_file","args":{"path":"src/config.py","content":"WIDTH = 40\\nHEIGHT = 20"}}

run_command — run a shell command (arg name is "command", NOT "cmd"):
{"thought":"Test imports","tool":"run_command","args":{"command":"python3 -c \\"import mymod; print('ok')\\"" }}

read_file — read a file:
{"thought":"Check the file","tool":"read_file","args":{"path":"src/app.py"}}

## Response Format
Output EXACTLY ONE raw JSON object. No prose before or after it. No markdown code fences.
No explanation outside the object. Required fields:
- "thought": Brief reasoning about what to do next (1-3 sentences)
- "tool": The exact tool name to call
- "args": An object with the tool's arguments

Correct output (the entire response must look like this):
{"thought":"I need to list the workspace to see what already exists.","tool":"list_dir","args":{"path":"."}}`;

}

// ── Focus Chain ────────────────────────────────────────────────

function getFocusChainBlock() {
  const chain = readFocusChain();
  if (!chain || chain.includes('no focus items set')) return '';

  // Parse checkboxes from focus chain
  const items = chain.split('\n').filter(l => l.match(/^(\s*[-*]|\s*\d+\.)\s+\[[ xX]\]/));
  if (items.length === 0) return '';

  const pending = items.filter(l => l.match(/^[-*]\s+\[ \]/));
  if (pending.length === 0) return '✅ All focus chain items completed.';

  return `## Focus Chain (human-set priorities)\n${items.join('\n')}`;
}

// ── Focus Prompts ──────────────────────────────────────────────

function formatStepWindow(step) {
  return config.maxSteps > 0 ? `${step}/${config.maxSteps}` : `${step}/unbounded`;
}

function getFocusPrompt(step, currentSubtask) {
  if (step <= 20) return ''; // Fresh, no reminder needed

  const task = currentSubtask
    ? `Current subtask: "${currentSubtask.task}" (Phase: ${currentSubtask.phase})`
    : 'No specific subtask — check the plan.';

  if (step <= 50) {
    return `\n📋 Step ${formatStepWindow(step)}. ${task}`;
  }

  if (step <= 100) {
    return `\n⚠️ FOCUS CHECK — Step ${formatStepWindow(step)}. ${task}\nYou've been working for ${step} steps. Stay focused on the current subtask. If blocked, mark it and move on.`;
  }

  if (step <= 250) {
    return `\n🚨 DRIFT WARNING — Step ${formatStepWindow(step)}. ${task}\nYou are ${step} steps in. Complete your current subtask NOW or mark it blocked.`;
  }

  return `\n🔴 LONG RUN — Step ${formatStepWindow(step)}. ${task}\nDeep in a long session. Trust your memory files. Check plan.md. Stay on track.`;
}

// ── Context Summary Bounding ───────────────────────────────────

/**
 * Inject a bounded slice of the context summary to prevent prompt bloat.
 * Preserves the head (task anchor, files changed) and tail (where I left off),
 * inserting a truncation marker in the middle when needed.
 *
 * @param {string} summary
 * @returns {string}
 */
function boundContextSummary(summary) {
  // Scale summary budget with context window:
  // 12k → ~1800 chars total; 32k → ~4000; 128k → ~12000
  const budget = Math.min(24000, Math.max(1800, Math.floor(config.contextWindow * 0.15)));
  const headChars = Math.floor(budget * 0.45);
  const tailChars = budget - headChars;

  if (summary.length <= budget) return summary;
  // Reserve space for the separator so the total output stays within budget
  const separator = '\n\n... [NNNN chars truncated — see context-summary.md for full history] ...\n\n';
  const separatorOverhead = separator.length + 10; // +10 for variable-length skipped count
  const effectiveBudget = budget - separatorOverhead;
  const headSlice = Math.floor(effectiveBudget * 0.45);
  const tailSlice = effectiveBudget - headSlice;
  const head = summary.slice(0, headSlice);
  const tail = summary.slice(-tailSlice);
  const skipped = summary.length - headSlice - tailSlice;
  return `${head}\n\n... [${skipped} chars truncated — see context-summary.md for full history] ...\n\n${tail}`;
}

function getCompactionAnnotation(summary) {
  if (String(summary || '').includes('compaction_mode=fallback')) {
    return '⚠️ This context summary was generated by fallback compaction mode. Re-verify critical details from source files.';
  }
  return '';
}

// ── Stale File Alerts ──────────────────────────────────────────

function getStaleFileAlerts() {
  const tracked = readFilesTouched();
  const alerts = [];

  for (const [filePath, freshness] of Object.entries(tracked.freshness || {})) {
    if (!freshness || typeof freshness !== 'object') continue;
    if (!freshness.requiresRereadBeforeEdit && !freshness.staleSummaryClaims) continue;
    const reasons = [];
    if (freshness.requiresRereadBeforeEdit) reasons.push('current file must be re-read before further edits');
    if (freshness.staleSummaryClaims) reasons.push('older summary claims about this file may be stale');
    alerts.push(`⚠️ ${filePath}: ${reasons.join('; ')}.`);
  }

  return alerts.length > 0 ? '\n## Stale File Alerts\n' + alerts.join('\n') : '';
}

// ── Think Guard ───────────────────────────────────────────────

/**
 * Returns a hard warning if the last working-memory entry was `think`.
 * Prevents the agent from issuing two consecutive think steps.
 */
function getThinkGuard(memory) {
  const recent = memory.getRecent(1);
  if (recent.length > 0 && recent[0].action === 'think') {
    return `🚫 THINK GUARD: You just called think. You MUST take a concrete action this step (read_file, write_file, run_command, update_plan, finish, etc.). Do NOT call think again.`;
  }
  return '';
}

// ── Error Pattern Detection ────────────────────────────────────

function getErrorWarning(consecutiveErrors, lastErrorTool) {
  if (consecutiveErrors < 2) return '';

  if (consecutiveErrors >= config.maxConsecutiveErrors) {
    return `\n🛑 CRITICAL: ${consecutiveErrors} consecutive errors. You MUST try a completely different approach. Re-read relevant files, reconsider your strategy, or update the plan.`;
  }

  if (consecutiveErrors >= config.maxSameToolErrors && lastErrorTool) {
    return `\n⚠️ ${consecutiveErrors} consecutive errors (last tool: ${lastErrorTool}). Try a different approach or tool.`;
  }

  return `\n⚠️ ${consecutiveErrors} errors in a row. Double-check your approach.`;
}

// ── Main Context Builder ───────────────────────────────────────

/**
 * Build the full messages array for the LLM.
 * 5-layer context assembly: Identity → Knowledge → State → Session → Guidance.
 *
 * @param {Object} opts
 * @param {number} opts.step - Current step number
 * @param {import('./memory.js').WorkingMemory} opts.memory - Working memory
 * @param {number} opts.consecutiveErrors - Error count
 * @param {string} opts.lastErrorTool - Last tool that errored
 * @param {boolean} opts.postCompaction - Whether we just recovered from compaction
 * @param {boolean} opts.preCompactionFlush - Whether to inject flush prompt
 * @param {string} opts.runtimeGuidance - Runtime loop guidance (soft anti-stall hints)
 * @returns {Array<{role:string, content:string}>}
 */
export function buildMessages({
  step,
  memory,
  consecutiveErrors = 0,
  lastErrorTool = '',
  postCompaction = false,
  preCompactionFlush = false,
  runtimeGuidance = '',
  stageGuidance = '',
  stageState = null,
  workspace = '',
  lastCompactionStep = 0,
  compactionCount = 0,
  routedTools = null,   // optional: routed tool subset from router.js (max 4 definitions)
}) {
  const task = readTask();
  const contextSummary = readContextSummary();
  const learnings = readLearnings();
  const planStatus = getPlanStatusSummary();
  const currentSubtask = getCurrentSubtask();

  // ── Layer 1: Identity (always present, survives compaction) ──
  const identityBlock = buildIdentityBlock();
  const systemPrompt = buildSystemPrompt(identityBlock, routedTools);

  // ── Build user message from structured sections ──────────────
  const sections = [];

  // ── Layer 2: Knowledge ──────────────────────────────────────
  // Task — scale truncation limit with context window
  // 12k model → 2000 chars; 32k → 5000; 128k → no truncation needed
  const MAX_TASK_CHARS = parseInt(process.env.AGENT_MAX_TASK_CHARS || '0', 10) ||
    Math.min(32000, Math.max(2000, Math.floor(config.contextWindow * 0.25)));
  const taskText = task || 'No task specified.';
  const taskDisplay = taskText.length > MAX_TASK_CHARS
    ? `${taskText.slice(0, MAX_TASK_CHARS)}\n... [truncated — full task in .agent/task.md]`
    : taskText;
  sections.push(`## Your Task\n${taskDisplay}`);

  // Skills summary
  const skillsStatus = getSkillsSummary();
  if (skillsStatus !== 'No custom skills loaded.') {
    sections.push(`## Custom Skills Available\n${skillsStatus}`);
  }

  // Memory summary
  const memSummary = getMemorySummary();
  if (memSummary !== 'No persistent memories yet.') {
    sections.push(`## Memory Status\n${memSummary}`);
  }

  // ── Layer 3: State ──────────────────────────────────────────
  // Plan status
  sections.push(`## Plan Status\n${planStatus}`);

  if (stageState && workspace) {
    const recentRecoveryEvent = readRecoveryEvents().slice(-1)[0] || null;
    const recoverySummary = recentRecoveryEvent
      ? `${recentRecoveryEvent.type}: ${recentRecoveryEvent.correctiveAction}`
      : '';
    const exposedToolNames = (routedTools ?? [...TOOL_DEFINITIONS, ...getSkillToolDefinitions()])
      .map(t => t.function.name);
    const runtimeStatus = getRuntimeStatusBlock(stageState, workspace, {
      compactionCount,
      recentRecoveryRule: recoverySummary,
      availableTools: exposedToolNames,
    });
    if (runtimeStatus) sections.push(runtimeStatus);
  }

  // Focus chain (human-set priorities)
  const focusChain = getFocusChainBlock();
  if (focusChain) sections.push(focusChain);

  // Context summary (compacted history) — injected with head+tail bounds
  if (contextSummary) {
    const annotation = getCompactionAnnotation(contextSummary);
    const body = boundContextSummary(contextSummary);
    sections.push(`## Previous Work Reference\nReference only. Do NOT summarize this section back to the user. Use it only to choose the next concrete tool call.\n${annotation ? annotation + '\n\n' : ''}${body}`);
    const gap = step - (lastCompactionStep || 0);
    if (gap > 30) {
      sections.push(`⚠️ Context summary is ${gap} steps old. Re-check plan and key files before major edits.`);
    }
  }

  // Learnings
  if (learnings && learnings.trim() !== '# Learnings\n') {
    const notes = learnings.replace('# Learnings\n', '').trim();
    if (notes) sections.push(`## Key Learnings\n${notes}`);
  }

  // Recent persistent memories (today's log)
  const recentMem = getRecentMemories(3);
  if (recentMem) sections.push(recentMem);

  // ── Layer 4: Session ────────────────────────────────────────
  // Recent actions (working memory)
  const recentContext = memory.formatForContext();
  if (recentContext) {
    sections.push(`## Recent Actions\n${recentContext}`);
  }

  // Stale file alerts
  const staleAlerts = getStaleFileAlerts();
  if (staleAlerts) sections.push(staleAlerts);

  // ── Layer 5: Guidance ───────────────────────────────────────
  // Post-compaction recovery prompt — suppressed when agent is in active repair mode
  // (narrativeRecoverySuppressed=true) to avoid adding noise while the model fixes a
  // specific broken artifact.
  if (postCompaction && !stageState?.narrativeRecoverySuppressed) {
    const lastAction = memory.getRecent(1)[0]?.action;
    const editActions = new Set(['write_file', 'edit_file', 'patch']);
    if (!editActions.has(lastAction)) {
      sections.push(buildRecoveryPrompt());
      if (stageState && workspace) {
        const recentRecoveryEvent = readRecoveryEvents().slice(-1)[0] || null;
        const runtimeStatus = getRuntimeStatusBlock(stageState, workspace, {
          compactionCount,
          recentRecoveryRule: recentRecoveryEvent
            ? `${recentRecoveryEvent.type}: ${recentRecoveryEvent.correctiveAction}`
            : '',
        });
        sections.push(`## Post-Compaction Anchor\nResume from runtime truth, not memory reconstruction.\nDo NOT narrate or summarize this anchor. Use it to pick one concrete next tool call.\n${runtimeStatus}`);
      }
    } else {
      sections.push('Context was compacted. Continue your current file operation carefully.');
    }
  }

  // Pre-compaction flush prompt
  if (preCompactionFlush) {
    sections.push(buildFlushPrompt());
  }

  // Think guard (hard block on consecutive think calls)
  const thinkGuard = getThinkGuard(memory);
  if (thinkGuard) sections.push(thinkGuard);

  // Error warnings
  const errorWarning = getErrorWarning(consecutiveErrors, lastErrorTool);
  if (errorWarning) sections.push(errorWarning);

  // Focus prompt
  const focus = getFocusPrompt(step, currentSubtask);
  if (focus) sections.push(focus);

  // Runtime guidance from loop heuristics (soft, non-blocking)
  if (runtimeGuidance) {
    sections.push(`## Runtime Guidance\n${runtimeGuidance}`);
  }

  if (stageGuidance) {
    sections.push(`## Stage Guidance\n${stageGuidance}`);
  }

  // Step instruction
  sections.push(`\n---\nStep ${formatStepWindow(step)}. What's your next action? Respond with JSON: { "thought": "...", "tool": "...", "args": {...} }`);

  // ── Hard budget enforcement ──────────────────────────────────
  // Ensure the total prompt fits within (contextWindow - maxOutputTokens).
  // If it doesn't, progressively drop the longest optional sections.
  // Uses ~3.5 chars/token as a conservative estimate.
  const CHARS_PER_TOKEN = 3.5;
  const maxInputTokens = config.contextWindow - config.maxOutputTokens;
  const maxInputChars = Math.floor(maxInputTokens * CHARS_PER_TOKEN);

  let userContent = sections.join('\n\n');
  let totalChars = systemPrompt.length + userContent.length;

  if (totalChars > maxInputChars) {
    // Drop sections from heaviest to lightest: context summary, learnings, memory status
    const droppableTags = ['## Previous Work Reference', '## Key Learnings', '## Memory Status', '## Custom Skills Available'];
    for (const tag of droppableTags) {
      if (totalChars <= maxInputChars) break;
      const idx = sections.findIndex(s => s.startsWith(tag));
      if (idx !== -1) {
        sections.splice(idx, 1);
        userContent = sections.join('\n\n');
        totalChars = systemPrompt.length + userContent.length;
      }
    }

    // If still over budget, truncate the Recent Actions section
    if (totalChars > maxInputChars) {
      const actionsIdx = sections.findIndex(s => s.startsWith('## Recent Actions'));
      if (actionsIdx !== -1) {
        const excess = totalChars - maxInputChars;
        const original = sections[actionsIdx];
        const trimTo = Math.max(200, original.length - excess - 100);
        sections[actionsIdx] = original.slice(0, trimTo) + '\n... [trimmed to fit context window]';
        userContent = sections.join('\n\n');
        totalChars = systemPrompt.length + userContent.length;
      }
    }
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

/**
 * Build a verification prompt to double-check completion.
 * Uses recent actions as evidence, not just plan status (plan may be stale).
 * @param {string} taskSummary - What the agent claims it accomplished
 * @param {import('./memory.js').WorkingMemory} memory - Working memory with recent actions
 */
export function buildVerificationMessages(taskSummary, memory) {
  const task = readTask();
  const planStatus = getPlanStatusSummary();

  // Include recent actions as evidence of actual work done
  const recentActions = memory ? memory.getRecent(8).map(e => {
    const resultSnippet = (e.result || '').slice(0, 200);
    return `- Step ${e.step}: ${e.action}${e.error ? ' (ERROR)' : ''} → ${resultSnippet}`;
  }).join('\n') : 'No action history available.';

  const filesModified = memory ? [...new Set(memory.entries
    .filter(e => ['write_file', 'edit_file', 'patch'].includes(e.action) && !e.error)
    .map(e => e.args?.path)
    .filter(Boolean))] : [];
  const commandsSucceeded = memory ? memory.entries
    .filter(e => e.action === 'run_command' && !e.error)
    .slice(-10)
    .map(e => `${e.args?.command || ''} => ${(e.result || '').slice(0, 120)}`) : [];

  // Check if a runtime smoke test was executed (must be _smoke_test file, not just any import check)
  // Require SMOKE OK in the result — running the smoke test isn't enough, it must pass
  const smokeTestRequired = config.requireSmokeTest;
  const smokeTestRan = memory ? memory.entries.some(e =>
    e.action === 'run_command' && !e.error &&
    String(e.result || '').includes('SMOKE OK')
  ) : false;

  const smokeTestSystemRule = smokeTestRequired
    ? 'IMPORTANT: For application tasks, a runtime smoke test must have been run (a script that instantiates key classes and calls methods without user interaction). If no smoke test was run, verification MUST fail with reason explaining a smoke test is needed.'
    : 'Smoke testing is disabled for this session. Verify based on actual file changes, command outputs, and task requirements only.';

  const smokeTestSection = !smokeTestRequired
    ? 'Smoke test: DISABLED (not required for this task type)'
    : smokeTestRan
      ? 'PASSED — A smoke test was executed successfully.'
      : 'NOT RUN — No runtime smoke test was detected. For application tasks, the agent must write and run a smoke test script that instantiates key classes and calls methods without user interaction.';

  const smokeTestVerifyRule = smokeTestRequired
    ? 'If this is an application task and no smoke test was run, verification should FAIL.'
    : 'Smoke test is not required — verify based on whether the actual deliverables (files, outputs) match the task requirements.';

  return [
    {
      role: 'system',
      content: `You are a code reviewer verifying whether a task was completed correctly. Focus on the ACTUAL ACTIONS taken and their results — not just the plan status (the agent may have completed work without updating plan checkboxes). ${smokeTestSystemRule} Respond with JSON: { "verified": true/false, "reason": "..." }`,
    },
    {
      role: 'user',
      content: `## Original Task\n${task}\n\n## Plan Status\n${planStatus}\n\n## Recent Actions (evidence of work done)\n${recentActions}\n\n## Files Modified\n${filesModified.length ? filesModified.join('\n') : 'none'}\n\n## Successful Commands\n${commandsSucceeded.length ? commandsSucceeded.join('\n') : 'none'}\n\n## Runtime Smoke Test\n${smokeTestSection}\n\n## Agent's Completion Summary\n${taskSummary}\n\n---\nBased on the ACTUAL ACTIONS and their results, is this task complete? The plan checkboxes may be stale — focus on whether the work was actually done (files created, commands run successfully, tests passing, etc). ${smokeTestVerifyRule}`,
    },
  ];
}
