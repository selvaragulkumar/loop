import fs from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import { getWorkspace } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'update_memory',
    description: 'Update the curated MEMORY.md file with important long-term knowledge. This is the agent\'s permanent knowledge base.',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Which section to update: "Project Facts", "Architecture Decisions", "Gotchas & Warnings", or "Useful Commands"' },
        content: { type: 'string', description: 'Content to add to the section (will be appended as a bullet point)' },
      },
      required: ['section', 'content'],
    },
  },
};

export function handler({ section, content }) {
  const memFile = path.resolve(getWorkspace(), config.memoryFile);
  if (!fs.existsSync(memFile)) {
    return `MEMORY.md not found. Run bootstrapIdentity() first.`;
  }

  const existing = fs.readFileSync(memFile, 'utf-8');
  const sectionHeader = `## ${section}`;

  if (!existing.includes(sectionHeader)) {
    // Add new section
    const updated = existing + `\n${sectionHeader}\n- ${content}\n`;
    fs.writeFileSync(memFile, updated, 'utf-8');
    return `Added new section "${section}" to MEMORY.md`;
  }

  // Find the section and append after "(none yet)" or at end of section
  const lines = existing.split('\n');
  const newLines = [];
  let inSection = false;
  let inserted = false;

  for (const line of lines) {
    if (line.startsWith('## ') && inSection) {
      // End of target section — insert before next section header
      if (!inserted) {
        newLines.push(`- ${content}`);
        inserted = true;
      }
      inSection = false;
    }

    if (line.trimEnd() === sectionHeader) {
      inSection = true;
    }

    // Skip "(none yet)" placeholder
    if (inSection && line.includes('(none yet)')) {
      newLines.push(`- ${content}`);
      inserted = true;
      continue;
    }

    newLines.push(line);
  }

  // If we were in the section at EOF
  if (inSection && !inserted) {
    newLines.push(`- ${content}`);
  }

  fs.writeFileSync(memFile, newLines.join('\n'), 'utf-8');
  return `Updated "${section}" in MEMORY.md: ${content.slice(0, 80)}`;
}
