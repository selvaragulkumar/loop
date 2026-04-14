// src/tools/planning/todoread.js
// Read the current in-session TODO list from .agent/todos.json.
// Use this to check remaining tasks before deciding what to do next.

import fs from 'node:fs';
import path from 'node:path';
import { getWorkspace } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'todoread',
    description: 'Read the current session TODO list. Returns all items grouped by status. Use before starting work to see what is pending or in-progress.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

export function handler() {
  try {
    const todoPath = path.join(getWorkspace(), '.agent', 'todos.json');
    if (!fs.existsSync(todoPath)) return 'No TODO list found. Use todowrite to create one.';

    const todos = JSON.parse(fs.readFileSync(todoPath, 'utf-8'));
    if (!Array.isArray(todos) || todos.length === 0) return 'TODO list is empty.';

    const ICON = { high: '🔴', medium: '🟡', low: '🟢' };
    const STATUS = { pending: '[ ]', in_progress: '[~]', done: '[x]' };

    const groups = { in_progress: [], pending: [], done: [] };
    for (const t of todos) {
      (groups[t.status] || groups.pending).push(t);
    }

    const lines = [];
    for (const [status, items] of Object.entries(groups)) {
      if (items.length === 0) continue;
      lines.push(`### ${status.replace('_', ' ').toUpperCase()}`);
      for (const t of items) {
        lines.push(`${STATUS[t.status] || '[ ]'} ${ICON[t.priority] || ''} [${t.id}] ${t.content}`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    return `todoread error: ${err.message}`;
  }
}
