import { createSkill as createSkillFn } from '../../skills.js';

export const definition = {
  type: 'function',
  function: {
    name: 'create_skill',
    description: 'Create a new reusable skill/tool that will be available in future steps. Use when you find yourself repeating a pattern. Skills are saved as markdown files in .agent/skills/.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (alphanumeric + underscores)' },
        description: { type: 'string', description: 'What the skill does (shown in tool list)' },
        parameters: { type: 'string', description: 'Markdown parameter list, e.g. "- path: string — File path\\n- pattern: string — Search pattern"' },
        implementation: { type: 'string', description: 'JavaScript code for the skill handler. Has access to: args, workspace, fs, path, execSync, readFile(path), writeFile(path, content)' },
        type: { type: 'string', description: 'Skill type: javascript (code), command (shell), knowledge (reference)', default: 'javascript' },
      },
      required: ['name', 'description', 'implementation'],
    },
  },
};

export function handler({ name, description, parameters, implementation, type }) {
  return createSkillFn({ name, description, parameters, implementation, type: type || 'javascript' });
}
