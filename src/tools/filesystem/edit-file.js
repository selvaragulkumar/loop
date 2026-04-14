import fs from 'node:fs';
import path from 'node:path';
import { getWorkspace, trackFileWrite } from '../../state.js';
import { safePath } from '../utils/contract.js';

export const definition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Replace an exact string in a file with a new string. The old string must match exactly (including whitespace).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        oldString: { type: 'string', description: 'Exact text to find (must match uniquely)' },
        newString: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
};

export function handler({ path: relPath, oldString, newString }) {
  const { abs, error } = safePath(relPath);
  if (error) return error;
  if (!fs.existsSync(abs)) return `EDIT_ERROR_FILE_NOT_FOUND: File not found: ${relPath}`;

  const content = fs.readFileSync(abs, 'utf-8');
  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    return `EDIT_ERROR_STRING_NOT_FOUND: String not found in ${relPath}. Re-read the file and match exact whitespace/indentation before retrying.`;
  }
  if (occurrences > 1) {
    return `EDIT_ERROR_NOT_UNIQUE: String found ${occurrences} times in ${relPath}. Must match exactly once. Add more context.`;
  }

  const updated = content.replace(oldString, newString);
  fs.writeFileSync(abs, updated, 'utf-8');
  trackFileWrite(relPath, { overwrite: true, forceRereadBeforeEdit: true });
  return `File edited: ${relPath} (1 replacement made)`;
}
