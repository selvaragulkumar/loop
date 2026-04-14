import { execFileSync } from 'node:child_process';
import { getWorkspace } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'webfetch',
    description: 'Fetch the content of a URL using curl. Returns raw response body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
};

export function handler({ url }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL.';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return 'Invalid URL. Only http/https are allowed.';
  }

  try {
    const output = execFileSync('curl', ['-s', '--max-time', '15', url], {
      cwd: getWorkspace(),
      encoding: 'utf-8',
      timeout: 15000,
    });
    return output;
  } catch (err) {
    return `Fetch error: ${err.message}`;
  }
}
