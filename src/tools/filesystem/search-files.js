import path from 'node:path';
import fs from 'node:fs';
import { getWorkspace } from '../../state.js';
import { searchInDirectory } from '../utils/native-search.js';
import { safePath } from '../utils/contract.js';

export const definition = {
  type: 'function',
  function: {
    name: 'search_files',
    description: 'Search for a text pattern across files using grep. Returns matching file paths and lines.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        path: { type: 'string', description: 'Directory to search in (default: ".")', default: '.' },
        filePattern: { type: 'string', description: 'Glob pattern for files (e.g. "*.js")', default: '' },
      },
      required: ['pattern'],
    },
  },
};

export function handler({ pattern, path: relPath, filePattern }) {
  const searchPattern = String(pattern || '');
  const scopedPath = relPath || '.';
  let includeGlob = filePattern || '*';
  const safeCheck = safePath(scopedPath);
  if (safeCheck.error) return safeCheck.error;
  let dir = safeCheck.abs;

  try {
    const stat = fs.statSync(dir);
    if (stat.isFile()) {
      includeGlob = path.basename(dir);
      dir = path.dirname(dir);
    }
  } catch {
    // Ignore and let native search return no matches.
  }

  const matches = searchInDirectory(dir, searchPattern, {
    maxResults: 50,
    filePattern: includeGlob,
    caseSensitive: false,
  });

  if (matches.length === 0) {
    return `No matches found. NO_MATCH: pattern="${searchPattern}" path="${scopedPath}" filePattern="${includeGlob}"`;
  }

  return matches
    .map((m) => `${path.posix.join(dir.replace(/\\/g, '/'), m.file)}:${m.line}:${m.text}`)
    .join('\n');
}
