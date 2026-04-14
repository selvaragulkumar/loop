# Sandbox Verifier — Detailed Implementation Flow

The sandbox verifier (`src/sandbox-verifier.js`) is the final gate before the agent is allowed to call `finish`. It decides whether the task is genuinely complete using a 3-source evidence model with hard rules that bypass the LLM judge when the answer is unambiguous.

---

## Overview

```
sandboxVerify(task, workspace, snapshot, priorFailures, actionLog)
        │
        ├─ 1. Workspace diff (SHA256 hashes)
        ├─ 2. Hard rule: nothing happened → FAIL immediately
        ├─ 3. Task verification commands (from task's own bash blocks)
        │       ├─ Any fail → FAIL immediately (authoritative)
        │       └─ All pass → PASS immediately (authoritative)
        ├─ 4. Spot-checks (syntax + pre-existing tests)
        │       └─ Any auth-test fails → FAIL immediately (no LLM override)
        ├─ 5. Hard rule: success in action log + all checks pass → PASS immediately
        ├─ 6. LLM judge (3 evidence sources → JSON verdict)
        └─ 7. Rule-based fallback (when LLM unavailable or ambiguous)
```

---

## Evidence Source 1: Workspace Diff

**How it works:**

Before the agent starts (in `cli.js`), the workspace is snapshotted:

```javascript
const snapshot = snapshotWorkspace(workspace);
// → { 'src/app.js': 'sha256hex...', 'README.md': 'sha256hex...', ... }
```

`snapshotWorkspace()` walks the workspace directory recursively, computing SHA256 hashes of every file. Three directories are always excluded from hashing:
- `.agent/` — runtime state (not task output)
- `node_modules/` — dependencies (not modified by agent)
- `.git/` — version control internals

When `sandboxVerify` is called, `diffWorkspace()` re-walks the workspace and compares hashes:

```
added    = files in current but not snapshot
modified = files in both but with different hashes
deleted  = files in snapshot but not current
```

`.agent/` files are filtered out of the `changedFiles` list before spot-checks, so internal state writes don't inflate the evidence.

**What it tells us:** What physical artifacts the agent created/changed/removed.

---

## Evidence Source 2: Action Log

**How it works:**

The working memory (`src/memory.js`) keeps a sliding window of every step: tool name, args, result, error flag. `sandboxVerify` receives this log as an array and `formatActionLog()` converts it for the LLM judge:

```
[Step 12] write_file → [OK] Written: src/app.js (247 bytes)
[Step 14] run_command → [OK] SMOKE OK
[Step 15] finish → [OK] ...
```

`think` steps are stripped from the log — they're internal reasoning, not evidence of doing. The log is capped at 3000 characters with a truncation marker.

**What it tells us:** What the agent actually attempted and whether it succeeded — catches cases where files were touched but the commands that test them failed.

**Verification success detection (`hasVerificationSuccessInLog`):**

A separate scan of the action log looks for recent `run_command` entries whose output contains explicit success signals:

```
OK | PASS | passed | success | SMOKE OK | ✓ | ✔ | all tests | no errors
```

This is used in the "verified output" hard rule (step 5) to avoid sending to the LLM judge when the evidence is clear. Entries that are "Skipped duplicate", "Blocked", or start with "Exit code" are excluded — these indicate guard interventions, not real test passes.

---

## Evidence Source 3: Spot-Checks

**How it works:**

`runSpotChecks()` performs two types of automated checks on `changedFiles`:

### Syntax checks (per changed file)

For every changed `.js` / `.mjs` file (excluding test files):
```bash
node --check <file>   # exits 0 if syntax valid, non-zero if syntax error
```

For every changed `.py` file (excluding test files):
```bash
python3 -m py_compile <file>   # exits 0 if valid, non-zero with traceback if not
```

Results are tagged `type: 'syntax'`.

### Authoritative test execution (pre-existing tests only)

Pre-existing test files are those that existed in the snapshot (before the agent started). Detected by pattern:

```
_smoke_test.js / _smoke_test.py
_test.js / _test.py
*.test.js
*.spec.js
```

**Critical security property:** Agent-created test files are NEVER run. A test file not in the original snapshot could have been written by the agent to trivially pass. Only tests the user authored before the run are authoritative.

Pre-existing test files are executed:
```bash
node <test_file>      # for .js / .mjs
python3 <test_file>   # for .py
```

Results are tagged `type: 'auth-test'`.

---

## Task Verification Commands (Special Evidence)

The task description itself can contain authoritative verification commands. `extractTaskVerificationCommands()` scans the task text for `bash` code blocks that appear under any heading matching `Verification`, `Verification Commands`, `Required Verification Commands`, `Validation Commands`, or `Done Criteria`:

```markdown
## Verification

```bash
python3 _smoke_test.py
node --test tests/
```
```

These commands are extracted and run in the workspace directory. They are treated as the highest-authority signal:
- **Any fails → immediate FAIL** (overrides everything else, including LLM judge)
- **All pass → immediate PASS** (overrides everything else)

This means if the task author specifies verification commands, the loop is closed without any LLM involvement.

---

## Decision Flow — Hard Rules First

### Rule 1: Nothing happened

```
totalChanges == 0 AND meaningfulActions.length == 0
→ FAIL: "No files changed and no meaningful actions were taken."
```

`meaningfulActions` = all working memory entries where `action !== 'think'` and `error === false`.

### Rule 2: Task verification command failed

```
taskVerifyResults has any entry with passed == false
→ FAIL: "Task verification command failed: $ <cmd>\n<output>"
```

Hard reject — no LLM override possible.

### Rule 3: Task verification commands all passed

```
taskVerifyResults.length > 0 AND all passed
→ PASS: "All N task verification command(s) passed."
```

Hard pass — no further checking needed.

### Rule 4: Authoritative test failed

```
spotChecks has any entry with type == 'auth-test' AND passed == false
→ FAIL: "Authoritative test failed: <file>\n<output>"
```

Hard reject — a test the user wrote before the run is failing. The agent cannot override this.

### Rule 5: Verified output in action log

```
totalChanges > 0 AND allSpotChecksPassed AND hasVerificationSuccessInLog(actionLog)
→ PASS: "Files changed, all spot checks passed, and action log shows successful verification output."
```

This avoids an unnecessary LLM call when the evidence is unambiguous.

**What counts as strong verification evidence** (after the bug fix):
- A real test-runner command was executed: `python3 _smoke_test.py`, `node --test tests/`, `pytest`, `npm test`, `*_test.py`, `*.test.js`, `*.spec.js`
- OR the output contains an unambiguous multi-test signal: `SMOKE OK`, `all tests passed`, `✓`, `5 tests passed`, etc.

**What does NOT count** (too weak, was the pre-fix bug):
- Inline one-liner assertions (`python3 -c "assert x == 1; print('config OK')"`) — these only check one thing and output like `config OK` is indistinguishable from a partial pass.
- Generic single-word `OK` or `success` outputs from arbitrary commands.

---

## LLM Judge

When no hard rule fires, the verifier assembles all three evidence sources and sends them to the LLM:

**System prompt (adversarial stance):**
```
You are a strict, adversarial task completion verifier. Your job is to decide whether
an autonomous agent has fully completed the assigned task.
...
Be critical. Partial work, placeholder output, or failed attempts are NOT acceptable.
...
Respond ONLY with JSON: {"verified": boolean, "reason": "one or two sentences"}
```

**User prompt structure:**
```
TASK:
<task text, truncated to 2000 chars>

WORKSPACE CHANGES:
Added (N): file1, file2, ...
Modified (N): file3, ...
Deleted (N): ...

ACTION LOG (what the agent did):
[Step 12] write_file → [OK] Written: src/app.js (247 bytes)
...

SPOT-CHECK RESULTS:
[PASS] src/app.js (syntax)
[PASS] _smoke_test.py (auth-test)
...
```

**Temperature:** 0.1 (strict, low variance)

**Response parsing:** The response is scanned for `{"verified": ..., "reason": "..."}`. If full JSON parse fails, keyword matching is used as a fallback (`"verified": true` / `"verified": false` substring scan).

---

## Rule-Based Fallback (LLM Unavailable)

If the LLM call throws (server down, timeout) or returns an ambiguous/unparseable response:

| Condition | Decision |
|-----------|----------|
| Spot checks exist, all passed, files changed | PASS |
| Any spot check failed | FAIL (lists failed files) |
| Files changed + meaningful actions, no checks | FAIL (inconclusive) |
| Anything else | FAIL (inconclusive) |

The fallback is intentionally conservative. An inconclusive result makes the agent retry verification rather than silently declaring success.

---

## Relationship to the Stage System

The stage system (`src/stages.js`) uses `parseRequiredCommands()` to extract required commands from the task spec and track whether the agent has executed them during the run. This is separate from the sandbox verifier — it runs **every step** to enforce that the agent doesn't advance to finalization without running the required checks.

`parseRequiredCommands()` recognises fenced bash blocks under any of these heading patterns:

| Heading | Recognised |
|---------|-----------|
| `## Verification` | ✅ |
| `## Verification Commands` | ✅ |
| `## Required Verification Commands` | ✅ |
| `## Validation Commands` | ✅ |
| `## Done Criteria` | ✅ |
| `## Phase N` | ✅ |
| `## Pre-finish Checklist` | ✅ |

It also recognises prose triggers like `"The agent must execute all of the following commands exactly:"` and `"Execute the following commands:"`.

**Pre-fix bug:** Only fenced blocks under sections containing `'phase'` or `'pre-finish checklist'` were captured. A standard `## Verification` section with bash blocks was silently ignored, so `missingCommandEvidence` was always empty and verification advanced trivially.

---

## Integration with the Main Loop

### Snapshot creation (`src/cli.js`)

```javascript
// Before runLoop starts:
const snapshot = snapshotWorkspace(workspace);
// Saved to .agent/workspace-snapshot.json for persistence across restarts
```

### Called from `finish` tool (`src/tools/planning/finish.js`)

When the agent calls `finish`, the tool invokes `sandboxVerify`:

```javascript
const { verified, reason } = await sandboxVerify(
  task,
  workspace,
  snapshot,
  priorFailures,
  mem.getRecent()   // full working memory window
);

if (!verified) {
  // Return feedback to agent — loop continues
  return `Verification failed: ${reason}\nDo not call finish again until the issues are resolved.`;
}

// verified === true → loop exits with exitReason: 'completed'
```

If verification fails, `finish` returns an error string and the loop continues. The agent must address the failure before calling `finish` again. The `priorFailures` counter is incremented each time, and escalating guidance is injected into the context.

### `AGENT_REQUIRE_SMOKE_TEST` flag

When set to `false`, the sandbox verifier is bypassed entirely:

```bash
AGENT_REQUIRE_SMOKE_TEST=false node src/cli.js --workspace . --task "Refactor comments"
```

Use this for non-build tasks (analysis, documentation, chat) where file diffs are not the right success metric.

---

## Security Properties

1. **Agent-created tests are never run** — prevents the agent from writing a trivially-passing test to fool verification.

2. **Hard rules cannot be overridden by the LLM** — an authoritative test failure or "nothing happened" always returns `verified: false`, regardless of what the LLM judge says.

3. **Path traversal safety** — `walkDir()` uses `path.join()` and relative paths; `.agent/` and `node_modules/` are blocked by name, not path prefix, so they cannot be evaded by symlinks pointing elsewhere.

4. **Timeout enforcement** — all `spawnSync` calls use `timeout: 10000` (syntax checks) or `timeout: 30000` (test runs), preventing infinite loops in test code from blocking the agent.

5. **Snapshot stored before agent starts** — the baseline is fixed before any agent action. The agent cannot modify the snapshot by writing to `.agent/workspace-snapshot.json` because `.agent/` files are excluded from the diff comparison.

---

## File Reference

| File | Role |
|------|------|
| `src/sandbox-verifier.js` | Full verifier implementation |
| `src/tools/planning/finish.js` | Integration point — calls `sandboxVerify` |
| `src/cli.js` | Creates initial workspace snapshot |
| `src/state.js` | Persists snapshot to `.agent/workspace-snapshot.json` |

---

## Example Verification Scenarios

### Scenario A — Clean pass via task commands
Task has `## Verification` block with `python3 _smoke_test.py`. Agent writes the code and the smoke test exits 0.
→ Rule 3 fires: **PASS** (task verification commands all passed)

### Scenario B — Smoke test broken
Agent writes files but introduces a syntax error. Pre-existing `_smoke_test.py` exits non-zero.
→ Rule 4 fires: **FAIL** (authoritative test failed: \_smoke\_test.py)

### Scenario C — Nothing done
Agent loops on `think` calls without writing anything.
→ Rule 1 fires: **FAIL** (no files changed and no meaningful actions taken)

### Scenario D — All good, no task commands
Agent writes 7 Python files. All syntax checks pass. `run_command python3 _smoke_test.py` output contains "SMOKE OK".
→ Rule 5 fires: **PASS** (files changed, all spot checks passed, action log shows successful verification)

### Scenario E — LLM judge needed
Agent modifies a config file. No test files exist. Syntax checks pass. No "SMOKE OK" in logs.
→ LLM judge called with workspace diff + action log + empty spot-checks.
