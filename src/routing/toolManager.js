// src/routing/toolManager.js
//
// Tool exposure manager.
// Converts a category (+ optional freeze state) into a capped list of
// tool definitions ready for injection into the LLM system prompt.
//
// Architecture decisions:
//   MAX_TOOLS = 4   — empirically keeps prompt token count within 2048–4096
//                     even for quantized 7B-class models.
//
//   Anchor tools (think + finish) are injected for non-planning categories
//   so the model always has a way to reason and exit regardless of which
//   category is active.  They fill the last slots (positions 3 and 4),
//   leaving 2 slots for the routed category.
//
//   When a tool is frozen the exposure collapses to that one tool + finish.
//   This prevents the model from randomly switching to a different action
//   while mid-execution, while still allowing it to exit if done.

import { getCategoryTools, getToolEntry } from './toolRegistry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_TOOLS = 4;

// Always available regardless of category — meta-tools for stability.
// create_skill is included so the model can always extract reusable patterns,
// even when the 'skills' category never wins the router lottery.
const ANCHOR_TOOL_NAMES = ['think', 'finish', 'create_skill'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAnchors() {
  return ANCHOR_TOOL_NAMES
    .map(name => getToolEntry(name))
    .filter(Boolean);
}

/**
 * Deduplicate entries by tool name, preserving first occurrence.
 * @param {import('./toolRegistry.js').ToolEntry[]} entries
 */
function dedup(entries) {
  const seen = new Set();
  return entries.filter(e => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return up to MAX_TOOLS tool definitions for the given category.
 *
 * @param {string}      category    - Routed category name.
 * @param {string|null} frozenTool  - If set, expose only this tool + finish.
 * @returns {object[]}  Array of OpenAI-style tool definition objects.
 */
export function getExposedTools(category, frozenTool = null) {
  // ── Freeze mode ────────────────────────────────────────────────────────────
  // Expose only the frozen tool + finish so the model can either continue
  // with the same action or signal completion — nothing else.
  if (frozenTool) {
    const frozen  = getToolEntry(frozenTool);
    const finishE = getToolEntry('finish');
    const tools   = dedup([frozen, finishE].filter(Boolean));
    return tools.map(e => e.definition);
  }

  // ── Normal mode ───────────────────────────────────────────────────────────
  const categoryTools = getCategoryTools(category); // already sorted by priority

  if (category === 'planning') {
    // Planning already contains think + finish, no special anchoring needed.
    return categoryTools
      .slice(0, MAX_TOOLS)
      .map(e => e.definition);
  }

  // For all other categories: reserve last 3 slots for anchors (think + finish + create_skill),
  // fill first slot from the routed category.
  const categorySlots = MAX_TOOLS - ANCHOR_TOOL_NAMES.length; // = 1
  const fromCategory  = categoryTools.slice(0, categorySlots);
  const anchors       = getAnchors();

  const merged = dedup([...fromCategory, ...anchors]);
  return merged.slice(0, MAX_TOOLS).map(e => e.definition);
}

/**
 * Return only the definition objects for a named set of tools.
 * Useful for manual override (e.g. error-recovery prompts).
 *
 * @param {string[]} names
 * @returns {object[]}
 */
export function getToolsByName(names) {
  return names
    .map(n => getToolEntry(n))
    .filter(Boolean)
    .map(e => e.definition);
}

/**
 * Summarise what would be exposed — handy for logging.
 *
 * @param {string}      category
 * @param {string|null} frozenTool
 * @returns {string[]}  List of tool names.
 */
export function previewExposure(category, frozenTool = null) {
  return getExposedTools(category, frozenTool).map(d => d.function.name);
}
