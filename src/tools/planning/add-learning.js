import { appendLearning } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'add_learning',
    description: 'Record a learning or note for future reference. Use when you discover something important about the project.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The learning or note to record' },
      },
      required: ['note'],
    },
  },
};

export function handler(args) {
  // Accept common aliases the model may use instead of 'note'
  const note = args.note ?? args.text ?? args.content ?? args.learning;
  if (!note) {
    return 'Error: note argument is required. Pass {"note": "your learning here"}.';
  }
  const text = String(note);
  appendLearning(text);
  return `Learning recorded: ${text.slice(0, 100)}`;
}
