export const definition = {
  type: 'function',
  function: {
    name: 'think',
    description: 'Internal reasoning step with no side effects. Use this to reason through a complex problem, weigh options, plan a multi-step sequence, or analyse an error before acting. The content is recorded in working memory so you can build on it in subsequent steps. Use think when the problem is genuinely complex — do NOT use it as a stalling tactic.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Your reasoning, analysis, or plan. Be thorough — this is your private scratchpad. No files are read or written.',
        },
      },
      required: ['content'],
    },
  },
};

export function handler(args = {}) {
  const content = args.content ?? args.question ?? args.thought ?? '';
  return `Thought recorded (${String(content || '').length} chars). Proceed with your next action.`;
}
