// src/tools/execution/lsp.js
// Lightweight LSP-style diagnostics — runs language-specific syntax/lint checks
// without requiring a running language server.
// Supports: .js/.mjs/.cjs, .ts, .py, .json, .yaml/.yml

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getWorkspace } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'lsp',
    description: 'Run syntax and lint diagnostics on a file. Returns errors and warnings using language-specific tools (node --check, tsc, python, eslint, etc.).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to check (relative to workspace root)' },
      },
      required: ['path'],
    },
  },
};

export function handler({ path: filePath }) {
  const workspace = getWorkspace();
  const abs = path.resolve(workspace, filePath);
  const ext = path.extname(filePath).toLowerCase();

  try {
    let output = '';

    if (ext === '.json') {
      try {
        JSON.parse(fs.readFileSync(abs, 'utf-8'));
        return `${filePath}: No JSON syntax errors.`;
      } catch (e) {
        return `${filePath}: JSON error — ${e.message}`;
      }
    }

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      try {
        execFileSync('node', ['--check', abs], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' });
        output = `${filePath}: No syntax errors (node --check).`;
      } catch (err) {
        return `${filePath}: Syntax error\n${err.stderr || err.message}`;
      }
      // Also try eslint if available
      try {
        const lint = execFileSync('npx', ['--no', 'eslint', '--format', 'compact', abs], {
          cwd: workspace, timeout: 15000, encoding: 'utf-8',
        });
        if (lint.trim()) output += `\n\nESLint:\n${lint.trim()}`;
      } catch (lintErr) {
        const lintOut = (lintErr.stdout || '') + (lintErr.stderr || '');
        if (lintOut.trim() && !lintOut.includes('not found') && !lintOut.includes('command not found')) {
          output += `\n\nESLint:\n${lintOut.trim()}`;
        }
      }
      return output;
    }

    if (ext === '.ts' || ext === '.tsx') {
      try {
        const result = execFileSync('npx', ['--no', 'tsc', '--noEmit', '--allowJs', '--checkJs'], {
          cwd: workspace, timeout: 30000, encoding: 'utf-8',
        });
        return result.trim() || `${filePath}: No TypeScript errors.`;
      } catch (err) {
        return `${filePath}: TypeScript check failed\n${err.message}`;
      }
    }

    if (ext === '.py') {
      try {
        execFileSync('python3', ['-m', 'py_compile', abs], {
          timeout: 5000, encoding: 'utf-8', stdio: 'pipe',
        });
        return `${filePath}: No Python syntax errors.`;
      } catch (err) {
        return `${filePath}: Python syntax error\n${err.stderr || err.message}`;
      }
    }

    if (ext === '.yaml' || ext === '.yml') {
      try {
        execFileSync('python3', ['-c', `import yaml,sys; yaml.safe_load(open(${JSON.stringify(abs)}))`], {
          timeout: 5000, encoding: 'utf-8', stdio: 'pipe',
        });
        return `${filePath}: No YAML syntax errors.`;
      } catch (err) {
        return `${filePath}: YAML error\n${err.stderr || err.message}`;
      }
    }

    return `${filePath}: No diagnostic checker available for ${ext || 'unknown'} files.`;
  } catch (err) {
    return `Diagnostics error: ${err.message}`;
  }
}
