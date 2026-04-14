// src/tools/filesystem/glob.js
// File discovery by glob pattern using JS-native traversal.

import { getWorkspace } from '../../state.js';
import { globFiles } from '../utils/native-search.js';

export const definition = {
  type: 'function',
  function: {
    name: 'glob',
    description: 'Return files matching a glob pattern relative to the workspace root. Supports ** for recursive search (e.g. "src/**/*.js"). Returns newline-separated paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts" or "*.json"' },
      },
      required: ['pattern'],
    },
  },
};

export function handler({ pattern }) {
  const workspace = getWorkspace();
  const matches = globFiles(workspace, pattern || '*', 300);
  return matches.length > 0 ? matches.join('\n') : 'No matches.';
}
