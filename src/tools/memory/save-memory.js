import { saveMemory as saveMem } from '../../memory-store.js';

export const definition = {
  type: 'function',
  function: {
    name: 'save_memory',
    description: 'Save an important fact, discovery, or decision to persistent memory. Use this when you learn something important that should survive context compaction.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember' },
        type: { type: 'string', description: 'Memory type: world (facts), experience (what happened), decision (choices made), opinion (preferences), gotcha (warnings)', default: 'experience' },
        tags: { type: 'string', description: 'Comma-separated tags for searchability', default: '' },
      },
      required: ['content'],
    },
  },
};

export function handler({ content, type, tags }) {
  const tagList = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  return saveMem(content, type || 'experience', tagList);
}
