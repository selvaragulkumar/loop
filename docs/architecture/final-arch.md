# Stage-Based Execution Architecture for Advanced-agent-loop
## Designing a More Reliable Autonomous Agent Without Hardcoded Task Modes

**Status:** Proposed architecture for implementation  
**Audience:** Runtime/loop maintainers, prompt/context maintainers, tool/runtime maintainers  
**Primary Goal:** Make long autonomous runs complete reliably without drift, clarification loops, repeated failed edits, premature finish, or missing required outputs  
**Scope:** `src/loop.js`, `src/context.js`, `src/state.js`, `src/memory.js`, `src/memory-store.js`, selected tool handlers, task templates, regression tests

---

# 0. Executive Summary

The current agent loop is capable but not disciplined enough for long autonomous work.

It can:
- read and write files,
- run commands,
- maintain memory,
- compact context,
- and partially complete tasks,

but it still fails in important ways:
- reopens interpretation after execution has started,
- loops on brittle `edit_file` operations,
- repeats `search_files` after `NO_MATCH`,
- drifts into alternate project roots,
- asks for clarification in autonomous runs,
- reaches step limits without producing required artifacts,
- and can finish with an unresolved question instead of a deliverable.

The root problem is not lack of tools or lack of compaction.  
The root problem is **lack of execution structure**.

This document proposes a **stage-based execution architecture** that replaces the current flat “every step can do anything” loop with a progression model:

1. **Intake**
2. **Discovery**
3. **Planning**
4. **Execution**
5. **Verification**
6. **Finalization**

The most important design addition is a persistent **Execution Contract**:
- generated during Planning,
- persisted as a file,
- loaded into context during Execution,
- used to prevent drift and enforce completion.

This design:
- keeps behavior generic across many tasks,
- fits the project’s markdown/file-based memory model,
- improves resumability,
- improves debuggability,
- reduces drift,
- and provides a realistic path to reliable autonomous completion.

---

# 1. Problem Statement

## 1.1 Observed Failure Pattern

Recent runs show the loop can:
- start correctly,
- create files,
- run commands,
- compact memory,
- partially implement features,
- produce some valid outputs,

but then degrade into:
- repeated `edit_file` failures (`String not found`)
- repeated searches with `NO_MATCH`
- repeated duplicate commands
- reopening earlier subproblems
- switching project roots mid-run
- creating clarification artifacts instead of finishing
- ending without required output files
- finishing with a question rather than a result

This means the system has:
- **mechanical capability**
- but insufficient **execution discipline**

## 1.2 Root Cause

The current loop is effectively:

```text
build context -> ask LLM for next action -> execute tool -> persist -> repeat