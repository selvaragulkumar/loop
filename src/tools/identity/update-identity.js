import fs from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import { getWorkspace } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'update_identity',
    description: 'Update the USER.md file with newly discovered information about the user or their preferences.',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Which section: "Preferences", "Project Context", or "Communication Style"' },
        content: { type: 'string', description: 'Content to add to the section' },
      },
      required: ['section', 'content'],
    },
  },
};

export function handler({ section, content }) {
  const userFile = path.resolve(getWorkspace(), config.userFile);
  if (!fs.existsSync(userFile)) {
    return `USER.md not found. Run bootstrapIdentity() first.`;
  }

  const existing = fs.readFileSync(userFile, 'utf-8');
  const sectionHeader = `## ${section}`;

  if (!existing.includes(sectionHeader)) {
    const updated = existing + `\n${sectionHeader}\n- ${content}\n`;
    fs.writeFileSync(userFile, updated, 'utf-8');
    return `Added new section "${section}" to USER.md`;
  }

  const lines = existing.split('\n');
  const newLines = [];
  let inSection = false;
  let inserted = false;

  for (const line of lines) {
    if (line.startsWith('## ') && inSection) {
      if (!inserted) {
        newLines.push(`- ${content}`);
        inserted = true;
      }
      inSection = false;
    }

    if (line.trimEnd() === sectionHeader) {
      inSection = true;
    }

    if (inSection && (line.includes('(none discovered yet)') || line.includes('(will be filled') || line.includes('(observing)'))) {
      newLines.push(`- ${content}`);
      inserted = true;
      continue;
    }

    newLines.push(line);
  }

  if (inSection && !inserted) {
    newLines.push(`- ${content}`);
  }

  fs.writeFileSync(userFile, newLines.join('\n'), 'utf-8');
  return `Updated "${section}" in USER.md: ${content.slice(0, 80)}`;
}
