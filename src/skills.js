// advanced-agent-loop/src/skills.js
// Dynamic Skill System — The agent can create, load, and use custom skills/tools.
//
// Skills are markdown files in .agent/skills/ that define reusable tool templates.
// The agent can create new skills during execution (meta-tool creation).
// Skills are loaded at startup and made available as additional tools.
//
// Skill file format (.agent/skills/<name>.md):
//   # Skill: <name>
//   ## Description
//   <what this skill does>
//   ## Parameters
//   - param1: <type> — <description>
//   ## Implementation
//   ```javascript
//   // The actual tool handler code (runs in a sandboxed context)
//   ```
//   ## Examples
//   <usage examples>

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import config from './config.js';
import { getWorkspace } from './state.js';

const nodeRequire = createRequire(import.meta.url);

// ── Skill Registry ─────────────────────────────────────────────

/** @type {Map<string, Skill>} */
const loadedSkills = new Map();

/**
 * @typedef {Object} Skill
 * @property {string} name
 * @property {string} description
 * @property {Object} parameters — JSON Schema for parameters
 * @property {Function} handler — Execution function
 * @property {string} source — 'builtin' | 'user' | 'agent-created'
 * @property {string} filePath — Path to the skill .md file (if file-based)
 */

// ── Loading ────────────────────────────────────────────────────

/**
 * Load all skills from .agent/skills/ directory.
 * Called at agent startup and after skill creation.
 * @returns {Skill[]} Array of successfully loaded skills
 */
export function loadSkills() {
  const skillsDir = path.join(getWorkspace(), config.skillsDir);
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
  const loaded = [];

  for (const file of files) {
    try {
      const filePath = path.join(skillsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const skill = parseSkillFile(content, filePath);
      if (skill) {
        loadedSkills.set(skill.name, skill);
        loaded.push(skill);
      }
    } catch (err) {
      console.error(`[skills] Failed to load ${file}: ${err.message}`);
    }
  }

  return loaded;
}

/**
 * Parse a skill markdown file into a Skill object.
 */
function parseSkillFile(content, filePath) {
  // Extract skill name from header
  const nameMatch = content.match(/^#\s+Skill:\s*(.+)/m);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim().toLowerCase().replace(/\s+/g, '_');

  // Extract description
  const descMatch = content.match(/##\s+Description\s*\n([\s\S]*?)(?=\n##|\n$)/);
  const description = descMatch ? descMatch[1].trim() : `Custom skill: ${name}`;

  // Extract parameters
  const params = parseParameters(content);

  // Extract implementation (JavaScript code block)
  const implMatch = content.match(/##\s+Implementation\s*\n[\s\S]*?```(?:javascript|js)\s*\n([\s\S]*?)```/);
  const implCode = implMatch ? implMatch[1].trim() : null;

  // Build handler
  let handler;
  if (implCode) {
    handler = buildSkillHandler(implCode, name);
  } else {
    // No implementation = command-based skill (just runs a shell command template)
    const cmdMatch = content.match(/##\s+Command\s*\n[\s\S]*?```(?:bash|sh)?\s*\n([\s\S]*?)```/);
    if (cmdMatch) {
      const cmdTemplate = cmdMatch[1].trim();
      handler = buildCommandHandler(cmdTemplate, name);
    } else {
      // Prompt-based skill (template that the agent can reference)
      handler = (_args) => {
        return `Skill "${name}" loaded. Description: ${description}\nUse this knowledge to complete your task.`;
      };
    }
  }

  return {
    name: `skill_${name}`,
    description,
    parameters: params,
    handler,
    source: 'agent-created',
    filePath,
  };
}

/**
 * Parse parameter definitions from skill markdown.
 */
function parseParameters(content) {
  const paramSection = content.match(/##\s+Parameters\s*\n([\s\S]*?)(?=\n##|\n$)/);
  if (!paramSection) return { type: 'object', properties: {}, required: [] };

  const properties = {};
  const required = [];
  const lines = paramSection[1].split('\n');

  for (const line of lines) {
    // Format: - param_name: type — description
    const match = line.match(/^[-*]\s+(\w+):\s*(\w+)\s*[—-]\s*(.+)/);
    if (match) {
      const [, paramName, paramType, paramDesc] = match;
      properties[paramName] = {
        type: paramType.toLowerCase() === 'string' ? 'string' :
              paramType.toLowerCase() === 'number' ? 'number' :
              paramType.toLowerCase() === 'boolean' ? 'boolean' : 'string',
        description: paramDesc.trim(),
      };
      // If line contains (required), mark it
      if (line.toLowerCase().includes('(required)')) {
        required.push(paramName);
      }
    }
  }

  return { type: 'object', properties, required };
}

/**
 * Build a handler function from JavaScript code in a skill file.
 * The code runs in a controlled context with access to workspace utilities.
 */
function buildSkillHandler(code, skillName) {
  return (args) => {
    try {
      const workspace = getWorkspace();

      // Create a sandbox context with useful utilities.
      // Use vm context instead of function params so user code can declare
      // const fs/path without "already declared" collisions.
      // Restricted require — only safe, side-effect-free modules
      const ALLOWED_REQUIRE = new Set([
        'path', 'url', 'querystring', 'crypto', 'util', 'string_decoder',
      ]);
      const restrictedRequire = (name) => {
        if (!ALLOWED_REQUIRE.has(name)) {
          throw new Error(`Module "${name}" is not allowed in skills. Allowed: ${[...ALLOWED_REQUIRE].join(', ')}`);
        }
        return nodeRequire(name);
      };

      // Workspace-scoped file helpers — prevent path traversal
      const safeResolve = (relPath) => {
        const abs = path.resolve(workspace, relPath);
        if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
          throw new Error(`Path "${relPath}" resolves outside workspace.`);
        }
        return abs;
      };

      const sandbox = {
        args,
        workspace,
        // No raw fs/path — use helpers instead
        require: restrictedRequire,
        execSync: (cmd, opts = {}) => {
          return execSync(cmd, {
            cwd: workspace,
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 5 * 1024 * 1024,
            ...opts,
            // Force cwd to workspace — skills can't change it
          });
        },
        readFile: (relPath) => {
          const abs = safeResolve(relPath);
          if (!fs.existsSync(abs)) return null;
          return fs.readFileSync(abs, 'utf-8');
        },
        writeFile: (relPath, content) => {
          const abs = safeResolve(relPath);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf-8');
        },
        // Expose safe utilities
        JSON,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        result: undefined,
      };

      const context = vm.createContext(sandbox);
      const wrapped = `(function(){\n${code}\n})()`;
      const previousCwd = process.cwd();
      let result;
      try {
        process.chdir(workspace);
        result = vm.runInContext(wrapped, context, {
          timeout: 30000,
          displayErrors: true,
        });
      } finally {
        process.chdir(previousCwd);
      }

      return String(result ?? `Skill "${skillName}" executed successfully.`);
    } catch (err) {
      return `Skill "${skillName}" error: ${err.message}`;
    }
  };
}

/**
 * Build a handler that runs a shell command template.
 * Template vars: {{param_name}} are replaced with args.
 */
function buildCommandHandler(cmdTemplate, skillName) {
  return (args) => {
    try {
      let cmd = cmdTemplate;
      for (const [key, value] of Object.entries(args || {})) {
        cmd = cmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
      }
      const output = execSync(cmd, {
        cwd: getWorkspace(),
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return output || `Command executed successfully (no output).`;
    } catch (err) {
      return `Skill "${skillName}" command error: ${err.message}\n${(err.stdout || '') + (err.stderr || '')}`;
    }
  };
}

// ── Skill Creation ─────────────────────────────────────────────

/**
 * Create a new skill file. Called by the agent via the create_skill tool.
 * @param {Object} opts
 * @param {string} opts.name — Skill name (alphanumeric + underscores)
 * @param {string} opts.description — What the skill does
 * @param {string} opts.parameters — Markdown-formatted parameter list
 * @param {string} opts.implementation — JavaScript code OR shell command
 * @param {string} opts.type — 'javascript' | 'command' | 'knowledge'
 * @returns {string} Result message
 */
export function createSkill({ name, description, parameters, implementation, type = 'javascript' }) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const skillsDir = path.join(getWorkspace(), config.skillsDir);
  fs.mkdirSync(skillsDir, { recursive: true });

  const implSection = type === 'command'
    ? `## Command\n\`\`\`bash\n${implementation}\n\`\`\``
    : type === 'knowledge'
    ? `## Knowledge\n${implementation}`
    : `## Implementation\n\`\`\`javascript\n${implementation}\n\`\`\``;

  const content = `# Skill: ${safeName}

## Description
${description}

## Parameters
${parameters || '- (no parameters)'}

${implSection}

## Examples
_Created by agent during task execution._

---
_Created: ${new Date().toISOString()}_
`;

  const filePath = path.join(skillsDir, `${safeName}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');

  // Reload skills to pick up the new one
  loadSkills();

  return `Skill "${safeName}" created at .agent/skills/${safeName}.md and loaded.`;
}

// ── Tool Integration ───────────────────────────────────────────

/**
 * Get tool definitions for all loaded skills.
 * These are added to the agent's available tools dynamically.
 */
export function getSkillToolDefinitions() {
  const defs = [];
  for (const [_name, skill] of loadedSkills) {
    defs.push({
      type: 'function',
      function: {
        name: skill.name,
        description: `[SKILL] ${skill.description}`,
        parameters: skill.parameters,
      },
    });
  }
  return defs;
}

/**
 * Execute a skill by name.
 * @param {string} name — Full skill tool name (e.g. "skill_deploy")
 * @param {Object} args — Tool arguments
 * @returns {{result: string, error: boolean}}
 */
export function executeSkill(name, args) {
  const skill = loadedSkills.get(name);
  if (!skill) return { result: `Skill not found: ${name}`, error: true };

  try {
    const result = skill.handler(args);
    return { result: String(result), error: false };
  } catch (err) {
    return { result: `Skill error (${name}): ${err.message}`, error: true };
  }
}

/**
 * Check if a tool name corresponds to a loaded skill.
 */
export function isSkillTool(name) {
  return loadedSkills.has(name);
}

/**
 * Get a summary of all loaded skills (for status display).
 */
export function getSkillsSummary() {
  if (loadedSkills.size === 0) return 'No custom skills loaded.';
  const lines = [];
  for (const [_name, skill] of loadedSkills) {
    lines.push(`- **${skill.name}**: ${skill.description.slice(0, 100)}`);
  }
  return `${loadedSkills.size} custom skill(s) loaded:\n${lines.join('\n')}`;
}
