import fs from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import { getWorkspace } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'update_plan',
    description: 'Update the agent plan file (.agent/plan.md) with new content. Use this to track progress, mark tasks complete, or add new subtasks.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full markdown content for the plan file' },
      },
      required: ['content'],
    },
  },
};

export function handler({ content }) {
  const abs = path.resolve(getWorkspace(), config.planFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return 'Plan updated.';
}
