// src/tools/planning/todowrite.js
// Write (replace) the agent's in-session TODO list.
// Stored at .agent/todos.json — structured, machine-readable, survives compaction.
// Use this to track sub-tasks within the current session. For durable plans, use update_plan.

import fs from 'node:fs';
import path from 'node:path';
import { getWorkspace } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'todowrite',
    description: 'Create or replace the session TODO list. Each item has an id, content, status (pending|in_progress|done), and priority (high|medium|low). Use this for tracking sub-tasks that are too granular for plan.md.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Complete replacement list of TODO items',
          items: {
            type: 'object',
            properties: {
              id:       { type: 'string',  description: 'Unique short identifier, e.g. "t1"' },
              content:  { type: 'string',  description: 'Description of the task' },
              status:   { type: 'string',  description: 'pending | in_progress | done' },
              priority: { type: 'string',  description: 'high | medium | low' },
            },
            required: ['id', 'content', 'status', 'priority'],
          },
        },
      },
      required: ['todos'],
    },
  },
};

export function handler({ todos }) {
  try {
    const todoPath = path.join(getWorkspace(), '.agent', 'todos.json');
    fs.mkdirSync(path.dirname(todoPath), { recursive: true });
    fs.writeFileSync(todoPath, JSON.stringify(todos, null, 2), 'utf-8');

    const counts = { pending: 0, in_progress: 0, done: 0 };
    for (const t of todos) counts[t.status] = (counts[t.status] || 0) + 1;
    return `TODO list saved (${todos.length} items: ${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.done} done).`;
  } catch (err) {
    return `todowrite error: ${err.message}`;
  }
}
