# Comprehensive Fix Plan — Advanced Agent Loop
## From Capable to Disciplined: Solving Every Known Bug, Security Hole, and Architectural Gap
 
**Status:** Implementation-ready specification  
**Supersedes:** `final-arch.md`, `stage-based-execution-architecture.md`  
**Scope:** All source files under `src/`, `src/tools/`, `src/routing/`, and `tests/`
 
---
 
## Table of Contents
 
0. [Executive Summary](#0-executive-summary)
1. [Critical Security Fixes (P0 — Fix Before Any Deployment)](#1-critical-security-fixes)
2. [Core Loop Bugs (P0 — Correctness)](#2-core-loop-bugs)
3. [State & Checkpoint Integrity (P1 — Reliability)](#3-state--checkpoint-integrity)
4. [Memory System Fixes (P1 — Data Integrity)](#4-memory-system-fixes)
5. [Routing & Tool Management (P1 — Stability)](#5-routing--tool-management)
6. [Context Assembly & Compaction (P2 — Fidelity)](#6-context-assembly--compaction)
7. [Loop Guard & Stall Detection (P2 — Accuracy)](#7-loop-guard--stall-detection)
8. [Verification System (P2 — Correctness)](#8-verification-system)
9. [Plan & Focus Chain (P2 — Usability)](#9-plan--focus-chain)
10. [Stage-Based Execution Architecture (P3 — New Feature)](#10-stage-based-execution-architecture)
11. [Cross-Platform Compatibility (P1 — Portability)](#11-cross-platform-compatibility)
12. [Test Coverage Gaps (P2 — Quality)](#12-test-coverage-gaps)
13. [Implementation Order](#13-implementation-order)
14. [File-by-File Change Map](#14-file-by-file-change-map)
 
---
 
# 0. Executive Summary
 
This codebase is a flat-loop autonomous agent (step → decide → execute → record → repeat) with routing, compaction, memory persistence, and dynamic skill creation. A developer has already shipped "Session 2" fixes (`<think>` block stripping, parse/LLM error tracking in memory, checkpoint persistence of error state, `maxConsecutiveErrors` gating). Those fixes are verified by `tests/session2-fixes.test.js`.
 
However, a thorough audit reveals **48 remaining issues** across 6 severity tiers:
 
| Severity | Count | Summary |
|----------|-------|---------|
| **P0-Security** | 7 | Command injection in 6 tool handlers + shell injection in memory search |
| **P0-Correctness** | 5 | Broken `require()` in ESM, fractional step ordering, verification always-pass, checkpoint corruption |
| **P1-Reliability** | 8 | File tracking loss on resume, race conditions, learning persistence, cross-platform grep |
| **P1-Stability** | 4 | Dual tool registry, frozen loop controller, config validation |
| **P2-Fidelity** | 10 | Compaction mode not propagated, stall detection false positives, plan status bugs |
| **P3-Architecture** | 14 | Stage-based execution (intake → discovery → planning → execution → verification → finalization) |
 
The two existing architecture documents (`final-arch.md` and `stage-based-execution-architecture.md`) correctly diagnose the *execution discipline* problem but do not address security, correctness, or reliability bugs. This document merges their stage-based architecture proposal with every concrete bug fix needed, producing a single implementation-ready specification.
 
---
 
# 1. Critical Security Fixes
 
> **P0 — Fix before any deployment or shared-network use.**  
> Every tool that passes user/LLM-controlled strings to `execSync()` via template literals is a command injection vector.
 
## 1.1 Command Injection — `run-command.js`
 
**File:** `src/tools/execution/run-command.js`  
**Line:** 24 — `execSync(command, { cwd: getWorkspace(), ... })`  
**Risk:** If the LLM is compromised, jailbroken, or fed a malicious task, it can execute arbitrary shell commands.
 
**Fix:**
```js
import { execFile } from 'node:child_process';
 
// Option A: Parse command into argv and use execFile (no shell)
// Option B: Maintain an allowlist of safe commands (npm, node, python, git, etc.)
//           and reject anything not on the list.
// Option C: Run inside a restricted sandbox (Docker/nsjail) — best for production.
 
// Minimum viable fix: sanitize + allowlist
const ALLOWED_PREFIXES = ['npm ', 'node ', 'npx ', 'python', 'git ', 'cat ', 'ls ', 'find ', 'grep ', 'echo '];
 
export function handler({ command, timeout }) {
  const cmd = command.trim();
  if (!ALLOWED_PREFIXES.some(p => cmd.startsWith(p))) {
    return { result: `Blocked: command "${cmd.slice(0, 40)}" not in allowlist.`, error: true };
  }
  // ... existing execSync logic with validated command
}
```
 
## 1.2 Command Injection — `search-files.js`
 
**File:** `src/tools/filesystem/search-files.js`  
**Line:** 28 — `grep -rn --include='${filePattern}' '${pattern.replace(...)}'`  
**Risk:** `filePattern` is completely unescaped. Pattern escaping is incomplete.
 
**Fix:**
```js
import { execFileSync } from 'node:child_process';
 
export function handler({ pattern, path: relPath, filePattern }) {
  const dir = path.resolve(getWorkspace(), relPath || '.');
  const args = ['-rn'];
  if (filePattern) args.push(`--include=${filePattern}`);
  args.push(pattern, dir);
 
  try {
    const output = execFileSync('grep', args, {
      encoding: 'utf-8', timeout: 10000, maxBuffer: 5 * 1024 * 1024,
    });
    // Pipe through head equivalent
    return output.split('\n').slice(0, 50).join('\n') || 'No matches found.';
  } catch {
    return 'No matches found.';
  }
}
```
 
## 1.3 Command Injection — `glob.js`
 
**File:** `src/tools/filesystem/glob.js`  
**Lines:** 34–46 — Both `find` and `ls` commands use unescaped pattern interpolation.
 
**Fix:** Use `execFileSync('find', [...args])` with argv array. For the `ls` path, use Node's `fs.globSync()` (Node 22+) or the `glob` npm package instead of shelling out.
 
```js
import { globSync } from 'node:fs';  // Node 22+
// OR
import { globSync } from 'glob';     // npm package, works everywhere
 
export function handler({ pattern }) {
  const workspace = getWorkspace();
  try {
    const matches = globSync(pattern, { cwd: workspace, nodir: true }).slice(0, 300);
    return matches.join('\n') || 'No matches.';
  } catch {
    return 'No matches.';
  }
}
```
 
## 1.4 Command Injection — `lsp.js`
 
**File:** `src/tools/execution/lsp.js`  
**Lines:** 31, 43, 54, 66, 73, 85 — Multiple `execSync` calls with path interpolation.
 
**Additional Bug:** Line 31 uses `require('fs')` inside an ES module file — this will throw `ReferenceError: require is not defined` at runtime. The `fs` module is never imported at the top.
 
**Fix (two bugs in one):**
```js
import fs from 'node:fs';  // Already needed — add this import
 
// Replace JSON validation:
// BEFORE (broken + injectable):
//   execSync(`node -e "JSON.parse(require('fs').readFileSync('${abs}','utf-8'))"`)
// AFTER (safe + works in ESM):
try {
  JSON.parse(fs.readFileSync(abs, 'utf-8'));
  return `${filePath}: No JSON syntax errors.`;
} catch (e) {
  return `${filePath}: JSON error — ${e.message}`;
}
 
// For node --check, use execFileSync:
import { execFileSync } from 'node:child_process';
execFileSync('node', ['--check', abs], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' });
```
 
## 1.5 Command Injection — `webfetch.js`
 
**File:** `src/tools/execution/webfetch.js`  
**Line:** ~26 — `execSync(\`curl -s '${url.replace(...)}'\`)`
 
**Fix:** Use Node's built-in `fetch()` (available since Node 18) or `execFileSync('curl', ['-s', url])`.
 
```js
// Best fix: use native fetch (no shell at all)
export async function handler({ url }) {
  try {
    new URL(url);  // validate URL format
  } catch {
    return 'Invalid URL.';
  }
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await resp.text();
  return text.slice(0, 50000);
}
```
 
Note: This makes the handler async. The tool execution pipeline in `src/tools/index.js` must handle async handlers (wrap in `await` or check for thenable return).
 
## 1.6 Command Injection — `patch.js`
 
**File:** `src/tools/filesystem/patch.js`  
**Risk:** Lower severity — diff content is passed via stdin, not shell interpolation. But control characters in the diff could still cause issues.
 
**Fix:** Validate diff format (must start with `---` or `diff` headers) before piping to `patch`. Or use a JS-native diff-apply library.
 
## 1.7 Shell Injection — `memory-store.js`
 
**File:** `src/memory-store.js`  
**Lines:** ~105, ~117, ~128 — `grep -rniH '${query.replace(/'/g, "'\\''")}' '${memDir}'`
 
**Risk:** The single-quote escaping is incomplete. Strings containing backticks, `$()`, or `$(...)` can escape the shell context.
 
**Fix:**
```js
import { execFileSync } from 'node:child_process';
 
// Replace all grep execSync calls:
const output = execFileSync('grep', ['-rniH', query, memDir], {
  encoding: 'utf-8', timeout: 5000,
});
```
 
---
 
# 2. Core Loop Bugs
 
## 2.1 Broken `require()` in ESM — `lsp.js`
 
**File:** `src/tools/execution/lsp.js`, line 31  
**Bug:** `JSON.parse(require('fs').readFileSync(...))` — The project uses `"type": "module"` in `package.json`, so `require()` is not available. This tool is completely non-functional for JSON files.  
**Fix:** See §1.4 above — replace with `fs.readFileSync()` using the already-needed `fs` import.
 
## 2.2 Fractional Step Numbers Corrupt Ordering
 
**File:** `src/loop.js`, lines ~340, ~370  
**Bug:** `verification_failed` entries use `step: step + 0.5` and `loop_guard` entries use `step: step + 0.1`. These fractional steps:
- Break `memory.getRecent()` slicing which assumes integer-step density
- Create checkpoint serialization with non-integer steps
- Confuse `detectIdenticalStreak()` comparison logic
- Make resume ordering ambiguous
 
**Fix:** Use integer steps with a sub-step type marker:
```js
memory.push({
  step,                        // Keep integer step
  subStep: 'verification',     // New field for sub-step type
  action: 'verification_failed',
  args: {},
  result: '...',
  error: true,
  timestamp: Date.now(),
});
```
 
Then update `getRecent()` and `getOld()` to handle entries with the same `step` value but different `subStep` values. The sort order becomes `(step, subStep)` where substep defaults to `'main'`.
 
## 2.3 Verification Always Passes After Retries
 
**File:** `src/loop.js`, lines ~430–460 (the `verifyCompletion` function)  
**Bug:** After `MAX_RETRIES` (2) failed verification attempts, the function returns `true`:
```js
log(`Verification error after ${MAX_RETRIES + 1} attempts... accepting by default`);
return true; // ← Agent can claim ANY completion is done
```
 
**Fix:** Return `false` on exhausted retries to force the loop to continue:
```js
log(`Verification failed after ${MAX_RETRIES + 1} attempts — rejecting completion.`);
return false;
```
 
Additionally, add a `verificationFailures` counter. If verification fails 3 times total (not just consecutively), force-accept and save a memory about the forced acceptance:
```js
if (totalVerificationFailures >= 3) {
  saveMemory('Forced task completion after 3 verification failures', 'experience', ['verification', 'forced']);
  return true;
}
```
 
## 2.4 Parse Error Checkpoint Saves Broken State
 
**File:** `src/loop.js`, lines ~270–280  
**Bug:** `saveState()` is called after every parse error, saving `consecutiveErrors` and `parseErrorStreak` but also saving the memory with the parse error entry. On resume, the agent sees its own parse error but may not understand the context.
 
**Fix:** Add a `lastErrorContext` field to checkpoint:
```js
saveCheckpoint({
  // ... existing fields
  lastErrorContext: consecutiveErrors > 0 ? {
    type: 'parse_error',
    streak: parseErrorStreak,
    lastErrorMessage: err.message,
  } : null,
});
```
 
On resume, inject this context as guidance:
```js
if (cp.lastErrorContext) {
  runtimeGuidance = `Resumed from error state: ${cp.lastErrorContext.type} ` +
    `(streak: ${cp.lastErrorContext.streak}). ${cp.lastErrorContext.lastErrorMessage}`;
}
```
 
## 2.5 UTF-8 Truncation in Parse Recovery
 
**File:** `src/loop.js`, line ~255  
**Bug:** `String(llmResponse.content || '').slice(0, 200)` may cut a multi-byte character mid-sequence.
 
**Fix:**
```js
function safeSlice(str, maxChars) {
  if (str.length <= maxChars) return str;
  // Find the last complete codepoint before maxChars
  let end = maxChars;
  while (end > 0 && str.charCodeAt(end - 1) >= 0xD800 && str.charCodeAt(end - 1) <= 0xDBFF) {
    end--; // Don't split a surrogate pair
  }
  return str.slice(0, end);
}
```
 
---
 
# 3. State & Checkpoint Integrity
 
## 3.1 File Tracking Cache Not Restored on Resume
 
**File:** `src/state.js` + `src/loop.js`  
**Bug:** `_filesTouchedCache` (in-memory cache of file reads/writes with timestamps) is never loaded from checkpoint. On resume, stale-file alerts miss all pre-crash changes.
 
**Fix:** In `state.js`, export `restoreFilesTracking()`:
```js
let _filesTouchedCache = null;
 
export function restoreFilesTracking() {
  _filesTouchedCache = readFilesTouched();
}
```
 
Call it in `loop.js` during resume:
```js
if (resume) {
  const cp = loadCheckpoint();
  restoreFilesTracking();  // ← Add this
  // ...
}
```
 
## 3.2 Race Condition in File Tracking Cache
 
**File:** `src/state.js`  
**Bug:** If multiple async tool executions write to `_filesTouchedCache` concurrently, one write can overwrite the other.
 
**Mitigation:** The current loop is single-threaded (one tool at a time), so this is theoretical. But as a safeguard:
```js
// Use a dirty flag + periodic flush instead of writing on every call
let _filesTouchedDirty = false;
 
export function trackFileRead(relPath) {
  if (!_filesTouchedCache) _filesTouchedCache = readFilesTouched();
  _filesTouchedCache.reads[relPath] = Date.now();
  _filesTouchedDirty = true;
}
 
export function flushFilesTouched() {
  if (_filesTouchedDirty) {
    writeFilesTouched(_filesTouchedCache);
    _filesTouchedDirty = false;
  }
}
```
 
Call `flushFilesTouched()` once per step in `saveState()` instead of per-tool.
 
## 3.3 Checkpoint Written on Every Step Including Errors
 
**File:** `src/loop.js`  
**Bug:** Parse errors and LLM errors call `saveState()`, meaning checkpoint.json contains an error-state snapshot. Not inherently wrong, but on resume the agent may not realize it was mid-error-recovery.
 
**Fix:** Add an `errorState` field to checkpoint (as described in §2.4). No change to *when* checkpoints are saved — crash safety requires saving on error steps too.
 
## 3.4 Progress File Rotation Can Lose Data
 
**File:** `src/state.js`, `appendProgress()`  
**Bug:** When `progress.md` exceeds `PROGRESS_MAX_BYTES` (200KB), it's truncated. But if the rotation happens mid-step, the current step's pre-execution log entry is lost.
 
**Fix:** Rotate to `progress-{timestamp}.md` archive instead of truncating. Keep a single rolling file:
```js
export function appendProgress(entry) {
  const abs = resolve(config.progressFile);
  const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (stat && stat.size > PROGRESS_MAX_BYTES) {
    const archiveName = config.progressFile.replace('.md', `-${Date.now()}.md`);
    fs.renameSync(abs, resolve(archiveName));
    fs.writeFileSync(abs, '# Progress Log (continued)\n\n', 'utf-8');
  }
  fs.appendFileSync(abs, entry, 'utf-8');
}
```
 
## 3.5 Concurrent Filesystem Writes Between Tools
 
**Files:** `state.js` — `writeProgress()`, `appendLearning()`, `saveCheckpoint()`  
**Risk:** If future tool handlers become async, simultaneous calls to these could corrupt files.
 
**Fix (defensive):** Add a simple write-lock per file:
```js
const _writeLocks = new Map();
 
function withLock(filePath, fn) {
  const key = path.resolve(filePath);
  const prev = _writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn).catch(fn); // Always release
  _writeLocks.set(key, next);
  return next;
}
```
 
Low priority — only needed if tool execution becomes concurrent.
 
---
 
# 4. Memory System Fixes
 
## 4.1 Memory Entry Deduplication
 
**File:** `src/memory-store.js` — `saveMemory()`  
**Bug:** Identical memories are appended without deduplication. If the agent saves "Project uses ESM" three times, all three entries exist.
 
**Fix:** Before appending, check the last N entries in today's log for near-duplicate content:
```js
export function saveMemory(content, type = 'experience', tags = []) {
  const logPath = dailyLogPath();
  if (fs.existsSync(logPath)) {
    const existing = fs.readFileSync(logPath, 'utf-8');
    // Simple dedup: skip if content appears verbatim in last 2000 chars
    const tail = existing.slice(-2000);
    if (tail.includes(content.slice(0, 100))) {
      return `Memory already saved (deduplicated).`;
    }
  }
  // ... existing save logic
}
```
 
## 4.2 Learning Persistence Not Integrated with Memory
 
**File:** `src/state.js` — `appendLearning()`  
**Bug:** Learnings written to `learnings.md` are independent of the memory system. They aren't included in pre-compaction memory flush, so important learnings may be duplicated post-compaction.
 
**Fix:** When a learning is appended, also save it to the memory system:
```js
export function appendLearning(note) {
  const abs = resolve(config.learningsFile);
  try {
    fs.appendFileSync(abs, `- ${note}\n`, 'utf-8');
  } catch (err) {
    console.error(`[state] appendLearning failed: ${err.message}`);
  }
  // Also persist via memory store so it survives compaction
  saveMemory(note, 'experience', ['learning']);
}
```
 
(Requires importing `saveMemory` from `memory-store.js` — watch for circular dependency. If circular, defer the save call via `process.nextTick`.)
 
## 4.3 WorkingMemory `push()` Lacks Deduplication
 
**File:** `src/memory.js` — `push()`  
**Bug:** Back-to-back identical entries (same action + args) create distinct memory entries. `detectIdenticalStreak()` counts them, but the entries still consume context window.
 
**Fix:** Add an `isDuplicate` flag on push:
```js
push(entry) {
  const last = this.entries[this.entries.length - 1];
  if (last && last.action === entry.action &&
      JSON.stringify(last.args) === JSON.stringify(entry.args)) {
    entry._duplicate = true;
  }
  // ... existing truncation logic
  this.entries.push({ ...entry, args });
}
```
 
`formatForContext()` can then collapse duplicates into `"[repeated ×3]"` annotations.
 
## 4.4 Memory Search Returns Nothing on Windows
 
**File:** `src/memory-store.js` — `searchMemory()`  
**Bug:** Uses `grep` via shell. Windows does not have `grep` by default. Search silently returns empty results.
 
**Fix:** See §11 (Cross-Platform Compatibility) for the full solution. Short version: use a JS-native search:
```js
function searchFiles(dir, query) {
  const results = [];
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(query.toLowerCase())) {
        results.push({ file, line: i + 1, text: line.trim() });
      }
    });
  }
  return results;
}
```
 
---
 
# 5. Routing & Tool Management
 
## 5.1 Dual Tool Registry — Synchronization Risk
 
**Files:** `src/tools/index.js` (TOOL_DEFINITIONS + TOOL_HANDLERS) and `src/routing/toolRegistry.js` (RAW_CATEGORIES + REGISTRY)
 
**Bug:** Tools are defined in two separate registries. Adding, renaming, or removing a tool requires updating both files. They can drift out of sync silently.
 
**Fix:** Consolidate into a single source of truth. Each tool file already exports `definition` and `handler`. Make `toolRegistry.js` the single source:
 
```js
// src/routing/toolRegistry.js — becomes the ONLY registry
import * as readFile from '../tools/filesystem/read-file.js';
import * as writeFile from '../tools/filesystem/write-file.js';
// ... all tool imports
 
const CATEGORY_MAP = {
  filesystem: [readFile, writeFile, editFile, listDir, searchFiles, glob, patch],
  execution:  [runCommand, lsp, webfetch, websearch],
  planning:   [think, finish, updatePlan, todoWrite, todoRead, addLearning],
  memory:     [saveMemory, searchMemory, updateMemory],
  identity:   [updateIdentity],
  skills:     [createSkill],
};
 
// Build definitions and handlers from the single source
export const TOOL_DEFINITIONS = Object.values(CATEGORY_MAP)
  .flat()
  .map(t => t.definition);
 
export const TOOL_HANDLERS = Object.fromEntries(
  Object.values(CATEGORY_MAP).flat().map(t => [t.definition.function.name, t.handler])
);
```
 
Then `src/tools/index.js` re-exports from `toolRegistry.js`:
```js
export { TOOL_DEFINITIONS, TOOL_HANDLERS, executeTool } from '../routing/toolRegistry.js';
```
 
## 5.2 Broken `runRoutedLoop()` in `loopController.js`
 
**File:** `src/routing/loopController.js`, lines 310–340  
**Bug:** The first `runRoutedLoop()` function has a freeze mechanism that sets `frozenTool = toolName` and then immediately clears it with `frozenTool = null` four lines later. The freeze never persists.
 
**Status:** The corrected `runLoop()` function below it uses `pendingFreeze` correctly.
 
**Fix:** Either:
- **(A)** Delete `runRoutedLoop()` entirely, keep only the corrected `runLoop()`.
- **(B)** Mark `runRoutedLoop()` as `@deprecated` and add a JSDoc link to `runLoop()`.
 
Recommendation: Option A — dead code with known bugs is a liability.
 
## 5.3 Tool Argument Schema Not Validated
 
**File:** `src/tools/index.js` — `executeTool()`  
**Bug:** Tool arguments from LLM are passed directly to handlers without schema validation. If the LLM sends `{ path: 123 }` instead of `{ path: "file.js" }`, the handler crashes with an unhelpful error.
 
**Fix:** Add lightweight validation before dispatching:
```js
function validateArgs(toolName, args, schema) {
  const required = schema?.required || [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      return `Missing required argument: "${field}"`;
    }
  }
  // Type checking for string fields
  const props = schema?.properties || {};
  for (const [key, spec] of Object.entries(props)) {
    if (args[key] !== undefined && spec.type === 'string' && typeof args[key] !== 'string') {
      args[key] = String(args[key]); // Auto-coerce instead of rejecting
    }
  }
  return null; // valid
}
```
 
## 5.4 Config Value Sanity Checks Missing
 
**File:** `src/config.js`  
**Bug:** No validation on loaded config values. If environment variables set `maxSteps=0` or `contextWindow=1`, the loop behaves erratically.
 
**Fix:**
```js
function validateConfig(cfg) {
  if (cfg.maxSteps < 1) cfg.maxSteps = 500;
  if (cfg.contextWindow < 1024) cfg.contextWindow = 8192;
  if (cfg.maxTotalChars < 10000) cfg.maxTotalChars = 10_000_000;
  if (cfg.workingMemoryWindow < 3) cfg.workingMemoryWindow = 10;
  if (cfg.maxConsecutiveErrors < 1) cfg.maxConsecutiveErrors = 5;
  return cfg;
}
```
 
---
 
# 6. Context Assembly & Compaction
 
## 6.1 Compaction Mode Not Propagated
 
**File:** `src/compaction.js` → `src/context.js`  
**Bug:** `compactMemory()` returns `{ usage, flushedCount, mode }` where `mode` is `'llm'` or `'fallback'`. But `mode` is never used by `context.js`. The agent doesn't know if it's reading an LLM-generated summary or a deterministic fallback.
 
**Fix:** Persist `mode` in the context summary file header:
```js
// In compaction.js, when writing summary:
const header = `<!-- compaction_mode: ${mode} -->\n`;
writeContextSummary(header + summary);
```
 
In `context.js`, detect and annotate:
```js
function getCompactionAnnotation(summaryText) {
  if (summaryText.includes('compaction_mode: fallback')) {
    return '⚠️ This summary was generated by deterministic fallback, not LLM. Quality may be reduced.';
  }
  return '';
}
```
 
## 6.2 Post-Compaction Recovery Prompt Always Injected
 
**File:** `src/context.js`  
**Bug:** `buildRecoveryPrompt()` is injected whenever `postCompaction=true`, even if the agent is mid-sequence (e.g., halfway through a multi-file edit). This disrupts focus.
 
**Fix:** Only inject recovery prompt if the last action before compaction was NOT a file-editing action:
```js
if (postCompaction) {
  const lastAction = memory.getRecent(1)[0]?.action;
  const editActions = new Set(['write_file', 'edit_file', 'patch']);
  if (!editActions.has(lastAction)) {
    sections.push(buildRecoveryPrompt());
  } else {
    sections.push('Context was compacted. Continue your current file operation.');
  }
}
```
 
## 6.3 Stale Context Summary After Many Steps
 
**File:** `src/context.js`  
**Bug:** If compaction happened 20+ steps ago, the context summary may describe a state that no longer reflects reality. The agent may re-do completed work.
 
**Fix:** Add a freshness indicator:
```js
function getStalenessWarning(step, lastCompactionStep) {
  const gap = step - lastCompactionStep;
  if (gap > 30) {
    return `⚠️ Context summary is ${gap} steps old. Re-read plan.md to verify current state.`;
  }
  return '';
}
```
 
## 6.4 Identity Block Missing File Error Handling
 
**File:** `src/identity.js` — `buildIdentityBlock()`  
**Bug:** If identity files (`SOUL.md`, `AGENTS.md`, etc.) are corrupted or missing, `readSoul()` etc. return empty strings silently. `buildIdentityBlock()` returns an empty string, giving the LLM zero identity context.
 
**Fix:**
```js
export function buildIdentityBlock() {
  const sections = [];
  const soul = readSoul();
  if (soul) sections.push(soul);
  else sections.push('# Identity\nYou are an autonomous coding agent.');  // Fallback
 
  const protocol = readAgentsProtocol();
  if (protocol) sections.push(protocol);
 
  if (sections.length <= 1) {
    console.warn('[identity] Most identity files missing — using minimal identity.');
  }
 
  return sections.join('\n\n');
}
```
 
---
 
# 7. Loop Guard & Stall Detection
 
## 7.1 Same-Tool Streak Misses Similar-but-Different Args
 
**File:** `src/loop.js` — `detectLoopGuard()`  
**Bug:** The check `every(e => JSON.stringify(e.args) === lastArgs)` only triggers on *exact* argument matches. If the agent retries `edit_file` with slightly different content each time (but same file, same target), the guard doesn't fire.
 
**Fix:** Add a "fuzzy match" tier that checks only key arguments:
```js
function argsAreSimilar(a, b, tool) {
  // For edit_file: compare 'path' and 'old_string' only (ignore 'new_string')
  if (tool === 'edit_file') {
    return a.path === b.path && a.old_string === b.old_string;
  }
  // For search_files: compare 'pattern' only
  if (tool === 'search_files') {
    return a.pattern === b.pattern;
  }
  // Default: exact match
  return JSON.stringify(a) === JSON.stringify(b);
}
```
 
Add a second-tier guard that uses `argsAreSimilar` with a higher threshold (e.g., 5 similar calls).
 
## 7.2 False Positive on Legitimate Repeated Reads
 
**File:** `src/loop.js` — `detectLoopGuard()`  
**Bug:** Reading the same file 6 times (e.g., checking if a write took effect, reading different sections) triggers the stall detector because the results are similar after normalization.
 
**Fix:** Exempt `read_file` from the "same result" check, or compare the *intent* (args) rather than result:
```js
const READ_TOOLS = new Set(['read_file', 'list_dir', 'todoread']);
// Don't flag same-result on read-only tools unless args are also identical
if (READ_TOOLS.has(lastAction)) {
  // Only flag if args AND results match (true stall)
  return sameArgsTail && sameResultTail;
}
```
 
## 7.3 Result Normalization Hides Progress
 
**File:** `src/loop.js`  
**Bug:** `normalizeResult()` takes only the first 160 characters after lowercasing. Two `run_command` results that differ only after character 160 (e.g., "Tests: 12 passed" vs "Tests: 15 passed") are considered identical.
 
**Fix:** Increase to 500 chars, or hash the full result:
```js
function normalizeResult(result) {
  const str = String(result || '').toLowerCase().trim();
  // Use a simple hash for long results instead of truncation
  if (str.length > 300) {
    return str.slice(0, 150) + '...' + str.slice(-150);
  }
  return str;
}
```
 
---
 
# 8. Verification System
 
## 8.1 Verification Bypass on LLM Failure (Already in §2.3)
 
Covered in §2.3. Key change: return `false` (not `true`) on exhausted retries.
 
## 8.2 No Evidence Checking in Verification
 
**File:** `src/loop.js` — `verifyCompletion()`  
**Bug:** The verification prompt asks the LLM "did the agent complete the task?" but doesn't require the agent to provide file-level evidence. The LLM may answer "yes" based on the agent's *claim* rather than *proof*.
 
**Fix:** Inject concrete evidence into the verification prompt:
```js
function buildVerificationEvidence(memory) {
  const writes = memory.entries
    .filter(e => ['write_file', 'edit_file', 'patch'].includes(e.action) && !e.error)
    .map(e => e.args.path || e.args.file)
    .filter(Boolean);
 
  const commands = memory.entries
    .filter(e => e.action === 'run_command' && !e.error)
    .map(e => `${e.args.command} → ${e.result?.slice(0, 100)}`);
 
  return {
    filesModified: [...new Set(writes)],
    commandsSucceeded: commands.slice(-10),
  };
}
```
 
## 8.3 Verification Counter Not Persisted
 
**Bug:** If the agent claims finish, fails verification, and then the process crashes, on resume the verification failure count is lost.
 
**Fix:** Add `verificationFailures` to the checkpoint schema.
 
---
 
# 9. Plan & Focus Chain
 
## 9.1 Plan Phase Status Ignores "Blocked" Items
 
**File:** `src/plan.js`  
**Bug:** Phase status derivation doesn't account for `blocked` items:
```js
if (phase.items.every(i => i.completed)) phase.status = 'completed';
else if (phase.items.some(i => i.status === 'in_progress')) phase.status = 'in_progress';
```
 
A phase with all items `blocked` shows as `not_started`.
 
**Fix:**
```js
if (phase.items.every(i => i.completed)) phase.status = 'completed';
else if (phase.items.every(i => i.status === 'blocked')) phase.status = 'blocked';
else if (phase.items.some(i => i.status === 'in_progress')) phase.status = 'in_progress';
else if (phase.items.some(i => i.completed)) phase.status = 'in_progress';
```
 
## 9.2 Focus Chain Parsing Too Rigid
 
**File:** `src/context.js` — `getFocusChainBlock()`  
**Bug:** Only `^[-*]\s+\[[ xX]\]` format is recognized. Numbered lists (`1. [ ] item`), indented items, or items without checkboxes are silently dropped.
 
**Fix:** Accept more formats:
```js
const items = chain.split('\n').filter(l =>
  l.match(/^(\s*[-*]|\s*\d+\.)\s+\[[ xX]\]/)
);
```
 
## 9.3 No Maximum Plan Size Enforcement
 
**Bug:** The LLM can generate extremely long plans that consume the context window. No size guard exists.
 
**Fix:** Truncate plan display in context to the current and next phase only:
```js
function getPlanForContext(plan) {
  const phases = parsePlan(plan);
  const current = phases.find(p => p.status === 'in_progress') || phases[0];
  const next = phases[phases.indexOf(current) + 1];
  return formatPhases([current, next].filter(Boolean));
}
```
 
---
 
# 10. Stage-Based Execution Architecture
 
> This section integrates the proposals from `final-arch.md` and `stage-based-execution-architecture.md` with concrete implementation specifications.
 
## 10.0 Design Rationale
 
The current loop is "flat" — every step can plan, implement, verify, or drift. The stage system adds **execution discipline** without hardcoded task-specific modes.
 
## 10.1 Stage Definitions
 
| Stage | Purpose | Allowed Tools | Exit Condition |
|-------|---------|---------------|----------------|
| **A — Intake** | Parse task, identify outputs, set scope | `read_file`, `list_dir`, `think` | `task_contract.md` written |
| **B — Discovery** | Ground task in codebase reality | `read_file`, `list_dir`, `search_files`, `glob`, `run_command` (read-only) | `discovery_summary.md` written |
| **C — Planning** | Create stable execution plan | `think`, `update_plan`, `todowrite`, `save_memory` | `plan.md` has ≥1 concrete phase + `execution_contract.md` written |
| **D — Execution** | Implement the plan | All tools except `finish` | All plan items completed or max sub-steps budget hit |
| **E — Verification** | Prove the work is correct | `run_command`, `read_file`, `search_files`, `lsp` | `verification_summary.md` written with all checks |
| **F — Finalization** | Write deliverables and exit | `write_file`, `read_file`, `finish` | `finish` tool called with evidence |
 
## 10.2 Stage State in Checkpoint
 
Extend `checkpoint.json`:
```json
{
  "stageState": {
    "currentStage": "execution",
    "stageStep": 12,
    "stageStartedAt": "2026-03-06T10:00:00Z",
    "stageCompletedAt": null,
    "lockedTargets": ["src/"],
    "requiredOutputs": ["result/REPORT.md"],
    "executionContractPath": ".agent/execution-contract.md",
    "discoverySummaryPath": ".agent/discovery-summary.md",
    "verificationSummaryPath": ".agent/verification-summary.md"
  }
}
```
 
## 10.3 Execution Contract
 
Generated during Stage C (Planning), persisted as `.agent/execution-contract.md`:
 
```markdown
# Execution Contract
 
## Objective
[One-sentence restatement of task]
 
## Required Outputs
- [ ] path/to/output1.md
- [ ] path/to/output2.json
 
## Allowed Workspace Roots
- src/
- tests/
 
## Forbidden Actions
- Do not modify package.json unless explicitly required
- Do not switch to a different project root
 
## Verification Checkpoints
1. `npm test` passes
2. output1.md exists and is non-empty
3. output2.json is valid JSON
 
## Completion Guard
All required outputs must exist and be non-empty.
All verification checkpoints must pass.
```
 
## 10.4 Stage Transition Logic
 
Add to `src/loop.js` (or new file `src/stages.js`):
 
```js
const STAGE_ORDER = ['intake', 'discovery', 'planning', 'execution', 'verification', 'finalization'];
 
function shouldAdvanceStage(currentStage, memory, state) {
  switch (currentStage) {
    case 'intake':
      return fs.existsSync(resolve('.agent/task-contract.md'));
    case 'discovery':
      return fs.existsSync(resolve('.agent/discovery-summary.md'));
    case 'planning': {
      const plan = readPlan();
      const contract = fs.existsSync(resolve('.agent/execution-contract.md'));
      return plan.includes('##') && contract;
    }
    case 'execution': {
      const plan = parsePlan(readPlan());
      return plan.every(phase => phase.status === 'completed' || phase.status === 'blocked');
    }
    case 'verification':
      return fs.existsSync(resolve('.agent/verification-summary.md'));
    case 'finalization':
      return false; // Exit via finish tool
    default:
      return false;
  }
}
 
function getStageGuidance(stage, step, stageStep) {
  switch (stage) {
    case 'intake':
      return `STAGE: INTAKE (step ${stageStep}). Understand the task. Write .agent/task-contract.md with: objective, required outputs, allowed paths, success criteria.`;
    case 'discovery':
      return `STAGE: DISCOVERY (step ${stageStep}). Explore the codebase to ground your plan. Write .agent/discovery-summary.md when done.`;
    case 'planning':
      return `STAGE: PLANNING (step ${stageStep}). Create plan.md with concrete phases and .agent/execution-contract.md. Do NOT start implementing yet.`;
    case 'execution':
      return `STAGE: EXECUTION (step ${stageStep}). Implement the plan. Stay in allowed workspace roots. Do not reopen task interpretation.`;
    case 'verification':
      return `STAGE: VERIFICATION (step ${stageStep}). Prove your work is correct. Run tests, check outputs. Write .agent/verification-summary.md.`;
    case 'finalization':
      return `STAGE: FINALIZATION (step ${stageStep}). Write any remaining deliverables. Verify required outputs exist. Call finish.`;
  }
}
```
 
## 10.5 Stage Tool Filtering
 
Integrate with the existing routing system:
 
```js
const STAGE_TOOL_ALLOWLIST = {
  intake:        ['read_file', 'list_dir', 'think', 'write_file', 'save_memory'],
  discovery:     ['read_file', 'list_dir', 'search_files', 'glob', 'run_command', 'think', 'write_file'],
  planning:      ['think', 'update_plan', 'todowrite', 'todoread', 'save_memory', 'write_file', 'read_file'],
  execution:     null, // all tools except finish (handled by router)
  verification:  ['run_command', 'read_file', 'search_files', 'lsp', 'write_file', 'think'],
  finalization:  ['write_file', 'read_file', 'finish', 'think'],
};
 
function filterToolsByStage(tools, stage) {
  const allowlist = STAGE_TOOL_ALLOWLIST[stage];
  if (!allowlist) return tools; // null = all tools allowed
  return tools.filter(t => allowlist.includes(t.function.name));
}
```
 
## 10.6 Stage Budget Allocation
 
Prevent any single stage from consuming the entire step budget:
 
```js
const STAGE_BUDGET_RATIOS = {
  intake:       0.05,   // 5% of maxSteps
  discovery:    0.10,   // 10%
  planning:     0.10,   // 10%
  execution:    0.55,   // 55%
  verification: 0.10,   // 10%
  finalization: 0.10,   // 10%
};
 
function getStageBudget(stage, maxSteps) {
  return Math.floor(maxSteps * STAGE_BUDGET_RATIOS[stage]);
}
```
 
If a stage exceeds its budget, force-advance to the next stage with a warning.
 
## 10.7 Anti-Drift Enforcement
 
During execution stage, check every step:
```js
function checkDrift(action, executionContract) {
  // 1. Verify workspace root hasn't changed
  if (action.args?.path && !isWithinAllowedRoots(action.args.path, executionContract.allowedRoots)) {
    return `DRIFT WARNING: ${action.args.path} is outside allowed roots: ${executionContract.allowedRoots.join(', ')}`;
  }
  // 2. Verify not re-opening interpretation
  if (action.tool === 'think' && executionContract.stage === 'execution') {
    return 'You are in EXECUTION stage. Do not re-plan. If blocked, mark the item blocked and move to the next.';
  }
  return null;
}
```
 
## 10.8 Completion Guard
 
Before `finish` is accepted in finalization, enforce:
```js
function completionGuard(executionContract) {
  const missing = [];
  for (const output of executionContract.requiredOutputs) {
    const abs = path.resolve(getWorkspace(), output);
    if (!fs.existsSync(abs)) {
      missing.push(output);
    } else {
      const stat = fs.statSync(abs);
      if (stat.size === 0) missing.push(`${output} (empty)`);
    }
  }
  if (missing.length > 0) {
    return `Cannot finish: missing required outputs: ${missing.join(', ')}`;
  }
  return null; // All good
}
```
 
---
 
# 11. Cross-Platform Compatibility
 
## 11.1 Replace Shell `grep` with JS-Native Search
 
**Files:** `src/memory-store.js`, `src/tools/filesystem/search-files.js`
 
**Bug:** `grep` is not available on Windows by default. All memory search and file search silently fails.
 
**Fix:** Create a shared utility:
 
```js
// src/tools/utils/native-search.js
import fs from 'node:fs';
import path from 'node:path';
 
export function searchInDirectory(dir, query, opts = {}) {
  const { maxResults = 50, filePattern = '*', caseSensitive = false } = opts;
  const results = [];
  const regex = new RegExp(query, caseSensitive ? '' : 'i');
  const files = getAllFiles(dir, filePattern);
 
  for (const file of files) {
    if (results.length >= maxResults) break;
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({ file: path.relative(dir, file), line: i + 1, text: lines[i].trim() });
          if (results.length >= maxResults) break;
        }
      }
    } catch { /* skip binary/unreadable files */ }
  }
  return results;
}
```
 
## 11.2 Replace Shell `find`/`ls` with Node Glob
 
**File:** `src/tools/filesystem/glob.js`  
**Bug:** `find` and `ls` commands have different syntax on macOS, Linux, and Windows.
 
**Fix:** Use `fs.globSync()` (Node 22+) or the `glob` npm package. See §1.3.
 
## 11.3 Shell Path Separators
 
**Bug:** Several files use forward-slash paths in shell commands which break on Windows.
 
**Fix:** Use `path.join()` and `path.resolve()` consistently. For shell commands, normalize to forward slashes explicitly:
```js
const shellPath = abs.replace(/\\/g, '/');
```
 
---
 
# 12. Test Coverage Gaps
 
## 12.1 Missing Test Categories
 
| Category | What to Test | Priority |
|----------|-------------|----------|
| **Security** | Command injection in all 6 tool handlers (send payloads like `'; rm -rf /; echo '`) | P0 |
| **Corrupted state** | Malformed `checkpoint.json`, partial `progress.md`, empty `SOUL.md` | P1 |
| **Cross-platform** | Memory search on Windows (no grep available) | P1 |
| **Concurrency** | Simultaneous file tracking writes (stress test) | P2 |
| **Large files** | `read_file` on 100MB+ files, memory with 1000+ entries | P2 |
| **Unicode** | Multi-byte characters in file paths, tool arguments, memory content | P2 |
| **Stage system** | Stage transitions, budget enforcement, drift detection, completion guard | P2 |
| **Skill recursion** | Skill A calls Skill B calls Skill A → timeout | P2 |
| **Network resilience** | LLM timeout mid-response, partial JSON, 502/503 errors | P2 |
| **Resume integrity** | Resume after crash at every possible point in the loop | P2 |
 
## 12.2 Test Infrastructure Improvements
 
1. **Add Windows CI:** Run tests on Windows in addition to Linux/macOS. The `grep`-dependent tests will immediately surface.
2. **Mock LLM for all unit tests:** A mock LLM should be parameterizable to return edge-case responses (partial JSON, thinking blocks, XML tool calls).
3. **Property-based testing for parser:** Use a library like `fast-check` to generate random LLM responses and ensure `parseAction()` never throws unhandled exceptions.
 
---
 
# 13. Implementation Order
 
Phases are ordered by risk-reduction. Each phase is independently deployable.
 
## Phase 1 — Security Hardening (P0)
**Target files:** All 7 files in §1  
**Estimated changes:** ~200 lines modified  
**Testing:** Add injection payload tests to `tools-regression.test.js`
 
1. Replace `execSync` with `execFileSync` in: `search-files.js`, `glob.js`, `lsp.js`, `webfetch.js`, `memory-store.js`
2. Add command allowlist to `run-command.js`
3. Fix `require()` → `import` in `lsp.js`
4. Add security regression tests
 
## Phase 2 — Core Correctness (P0)
**Target files:** `loop.js`, `memory.js`, `state.js`  
**Estimated changes:** ~150 lines modified
 
1. Fix fractional step numbers → integer steps with `subStep` field
2. Fix verification always-pass → return `false` on exhausted retries
3. Add `restoreFilesTracking()` on resume
4. Add `lastErrorContext` to checkpoint
5. Fix UTF-8 safe truncation
6. Update existing tests to cover new checkpoint fields
 
## Phase 3 — Reliability & Cross-Platform (P1)
**Target files:** `memory-store.js`, `state.js`, `glob.js`, `config.js`  
**Estimated changes:** ~300 lines (includes new `native-search.js` utility)
 
1. Create `src/tools/utils/native-search.js`
2. Replace all grep-based search with native search
3. Replace shell glob with Node glob
4. Add config validation
5. Fix learning persistence integration
6. Add memory deduplication
7. Add Windows-specific tests
 
## Phase 4 — Routing Consolidation (P1)
**Target files:** `tools/index.js`, `routing/toolRegistry.js`, `routing/loopController.js`  
**Estimated changes:** ~200 lines refactored
 
1. Consolidate dual tool registry into single source of truth
2. Remove or deprecate broken `runRoutedLoop()`
3. Add tool argument validation layer
4. Update routing tests
 
## Phase 5 — Context & Compaction Fixes (P2)
**Target files:** `context.js`, `compaction.js`, `identity.js`, `plan.js`  
**Estimated changes:** ~100 lines
 
1. Propagate compaction mode to context
2. Fix post-compaction recovery prompt disruption
3. Add staleness warning
4. Add identity block fallback
5. Fix plan phase status for blocked items
6. Expand focus chain parsing
7. Add plan size guard
 
## Phase 6 — Loop Guard Improvements (P2)
**Target files:** `loop.js`  
**Estimated changes:** ~80 lines
 
1. Add fuzzy-match stall detection for similar args
2. Exempt read-only tools from same-result guard
3. Improve result normalization
 
## Phase 7 — Verification Hardening (P2)
**Target files:** `loop.js`, `context.js`  
**Estimated changes:** ~60 lines
 
1. Add evidence injection to verification prompt
2. Persist verification failure count in checkpoint
3. Add forced-acceptance after N total failures (with memory save)
 
## Phase 8 — Stage-Based Execution (P3)
**Target files:** New `src/stages.js`, modified `loop.js`, `context.js`, `state.js`  
**Estimated changes:** ~400 lines new, ~100 lines modified
 
1. Create `src/stages.js` with stage definitions and transition logic
2. Add `stageState` to checkpoint schema
3. Integrate stage tool filtering with router
4. Add stage guidance to context assembly
5. Implement execution contract generation
6. Implement completion guard
7. Implement stage budget enforcement
8. Implement anti-drift checks
9. Add comprehensive stage transition tests
 
---
 
# 14. File-by-File Change Map
 
| File | Phase | Changes |
|------|-------|---------|
| `src/tools/execution/lsp.js` | 1 | Add `fs` import, fix `require()`, replace `execSync` with `execFileSync` |
| `src/tools/execution/run-command.js` | 1 | Add command allowlist validation |
| `src/tools/execution/webfetch.js` | 1 | Replace `execSync(curl)` with native `fetch()` |
| `src/tools/execution/websearch.js` | 1 | Replace `execSync` with `execFileSync` |
| `src/tools/filesystem/search-files.js` | 1,3 | Replace `execSync(grep)` with native search |
| `src/tools/filesystem/glob.js` | 1,3 | Replace shell `find`/`ls` with Node globSync |
| `src/tools/filesystem/patch.js` | 1 | Add diff format validation |
| `src/memory-store.js` | 1,3,4 | Replace grep with native search, add deduplication |
| `src/loop.js` | 2,6,7,8 | Fix fractional steps, verification, loop guard, add stages |
| `src/memory.js` | 2,4 | Add duplicate flag, fix getRecent for same-step entries |
| `src/state.js` | 2,3 | Add `restoreFilesTracking()`, fix file tracking cache, fix progress rotation, integrate learnings |
| `src/config.js` | 3 | Add `validateConfig()` |
| `src/tools/index.js` | 4 | Consolidate with toolRegistry, add arg validation |
| `src/routing/toolRegistry.js` | 4 | Become single source of truth for all tool definitions |
| `src/routing/loopController.js` | 4 | Remove broken `runRoutedLoop()` |
| `src/context.js` | 5,8 | Fix compaction mode, recovery prompt, staleness, stage guidance |
| `src/compaction.js` | 5 | Persist mode in summary header |
| `src/identity.js` | 5 | Add fallback identity if files missing |
| `src/plan.js` | 5 | Fix blocked status, add plan size guard |
| `src/stages.js` | 8 | **New file** — stage definitions, transitions, budgets, guards |
| `src/tools/utils/native-search.js` | 3 | **New file** — cross-platform file search |
| `tests/security.test.js` | 1 | **New file** — injection payload tests |
| `tests/stages.test.js` | 8 | **New file** — stage transition tests |
| `tests/cross-platform.test.js` | 3 | **New file** — Windows compatibility tests |
 
---
 
# Appendix A — Known Fixed Issues (Session 2)
 
These issues are already fixed and verified by `tests/session2-fixes.test.js`:
 
| ID | Fix | Status |
|----|-----|--------|
| THINKING-1 | `<think>` blocks stripped before parsing | ✅ Fixed |
| MEM-1 | Parse errors pushed to WorkingMemory | ✅ Fixed |
| MEM-2 | LLM errors pushed to WorkingMemory | ✅ Fixed |
| MEM-3 | `parseErrorStreak` + `runtimeGuidance` saved in checkpoint | ✅ Fixed |
| MEM-4 | Parse errors gated by `maxConsecutiveErrors` | ✅ Fixed |
 
---
 
# Appendix B — Configuration Defaults Reference
 
```js
// src/config.js — current defaults and recommended changes
{
  maxSteps: 500,                    // No change
  maxTotalChars: 50_000_000,        // No change
  contextWindow: 8192,              // Add: minimum 1024 validation
  workingMemoryWindow: 10,          // Add: minimum 3 validation
  maxConsecutiveErrors: 5,          // No change
  maxSameToolErrors: 3,             // Document: used for warning tier
  compactionThresholdChars: 50000,  // No change
  compactionIntervalSteps: 50,      // No change
  maxTerminalLines: 200,            // No change
  // NEW (Stage system):
  enableStages: false,              // Feature flag — opt-in initially
  stageBudgetRatios: { intake: 0.05, discovery: 0.10, planning: 0.10,
                       execution: 0.55, verification: 0.10, finalization: 0.10 },
}
```
 
---
 
# Appendix C — Verification Checklist
 
After all phases are implemented, run this checklist:
 
- [ ] `npm test` — all existing tests pass
- [ ] `tests/security.test.js` — injection payloads blocked
- [ ] `tests/cross-platform.test.js` — Windows/Linux parity
- [ ] `tests/stages.test.js` — stage transitions correct
- [ ] Manual 50-step run with `enableStages: true` — no drift
- [ ] Manual 100-step run with deliberate stall — loop guard fires correctly
- [ ] Resume from checkpoint after crash — all state restored
- [ ] Run with `grep` uninstalled — memory search still works
- [ ] Run `lsp` tool on `.json` file — no `require()` error
- [ ] Verify `finish` rejected when required outputs missing
 
 