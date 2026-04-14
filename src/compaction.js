// advanced-agent-loop/src/compaction.js
// Context compaction via LLM summarization.
// Enhanced with OpenClaw-inspired pre-compaction memory flush
// and post-compaction identity recovery.
//
// Compaction lifecycle:
//   1. FLUSH — Save critical memories from working memory to persistent files
//   2. COMPRESS — Collapse repeated parse_error streaks in the input segment
//   3. SUMMARIZE — LLM compresses old steps into structured summary (with fallback)
//   4. RECOVER — Inject identity + recovery prompt so agent re-orients
//
// Resilience patterns (OpenClaw/Kilo):
//   - Deterministic fallback when LLM summarization fails
//   - Hard summary size cap to prevent re-bloat
//   - mode=llm|fallback metadata on every written summary

import { chatCompletion } from './llm.js';
import { readContextSummary, writeContextSummary } from './state.js';
import { flushMemories } from './memory-store.js';
import config from './config.js';

const COMPACTION_SYSTEM_PROMPT = `You are a context summarizer for an autonomous coding agent. Your job is to compress the agent's work history into a dense, structured summary that preserves all critical information.

Your summary MUST include these sections:
1. **Task Anchor** — One-sentence restatement of the overall goal
2. **Files Changed** — List every file created, modified, or deleted
3. **Commands Run** — List important commands and their outcomes
4. **Key Decisions** — Architecture choices, library selections, approach changes
5. **Current State** — What is working, what is broken, what is partially done
6. **Learnings** — Important discoveries about the project/codebase
7. **Where I Left Off** — Exact state of the last subtask being worked on

Rules:
- Be extremely concise but miss NOTHING important
- Preserve exact file paths and function names
- Preserve error messages verbatim if they're unresolved
- Preserve the SEQUENCE of what happened (order matters)
- If something was tried and failed, note both the attempt and the failure
- Include the last thing the agent was doing (for seamless continuation)
- For file-specific fixes, preserve uncertainty when appropriate: if a file was later rewritten or may be stale, say it was modified and should be re-read before relying on earlier fix assumptions
- Output only the structured summary, no preamble`;

// ── Segment Compression ────────────────────────────────────────

/**
 * Collapse consecutive parse_error (and repeated loop_guard) streaks into
 * a single summary entry. Reduces LLM input noise before compaction.
 *
 * @param {Array} entries - Raw working memory entries
 * @returns {Array} Compressed entries
 */
function compressRawEntries(entries) {
  const compressed = [];
  let streakAction = null;
  let streakCount = 0;
  let streakStart = null;

  for (const entry of entries) {
    const isNoise = entry.action === 'parse_error' || entry.action === 'loop_guard';

    if (isNoise && entry.action === streakAction) {
      // Extend current streak
      streakCount++;
    } else {
      // Flush any pending streak
      if (streakAction !== null && streakCount > 0) {
        compressed.push({
          step: streakStart,
          action: `${streakAction}_streak`,
          args: {},
          result: `[${streakCount} consecutive ${streakAction} entries collapsed]`,
          error: streakAction === 'parse_error',
          timestamp: entry.timestamp,
        });
        streakAction = null;
        streakCount = 0;
        streakStart = null;
      }

      if (isNoise) {
        // Start new streak
        streakAction = entry.action;
        streakCount = 1;
        streakStart = entry.step;
      } else {
        compressed.push(entry);
      }
    }
  }

  // Flush any trailing streak
  if (streakAction !== null && streakCount > 0) {
    compressed.push({
      step: streakStart,
      action: `${streakAction}_streak`,
      args: {},
      result: `[${streakCount} consecutive ${streakAction} entries collapsed]`,
      error: streakAction === 'parse_error',
      timestamp: Date.now(),
    });
  }

  return compressed;
}

/**
 * Format compressed entries for LLM input (mirrors WorkingMemory.formatForCompaction).
 *
 * @param {Array} entries
 * @returns {string}
 */
function formatCompressedEntries(entries) {
  return entries.map(e => {
    const argsStr = e.args ? JSON.stringify(e.args).slice(0, 200) : '';
    const resultStr = (e.result || '').slice(0, 500);
    return `Step ${e.step}: ${e.action}(${argsStr}) → ${e.error ? 'ERROR: ' : ''}${resultStr}`;
  }).join('\n');
}

export function buildRuntimeAnchorSection(anchor = null) {
  if (!anchor || typeof anchor !== 'object') return '';
  const lines = [
    '## Runtime Anchor',
    `Current stage: ${anchor.currentStage || 'unknown'}`,
    `Locked target root: ${anchor.lockedRoot || 'n/a'}`,
    `Current blocker: ${anchor.blockedReason || 'none'}`,
    `Missing outputs: ${Array.isArray(anchor.missingOutputs) && anchor.missingOutputs.length ? anchor.missingOutputs.join(', ') : 'none'}`,
    `Next required action: ${anchor.nextRequiredAction || 'Continue current stage work.'}`,
    `Last successful milestone: ${anchor.lastSuccessfulMilestone || 'none'}`,
    `Recent recovery event: ${anchor.recentRecoveryRule || 'none'}`,
  ];
  // Fix D: include verification snapshot so the compaction LLM has ground-truth
  // on which checks currently pass/fail — prevents wrong diagnosis being baked into the summary.
  if (anchor.verificationSnapshot) {
    lines.push(`\n## Verification Snapshot (current pass/fail state)\n${anchor.verificationSnapshot}`);
  }
  return lines.join('\n');
}

function ensureSection(summary, heading, body) {
  if (!body) return summary;
  const text = String(summary || '').trim();
  if (new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'mi').test(text)) {
    return text;
  }
  return `${text}\n\n## ${heading}\n${body}`.trim();
}

export function enforceCompactionInvariants(summary, anchor = null) {
  let next = String(summary || '').trim();
  const runtimeAnchor = buildRuntimeAnchorSection(anchor);
  if (runtimeAnchor && !/##\s+Runtime Anchor/i.test(next)) {
    next = `${runtimeAnchor}\n\n${next}`.trim();
  }

  if (anchor) {
    next = ensureSection(next, 'Current State', [
      `Stage: ${anchor.currentStage || 'unknown'}`,
      `Blocked by: ${anchor.blockedReason || 'none'}`,
      `Missing outputs: ${Array.isArray(anchor.missingOutputs) && anchor.missingOutputs.length ? anchor.missingOutputs.join(', ') : 'none'}`,
    ].join('\n'));

    next = ensureSection(next, 'Where I Left Off', [
      `Next required action: ${anchor.nextRequiredAction || 'Continue current stage work.'}`,
      `Last successful milestone: ${anchor.lastSuccessfulMilestone || 'none'}`,
      `Recent recovery event: ${anchor.recentRecoveryRule || 'none'}`,
    ].join('\n'));
  }

  return next;
}

// ── Deterministic Fallback ─────────────────────────────────────

/**
 * Build a structured fallback summary from raw entries without LLM.
 * Kilo/OpenClaw-style: compaction must never completely fail.
 *
 * @param {Array} rawEntries
 * @param {number} fromStep
 * @param {number} toStep
 * @param {string|null} existingSummary
 * @returns {string}
 */
function buildFallbackSummary(rawEntries, fromStep, toStep, existingSummary, anchor = null) {
  const sections = [];

  // Carry forward the task anchor from existing summary if available
  if (existingSummary) {
    const anchorMatch = existingSummary.match(/\*\*Task Anchor\*\*[^\n]*\n([^\n]+)/);
    const taskAnchor = anchorMatch ? anchorMatch[1].trim() : existingSummary.slice(0, 200).split('\n')[0];
    if (taskAnchor) {
      sections.push(`## Task Anchor\n${taskAnchor}`);
    }
  }

  const runtimeAnchor = buildRuntimeAnchorSection(anchor);
  if (runtimeAnchor) {
    sections.push(runtimeAnchor);
  }

  const filesChanged = new Set();
  const commandsRun = [];
  const errors = [];
  const decisions = [];

  for (const e of rawEntries) {
    if ((e.action === 'write_file' || e.action === 'edit_file') && !e.error && e.args?.path) {
      filesChanged.add(e.args.path);
    }
    if (e.action === 'run_command' && e.args?.command) {
      const status = e.error ? 'FAILED' : 'OK';
      commandsRun.push(`${e.args.command.slice(0, 80)} [${status}]`);
    }
    if (e.error && !['parse_error', 'parse_error_streak', 'loop_guard'].includes(e.action)) {
      errors.push(`${e.action}: ${(e.result || '').slice(0, 150)}`);
    }
    if ((e.action === 'update_plan' || e.action === 'add_learning' || e.action === 'create_skill') && !e.error) {
      const note = e.args?.content || e.args?.note || e.args?.name || '';
      if (note) decisions.push(`${e.action}: ${String(note).slice(0, 100)}`);
    }
  }

  const fileLines = [...filesChanged].map((file) => `${file} — modified; re-read current file before relying on earlier fix assumptions`);
  sections.push(`## Files Changed (steps ${fromStep}-${toStep})\n${fileLines.join('\n') || 'none'}`);
  sections.push(`## Commands Run\n${commandsRun.slice(-10).join('\n') || 'none'}`);

  if (errors.length > 0) {
    sections.push(`## Errors (unresolved)\n${errors.slice(-5).join('\n')}`);
  }

  if (decisions.length > 0) {
    sections.push(`## Key Decisions\n${decisions.join('\n')}`);
  }

  // Last 3 actions as handoff
  const lastActions = rawEntries.slice(-3)
    .map(e => `Step ${e.step}: ${e.action}${e.error ? ' (ERROR)' : ''}`)
    .join('\n');
  sections.push(`## Where I Left Off\n${lastActions || 'unknown'}`);

  return sections.join('\n\n');
}

// ── Main Compaction Entry ──────────────────────────────────────

/**
 * Compact old working memory entries into a summary.
 * Includes: pre-compaction flush, segment compression, LLM summarization
 * with deterministic fallback, and hard size capping.
 *
 * @param {string} formattedOldEntries - Pre-formatted old steps (fallback input)
 * @param {number} fromStep - First step in the batch
 * @param {number} toStep - Last step in the batch
 * @param {Array} rawOldEntries - Raw memory entries (for flush + compression)
 * @returns {Promise<{summary: string, usage: Object, flushedCount: number, mode: string}>}
 */
export async function compactMemory(formattedOldEntries, fromStep, toStep, rawOldEntries = [], anchor = null) {
  // Hard cap scales with context window: 15% of tokens * 3 chars/token, capped 2k–20k chars.
  // Small model (12k) → ~5400 chars; 32k → ~14400; 128k → 20000 (hard max).
  const maxSummaryChars = Math.min(40000, Math.max(2000, Math.floor(config.contextWindow * 0.15 * 3)));

  // ── Phase 1: Pre-compaction Memory Flush ────────────────────
  let flushedCount = 0;
  if (config.memoryFlushEnabled && rawOldEntries.length > 0) {
    flushedCount = flushMemories(rawOldEntries);
  }

  // ── Phase 2: Compress Segment Input ─────────────────────────
  // Collapse parse_error / loop_guard streaks before sending to LLM
  const inputText = rawOldEntries.length > 0
    ? formatCompressedEntries(compressRawEntries(rawOldEntries))
    : formattedOldEntries;

  // ── Phase 3: LLM Summarization (with deterministic fallback) ─
  const existingSummary = readContextSummary();
  let newSummary;
  let mode;
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  try {
    const anchorSection = buildRuntimeAnchorSection(anchor);
    const messages = [
      { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          existingSummary
            ? `## Previous Summary (steps before ${fromStep})\n${existingSummary.slice(0, 2000)}\n\n---\n\n`
            : '',
          anchorSection ? `${anchorSection}\n\n---\n\n` : '',
          `## New Steps to Summarize (steps ${fromStep}-${toStep})\n${inputText}`,
          `\n\n---\n\nProduce a complete, updated summary covering ALL work from step 1 through step ${toStep}. `,
          `The summary should REPLACE the previous summary, not add to it. `,
          `Keep total output under ${Math.floor(maxSummaryChars * 0.9)} characters.`,
        ].join(''),
      },
    ];

    const response = await chatCompletion(messages, { temperature: 0.1 });
    // Strip thinking blocks — summarization models may emit <think>...</think> preambles
    newSummary = response.content
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .trim();
    usage = response.usage;
    mode = 'llm';
  } catch (err) {
    // LLM failed — deterministic fallback (Kilo/OpenClaw resilience)
    newSummary = buildFallbackSummary(rawOldEntries, fromStep, toStep, existingSummary, anchor);
    mode = 'fallback';
  }

  newSummary = enforceCompactionInvariants(newSummary, anchor);

  // ── Phase 4: Hard Size Cap ───────────────────────────────────
  if (newSummary.length > maxSummaryChars) {
    newSummary = newSummary.slice(0, maxSummaryChars) + '\n... [summary truncated at size limit]';
  }

  // Write with mode metadata
  writeContextSummary(
    `<!-- Compacted at step ${toStep}, ${new Date().toISOString()}, compaction_mode=${mode}, flushed=${flushedCount} -->\n${newSummary}`
  );

  return { summary: newSummary, usage, flushedCount, mode };
}

/**
 * Check if step-interval-based compaction should trigger.
 * @param {number} step - Current step number
 * @param {number} lastCompactionStep - Step when last compaction happened
 * @param {number} interval - Steps between compactions
 */
export function shouldCompactByInterval(step, lastCompactionStep, interval) {
  return (step - lastCompactionStep) >= interval;
}
