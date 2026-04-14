# Anti-Stall Guards Reference

Complete inventory of all stall-detection and recovery mechanisms in the agent loop.

**Source files:** `src/guards.js`, `src/loop.js`, `src/recovery.js`, `src/stages.js`, `src/compaction.js`
**Total guards:** 42 distinct mechanisms across 8 categories

---

## 1. Parse Error Recovery Guards

| # | Guard | Trigger | Action | Source |
|---|---|---|---|---|
| 1 | **Parse Error Streak Forced-Think** | `parseErrorStreak >= 3` | Injects synthetic `think` action with strict JSON instructions, resets streak | `loop.js:410-427` |
| 2 | **Parse Recovery Guidance** | Any parse error | Injects targeted guidance based on error classification (TRUNCATED_STRING, PROSE_ONLY, etc.) | `recovery.js` |
| 3 | **Parse Error Burst Recovery** | Burst of parse errors in recent window | Escalated recovery event logged | `loop.js:544-548` |

---

## 2. Repeat / Identical Action Guards

| # | Guard | Trigger | Action | Source |
|---|---|---|---|---|
| 4 | **Same-Tool Same-Args Stall** | Same tool + identical args 3+ consecutive steps | Warning: stop repeating, run verification | `guards.js:83-90` |
| 5 | **Same-Tool Similar-Args Stall** | Same tool + similar args 5+ consecutive steps | Warning: re-ground on source state | `guards.js:92-98` |
| 6 | **General Tail Streak** | Same action 6+ times or same action + same result | Warning: run verification commands | `guards.js:111-113` |
| 7 | **Identical Streak Hard Stop** | Same tool + same args 4+ steps after loop_guard fired | **Terminates the loop** with exit reason `error` | `loop.js:848-854` |
| 8 | **Repeated Failure Retry Block** | Same failed action retried without diagnostic step in between | RETRY_BLOCKED: must run read/search/list first | `guards.js:296-313` |
| 9 | **Repeated Observation Retry Block** | Same read-only tool + same args + same result 2+ times | RETRY_BLOCKED: change args or use different tool | `guards.js:315-360` |
| 10 | **Same-File Read Churn Block** | `read_file` on same path 4+ times in recent window | RETRY_BLOCKED: you already know this file, use write_file | `guards.js:324-332` |

---

## 3. Write Churn / Thrash Guards

| # | Guard | Trigger | Action | Source |
|---|---|---|---|---|
| 11 | **File Write Churn Detection** | Same file written/edited 3+ times in last 16 steps | Warning: stop rewriting, move to next file | `guards.js:130-159` |
| 12 | **File Edit Churn Block** | Same file edited 4+ times AND touched 6+ times in last 20 steps | EDIT_CHURN_BLOCKED: flip-flop detected | `guards.js:368-393` |
| 13 | **Session Write-Thrash Guard** | Same file written 5+ times across entire session (survives compaction) | FORCED-THINK injection + STALL RECOVERY guidance | `loop.js:428-466` |
| 14 | **Thrash-Block Hard Guard** | After write-thrash redirect identifies a caller file | Hard-blocks the thrash file for 3 steps, forces agent to fix the caller instead | `loop.js:654-675` |
| 15 | **Test File Write Churn** | Smoke test / test file being rewritten repeatedly | Redirects to fixing SOURCE code instead of test file | `guards.js:151-154` |
| 16 | **Cross-File Mismatch Diagnostic** | `AttributeError` / `TypeError` in failed command output | Scans workspace to find caller vs definition mismatch, injects specific fix guidance | `guards.js:541-618` |
| 17 | **Caller Extraction from Traceback** | Write-thrash guard fires + error traceback available | Parses Python/JS traceback to identify the actual broken caller file | `guards.js:511-534` |

---

## 4. Stage System Guards

| # | Guard | Trigger | Action | Source |
|---|---|---|---|---|
| 18 | **Stage-Misaligned Action Block** | Tool not in current stage's allowlist | RETRY_BLOCKED: wrong stage for this action | `guards.js:413-443` |
| 19 | **Stage Reset Safety Valve** | 4+ consecutive stage-misaligned blocks | Force-resets stage back to `execution` | `loop.js:611-619` |
| 20 | **Execution Discovery Block** | Read-only tools targeting files outside locked targets during execution | RETRY_BLOCKED: stay within locked targets | `guards.js:445-463` |
| 21 | **Verification Repair Mode** | 3+ verification failures | Limits tools to read/write/run/finish only | `stages.js` |

---

## 5. Finish / Completion Guards

| # | Guard | Trigger | Action | Source |
|---|---|---|---|---|
| 22 | **Finish Stage Gate** | `finish` called before finalization stage | Finish BLOCKED: advance to finalization first | `loop.js:875-884` |
| 23 | **Completion Guard** | `finish` called but required outputs missing or verification commands fail | Finish BLOCKED + recovery guidance | `loop.js:896-907` |
| 24 | **Smoke Test Gate** | `finish` called but no passing smoke test detected | Finish BLOCKED: run/write smoke test first | `loop.js:947-952` |
| 25 | **Smoke Test Source-Fix Redirect** | Smoke test ran but failed | Finish BLOCKED: fix SOURCE CODE, not the test | `loop.js:951` |
| 26 | **Blocked Finish Retry** | `finish` blocked 2+ times in last 4 steps | RETRY_BLOCKED: don't call finish again until blocker resolved | `guards.js:404-411` |
| 27 | **Premature Success Artifact Block** | Writing success artifacts before required outputs exist | BLOCKED: create deliverables first | `loop.js:628-653` |
| 28 | **Missing Artifact Priority Block** | Writing unrelated files while required deliverables missing | Redirects to create missing deliverables first | `guards.js:624-635` |

---

## 6. Finalization / Read Churn Guards

| # | Guard | Trigger | Action | Source |
|---|---|---|---|---|
| 29 | **Finalization Read Churn** | 5+ consecutive read-only checks on result/ artifacts in finalization stage | Warning: stop re-reading, repair or finish | `guards.js:161-177` |
| 30 | **Finalization Read Churn Block** | 4+ consecutive result/ reads in finalization | RETRY_BLOCKED: write/edit the artifact or finish | `guards.js:482-504` |
| 31 | **Plan/Progress Reread Block** | Reading `.agent/plan.md` or `.agent/progress.md` 3+ times in verification/finalization | RETRY_BLOCKED: use runtime status instead | `guards.js:465-480` |

---

## 7. Infrastructure Guards

| # | Guard | Trigger | Action | Source |
|---|---|---|---|---|
| 32 | **Baseline Environment Reset Detection** | Same baseline env probe commands (`node -v`, `pwd`, etc.) run 2+ times | Warning: don't restart Phase 1 | `guards.js:199-211` |
| 33 | **Search No-Match Stall** | `search_files` returns no matches 2+ times consecutively | Warning: switch to read_file with exact identifiers | `guards.js:213-224` |
| 34 | **Identical Failed Retry Detection** | Same failing action retried 2+ times with same args | Warning: read/search target first, change args | `guards.js:226-243` |
| 35 | **Consecutive Error Limit** | `consecutiveErrors >= 8` | **Terminates the loop** | `loop.js` |
| 36 | **Same-Tool Error Limit** | Same tool errors 3+ times | **Terminates the loop** | `loop.js` |
| 37 | **Stale File Edit Block** | `edit_file` on a file that changed since last read | RETRY_BLOCKED: re-read the file first | `guards.js:395-402` |
| 38 | **Protected File Guard** | Write/edit on pre-existing test file | PROTECTED: fix source code instead | `loop.js:676-691` |

---

## 8. Memory / Context Guards

| # | Guard | Trigger | Action | Source |
|---|---|---|---|---|
| 39 | **Compaction Trigger** | Old entries exceed threshold chars OR interval steps elapsed | Summarize + flush memories to persistent store | `compaction.js` |
| 40 | **Post-Compaction Identity Recovery** | After any compaction | Re-inject SOUL.md, AGENTS.md, MEMORY.md orientation | `loop.js:305-311` |
| 41 | **Pre-Compaction Memory Flush** | Before compaction destroys old entries | Save high-value entries to persistent daily log | `memory-store.js` |
| 42 | **Heartbeat Memory Check** | Every 10 steps | Save current subtask + progress to persistent store | `memory-store.js` |

---

## Guard Execution Order Per Step

The guards execute in this sequence within each loop iteration:

```
1. Compaction check (guard 39-41)
2. Heartbeat memory check (guard 42)
3. Stage advancement
4. Forced-think injection checks:
   a. Parse error streak (guard 1)
   b. Session write-thrash (guard 13, 14, 16, 17)
   c. Repeat-guard stall breaker (guard 10)
5. LLM call → parse response (guard 2, 3)
6. Pre-execution blocks:
   a. Repeated action block (guards 8, 9, 10, 12, 15)
   b. Stage-misaligned block (guards 18, 19, 20)
   c. Premature artifact block (guard 27)
   d. Thrash-block hard guard (guard 14)
   e. Protected file guard (guard 38)
   f. Missing artifact priority (guard 28)
   g. Stale file edit block (guard 37)
7. Tool execution
8. Post-execution checks:
   a. Finish gate (guards 22-26)
   b. Completion guard (guard 23)
   c. Smoke test gate (guards 24, 25)
9. Loop guard detection (guards 4-7, 29-34)
10. Error limit checks (guards 35, 36)
```

---

## Guard Categories by Severity

### Terminators (kill the loop)
- Guard 7: Identical Streak Hard Stop (4+ identical actions after loop_guard)
- Guard 35: Consecutive Error Limit (8+ errors)
- Guard 36: Same-Tool Error Limit (3+ same-tool errors)

### Blockers (reject the action, force different behavior)
- Guards 8-10: Retry/observation blocks
- Guard 12: Edit churn block
- Guards 14, 37, 38: Thrash-block, stale file, protected file
- Guards 18, 20: Stage-misaligned blocks
- Guards 22-28: Finish/completion blocks
- Guards 30-31: Finalization read churn blocks

### Injectors (override the LLM response with a synthetic action)
- Guard 1: Parse error forced-think
- Guard 13: Session write-thrash forced-think
- Guard 10 (escalated): Repeat-guard stall forced-think

### Advisors (inject guidance into next prompt, don't block)
- Guards 2-6: Parse recovery, stall warnings
- Guards 11, 15, 29: Write churn warnings, read churn warnings
- Guards 32-34: Infrastructure stall warnings
- Guards 40-42: Post-compaction recovery, heartbeat