// advanced-agent-loop/src/state.js
// File-based state management — the filesystem IS the state machine.
// All state is markdown/JSON on disk. Crash-safe, human-readable, resumable.
// Now includes identity layer bootstrapping, skills dir, and focus chain.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

let workspaceRoot = process.cwd();

export function setWorkspace(dir) {
  workspaceRoot = dir;
}

export function getWorkspace() {
  return workspaceRoot;
}

function resolve(relativePath) {
  return path.join(workspaceRoot, relativePath);
}

// ── Init ───────────────────────────────────────────────────────

/** Create the full .agent/ directory structure. Non-destructive (skips existing files). */
export function initAgentDir() {
  const dirs = [
    config.agentDir,
    config.memoryDir,
    config.skillsDir,
  ];
  for (const d of dirs) {
    fs.mkdirSync(resolve(d), { recursive: true });
  }

  // Create empty files only if they don't exist
  const defaults = {
    [config.taskFile]: '',
    [config.planFile]: '# Plan\n\n_No plan yet._\n',
    [config.progressFile]: '# Progress Log\n\n',
    [config.contextSummaryFile]: '',
    [config.checkpointFile]: JSON.stringify({
      step: 0,
      phase: 'init',
      workingMemory: [],
      compactionCount: 0,
      skillsCreated: 0,
      memoriesSaved: 0,
    }, null, 2),
    [config.filesTouchedFile]: JSON.stringify({ reads: {}, writes: {}, freshness: {} }, null, 2),
    [config.commandsRunFile]: JSON.stringify([], null, 2),
    [config.recoveryEventsFile]: JSON.stringify([], null, 2),
    [config.learningsFile]: '# Learnings\n\n',
    [config.focusChainFile]: '# Focus Chain\n\n_Human-editable: add items here to steer the agent._\n\n- [ ] (no focus items set)\n',
  };

  for (const [relPath, content] of Object.entries(defaults)) {
    const abs = resolve(relPath);
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, content, 'utf-8');
    }
  }
}

// ── Read Helpers ───────────────────────────────────────────────

export function readText(relPath) {
  const abs = resolve(relPath);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf-8');
}

export function readJSON(relPath) {
  const text = readText(relPath);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function normalizeFilesTouchedShape(data) {
  return {
    reads: data?.reads && typeof data.reads === 'object' ? data.reads : {},
    writes: data?.writes && typeof data.writes === 'object' ? data.writes : {},
    freshness: data?.freshness && typeof data.freshness === 'object' ? data.freshness : {},
  };
}

export function readTask()           { return readText(config.taskFile); }
export function readPlan()           { return readText(config.planFile); }
export function readProgress()       { return readText(config.progressFile); }

function sanitizeContextSummary(text) {
  const original = String(text || '');
  if (!original) return original;

  let summary = original.replace(/<\/?think>/gi, '');
  const contaminationPatterns = [
    /The user wants me to produce .*summary/i,
    /Let me (analyze|construct|merge|re-read).*(summary|context)/i,
    /Looking at the context, I can see(?::|\s)/i,
    /I'?m at step \d+/i,
    /Let me think about what'?s happening/i,
    /Current state from runtime anchor/i,
    /Let me create a compact summary/i,
    /Key observations:/i,
    /New Steps to Summarize/i,
    /Previous Summary/i,
  ];

  if (contaminationPatterns.some((pattern) => pattern.test(summary))) {
    const lines = summary.split('\n');
    const cleaned = [];
    let skippingNarrative = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^##\s+/.test(trimmed) || /^<!--.*-->$/.test(trimmed)) {
        skippingNarrative = false;
        cleaned.push(line);
        continue;
      }

      if (contaminationPatterns.some((pattern) => pattern.test(trimmed))) {
        skippingNarrative = true;
        continue;
      }

      if (skippingNarrative) {
        if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || /^Step\s+\d+:/i.test(trimmed)) continue;
        if (/^Current state/i.test(trimmed) || /^Let me /i.test(trimmed) || /^Looking at /i.test(trimmed)) continue;
        if (trimmed === '') continue;
      }

      cleaned.push(line);
    }

    summary = cleaned.join('\n').trim();
  }

  return summary;
}

export function readContextSummary() { return sanitizeContextSummary(readText(config.contextSummaryFile)); }
export function readCheckpoint()     { return readJSON(config.checkpointFile); }
export function readFilesTouched()   { return normalizeFilesTouchedShape(readJSON(config.filesTouchedFile)); }
export function readCommandsRun()    { return readJSON(config.commandsRunFile) || []; }
export function readRecoveryEvents() { return readJSON(config.recoveryEventsFile) || []; }
export function readLearnings()      { return readText(config.learningsFile); }
export function readFocusChain()     { return readText(config.focusChainFile); }

// ── Write Helpers ──────────────────────────────────────────────

export function writeText(relPath, content) {
  const abs = resolve(relPath);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  } catch (err) {
    console.error(`[state] writeText failed (${relPath}): ${err.message}`);
    throw err; // re-throw so callers (e.g. saveCheckpoint) know it failed
  }
}

export function writeJSON(relPath, data) {
  writeText(relPath, JSON.stringify(data, null, 2));
}

export function writeTask(content)           { writeText(config.taskFile, content); }
export function writePlan(content)           { writeText(config.planFile, content); }
export function writeProgress(content)       { writeText(config.progressFile, content); }
export function writeContextSummary(content) { writeText(config.contextSummaryFile, content); }
export function writeCheckpoint(data) {
  // Atomic write: write to temp file then rename to prevent partial-write corruption
  const abs = path.join(workspaceRoot, config.checkpointFile);
  const tmp = abs + '.tmp';
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmp); } catch {}
    console.error(`[state] writeCheckpoint failed: ${err.message}`);
    throw err;
  }
}
export function writeFilesTouched(data)      { writeJSON(config.filesTouchedFile, data); }
export function writeCommandsRun(data)       { writeJSON(config.commandsRunFile, data); }
export function writeRecoveryEvents(data)    { writeJSON(config.recoveryEventsFile, data); }
export function writeLearnings(content)      { writeText(config.learningsFile, content); }

// ── Append Helpers ─────────────────────────────────────────────

const PROGRESS_MAX_BYTES = 200_000; // 200KB — rotate beyond this

export function appendProgress(entry) {
  const abs = resolve(config.progressFile);
  try {
    // Inject wall-clock timestamp into step headers for auditability
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const stamped = entry.replace(/(^|\n)(## Step \d+)/, `$1$2 [${now}]`);

    // Rotate when file exceeds size limit to prevent unbounded growth
    if (fs.existsSync(abs) && fs.statSync(abs).size > PROGRESS_MAX_BYTES) {
      const archiveName = config.progressFile.replace('.md', `-${Date.now()}.md`);
      fs.renameSync(abs, resolve(archiveName));
      fs.writeFileSync(abs, `# Progress Log (previous: ${path.basename(archiveName)})\n\n`, 'utf-8');
    }

    fs.appendFileSync(abs, stamped + '\n', 'utf-8');
  } catch (err) {
    console.error(`[state] appendProgress failed: ${err.message}`);
  }
}

const LEARNINGS_MAX_BYTES = 50_000; // 50KB — rotate beyond this

export function appendLearning(note) {
  const abs = resolve(config.learningsFile);
  try {
    // Rotate when file exceeds size limit (same pattern as appendProgress)
    if (fs.existsSync(abs) && fs.statSync(abs).size > LEARNINGS_MAX_BYTES) {
      const archiveName = config.learningsFile.replace('.md', `-${Date.now()}.md`);
      fs.renameSync(abs, resolve(archiveName));
      fs.writeFileSync(abs, '# Learnings\n\n', 'utf-8');
    }
    fs.appendFileSync(abs, `- ${note}\n`, 'utf-8');
  } catch (err) {
    console.error(`[state] appendLearning failed: ${err.message}`);
  }
  // Also persist through memory-store so learnings survive compaction context loss.
  process.nextTick(async () => {
    try {
      const mod = await import('./memory-store.js');
      mod.saveMemory(note, 'experience', ['learning']);
    } catch {}
  });
}

// ── File Tracking (in-memory cache to avoid O(n) read+write per touch) ──────

let _filesTouchedCache = null;
let _filesTouchedDirty = false;

function getFilesTouchedCache() {
  if (!_filesTouchedCache) {
    _filesTouchedCache = normalizeFilesTouchedShape(readFilesTouched());
  }
  return _filesTouchedCache;
}

/** Flush the in-memory file-tracking cache to disk. Called by saveCheckpoint(). */
export function flushFilesTouched() {
  if (_filesTouchedDirty && _filesTouchedCache) {
    try {
      writeFilesTouched(_filesTouchedCache);
      _filesTouchedDirty = false;
    } catch (err) {
      console.error(`[state] flushFilesTouched failed: ${err.message}`);
    }
  }
}

/** Restore in-memory file tracking cache from disk (used on resume). */
export function restoreFilesTracking() {
  _filesTouchedCache = normalizeFilesTouchedShape(readFilesTouched());
  _filesTouchedDirty = false;
}

function hashText(content) {
  return crypto.createHash('sha1').update(String(content || ''), 'utf-8').digest('hex');
}

function hashFile(absPath) {
  try {
    return hashText(fs.readFileSync(absPath, 'utf-8'));
  } catch {
    return '';
  }
}

function getCurrentTrackingStep() {
  return Number(_commandTrackingContext?.step || 0);
}

function ensureFreshnessEntry(tracked, filePath) {
  if (!tracked.freshness[filePath]) {
    tracked.freshness[filePath] = {
      path: filePath,
      lastReadStep: 0,
      lastWriteStep: 0,
      lastReadHash: '',
      lastWriteHash: '',
      lastKnownHash: '',
      lastErrorStep: 0,
      requiresRereadBeforeEdit: false,
      staleSummaryClaims: false,
      lastReadStartLine: 0,
      lastReadEndLine: 0,
      lastWriteWasOverwrite: false,
      staleReason: '',
    };
  }
  return tracked.freshness[filePath];
}

export function trackFileRead(filePath, meta = {}) {
  const tracked = getFilesTouchedCache();
  const abs = resolve(filePath);
  const now = Date.now();
  const freshness = ensureFreshnessEntry(tracked, filePath);
  const fileHash = hashFile(abs);

  tracked.reads[filePath] = {
    lastRead: now,
    count: (tracked.reads[filePath]?.count || 0) + 1,
    lastReadStep: Number(meta.step || getCurrentTrackingStep()),
    lastReadHash: fileHash,
    lastReadStartLine: Number(meta.startLine || 0),
    lastReadEndLine: Number(meta.endLine || 0),
  };

  freshness.lastReadStep = Number(meta.step || getCurrentTrackingStep());
  freshness.lastReadHash = fileHash;
  freshness.lastKnownHash = fileHash || freshness.lastKnownHash;
  freshness.lastReadStartLine = Number(meta.startLine || 0);
  freshness.lastReadEndLine = Number(meta.endLine || 0);
  freshness.requiresRereadBeforeEdit = false;
  freshness.staleReason = '';
  _filesTouchedDirty = true;
}

export function trackFileWrite(filePath, meta = {}) {
  const tracked = getFilesTouchedCache();
  const abs = resolve(filePath);
  const now = Date.now();
  const freshness = ensureFreshnessEntry(tracked, filePath);
  const fileHash = hashFile(abs);
  const wasOverwrite = meta.overwrite === true;

  tracked.writes[filePath] = {
    lastWrite: now,
    count: (tracked.writes[filePath]?.count || 0) + 1,
    lastWriteStep: Number(meta.step || getCurrentTrackingStep()),
    lastWriteHash: fileHash,
    lastWriteWasOverwrite: wasOverwrite,
  };

  freshness.lastWriteStep = Number(meta.step || getCurrentTrackingStep());
  freshness.lastWriteHash = fileHash;
  freshness.lastKnownHash = fileHash || freshness.lastKnownHash;
  freshness.lastWriteWasOverwrite = wasOverwrite;
  freshness.requiresRereadBeforeEdit = wasOverwrite || meta.forceRereadBeforeEdit === true;
  freshness.staleSummaryClaims = wasOverwrite || freshness.staleSummaryClaims;
  freshness.staleReason = freshness.requiresRereadBeforeEdit
    ? 'File changed after the last trusted read. Re-read current on-disk contents before editing again.'
    : '';
  _filesTouchedDirty = true;
}

export function markFileRequiresReread(filePath, reason = '', meta = {}) {
  const tracked = getFilesTouchedCache();
  const freshness = ensureFreshnessEntry(tracked, filePath);
  freshness.lastErrorStep = Number(meta.step || getCurrentTrackingStep());
  freshness.requiresRereadBeforeEdit = true;
  freshness.staleSummaryClaims = true;
  freshness.staleReason = reason || freshness.staleReason || 'Re-read the file before editing again.';
  _filesTouchedDirty = true;
}

export function getFileFreshnessStatus(filePath) {
  const tracked = normalizeFilesTouchedShape(readFilesTouched());
  const freshness = tracked.freshness[filePath] || {
    path: filePath,
    lastReadStep: 0,
    lastWriteStep: 0,
    lastReadHash: '',
    lastWriteHash: '',
    lastKnownHash: '',
    lastErrorStep: 0,
    requiresRereadBeforeEdit: false,
    staleSummaryClaims: false,
    staleReason: '',
  };
  const abs = resolve(filePath);
  const currentHash = fs.existsSync(abs) ? hashFile(abs) : '';
  const externallyChanged = Boolean(
    currentHash
    && freshness.lastKnownHash
    && currentHash !== freshness.lastKnownHash
  );
  const stale = freshness.requiresRereadBeforeEdit || externallyChanged;
  return {
    ...freshness,
    currentHash,
    externallyChanged,
    stale,
    reason: externallyChanged
      ? 'File changed since the last tracked read/write. Re-read current on-disk contents before editing.'
      : (freshness.staleReason || ''),
  };
}

// ── Command Tracking ───────────────────────────────────────────

let _commandTrackingContext = {
  stage: '',
  step: 0,
  retryCount: 0,
};

export function setCommandTrackingContext(context = {}) {
  _commandTrackingContext = {
    stage: context.stage || '',
    step: Number(context.step || 0),
    retryCount: Number(context.retryCount || 0),
  };
}

export function trackCommand(cmd, exitCode, outputSnippet, meta = {}) {
  const commands = readCommandsRun();
  const touched = readFilesTouched();
  const now = Date.now();
  const relatedFileChanges = Object.entries(touched.writes || {})
    .filter(([, info]) => now - Number(info.lastWrite || 0) < 10_000)
    .map(([filePath]) => filePath);
  const outputDigest = String(outputSnippet || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  commands.push({
    command: cmd,
    exitCode,
    skipped: meta.skipped === true,
    success: Number(exitCode) === 0 && meta.skipped !== true,
    stage: meta.stage || _commandTrackingContext.stage || '',
    step: Number(meta.step || _commandTrackingContext.step || 0),
    retryCount: Number(meta.retryCount ?? _commandTrackingContext.retryCount ?? 0),
    executedAt: new Date().toISOString(),
    outputSnippet: (outputSnippet || '').slice(0, 500),
    outputDigest,
    relatedFileChanges,
    timestamp: now,
  });
  // Keep last 100 commands
  if (commands.length > 100) commands.splice(0, commands.length - 100);
  writeCommandsRun(commands);
}

/** Clear the command dedup history so previously-skipped commands can run again.
 *  Call this after a finish rejection so the agent can re-run verification commands
 *  as fresh evidence without hitting the duplicate guard.
 */
export function clearCommandDedup() {
  writeCommandsRun([]);
}

export function trackRecoveryEvent(type, trigger, correctiveAction, meta = {}) {
  const events = readRecoveryEvents();
  events.push({
    type,
    trigger,
    correctiveAction,
    target: meta.target || '',
    stage: meta.stage || '',
    step: Number(meta.step || 0),
    timestamp: new Date().toISOString(),
  });
  if (events.length > 100) events.splice(0, events.length - 100);
  writeRecoveryEvents(events);
}

// ── Checkpoint ─────────────────────────────────────────────────

/**
 * Save full checkpoint state.
 * @param {Object} state - { step, phase, currentSubtask, workingMemory, totalCharsUsed, consecutiveErrors }
 */
export function saveCheckpoint(state) {
  flushFilesTouched(); // batch-write file tracking instead of per-touch I/O
  writeCheckpoint({
    ...state,
    savedAt: new Date().toISOString(),
  });
}

/**
 * Load checkpoint or return default.
 */
export function loadCheckpoint() {
  return readCheckpoint() || {
    step: 0,
    phase: 'init',
    currentSubtask: null,
    workingMemory: [],
    totalCharsUsed: 0,
    consecutiveErrors: 0,
  };
}
