import { execSync } from 'node:child_process';
import { getWorkspace } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'patch',
    description: 'Apply a unified diff patch to the workspace using `patch` command.',
    parameters: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Unified diff text to apply' },
      },
      required: ['diff'],
    },
  },
};

export function handler({ diff }) {
  const text = String(diff || '');
  if (!text.trim()) return 'PATCH_ERROR_INVALID_DIFF: empty diff.';
  if (!text.startsWith('---') && !text.startsWith('diff ')) {
    return 'PATCH_ERROR_INVALID_DIFF: expected unified diff header (--- / diff).';
  }
  // Block absolute paths in diffs to prevent writes outside workspace
  if (/^[+-]{3}\s+\/[^\s]/m.test(text)) {
    return 'PATCH_ERROR_INVALID_DIFF: absolute paths not allowed in diffs. Use relative paths only.';
  }
  try {
    execSync(`patch -p1`, {
      cwd: getWorkspace(),
      input: text,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'Patch applied';
  } catch (err) {
    return `Patch error: ${err.message}`;
  }
}
