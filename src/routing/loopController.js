// src/routing/loopController.js
//
// Routed loop controller.
// Drop-in complement to src/loop.js that adds deterministic tool routing,
// per-step tool freezing, and a hard repeated-call guard.
//
// Architecture decisions:
//   • Routing runs BEFORE each LLM call so the model only ever sees the
//     tools it needs — reducing context entropy for quantized models.
//   • The freeze system gives the model one extra step with the same tool
//     after selection, then re-routes.  This mirrors how a human engineer
//     stays focused on one sub-task before moving on.
//   • The repeat guard is checked BEFORE execution.  Skipping the call
//     entirely is safer than executing and getting the same result again.
//   • LLM client is injected via parameter so the controller stays testable
//     without network calls.

import { route, explainRoute } from './router.js';
import { getExposedTools, previewExposure } from './toolManager.js';
import { executeRegistryTool, getToolCategory } from './toolRegistry.js';
import { setWorkspace } from '../state.js';
import { setLLMLogDir } from '../llm.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_STEPS          = 500;
const MAX_IDENTICAL_RUNS = 3;   // hard-stop after N identical calls in a row
const MAX_PARSE_ERRORS   = 5;   // hard-stop after N consecutive parse failures
const FINISH_PREFIX      = '__FINISH__:';

// ── Message helpers ───────────────────────────────────────────────────────────

/**
 * Build the system prompt.
 * Intentionally compact — only what the model needs for this step.
 */
function buildSystemPrompt(tools) {
  const toolList = tools
    .map(t => `• ${t.function.name}: ${t.function.description}`)
    .join('\n');

  return [
    'You are an autonomous agent.  Respond with EXACTLY one JSON object, no prose.',
    '',
    'Format for tool calls:',
    '{"thought":"<brief reasoning>","tool":"<tool_name>","args":{...}}',
    '',
    'Format to finish:',
    '{"thought":"<brief reasoning>","tool":"finish","args":{"summary":"<result>"}}',
    '',
    'Available tools this step:',
    toolList,
    '',
    'Rules:',
    '• Output valid JSON only — no markdown, no code blocks, no extra text.',
    '• Use ES module syntax in any code you write (import/export, not require).',
    '• Never call the same tool with identical arguments twice in a row.',
  ].join('\n');
}

/**
 * Build the user message for one step.
 */
function buildUserMessage(task, history, step, runtimeGuidance) {
  const lines = [`## Task\n${task}`, `## Step\n${step}`];

  if (history.length > 0) {
    const recent = history.slice(-6); // last 6 entries to stay within token budget
    lines.push('## Recent steps');
    for (const h of recent) {
      const resultSnippet = String(h.result ?? '').slice(0, 300);
      const status = h.error ? 'ERROR' : 'ok';
      lines.push(`Step ${h.step} [${h.action}] → ${status}: ${resultSnippet}`);
    }
  }

  if (runtimeGuidance) {
    lines.push(`## Guidance\n${runtimeGuidance}`);
  }

  return lines.join('\n\n');
}

// ── Response parser ───────────────────────────────────────────────────────────

/**
 * Parse the model's raw text response into { toolName, toolArgs, finalAnswer }.
 * Handles JSON wrapped in markdown code fences if present.
 *
 * @returns {{ toolName: string|null, toolArgs: object, finalAnswer: string|null, raw: string }}
 */
function parseResponse(text) {
  let src = text.trim();

  // Strip optional markdown code fence
  if (src.startsWith('`')) {
    const m = src.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) src = m[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(src);
  } catch {
    return { toolName: null, toolArgs: {}, finalAnswer: null, raw: text };
  }

  const toolName = parsed.tool ?? null;
  const toolArgs = parsed.args ?? {};

  if (toolName === 'finish') {
    return {
      toolName: 'finish',
      toolArgs,
      finalAnswer: toolArgs.summary ?? parsed.thought ?? 'Task completed.',
      raw: text,
    };
  }

  return { toolName, toolArgs, finalAnswer: null, raw: text };
}

// ── Repeat guard ──────────────────────────────────────────────────────────────

/**
 * Check whether this exact call (tool + args) appeared in the last N history entries.
 *
 * @param {string}  toolName
 * @param {object}  toolArgs
 * @param {object[]} history
 * @returns {boolean}
 */
function isIdenticalRepeat(toolName, toolArgs, history) {
  if (history.length === 0) return false;

  const argsKey = JSON.stringify(toolArgs ?? {});
  let streak = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.action !== toolName) break;
    if (JSON.stringify(h.args ?? {}) !== argsKey) break;
    streak++;
    if (streak >= MAX_IDENTICAL_RUNS) return true;
  }
  return false;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

// ── Single-step freeze routed loop ───────────────────────────────────────────

/**
 * Routed loop with proper single-step freeze.
 *
 * @param {object} opts
 */
export async function runLoop({
  task,
  llmClient,
  workspace  = null,
  maxSteps   = MAX_STEPS,
  onStep,
  verbose    = false,
}) {
  if (!task)      throw new Error('task is required');
  if (!llmClient) throw new Error('llmClient is required');
  if (workspace) { setWorkspace(workspace); setLLMLogDir(workspace); }

  const history = [];
  let frozenTool      = null;   // tool to freeze for current step (null = route freely)
  let pendingFreeze   = null;   // tool selected last step → freeze for THIS step
  let runtimeGuidance = '';
  let identicalStreak = 0;
  let parseErrorStreak = 0;
  let exitReason      = 'max_steps';
  let exitSummary     = '';

  for (let step = 0; step < maxSteps; step++) {

    // Apply pending freeze from previous step
    frozenTool    = pendingFreeze;
    pendingFreeze = null;

    // ── 1 + 2. Route + expose ─────────────────────────────────────────────────
    const lastStep = history[history.length - 1] ?? null;
    const category = frozenTool
      ? (getToolCategory(frozenTool) ?? 'planning')
      : route(task, lastStep, step);

    const tools = getExposedTools(category, frozenTool);

    if (verbose) {
      process.stderr.write(
        `[loop] step=${step + 1} category=${category} frozen=${frozenTool ?? '-'} tools=${previewExposure(category, frozenTool).join(',')}\n`
      );
    }

    // ── 3. LLM call ───────────────────────────────────────────────────────────
    const messages = [
      { role: 'system', content: buildSystemPrompt(tools) },
      { role: 'user',   content: buildUserMessage(task, history, step + 1, runtimeGuidance) },
    ];

    let rawResponse;
    try {
      const resp = await llmClient(messages, tools);
      rawResponse = resp.content ?? '';
    } catch (err) {
      history.push({
        step: step + 1, action: 'llm_error', args: {}, error: true,
        result: `LLM error: ${err.message}`, timestamp: Date.now(),
      });
      runtimeGuidance = `LLM error: ${err.message}`;
      continue;
    }

    // ── 4. Parse ──────────────────────────────────────────────────────────────
    const { toolName, toolArgs, finalAnswer } = parseResponse(rawResponse);

    if (!toolName) {
      parseErrorStreak++;
      history.push({
        step: step + 1, action: 'parse_error', args: {}, error: true,
        result: rawResponse.slice(0, 300), timestamp: Date.now(),
      });
      runtimeGuidance = `Parse error (${parseErrorStreak}/${MAX_PARSE_ERRORS}): output exactly one JSON object, no prose or markdown.`;
      frozenTool    = null;
      pendingFreeze = null;
      if (parseErrorStreak >= MAX_PARSE_ERRORS) {
        exitReason  = 'error';
        exitSummary = `Too many consecutive parse failures (${parseErrorStreak}).`;
        break;
      }
      continue;
    }

    parseErrorStreak = 0;
    runtimeGuidance  = '';

    // ── 5. Final answer ───────────────────────────────────────────────────────
    if (finalAnswer !== null) {
      exitReason  = 'completed';
      exitSummary = finalAnswer;
      history.push({
        step: step + 1, action: 'finish', args: toolArgs, error: false,
        result: finalAnswer, timestamp: Date.now(),
      });
      if (onStep) onStep({ step: step + 1, tool: 'finish', result: finalAnswer, history });
      break;
    }

    // ── 6. Repeat guard ───────────────────────────────────────────────────────
    if (isIdenticalRepeat(toolName, toolArgs, history)) {
      identicalStreak++;
      const msg = `Repeat guard: \`${toolName}\` with identical args (${identicalStreak + 1}×). Change strategy.`;
      history.push({
        step: step + 1, action: 'repeat_guard', args: {}, error: false,
        result: msg, timestamp: Date.now(),
      });
      runtimeGuidance = msg;
      pendingFreeze   = null; // force re-route next step

      if (identicalStreak >= MAX_IDENTICAL_RUNS) {
        exitReason  = 'error';
        exitSummary = `Hard stop: ${toolName} repeated ${identicalStreak + 1}× with identical args.`;
        break;
      }
      continue;
    }

    identicalStreak = 0;

    // ── 7. Execute ────────────────────────────────────────────────────────────
    const { result, error } = executeRegistryTool(toolName, toolArgs);

    history.push({
      step: step + 1, action: toolName, args: toolArgs, error,
      result, timestamp: Date.now(),
    });

    if (onStep) onStep({ step: step + 1, tool: toolName, args: toolArgs, result, error, history });

    // ── 8. Schedule freeze for next step ──────────────────────────────────────
    // Next iteration will expose ONLY this tool (+ finish), anchoring the
    // model in the same context for one follow-up action.
    pendingFreeze = toolName;
  }

  return { exitReason, summary: exitSummary, steps: history.length, history };
}
