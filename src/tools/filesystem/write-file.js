import fs from 'node:fs';
import path from 'node:path';
import { getWorkspace, trackFileWrite } from '../../state.js';
import { safePath } from '../utils/contract.js';

export const definition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
};

export function handler(args) {
  const relPath = args.path;
  // Accept common aliases the model may use instead of 'content'
  const content = args.content ?? args.text ?? args.data ?? args.body;
  if (content == null) {
    return 'Error: content argument is required. Pass {"path": "...", "content": "..."}';
  }
  const str = String(content);
  const { abs, error } = safePath(relPath);
  if (error) return error;
  const existedBefore = fs.existsSync(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, str, 'utf-8');
  trackFileWrite(relPath, { overwrite: existedBefore, forceRereadBeforeEdit: existedBefore });
  return `File written: ${relPath} (${str.length} chars)`;
}
