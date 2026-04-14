import { searchMemory as searchMem } from '../../memory-store.js';

export const definition = {
  type: 'function',
  function: {
    name: 'search_memory',
    description: 'Search across all persistent memory files (daily logs, MEMORY.md, learnings) for a keyword or pattern.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search pattern (supports regex)' },
        type: { type: 'string', description: 'Optional: filter by memory type (world, experience, decision, opinion, gotcha)', default: '' },
      },
      required: ['query'],
    },
  },
};

export function handler({ query, type }) {
  return searchMem(query, { type: type || undefined });
}
