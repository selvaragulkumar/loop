export const definition = {
  type: 'function',
  function: {
    name: 'finish',
    description: 'Signal that the task is complete. Provide a summary of what was accomplished.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of what was accomplished' },
      },
      required: ['summary'],
    },
  },
};

export function handler({ summary }) {
  return `__FINISH__:${summary}`;
}
