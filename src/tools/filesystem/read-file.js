import fs from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import { getWorkspace, trackFileRead } from '../../state.js';
import { safePath } from '../utils/contract.js';

export const definition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the contents of a file. Returns file content as text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        startLine: { type: 'integer', description: 'Start line (1-based). Omit for full file.', default: 1 },
        endLine: { type: 'integer', description: 'End line (1-based, inclusive). Omit for full file.', default: -1 },
      },
      required: ['path'],
    },
  },
};

export function handler({ path: relPath, startLine, endLine }) {
  const { abs, error } = safePath(relPath);
  if (error) return error;
  if (!fs.existsSync(abs)) return `File not found: ${relPath}`;

  const content = fs.readFileSync(abs, 'utf-8');
  trackFileRead(relPath, { startLine: startLine || 1, endLine: endLine || -1 });

  const lines = content.split('\n');
  const start = Math.max(1, startLine || 1) - 1;
  const end = (!endLine || endLine < 0) ? lines.length : Math.min(endLine, lines.length);
  const selected = lines.slice(start, end);
  const formatLine = (line, index) => `${index + 1} | ${line}`;

  if (selected.length > config.maxFileReadLines) {
    const kept = Math.floor(config.maxFileReadLines / 2);
    const head = selected.slice(0, kept).map((line, i) => formatLine(line, start + i));
    const tailStart = end - kept;
    const tail = selected.slice(-kept).map((line, i) => formatLine(line, tailStart + i));
    return [
      ...head,
      `... [${selected.length - config.maxFileReadLines} lines omitted from ${relPath}; re-read with startLine/endLine around the target region] ...`,
      ...tail,
    ].join('\n');
  }

  return selected.map((line, i) => formatLine(line, start + i)).join('\n');
}
