import { execSync } from 'node:child_process';
import config from '../../config.js';
import { getWorkspace, readCommandsRun, trackCommand } from '../../state.js';

export const definition = {
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Execute a shell command in the workspace directory. Returns stdout + stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeout: { type: 'integer', description: 'Timeout in ms (default: 30000)', default: 30000 },
        allowRepeat: { type: 'boolean', description: 'Set true to allow repeating the same command even if it was recently successful.', default: false },
      },
      required: ['command'],
    },
  },
};

function normalizeCommand(command) {
  return String(command || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^mkdir\s+-p\s+result\s*&&\s*/i, '');
}

function isSkippableDuplicateCandidate(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;

  // Only dedupe composite/setup-style commands. Single verification commands
  // like `node ... list` or `node --test ...` must remain repeatable.
  return normalized.includes('&&')
    || normalized.includes('||')
    || normalized.includes('>')
    || normalized.includes('|')
    || /^mkdir\s+-p\b/i.test(normalized);
}

function wasRecentlySuccessful(command, lookback = 20) {
  if (!isSkippableDuplicateCandidate(command)) return false;
  const normalized = normalizeCommand(command);
  const history = readCommandsRun();
  const recent = history.slice(-lookback).reverse();
  return recent.some(entry =>
    Number(entry.exitCode) === 0 &&
    entry.skipped !== true &&
    normalizeCommand(entry.command) === normalized
  );
}

function getLastCommandOutput(command, lookback = 20) {
  const normalized = normalizeCommand(command);
  const history = readCommandsRun();
  const recent = history.slice(-lookback).reverse();
  const match = recent.find(entry =>
    entry.skipped !== true &&
    normalizeCommand(entry.command) === normalized
  );
  return match ? String(match.outputSnippet || '').trim().slice(0, 200) : null;
}

// Default command allowlist. Extend via AGENT_ALLOWED_COMMANDS env var (comma-separated prefixes).
const DEFAULT_PREFIXES = [
  // JavaScript / Node.js
  'npm ', 'node ', 'npx ', 'yarn ', 'pnpm ', 'bun ', 'deno ', 'tsc ', 'jest ', 'mocha ', 'eslint ', 'prettier ',
  // Python
  'python', 'python3', 'pip ', 'pip3 ', 'pytest ', 'uv ',
  // Rust
  'cargo ', 'rustc ',
  // Go
  'go ',
  // Java / JVM
  'java ', 'javac ', 'mvn ', 'gradle ',
  // C / C++
  'make ', 'cmake ', 'gcc ', 'g++ ', 'cc ',
  // .NET
  'dotnet ',
  // Ruby
  'ruby ', 'bundle ', 'gem ', 'rake ',
  // Git
  'git ',
  // Docker
  'docker ', 'docker-compose ',
  // Shell utilities
  'cd ', 'cat ', 'ls ', 'find ', 'grep ', 'echo ', 'printf ', 'mkdir ', 'cp ', 'mv ', 'rm ',
  'bash ', 'sh ', 'pwd', 'sed ', 'head ', 'tail ', 'touch ', 'chmod ', 'chown ',
  'awk ', 'sort ', 'uniq ', 'wc ', 'diff ', 'tar ', 'zip ', 'unzip ',
  'which ', 'env ', 'test ', 'true', 'false', 'curl ', 'wget ',
];

const ALLOWED_PREFIXES = (() => {
  const extra = process.env.AGENT_ALLOWED_COMMANDS;
  if (!extra) return DEFAULT_PREFIXES;
  const custom = extra.split(',').map(s => s.trim()).filter(Boolean);
  return [...DEFAULT_PREFIXES, ...custom];
})();

function normalizeSegment(segment) {
  let text = String(segment || '').trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    text = text.slice(1, -1).trim();
  }
  text = text
    .replace(/\s+\d*>>?\s*[^&|;]+$/g, '')
    .replace(/\s+\d*>\s*&\d+\s*$/g, '')
    .trim();
  return text;
}

function splitCommandSegments(command) {
  const input = String(command || '');
  const segments = [];
  let current = '';
  let singleQuote = false;
  let doubleQuote = false;
  let escape = false;
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escape = true;
      continue;
    }

    if (ch === "'" && !doubleQuote) {
      singleQuote = !singleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !singleQuote) {
      doubleQuote = !doubleQuote;
      current += ch;
      continue;
    }

    if (!singleQuote && !doubleQuote) {
      if (ch === '(') {
        parenDepth++;
        current += ch;
        continue;
      }
      if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        current += ch;
        continue;
      }

      const twoChar = `${ch}${next || ''}`;
      if (parenDepth === 0 && (twoChar === '&&' || twoChar === '||')) {
        if (current.trim()) segments.push(normalizeSegment(current));
        current = '';
        i++;
        continue;
      }
      if (parenDepth === 0 && (ch === ';' || ch === '|')) {
        if (current.trim()) segments.push(normalizeSegment(current));
        current = '';
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) segments.push(normalizeSegment(current));
  return segments.filter(Boolean);
}

// Block dangerous shell metacharacters that bypass prefix validation
const DANGEROUS_PATTERNS = [
  /`[^`]+`/,        // backtick command substitution
  /\$\(/,           // $() command substitution
  /[<>]\(/,         // process substitution <() >()
];

function hasDangerousShellSyntax(command) {
  // Check the raw command outside of single-quoted strings (where metacharacters are literal)
  const withoutSingleQuoted = command.replace(/'[^']*'/g, '');
  return DANGEROUS_PATTERNS.some(p => p.test(withoutSingleQuoted));
}

function isAllowedCommand(command) {
  if (hasDangerousShellSyntax(command)) return false;
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const cmd = normalizeSegment(segment).toLowerCase();
    return ALLOWED_PREFIXES.some((prefix) => cmd.startsWith(prefix));
  });
}

export function handler({ command, timeout, allowRepeat }) {
  const timeoutMs = timeout || 30000;
  if (!isAllowedCommand(command)) {
    return `Blocked: command "${String(command || '').slice(0, 80)}" not in allowlist.`;
  }
  if (!allowRepeat && wasRecentlySuccessful(command)) {
    const prevOutput = getLastCommandOutput(command);
    const msg = `Skipped duplicate command: ${command}${prevOutput ? `\n[Last result: ${prevOutput}]` : ''}`;
    trackCommand(command, 0, msg, { skipped: true });
    return msg;
  }

  try {
    const output = execSync(command, {
      cwd: getWorkspace(),
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    trackCommand(command, 0, output, { skipped: false });
    const lines = output.split('\n');
    if (lines.length > config.maxTerminalLines) {
      const kept = Math.floor(config.maxTerminalLines / 2);
      return [
        ...lines.slice(0, kept),
        `\n... [${lines.length - config.maxTerminalLines} lines omitted] ...\n`,
        ...lines.slice(-kept),
      ].join('\n');
    }
    return output || '(no output)';
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    const exitCode = Number.isInteger(err.status) ? err.status : 1;
    if (exitCode === 0) {
      trackCommand(command, 0, output, { skipped: false });
      return output || '(no output)';
    }
    trackCommand(command, exitCode, output, { skipped: false });
    return `Exit code ${exitCode}:\n${output.slice(0, 5000)}`;
  }
}
