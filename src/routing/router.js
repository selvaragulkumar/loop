// src/routing/router.js
//
// Deterministic, LLM-free router.
// Input : task string + previous step metadata
// Output: category string  (one of filesystem | execution | planning |
//                            memory | identity | skills)
//
// Architecture decision:
//   Pure keyword + rule logic — zero LLM calls, zero async, zero state.
//   This keeps routing latency near-zero and makes it trivially testable.
//   The scoring model is additive: each matching keyword or rule adds weight
//   to the candidate categories, and the highest scorer wins.
//   Tie-breaking is handled by a static priority fallback list.

import { getToolCategory, getCategories } from './toolRegistry.js';

// ── Keyword tables ─────────────────────────────────────────────────────────────
//
// Each entry is [pattern, weight].
// Patterns are lowercase strings; the router lower-cases the task before matching.
// Weights let specific phrases (e.g. "write a file") outscore ambiguous single words.

const KEYWORD_WEIGHTS = {
  filesystem: [
    ['read file',       3], ['write file',    3], ['edit file',    3],
    ['create file',     3], ['modify file',   3], ['update file',  3],
    ['delete file',     2], ['list files',    2], ['list dir',     2],
    ['search files',    2], ['find file',     2], ['glob',         2],
    ['patch',           2], ['diff',          2], ['source code',  2],
    ['read',            1], ['write',         1], ['edit',         1],
    ['file',            1], ['directory',     1], ['folder',       1],
    ['path',            1], ['content',       1], ['code',         1],
    ['open',            1], ['save',          1], ['rename',       1],
  ],

  execution: [
    ['run command',     3], ['execute script', 3], ['run test',    3],
    ['run tests',       3], ['npm install',    3], ['npm run',     3],
    ['node ',           2], ['bash ',          2], ['shell ',      2],
    ['lint',            2], ['syntax check',   2], ['type check',  2],
    ['fetch url',       2], ['http request',   2], ['web request', 2],
    ['download',        2], ['curl',           2], ['api call',    2],
    ['run',             1], ['execute',        1], ['test',        1],
    ['install',         1], ['script',         1], ['command',     1],
    ['check',           1], ['build',          1], ['compile',     1],
    ['fetch',           1], ['http',           1], ['url',         1],
    ['search web',      2], ['look up',        1], ['google',      1],
  ],

  planning: [
    ['think about',     3], ['think through',  3], ['make a plan', 3],
    ['update plan',     3], ['write todo',     3], ['create todo', 3],
    ['what to do',      2], ['next step',      2], ['decide',      2],
    ['summarize',       2], ['finish',         2], ['done',        2],
    ['complete task',   2], ['mark done',      2], ['reflect',     2],
    ['plan',            1], ['think',          1], ['todo',        1],
    ['task',            1], ['step',           1], ['organize',    1],
    ['strategy',        1], ['approach',       1], ['consider',    1],
    ['learn',           1], ['note',           1], ['start',       1],
  ],

  memory: [
    ['remember this',   3], ['save to memory', 3], ['look up memory', 3],
    ['search memory',   2], ['recall',         2], ['update memory', 2],
    ['what did i',      2], ['previous session', 2],
    ['remember',        1], ['memory',         1], ['store',       1],
    ['knowledge',       1], ['history',        1],
  ],

  identity: [
    ['update identity', 3], ['update soul',    3], ['change personality', 3],
    ['update agents',   2], ['update user',    2],
    ['identity',        1], ['soul',           1], ['personality', 1],
    ['who am i',        2], ['self',           1],
  ],

  skills: [
    ['create skill',    3], ['new tool',       3], ['add capability', 3],
    ['define skill',    2], ['register skill', 2],
    ['skill',           1], ['capability',     1], ['plugin',      1],
  ],
};

// Tie-break order when scores are equal (lower index = higher preference).
const FALLBACK_PRIORITY = ['planning', 'filesystem', 'execution', 'memory', 'identity', 'skills'];

// ── Rule table ─────────────────────────────────────────────────────────────────
//
// Rules are checked in order and can short-circuit scoring entirely.
// Each rule returns a category string or null (no match).

/** @param {{ action: string, error: boolean }|null} lastStep */
function applyRules(task, lastStep, stepIndex) {
  const t = task.toLowerCase();

  // Rule 1 — very first step: plan before acting
  if (stepIndex === 0) return 'planning';

  // Rule 2 — previous step was a hard error on an execution tool → re-route to planning
  if (lastStep?.error && getToolCategory(lastStep.action) === 'execution') {
    return 'planning';
  }

  // Rule 3 — previous step was a hard error on a filesystem tool → stay in filesystem
  //          (likely need to create the missing file or fix the path)
  if (lastStep?.error && getToolCategory(lastStep.action) === 'filesystem') {
    return 'filesystem';
  }

  // Rule 3.5 — previous step was a hard error on an UNKNOWN tool (hallucinated name).
  // getToolCategory() returns null for unregistered names, so Rules 2 & 3 don't fire.
  // Score the task to find intent, but avoid routing to 'planning' when the task has
  // filesystem keywords — that would hide list_dir/read_file and create a think-loop stall.
  if (lastStep?.error && getToolCategory(lastStep.action) === null) {
    const scores = scoreTask(task);
    const winner = pickWinner(scores);
    if (winner === 'planning' && scores['filesystem'] > 0) {
      return 'filesystem';
    }
    return winner;
  }

  // Rule 4 — explicit finish/done signals bypass routing
  if (/\b(finish|done|completed?|all done)\b/.test(t)) return 'planning';

  // Rule 5 — explicit memory signals
  if (/\b(remember|recall|memory|knowledge base)\b/.test(t)) return 'memory';

  return null; // no rule matched
}

// ── Scoring engine ─────────────────────────────────────────────────────────────

function scoreTask(task) {
  const lower = task.toLowerCase();
  const scores = Object.fromEntries(getCategories().map(c => [c, 0]));

  for (const [category, pairs] of Object.entries(KEYWORD_WEIGHTS)) {
    for (const [keyword, weight] of pairs) {
      if (lower.includes(keyword)) {
        scores[category] += weight;
      }
    }
  }
  return scores;
}

function pickWinner(scores) {
  let best = null;
  let bestScore = -1;

  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = cat;
      bestScore = score;
    } else if (score === bestScore) {
      // Tie: prefer the one ranked earlier in FALLBACK_PRIORITY
      const currentRank = FALLBACK_PRIORITY.indexOf(best);
      const newRank     = FALLBACK_PRIORITY.indexOf(cat);
      if (newRank !== -1 && (currentRank === -1 || newRank < currentRank)) {
        best = cat;
      }
    }
  }

  return best ?? FALLBACK_PRIORITY[0];
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Route a step to a tool category.
 *
 * @param {string}  task            - The overall task description.
 * @param {object|null} lastStep    - Metadata from the previous step:
 *                                    { action, args, error, result }
 * @param {number}  stepIndex       - Zero-based step counter (0 = first step).
 * @returns {string}  Category name.
 */
export function route(task, lastStep, stepIndex) {
  // 1. Rule-based override (fast path)
  const ruled = applyRules(task, lastStep, stepIndex);
  if (ruled) return ruled;

  // 2. Scoring
  const scores = scoreTask(task);

  // Boost: if the last step succeeded and was in a category, bias toward staying
  // in that category (+2).  Prevents thrashing between categories for multi-step
  // tasks like "read file A, then read file B".
  if (lastStep && !lastStep.error) {
    const lastCat = getToolCategory(lastStep.action);
    if (lastCat && scores[lastCat] !== undefined) {
      scores[lastCat] += 2;
    }
  }

  return pickWinner(scores);
}

/**
 * Explain the routing decision for a given task + step.
 * Useful for debugging without touching production flow.
 *
 * @returns {{ category: string, scores: object, ruled: string|null }}
 */
export function explainRoute(task, lastStep, stepIndex) {
  const ruled  = applyRules(task, lastStep, stepIndex);
  const scores = scoreTask(task);

  if (lastStep && !lastStep.error) {
    const lastCat = getToolCategory(lastStep.action);
    if (lastCat && scores[lastCat] !== undefined) scores[lastCat] += 2;
  }

  return {
    category: ruled ?? pickWinner(scores),
    ruled,
    scores,
  };
}
