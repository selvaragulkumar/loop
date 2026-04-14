import path from 'node:path';
import { getWorkspace } from '../../state.js';

// ── Path Safety ──────────────────────────────────────────────────

/**
 * Resolve a relative path against the workspace and verify it stays inside.
 * Returns { abs, error } — if error is set, the path is outside the workspace.
 */
export function safePath(relPath) {
  const workspace = getWorkspace();
  const abs = path.resolve(workspace, relPath);
  // Must be the workspace itself or a descendant
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    return { abs, error: `Security: path "${relPath}" resolves outside workspace boundary.` };
  }
  return { abs, error: null };
}

function getRequiredArgs(definition) {
  return definition?.function?.parameters?.required || [];
}

export function normalizeToolArgs(toolName, rawArgs) {
  const args = { ...(rawArgs || {}) };

  // Common LLM alias mistakes for planning tool calls.
  if (toolName === 'think') {
    if (typeof args.content !== 'string' || !args.content.trim()) {
      if (typeof args.question === 'string' && args.question.trim()) args.content = args.question;
      else if (typeof args.thought === 'string' && args.thought.trim()) args.content = args.thought;
    }
    delete args.question;
    delete args.thought;
  }

  if (toolName === 'edit_file') {
    if (args.oldString === undefined) {
      if (typeof args.find === 'string') args.oldString = args.find;
      else if (typeof args.oldStr === 'string') args.oldString = args.oldStr;
      else if (typeof args.textToReplace === 'string') args.oldString = args.textToReplace;
      else if (typeof args.search === 'string') args.oldString = args.search;
      else if (typeof args.targetText === 'string') args.oldString = args.targetText;
    }
    if (args.newString === undefined) {
      if (typeof args.replace === 'string') args.newString = args.replace;
      else if (typeof args.newStr === 'string') args.newString = args.newStr;
      else if (typeof args.textToInsert === 'string') args.newString = args.textToInsert;
      else if (typeof args.replacement === 'string') args.newString = args.replacement;
      else if (typeof args.updatedText === 'string') args.newString = args.updatedText;
    }
    delete args.find;
    delete args.replace;
    delete args.oldStr;
    delete args.newStr;
    delete args.textToReplace;
    delete args.textToInsert;
    delete args.search;
    delete args.replacement;
    delete args.targetText;
    delete args.updatedText;
  }

  return args;
}

export function validateToolArgs(definition, args, toolName = '') {
  const required = getRequiredArgs(definition);
  const missing = required.filter((key) => {
    const v = args?.[key];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v.trim() === '') {
      // `think` may intentionally record an empty note in some flows/tests.
      if (toolName === 'think' && key === 'content') return false;
      // `write_file` content can legitimately be empty (e.g. __init__.py)
      if (toolName === 'write_file' && key === 'content') return false;
      return true;
    }
    return false;
  });
  return {
    ok: missing.length === 0,
    missing,
  };
}

export function isToolFailureResult(toolName, text) {
  const lower = String(text || '').toLowerCase();

  if (lower.includes('arg_validation_error:')) return true;
  if (lower.startsWith('blocked: command')) return true;
  if (lower.includes('tool error (')) return true;
  if (lower.includes('unknown tool:')) return true;
  if (lower.includes('search_error:')) return true;
  if (lower.includes('file not found:')) return true;
  if (lower.includes('invalid url')) return true;
  if (lower.includes('fetch error:')) return true;
  if (lower.includes('patch error:')) return true;
  if (lower.includes('patch_error_')) return true;
  if (lower.startsWith('security:')) return true;

  // run_command with non-zero exit code is a failure
  if (toolName === 'run_command') {
    const exitMatch = text.match(/^Exit code (\d+):/);
    if (exitMatch && exitMatch[1] !== '0') return true;
  }

  if (toolName === 'edit_file') {
    if (lower.includes('string not found in')) return true;
    if (lower.includes('must match exactly once')) return true;
    if (lower.includes('edit_error_')) return true;
  }

  return false;
}
