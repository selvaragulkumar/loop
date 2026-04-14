import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { readFilesTouched } from './state.js';

export const STAGE_ORDER = ['intake', 'discovery', 'planning', 'execution', 'verification', 'finalization'];
const STAGE_COMPLETE_TAG = 'stage_status: complete';
const STAGE_DRAFT_TAG = 'stage_status: draft';

const DEFAULT_BUDGET_RATIOS = {
  intake: 0.05,
  discovery: 0.10,
  planning: 0.10,
  execution: 0.55,
  verification: 0.10,
  finalization: 0.10,
};

export const STAGE_TOOL_ALLOWLIST = {
  intake: ['read_file', 'list_dir', 'think', 'write_file', 'save_memory', 'finish'],
  discovery: ['read_file', 'list_dir', 'search_files', 'glob', 'run_command', 'think', 'write_file', 'finish'],
  planning: ['think', 'update_plan', 'todowrite', 'todoread', 'save_memory', 'write_file', 'read_file', 'list_dir', 'run_command', 'finish'],
  execution: null,
  verification: ['run_command', 'read_file', 'search_files', 'lsp', 'write_file', 'edit_file', 'think', 'finish'],
  finalization: ['write_file', 'edit_file', 'read_file', 'run_command', 'finish', 'think'],
};

function parseRequiredOutputs(taskText) {
  const text = String(taskText || '');
  const outputs = new Set();
  let currentSection = '';
  let inRequiredOutputs = false;
  let inOptionalBlock = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    if (/^##+\s+/.test(line)) {
      currentSection = line.toLowerCase();
      inOptionalBlock = currentSection.includes('optional');
      inRequiredOutputs = false;
      continue;
    }

    if (/^required final outputs:/i.test(line)) {
      inRequiredOutputs = true;
      inOptionalBlock = false;
      continue;
    }

    if (/^optional/i.test(line)) {
      inOptionalBlock = true;
      inRequiredOutputs = false;
      continue;
    }

    const matches = line.match(/result\/[A-Za-z0-9._/-]+\.(?:md|json|txt|csv)/g) || [];
    if (matches.length === 0) continue;

    if (inRequiredOutputs) {
      for (const match of matches) outputs.add(match);
      continue;
    }

    if (line.startsWith('-') && !inOptionalBlock) {
      for (const match of matches) outputs.add(match);
      continue;
    }

    if (/^create:/i.test(line) && !inOptionalBlock && currentSection.includes('phase')) {
      for (const match of matches) outputs.add(match);
    }
  }

  return [...outputs];
}

function parseExampleJsonBlock(lines, startIndex) {
  let inFence = false;
  const jsonLines = [];

  for (let i = startIndex; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!inFence) {
      if (line.startsWith('```json')) {
        inFence = true;
      } else if (line.startsWith('```')) {
        inFence = true;
      } else if (line) {
        break;
      }
      continue;
    }

    if (line.startsWith('```')) break;
    jsonLines.push(rawLine);
  }

  if (jsonLines.length === 0) return null;
  try {
    return JSON.parse(jsonLines.join('\n'));
  } catch {
    return null;
  }
}

function extractSchemaPaths(schema, prefix = '') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const paths = [];
  for (const [key, value] of Object.entries(schema)) {
    const next = prefix ? `${prefix}.${key}` : key;
    paths.push(next);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...extractSchemaPaths(value, next));
    }
  }
  return paths;
}

function inferSchemaType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function extractSchemaRules(schema, prefix = '') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const rules = [];
  for (const [key, value] of Object.entries(schema)) {
    const next = prefix ? `${prefix}.${key}` : key;
    rules.push({ path: next, type: inferSchemaType(value) });
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      rules.push(...extractSchemaRules(value, next));
    }
  }
  return rules;
}

function parseOutputContracts(taskText) {
  const lines = String(taskText || '').split('\n');
  const contracts = {};
  let currentFile = null;
  let captureMode = null;
  let awaitingItems = false;

  const ensureContract = (file) => {
    if (!file) return null;
    if (!contracts[file]) {
      contracts[file] = { headings: [], sections: [], schemaPaths: [], schemaRules: [] };
    }
    return contracts[file];
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    const fileMatches = rawLine.match(/result\/[A-Za-z0-9._/-]+\.(?:md|json|txt|csv)/g) || [];
    if (fileMatches.length === 1) {
      currentFile = fileMatches[0];
      ensureContract(currentFile);
    }

    if (/^under heading:/i.test(line)) {
      captureMode = 'headings';
      awaitingItems = true;
      continue;
    }
    if (/^with short sections:/i.test(line) || /^include these sections:/i.test(line)) {
      captureMode = 'sections';
      awaitingItems = true;
      continue;
    }
    if (/^use this schema:/i.test(line)) {
      const contract = ensureContract(currentFile);
      const schema = parseExampleJsonBlock(lines, i + 1);
      if (contract && schema) {
        contract.schemaPaths = [...new Set([...contract.schemaPaths, ...extractSchemaPaths(schema)])];
        contract.schemaRules = extractSchemaRules(schema);
      }
      captureMode = null;
      continue;
    }

    if (captureMode === 'headings') {
      if (!line) {
        if (awaitingItems) continue;
        captureMode = null;
        continue;
      }
      const match = line.match(/^-\s+`?(.+?)`?$/);
      if (!match) {
        captureMode = null;
        continue;
      }
      awaitingItems = false;
      ensureContract(currentFile)?.headings.push(match[1]);
      continue;
    }

    if (captureMode === 'sections') {
      if (!line) {
        if (awaitingItems) continue;
        captureMode = null;
        continue;
      }
      const match = line.match(/^(?:[-*]|\d+\.)\s+(.+?)\s*$/);
      if (!match) {
        captureMode = null;
        continue;
      }
      awaitingItems = false;
      ensureContract(currentFile)?.sections.push(match[1].replace(/`/g, ''));
    }
  }

  for (const contract of Object.values(contracts)) {
    contract.headings = [...new Set(contract.headings)];
    contract.sections = [...new Set(contract.sections)];
    contract.schemaPaths = [...new Set(contract.schemaPaths)];
    contract.schemaRules = contract.schemaRules || [];
  }

  return contracts;
}

function parseLockedTargets(taskText) {
  const text = String(taskText || '');
  const targets = new Set();

  // Legacy pattern: explicit playground_app/ paths
  for (const m of text.match(/playground_app\/[A-Za-z0-9._/-]+/g) || []) {
    targets.add(m);
  }

  // Generic pattern: detect file paths listed under "Project Structure" or similar
  // code-fence blocks that describe the folder layout.
  // Matches lines like "  main.py          # Entry point" inside a fenced block
  // preceded by a folder line like "snake_game/"
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let fenceMatch;
  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    const block = fenceMatch[1];
    const lines = block.split('\n');
    let currentDir = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Strip inline comments: "main.py   # Entry point" → "main.py"
      const clean = trimmed.split(/\s{2,}|\s*#/)[0].trim();
      if (!clean) continue;
      // Directory line: ends with /
      if (clean.endsWith('/') && !clean.includes(' ')) {
        currentDir = clean;
        continue;
      }
      // File line: has an extension and is under a directory
      if (currentDir && /\.[A-Za-z0-9]+$/.test(clean) && !clean.includes(' ')) {
        targets.add(`${currentDir}${clean}`);
      }
    }
  }

  return [...targets];
}

function parseRequiredCommands(taskText) {
  const lines = String(taskText || '').split('\n');
  const commands = new Set();
  let inCommandBlock = false;
  let inFence = false;
  let fenceLines = [];
  let currentSection = '';

  const pushFenceCommands = (rawFenceLines) => {
    let pending = '';
    for (const rawFenceLine of rawFenceLines) {
      let line = String(rawFenceLine || '').trim();
      if (!line || line.startsWith('#')) continue;
      line = line.replace(/^\$\s+/, '');
      const continued = /\\\s*$/.test(line);
      line = line.replace(/\\\s*$/, '').trim();
      if (!line) continue;
      pending = pending ? `${pending} ${line}` : line;
      if (!continued) {
        const normalized = pending.replace(/\s+/g, ' ').trim();
        if (normalized) commands.add(normalized);
        pending = '';
      }
    }

    if (pending) {
      const normalized = pending.replace(/\s+/g, ' ').trim();
      if (normalized) commands.add(normalized);
    }
  };

  const flushFence = () => {
    if (fenceLines.length === 0) return;
    pushFenceCommands(fenceLines);
    fenceLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^##+\s+/.test(line)) {
      if (inFence) {
        flushFence();
        inFence = false;
      }
      currentSection = line.toLowerCase();
      inCommandBlock = false;
      continue;
    }

    if (/^run exactly once:/i.test(line) || /^run these commands as needed:/i.test(line) ||
        /^the agent must execute all of the following commands exactly:/i.test(line) ||
        /^execute the following commands:/i.test(line)) {
      inCommandBlock = true;
      continue;
    }

    // Detect verification-oriented section headings broadly
    const isVerificationSection =
      currentSection.includes('phase') ||
      currentSection.includes('pre-finish checklist') ||
      /verif(y|ication|ication commands?)?/i.test(currentSection) ||
      /validation( commands?)?/i.test(currentSection) ||
      /done criteria/i.test(currentSection) ||
      /required (verification|validation) commands?/i.test(currentSection);

    if (line.startsWith('```')) {
      if (inCommandBlock || isVerificationSection) {
        if (inFence) {
          flushFence();
          inFence = false;
        } else {
          inFence = true;
          fenceLines = [];
        }
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(rawLine);
      continue;
    }

    const commandMatch = line.match(/^(?:\d+\.\s+)?`([^`].*?)`$/);
    if (commandMatch && (inCommandBlock || isVerificationSection || currentSection.includes('phase 1') || currentSection.includes('phase 4'))) {
      commands.add(commandMatch[1]);
      continue;
    }

    if (inCommandBlock && line && !/^[-*]/.test(line)) {
      inCommandBlock = false;
    }
  }

  if (inFence) flushFence();

  return [...commands];
}

function normalizeCommand(text) {
  return String(text || '')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function commandEvidenceSatisfied(requiredCommand, history) {
  const target = normalizeCommand(requiredCommand);
  return history.some((entry) => {
    if (Number(entry.exitCode) !== 0) return false;
    const executed = normalizeCommand(entry.command);
    return executed === target || executed.includes(target) || target.includes(executed);
  });
}

function extractNodeTestTargets(command) {
  const text = String(command || '');
  if (!/\bnode\s+--test\b/.test(text)) return [];
  return [
    ...new Set(
      (text.match(/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[cm]?js/g) || [])
        .filter((candidate) => candidate.includes('/'))
    ),
  ];
}

function extractJsTargets(paths = []) {
  return [...new Set((paths || []).filter((candidate) => /\.(?:[cm]?js)$/i.test(String(candidate || ''))))];
}

function resolveModuleSpecifier(fromFile, specifier) {
  if (!specifier || !specifier.startsWith('.')) return '';
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function parseModuleExports(text) {
  const exports = new Set();
  let hasDefault = false;
  const content = String(text || '');

  if (/export\s+default\b/.test(content)) hasDefault = true;

  for (const match of content.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    exports.add(match[1]);
  }

  for (const match of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    const names = match[1].split(',').map((part) => part.trim()).filter(Boolean);
    for (const name of names) {
      const aliasMatch = name.match(/^(.*?)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) exports.add(aliasMatch[2].trim());
      else exports.add(name.trim());
    }
  }

  return { exports, hasDefault };
}

function parseModuleImports(text) {
  const imports = [];
  const content = String(text || '');
  for (const match of content.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = match[1].trim();
    const specifier = match[2].trim();
    if (!specifier.startsWith('.')) continue;

    const entry = { specifier, defaultImport: '', namedImports: [] };
    const parts = clause.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0 && !parts[0].startsWith('{') && !parts[0].startsWith('*')) {
      entry.defaultImport = parts[0];
    }

    const namedMatch = clause.match(/\{([^}]+)\}/);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map((part) => part.trim()).filter(Boolean);
      for (const name of names) {
        const aliasMatch = name.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        entry.namedImports.push(aliasMatch ? aliasMatch[1] : name);
      }
    }

    imports.push(entry);
  }
  return imports;
}

function inspectModuleCompatibility(filePath, workspace) {
  const abs = path.join(workspace, filePath);
  const text = readTextIfExists(abs);
  if (!text.trim()) return [];

  const issues = [];
  for (const importEntry of parseModuleImports(text)) {
    const target = resolveModuleSpecifier(abs, importEntry.specifier);
    if (!target) continue;
    const targetInfo = parseModuleExports(readTextIfExists(target));

    if (importEntry.defaultImport && !targetInfo.hasDefault) {
      issues.push(`${filePath} imports default from ${importEntry.specifier}, but ${path.relative(workspace, target)} has no default export`);
    }
    for (const named of importEntry.namedImports) {
      if (!targetInfo.exports.has(named)) {
        issues.push(`${filePath} imports "${named}" from ${importEntry.specifier}, but ${path.relative(workspace, target)} does not export it`);
      }
    }
  }
  return issues;
}

function isNodeTestFileCompatible(filePath, workspace) {
  const abs = path.join(workspace, filePath);
  const text = readTextIfExists(abs);
  if (!text.trim()) {
    return {
      compatible: false,
      reason: `${filePath} is missing or empty for required node --test verification`,
    };
  }

  const hasNodeTestImport = /from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/.test(text);
  const usesTestApi = /\btest\s*\(|\bdescribe\s*\(|\bit\s*\(/.test(text);
  const usesProcessExitHarness = /\bprocess\.exit\s*\(/.test(text);

  if (!hasNodeTestImport || !usesTestApi) {
    return {
      compatible: false,
      reason: `${filePath} is not structurally compatible with node --test`,
    };
  }

  if (usesProcessExitHarness) {
    return {
      compatible: false,
      reason: `${filePath} uses process.exit and looks like a pseudo-runner, not a node:test suite`,
    };
  }

  return { compatible: true, reason: '' };
}

function isLikelyFilePath(rel) {
  return /\/[^/]+\.[A-Za-z0-9]+$/.test(String(rel || ''));
}

function getFileStatus(abs) {
  if (!fs.existsSync(abs)) {
    return { exists: false, nonEmpty: false, lastModified: null };
  }
  try {
    const stat = fs.statSync(abs);
    return {
      exists: true,
      nonEmpty: stat.size > 0,
      lastModified: stat.mtime.toISOString(),
    };
  } catch {
    return { exists: true, nonEmpty: false, lastModified: null };
  }
}

export function getStageBudget(stage, maxSteps, ratios = DEFAULT_BUDGET_RATIOS) {
  const ratio = ratios?.[stage] ?? DEFAULT_BUDGET_RATIOS[stage] ?? 0.1;
  return Math.max(1, Math.floor(maxSteps * ratio));
}

export function createInitialStageState(taskText, maxSteps, ratios = DEFAULT_BUDGET_RATIOS) {
  return {
    currentStage: 'intake',
    stageStep: 0,
    stageStartedAt: new Date().toISOString(),
    stageCompletedAt: null,
    stageBlockedReason: '',
    finishAllowed: false,
    finalizationReady: false,
    nextRequiredActionHint: 'Complete intake artifacts.',
    missingDeliverables: [],
    missingCommandEvidence: [],
    repairModeActive: false,
    lastFailedRequiredCommand: '',
    relatedRepairTargets: [],
    expectedRepairScope: '',
    narrativeRecoverySuppressed: false,
    maxSteps,
    budgetRatios: { ...DEFAULT_BUDGET_RATIOS, ...(ratios || {}) },
    lockedTargets: parseLockedTargets(taskText),
    requiredCommands: parseRequiredCommands(taskText),
    requiredOutputs: parseRequiredOutputs(taskText),
    outputContracts: parseOutputContracts(taskText),
    executionContractPath: '.agent/execution-contract.md',
    discoverySummaryPath: '.agent/discovery-summary.md',
    verificationSummaryPath: '.agent/verification-summary.md',
    taskContractPath: '.agent/task-contract.md',
  };
}

export function getStageGuidance(stage, step, stageStep) {
  switch (stage) {
    case 'intake':
      return `STAGE: INTAKE (step ${stageStep}, global ${step}). Understand the task. Update .agent/task-contract.md and set "${STAGE_COMPLETE_TAG}" when done.`;
    case 'discovery':
      return `STAGE: DISCOVERY (step ${stageStep}, global ${step}). Ground the task in the repo. Update .agent/discovery-summary.md and set "${STAGE_COMPLETE_TAG}" when done.`;
    case 'planning':
      return `STAGE: PLANNING (step ${stageStep}, global ${step}). Create a concrete plan and .agent/execution-contract.md. Set "${STAGE_COMPLETE_TAG}" when ready for execution. Do NOT summarize prior work or restate the runtime anchor. If runtime status already shows missing workspace artifacts, stop rediscovery and start creating the missing files with concrete tool calls.`;
    case 'execution':
      return `STAGE: EXECUTION (step ${stageStep}, global ${step}). Implement per plan. Avoid task reinterpretation drift.`;
    case 'verification':
      return `STAGE: VERIFICATION (step ${stageStep}, global ${step}). Run checks, collect evidence, and set "${STAGE_COMPLETE_TAG}" in .agent/verification-summary.md.
IMPORTANT — Runtime Smoke Test: You MUST write a file called _smoke_test.py (or _smoke_test.js) in the workspace root and run it. Requirements:
  - Use PACKAGE imports (e.g. "from snake_game.snake import Snake"), NOT "cd package && from snake import..."
  - Instantiate key classes and call their methods
  - NO interactive features (no curses.wrapper, no input(), no GUI)
  - Print "SMOKE OK" at the end
  - Run from workspace root: python3 _smoke_test.py
If the smoke test crashes, read the traceback, fix the bug with edit_file, and re-run until "SMOKE OK" prints.
Only set stage_status: complete AFTER _smoke_test.py prints "SMOKE OK".`;
    case 'finalization':
      return `STAGE: FINALIZATION (step ${stageStep}, global ${step}). Ensure required outputs exist and are non-empty. If any runtime errors remain, fix them with edit_file before calling finish.`;
    default:
      return '';
  }
}

export function inspectStageState(stageState, workspace) {
  const deliverables = [];
  const missingWorkspaceArtifacts = [];
  const missingOutputs = [];
  const invalidContracts = [];
  const missingCommandEvidence = [];
  const invalidVerificationArtifacts = [];
  const commandHistoryPath = path.join(workspace, config.commandsRunFile);
  let commandHistory = [];

  try {
    commandHistory = JSON.parse(readTextIfExists(commandHistoryPath)) || [];
  } catch {
    commandHistory = [];
  }

  for (const command of stageState.requiredCommands || []) {
    for (const target of extractNodeTestTargets(command)) {
      const compatibility = isNodeTestFileCompatible(target, workspace);
      if (!compatibility.compatible) {
        invalidVerificationArtifacts.push(compatibility.reason);
      }
    }
    if (!commandEvidenceSatisfied(command, commandHistory)) {
      missingCommandEvidence.push(command);
    }
  }

  for (const filePath of extractJsTargets(stageState.lockedTargets || [])) {
    for (const issue of inspectModuleCompatibility(filePath, workspace)) {
      invalidVerificationArtifacts.push(issue);
    }
  }

  for (const rel of stageState.lockedTargets || []) {
    if (!isLikelyFilePath(rel)) continue;
    const abs = path.join(workspace, rel);
    const status = getFileStatus(abs);
    deliverables.push({
      path: rel,
      kind: 'workspace_artifact',
      exists: status.exists,
      nonEmpty: status.nonEmpty,
      lastModified: status.lastModified,
      requiredForCompletion: true,
      contractSatisfied: status.exists && status.nonEmpty,
    });
    if (!status.exists) missingWorkspaceArtifacts.push(rel);
    else if (!status.nonEmpty) missingWorkspaceArtifacts.push(`${rel} (empty)`);
  }

  for (const rel of stageState.requiredOutputs || []) {
    const abs = path.join(workspace, rel);
    const status = getFileStatus(abs);
    let contractSatisfied = status.exists && status.nonEmpty;
    const contract = stageState.outputContracts?.[rel];
    const text = status.exists ? readTextIfExists(abs) : '';

    if (status.exists && !status.nonEmpty) missingOutputs.push(`${rel} (empty)`);
    if (!status.exists) missingOutputs.push(rel);

    if (contract && text) {
      for (const heading of contract.headings || []) {
        if (!text.includes(heading)) {
          invalidContracts.push(`${rel} missing heading "${heading}"`);
          contractSatisfied = false;
        }
      }

      for (const section of contract.sections || []) {
        const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headingPattern = new RegExp(`^#+\\s*${escaped}(?:\\s|$)`, 'mi');
        if (!headingPattern.test(text)) {
          invalidContracts.push(`${rel} missing section "${section}"`);
          contractSatisfied = false;
        }
      }

      const schemaRules = Array.isArray(contract.schemaRules) && contract.schemaRules.length > 0
        ? contract.schemaRules
        : (contract.schemaPaths || []).map((pathKey) => ({ path: pathKey, type: null }));

      if (schemaRules.length > 0) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          invalidContracts.push(`${rel} is not valid JSON`);
          parsed = null;
          contractSatisfied = false;
        }

        if (parsed) {
          for (const rule of schemaRules) {
            const pathKey = rule.path;
            const parts = pathKey.split('.');
            let current = parsed;
            let ok = true;
            for (const part of parts) {
              if (!current || typeof current !== 'object' || !(part in current)) {
                ok = false;
                break;
              }
              current = current[part];
            }
            if (!ok) {
              invalidContracts.push(`${rel} missing key "${pathKey}"`);
              contractSatisfied = false;
              continue;
            }

            if (rule.type && rule.type !== 'null') {
              const actualType = Array.isArray(current) ? 'array' : typeof current;
              if (actualType !== rule.type) {
                invalidContracts.push(`${rel} key "${pathKey}" has wrong type: expected ${rule.type}, got ${actualType}`);
                contractSatisfied = false;
              }
            }
          }
        }
      }
    }

    deliverables.push({
      path: rel,
      kind: 'result',
      exists: status.exists,
      nonEmpty: status.nonEmpty,
      lastModified: status.lastModified,
      requiredForCompletion: true,
      contractSatisfied,
    });
  }

  const implementationReady = missingWorkspaceArtifacts.length === 0;
  const verificationComplete = implementationReady && missingCommandEvidence.length === 0 && invalidVerificationArtifacts.length === 0;
  const finalizationReady = verificationComplete;
  // Require at least one file modification before advancing past execution or allowing finish.
  // Prevents the model from skipping to finalization without doing any work.
  const touched = readFilesTouched();
  // Only count workspace file modifications, not .agent/ internal files
  const hasFileModifications = Object.keys(touched.writes || {}).some(
    f => !f.startsWith('.agent/') && !f.startsWith('.agent\\')
  );
  const stageReadyToAdvance = (
    (stageState.currentStage === 'execution' && implementationReady && hasFileModifications) ||
    (stageState.currentStage === 'verification' && verificationComplete && hasFileModifications) ||
    (stageState.currentStage === 'finalization' && missingOutputs.length === 0 && invalidContracts.length === 0)
  );
  const finishAllowed = finalizationReady && missingOutputs.length === 0 && invalidContracts.length === 0 && stageState.currentStage === 'finalization' && hasFileModifications;

  let stageBlockedReason = '';
  let nextRequiredActionHint = 'Continue current stage work.';
  if (missingWorkspaceArtifacts.length > 0) {
    stageBlockedReason = `Missing workspace artifacts: ${missingWorkspaceArtifacts.join(', ')}`;
    nextRequiredActionHint = 'Create or populate the missing workspace artifacts.';
  } else if (invalidVerificationArtifacts.length > 0) {
    stageBlockedReason = `Verification artifacts are incompatible: ${invalidVerificationArtifacts.join(', ')}`;
    nextRequiredActionHint = 'Repair the failing test or verification files so they are structurally compatible with the required verification command.';
  } else if (missingCommandEvidence.length > 0) {
    stageBlockedReason = `Missing required command evidence: ${missingCommandEvidence.join(', ')}`;
    nextRequiredActionHint = 'Run the missing validation commands and capture success.';
  } else if (missingOutputs.length > 0) {
    stageBlockedReason = `Missing required outputs: ${missingOutputs.join(', ')}`;
    nextRequiredActionHint = 'Write the missing required output artifacts.';
  } else if (invalidContracts.length > 0) {
    stageBlockedReason = `Output contracts not satisfied: ${invalidContracts.join(', ')}`;
    nextRequiredActionHint = 'Repair the output artifacts so required headings, sections, and schema keys match.';
  } else if (!hasFileModifications) {
    stageBlockedReason = 'No files have been modified yet. You must use edit_file or write_file to make changes before finishing.';
    nextRequiredActionHint = 'Use edit_file with oldString/newString to fix the bugs, then run verification commands.';
  } else if (stageState.currentStage !== 'finalization') {
    stageBlockedReason = `Stage ${stageState.currentStage} is complete, but runtime has not advanced yet.`;
    nextRequiredActionHint = 'Advance to the next runtime stage.';
  } else {
    nextRequiredActionHint = 'Call finish.';
  }

  return {
    deliverables,
    missingWorkspaceArtifacts,
    missingOutputs,
    invalidContracts,
    invalidVerificationArtifacts,
    missingCommandEvidence,
    implementationReady,
    verificationComplete,
    finalizationReady,
    stageReadyToAdvance,
    finishAllowed,
    hasFileModifications,
    stageBlockedReason,
    nextRequiredActionHint,
  };
}

export function getRuntimeStatusBlock(stageState, workspace, extra = {}) {
  if (!workspace || !stageState) return '';
  const status = inspectStageState(stageState, workspace);
  const lockedRoot = (stageState.lockedTargets || []).find((item) => !isLikelyFilePath(item)) || 'n/a';
  const recentRecovery = extra.recentRecoveryRule || stageState.recentRecoveryRule || 'none';
  const compactionCount = Number(extra.compactionCount || 0);
  const availableTools = Array.isArray(extra.availableTools) && extra.availableTools.length > 0
    ? extra.availableTools.join(', ')
    : 'all';
  return [
    '## Runtime Status',
    `- current_stage: ${stageState.currentStage}`,
    `- available_tools_this_step: [${availableTools}]`,
    `- stage_ready_to_advance: ${status.stageReadyToAdvance ? 'yes' : 'no'}`,
    `- implementation_ready: ${status.implementationReady ? 'yes' : 'no'}`,
    `- verification_complete: ${status.verificationComplete ? 'yes' : 'no'}`,
    `- finish_allowed: ${status.finishAllowed ? 'yes' : 'no'}`,
    `- finalization_ready: ${status.finalizationReady ? 'yes' : 'no'}`,
    `- blocked_reason: ${status.stageBlockedReason || 'none'}`,
    `- locked_root: ${lockedRoot}`,
    `- missing_outputs: ${status.missingOutputs.length ? status.missingOutputs.join(', ') : 'none'}`,
    `- missing_workspace_artifacts: ${status.missingWorkspaceArtifacts.length ? status.missingWorkspaceArtifacts.join(', ') : 'none'}`,
    `- missing_command_evidence: ${status.missingCommandEvidence.length ? status.missingCommandEvidence.join(', ') : 'none'}`,
    `- invalid_verification_artifacts: ${status.invalidVerificationArtifacts.length ? status.invalidVerificationArtifacts.join(', ') : 'none'}`,
    `- repair_mode_active: ${stageState.repairModeActive ? 'yes' : 'no'}`,
    `- last_failed_required_command: ${stageState.lastFailedRequiredCommand || 'none'}`,
    `- related_repair_targets: ${stageState.relatedRepairTargets?.length ? stageState.relatedRepairTargets.join(', ') : 'none'}`,
    `- recent_recovery_rule: ${recentRecovery}`,
    `- compaction_count: ${compactionCount}`,
    `- next_required_action: ${status.nextRequiredActionHint}`,
  ].join('\n');
}

export function filterToolsByStage(tools, stage) {
  const allow = STAGE_TOOL_ALLOWLIST[stage];
  if (!allow) return tools;
  return tools.filter((t) => allow.includes(t.function.name));
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function stageDocIsComplete(filePath, requiredPatterns = []) {
  const text = readTextIfExists(filePath);
  if (!text) return false;
  // Accept exact tag or common fuzzy variations models produce
  const hasCompleteTag = text.includes(STAGE_COMPLETE_TAG)
    || /stage.status.*(?:complete|ready|done)/im.test(text)
    || /ready.for.execution/im.test(text);
  if (!hasCompleteTag) return false;
  return requiredPatterns.every((p) => p.test(text));
}

function executionContractSignalsCompletion(text) {
  const content = String(text || '');
  if (!content.trim()) return false;

  const hasCompleteStatus = content.includes(STAGE_COMPLETE_TAG)
    || /^##\s+Status:\s*complete\b/im.test(content)
    || /^Status:\s*complete\b/im.test(content)
    // Fuzzy: models often write "ready for execution" or similar instead of the exact tag
    || /ready.for.execution/im.test(content)
    || /stage.status.*(?:complete|ready|done|execution)/im.test(content);

  const hasStructuredContract = /^##\s+Required Outputs/m.test(content)
    && /^##\s+(?:Verification Checkpoints|Completion Criteria|Validation|Checks)/m.test(content);

  const hasSemanticCompletionShape = /^##\s+Validation Commands/m.test(content)
    || /^##\s+Completion Criteria/m.test(content)
    || /^##\s+Expected Outputs/m.test(content)
    || /^##\s+(?:Execution Flow|Next Steps|Implementation Plan)/m.test(content)
    || /^##\s+Stage:\s*(execution|verification|finalization)\b/im.test(content)
    || /^Stage:\s*(execution|verification|finalization)\b/im.test(content);

  return hasCompleteStatus && (hasStructuredContract || hasSemanticCompletionShape);
}

function ensureFileIfMissing(filePath, content, { force = false } = {}) {
  if (!force && fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function buildChecklist(items) {
  if (!items || items.length === 0) return '- [ ] (none)';
  return items.map((p) => `- [ ] ${p}`).join('\n');
}

export function ensureStageArtifacts(stageState, workspace, taskText = '', { reset = false } = {}) {
  if (!workspace) return;
  const requiredOutputs = stageState.requiredOutputs || [];
  const lockedTargets = stageState.lockedTargets || [];
  const objective = String(taskText || '').split('\n').find((l) => l.trim()) || 'Task objective not specified';
  const taskContract = path.join(workspace, stageState.taskContractPath);
  const discoverySummary = path.join(workspace, stageState.discoverySummaryPath);
  const executionContract = path.join(workspace, stageState.executionContractPath);
  const verificationSummary = path.join(workspace, stageState.verificationSummaryPath);
  const opts = { force: reset };

  ensureFileIfMissing(taskContract, [
    '# Task Contract',
    STAGE_DRAFT_TAG,
    '',
    '## Objective',
    objective,
    '',
    '## Required Outputs',
    buildChecklist(requiredOutputs),
    '',
    '## Allowed Workspace Roots',
    buildChecklist(lockedTargets),
    '',
    '## Success Criteria',
    '- [ ] Outputs created and verified',
    '',
    `Set "${STAGE_COMPLETE_TAG}" when intake is complete.`,
    '',
  ].join('\n'), opts);

  ensureFileIfMissing(discoverySummary, [
    '# Discovery Summary',
    STAGE_DRAFT_TAG,
    '',
    '## Relevant Files',
    '- [ ]',
    '',
    '## Entry Points',
    '- [ ]',
    '',
    '## Risks',
    '- [ ]',
    '',
    `Set "${STAGE_COMPLETE_TAG}" when discovery is complete.`,
    '',
  ].join('\n'), opts);

  ensureFileIfMissing(executionContract, [
    '# Execution Contract',
    STAGE_DRAFT_TAG,
    '',
    '## Required Outputs',
    buildChecklist(requiredOutputs),
    '',
    '## Allowed Roots',
    buildChecklist(lockedTargets),
    '',
    '## Verification Checkpoints',
    '- [ ]',
    '',
    '## Completion Guard',
    'All required outputs must exist and be non-empty.',
    '',
    `Set "${STAGE_COMPLETE_TAG}" when planning is complete.`,
    '',
  ].join('\n'), opts);

  ensureFileIfMissing(verificationSummary, [
    '# Verification Summary',
    STAGE_DRAFT_TAG,
    '',
    '## Checks',
    '- [ ] command',
    '',
    '## Outcome',
    '- [ ] pass/fail/warn with evidence',
    '',
    `Set "${STAGE_COMPLETE_TAG}" when verification is complete.`,
    '',
  ].join('\n'), opts);
}

function shouldAdvanceStage(currentStage, stageState, workspace, planText = '') {
  const resolve = (p) => path.join(workspace, p);
  const runtime = inspectStageState(stageState, workspace);
  switch (currentStage) {
    case 'intake':
      return stageDocIsComplete(resolve(stageState.taskContractPath), [/^##\s+Objective/m, /^##\s+Required Outputs/m]);
    case 'discovery':
      return stageDocIsComplete(resolve(stageState.discoverySummaryPath), [/^##\s+Relevant Files/m, /^##\s+Entry Points/m]);
    case 'planning': {
      const executionContractText = readTextIfExists(resolve(stageState.executionContractPath));
      const hasStructuredContract = /^##\s+Required Outputs/m.test(executionContractText)
        && /^##\s+(?:Verification Checkpoints|Completion Criteria|Validation|Checks)/m.test(executionContractText);
      const hasTaggedContract = stageDocIsComplete(resolve(stageState.executionContractPath), [/^##\s+Required Outputs/m, /^##\s+(?:Verification Checkpoints|Completion Criteria|Validation|Checks)/m]);
      const hasSemanticCompletion = executionContractSignalsCompletion(executionContractText);
      const planHasHeadings = /###\s+/m.test(String(planText || ''));
      const implementationStarted = runtime.deliverables
        .filter((item) => item.kind === 'workspace_artifact')
        .some((item) => item.exists);
      const contractHasSubstance = executionContractText.length > 300
        && /^##\s+Phase/m.test(executionContractText);
      // Auto-advance: if model is already creating workspace files, it's effectively
      // in execution regardless of contract format. Don't trap it in planning.
      if (implementationStarted && contractHasSubstance) return true;
      // Fast-track: if all artifacts exist and verification is already complete, skip ahead.
      if (runtime.verificationComplete || runtime.finalizationReady) return true;
      // Fast-track: if implementation is well underway (files exist) and contract has any substance, advance.
      if (implementationStarted && executionContractText.length > 100) return true;
      return (hasTaggedContract && planHasHeadings)
        || (hasStructuredContract && (planHasHeadings || implementationStarted))
        || (hasSemanticCompletion && (implementationStarted || runtime.verificationComplete || runtime.finalizationReady));
    }
    case 'execution':
      return runtime.missingWorkspaceArtifacts.length === 0;
    case 'verification':
      return runtime.missingWorkspaceArtifacts.length === 0 && runtime.missingCommandEvidence.length === 0;
    case 'finalization':
      return false;
    default:
      return false;
  }
}

function nextStage(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return stage;
  return STAGE_ORDER[idx + 1];
}

export function tickAndAdvanceStage(stageState, step, workspace, planText = '') {
  const next = { ...stageState };
  next.stageStep = (next.stageStep || 0) + 1;
  let changed = false;
  let reason = '';
  const runtime = inspectStageState(next, workspace);
  next.stageBlockedReason = runtime.stageBlockedReason;
  next.finishAllowed = runtime.finishAllowed;
  next.finalizationReady = runtime.finalizationReady;
  next.implementationReady = runtime.implementationReady;
  next.verificationComplete = runtime.verificationComplete;
  next.nextRequiredActionHint = runtime.nextRequiredActionHint;
  next.missingDeliverables = [...runtime.missingWorkspaceArtifacts, ...runtime.missingOutputs];
  next.missingCommandEvidence = runtime.missingCommandEvidence;

  const transitions = [];
  // Advance at most one stage per tick — prevents skipping phases when multiple
  // advance conditions are simultaneously satisfied (e.g. stale artifacts from a prior run).
  if (shouldAdvanceStage(next.currentStage, next, workspace, planText)) {
    const old = next.currentStage;
    const advanced = nextStage(next.currentStage);
    if (advanced !== old) {
      next.currentStage = advanced;
      next.stageCompletedAt = new Date().toISOString();
      next.stageStartedAt = new Date().toISOString();
      next.stageStep = 1;
      changed = true;
      transitions.push(`${old}->${next.currentStage}`);
      const advancedRuntime = inspectStageState(next, workspace);
      next.stageBlockedReason = advancedRuntime.stageBlockedReason;
      next.finishAllowed = advancedRuntime.finishAllowed;
      next.finalizationReady = advancedRuntime.finalizationReady;
      next.implementationReady = advancedRuntime.implementationReady;
      next.verificationComplete = advancedRuntime.verificationComplete;
      next.nextRequiredActionHint = advancedRuntime.nextRequiredActionHint;
      next.missingDeliverables = [...advancedRuntime.missingWorkspaceArtifacts, ...advancedRuntime.missingOutputs];
      next.missingCommandEvidence = advancedRuntime.missingCommandEvidence;
    }
  }

  if (transitions.length > 0) {
    reason = `condition_met:${transitions.join(',')}`;
    next.lastStageTransitionReason = reason;
  } else {
    const budget = getStageBudget(next.currentStage, next.maxSteps || 500, next.budgetRatios);
    if (next.stageStep > budget && !next.stageBlockedReason) {
      next.stageBlockedReason = `Stage ${next.currentStage} exceeded its budget without satisfying runtime completion conditions.`;
    }
  }

  return { stageState: next, changed, reason };
}

export function completionGuard(stageState, workspace) {
  const runtime = inspectStageState(stageState, workspace);
  // Require that at least one real workspace file was modified (not just .agent/ internals)
  if (!runtime.hasFileModifications) {
    return 'Cannot finish: no workspace files were modified. At least one file must be created or edited.';
  }
  if (runtime.missingWorkspaceArtifacts.length > 0 || runtime.missingOutputs.length > 0) {
    return `Cannot finish: missing required outputs: ${[...runtime.missingWorkspaceArtifacts, ...runtime.missingOutputs].join(', ')}`;
  }
  if (runtime.invalidContracts.length > 0 || runtime.invalidVerificationArtifacts.length > 0 || runtime.missingCommandEvidence.length > 0) {
    return `Cannot finish: output contract not satisfied: ${[
      ...runtime.invalidContracts,
      ...runtime.invalidVerificationArtifacts,
      ...runtime.missingCommandEvidence.map((cmd) => `missing successful command evidence for "${cmd}"`),
    ].join(', ')}`;
  }
  return '';
}
