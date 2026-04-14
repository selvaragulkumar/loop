// src/routing/toolRegistry.js
//
// Builds a category-keyed registry from the existing tool modules.
// Each category maps to { definitions: [...], handlers: {...} }.
//
// Architecture decision:
//   Static imports are used (not dynamic import()) because all tools are
//   known at build time, and static imports give us synchronous access
//   without async waterfalls inside the router hot-path.
//   The registry is built once at module load and frozen to prevent
//   accidental mutation across steps.

import * as readFile     from '../tools/filesystem/read-file.js';
import * as writeFile    from '../tools/filesystem/write-file.js';
import * as editFile     from '../tools/filesystem/edit-file.js';
import * as listDir      from '../tools/filesystem/list-dir.js';
import * as searchFiles  from '../tools/filesystem/search-files.js';
import * as glob         from '../tools/filesystem/glob.js';
import * as patch        from '../tools/filesystem/patch.js';

import * as runCommand   from '../tools/execution/run-command.js';
import * as webfetch     from '../tools/execution/webfetch.js';
import * as websearch    from '../tools/execution/websearch.js';
import * as lsp          from '../tools/execution/lsp.js';

import * as think        from '../tools/planning/think.js';
import * as finish       from '../tools/planning/finish.js';
import * as updatePlan   from '../tools/planning/update-plan.js';
import * as addLearning  from '../tools/planning/add-learning.js';
import * as todoread     from '../tools/planning/todoread.js';
import * as todowrite    from '../tools/planning/todowrite.js';

import * as saveMemory   from '../tools/memory/save-memory.js';
import * as searchMemory from '../tools/memory/search-memory.js';
import * as updateMemory from '../tools/memory/update-memory.js';

import * as updateIdentity from '../tools/identity/update-identity.js';
import * as createSkill    from '../tools/skills/create-skill.js';
import { normalizeToolArgs, validateToolArgs, isToolFailureResult } from '../tools/utils/contract.js';

// ── Category definitions ──────────────────────────────────────────────────────
//
// Priority field (lower = served first by toolManager).
// Controls which tools surface in the top-4 window when a category has more
// than 4 members.  Read-before-write ordering is intentional everywhere.

const RAW_CATEGORIES = {
  filesystem: [
    { mod: readFile,    priority: 1 },
    { mod: listDir,     priority: 2 },
    { mod: searchFiles, priority: 3 },
    { mod: glob,        priority: 4 },
    { mod: editFile,    priority: 5 },
    { mod: writeFile,   priority: 6 },
    { mod: patch,       priority: 7 },
  ],

  execution: [
    { mod: runCommand,  priority: 1 },
    { mod: lsp,         priority: 2 },
    { mod: webfetch,    priority: 3 },
    { mod: websearch,   priority: 4 },
  ],

  planning: [
    { mod: think,       priority: 1 },
    { mod: finish,      priority: 2 },
    { mod: todoread,    priority: 3 },
    { mod: updatePlan,  priority: 4 },
    { mod: todowrite,   priority: 5 },
    { mod: addLearning, priority: 6 },
  ],

  memory: [
    { mod: searchMemory, priority: 1 },
    { mod: updateMemory, priority: 2 },
    { mod: saveMemory,   priority: 3 },
  ],

  identity: [
    { mod: updateIdentity, priority: 1 },
  ],

  skills: [
    { mod: createSkill, priority: 1 },
  ],
};

// ── Build the registry ────────────────────────────────────────────────────────

/**
 * @typedef {{ name: string, definition: object, handler: Function, priority: number }} ToolEntry
 * @typedef {{ [category: string]: ToolEntry[] }} Registry
 */

/** Full category → sorted tool entries map.  Sorted ascending by priority. */
export const REGISTRY = Object.fromEntries(
  Object.entries(RAW_CATEGORIES).map(([cat, entries]) => [
    cat,
    entries
      .sort((a, b) => a.priority - b.priority)
      .map(({ mod, priority }) => ({
        name:       mod.definition.function.name,
        definition: mod.definition,
        handler:    mod.handler,
        priority,
      })),
  ])
);

// Freeze to prevent external mutation
Object.freeze(REGISTRY);

/** Flat built-in tool definitions derived from the single registry source. */
export const TOOL_DEFINITIONS = Object.values(REGISTRY).flat().map(e => e.definition);

/** Flat built-in tool handlers derived from the single registry source. */
export const TOOL_HANDLERS = Object.fromEntries(
  Object.values(REGISTRY).flat().map(e => [e.name, e.handler])
);

// ── Flat lookup maps ──────────────────────────────────────────────────────────

/** name → ToolEntry (all categories merged) */
const FLAT = new Map(
  Object.values(REGISTRY).flat().map(e => [e.name, e])
);

/** name → category string */
const NAME_TO_CATEGORY = new Map(
  Object.entries(REGISTRY).flatMap(([cat, entries]) =>
    entries.map(e => [e.name, cat])
  )
);

// ── Public API ────────────────────────────────────────────────────────────────

/** Return the category a tool belongs to, or null if unknown. */
export function getToolCategory(name) {
  return NAME_TO_CATEGORY.get(name) ?? null;
}

/** Return a single ToolEntry by name, or null. */
export function getToolEntry(name) {
  return FLAT.get(name) ?? null;
}

/** Return all tool entries in a category, sorted by priority. */
export function getCategoryTools(category) {
  return REGISTRY[category] ?? [];
}

/** Return all known category names. */
export function getCategories() {
  return Object.keys(REGISTRY);
}

// Common aliases from LLM training data → canonical registry names.
const TOOL_ALIASES = new Map([
  ['bash',       'run_command'],
  ['shell',      'run_command'],
  ['execute',    'run_command'],
  ['list_files', 'list_dir'],
  ['ls',         'list_dir'],
]);

/** Execute a tool by name with args.  Returns { result, error }. */
export function executeRegistryTool(name, args) {
  const resolvedName = TOOL_ALIASES.get(name) ?? name;
  const entry = FLAT.get(resolvedName);
  if (!entry) {
    return { result: `Unknown tool: ${name}`, error: true };
  }
  const normalizedArgs = normalizeToolArgs(resolvedName, args);
  const validation = validateToolArgs(entry.definition, normalizedArgs, resolvedName);
  if (!validation.ok) {
    return {
      result: `ARG_VALIDATION_ERROR: ${resolvedName} missing required args: ${validation.missing.join(', ')}`,
      error: true,
    };
  }
  try {
    const raw = entry.handler(normalizedArgs);
    const result = String(raw ?? '');
    return { result, error: isToolFailureResult(resolvedName, result) };
  } catch (err) {
    return { result: `Tool error (${name}): ${err.message}`, error: true };
  }
}
