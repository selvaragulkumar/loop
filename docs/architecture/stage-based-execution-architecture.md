# Stage-Based Execution Architecture for Advanced-agent-loop
## Designing a More Reliable Autonomous Agent Without Hardcoded Task Modes

## Document Purpose
This document proposes a **stage-based execution architecture** for `Advanced-agent-loop` to address the failures observed in long autonomous runs:

- task drift
- repeated failed edits
- clarification loops inside autonomous execution
- output/report files not being written before step budget exhaustion
- weak recovery after repeated `NO_MATCH` / `String not found`
- lack of reliable completion behavior despite compaction and memory working mechanically

The goal is to improve the agent so it behaves more like a disciplined software engineer:
1. understand the task,
2. analyze the codebase,
3. create a stable execution plan,
4. execute in controlled steps,
5. verify outcomes,
6. finalize required deliverables.

This design avoids hardcoded task-specific “modes” and instead introduces **generic execution stages** that can work across many task types, including:
- development tasks
- validation tasks
- debugging tasks
- refactoring tasks
- build-and-test tasks
- documentation tasks

It is especially suitable for this project because **memory is persisted in markdown/files**, not in a graph runtime.

---

# 1. Core Problem

## 1.1 Observed failure pattern
Recent runs show the loop can:
- start correctly,
- create files,
- run commands,
- compact memory,
- partially implement features,

but then degrade into:
- repeated `edit_file` failures (`String not found`)
- repeated searches with `NO_MATCH`
- returning to earlier subproblems
- creating clarification artifacts instead of finishing
- ending without required output files
- drifting into alternate project interpretations

This means the system has:
- **mechanical capability**
- but insufficient **execution discipline**

## 1.2 Root cause
The current loop is too “flat”:

> build context -> ask LLM for next action -> execute tool -> persist -> repeat

This makes every step equally free to:
- inspect,
- plan,
- implement,
- revise,
- retry,
- drift,
- or finish.

Because all of these happen in one undifferentiated loop, the model can:
- go back to planning after implementation started,
- reopen resolved questions,
- re-run failed edits without proper re-grounding,
- miss required finalization under step pressure.

---

# 2. Architectural Principle

## Replace Flat Looping with Stage-Based Progression

Instead of “modes” like a hardcoded planner mode or builder mode, introduce a **generic stage system**.

A **stage** is:
- not task-specific,
- not tool-specific,
- not a hardcoded workflow for one prompt,
- but a controlled state of execution with different expectations and constraints.

This is a better fit than ad-hoc modes because:
- stages are generic and reusable,
- stages map naturally to markdown/file-based memory,
- stages allow stronger progression guarantees,
- stages reduce drift without forcing exact command allowlists for every task.

---

# 3. Proposed Stages

The loop should operate through these stages:

1. **Stage A — Intake**
2. **Stage B — Discovery**
3. **Stage C — Planning**
4. **Stage D — Execution**
5. **Stage E — Verification**
6. **Stage F — Finalization**

These stages are generic enough to support many tasks.

---

# 4. Stage Definitions

## Stage A — Intake
### Purpose
Understand the task and identify:
- outputs required
- scope boundaries
- constraints
- likely workspace/app root
- success criteria

### Allowed behavior
- read task
- inspect workspace root
- identify required artifacts
- identify forbidden paths
- initialize a stage file / stage state

### Not allowed
- large implementation work
- speculative file creation
- asking the user for clarification unless task explicitly requires interactive clarification

### Deliverables
- `current_stage = intake`
- `task_contract.md` or equivalent internal representation containing:
  - objective
  - required outputs
  - allowed paths
  - forbidden paths
  - success criteria
  - completion guard inputs

---

## Stage B — Discovery
### Purpose
Ground the task in the real codebase before planning implementation.

### Allowed behavior
- `list_dir`
- `read_file`
- `search_files`
- light `run_command` for environment discovery only

### Expected outputs
- identify relevant files
- identify architectural entry points
- identify implementation targets
- identify potential hazards

### Not allowed
- feature implementation
- repetitive broad search loops
- multiple identical `NO_MATCH` retries without reading source directly

### Deliverables
- `discovery_summary.md`
- list of relevant files
- identified implementation root
- confirmed command/test surface

---

## Stage C — Planning
### Purpose
Create a stable execution plan before editing the codebase.

### Allowed behavior
- `update_plan`
- `think`
- `todoread` / `todowrite`
- optional memory save for major findings

### Required outputs
- a plan broken into concrete actions
- file targets
- expected commands
- verification steps
- completion steps

### Important design choice
This stage should also generate a **prompt template for execution**, for example:

- current app root
- current feature objective
- required files
- next command/test checkpoints
- completion conditions
- forbidden drift paths

This is the user’s suggestion, and it is a strong one:
> the first stage ideates, plans, and creates a prompt template, then the next stage begins actual work

That is exactly right.

### Why this helps
Once the execution starts, the model no longer needs to rediscover the task every step.  
It receives a stable, bounded, execution-focused context derived from the planning stage.

### Deliverables
- `plan.md`
- `execution_contract.md`

---

## Stage D — Execution
### Purpose
Perform the actual work:
- create files
- edit files
- run implementation commands
- add tests
- update docs
- write outputs

### Allowed behavior
- `write_file`
- `edit_file`
- `patch`
- `run_command`
- `read_file` when needed for grounding
- memory/planning updates only if necessary

### Key rules
Execution must be constrained by the plan:
- only work in identified target roots
- only create outputs described in planning or clearly implied by the task
- do not reopen task interpretation unless hard contradiction is found

### Not allowed
- autonomous clarification loops
- switching to a new project root unless strong evidence requires it
- repeated exact failed edit attempts
- repeated exact duplicate commands unless verifying after a file change

### Deliverables
- working implementation
- updated app/test/docs files

---

## Stage E — Verification
### Purpose
Prove the work is correct.

### Allowed behavior
- run test commands
- run CLI smoke commands
- read output files
- inspect checkpoint/memory files if task requires agent validation
- generate structured pass/fail summary

### Required outputs
- verification ledger:
  - command
  - expected result
  - actual result
  - pass/fail/warn
- identification of unresolved issues

### Not allowed
- reopening major implementation unless a verification failure requires repair
- arbitrary exploratory searches unrelated to the failure

### Deliverables
- `verification_summary.md`
- per-command or per-check status table

---

## Stage F — Finalization
### Purpose
Write final required artifacts and exit cleanly.

### Allowed behavior
- re-read latest output/input artifacts
- write final reports/status files
- verify files exist and are non-empty
- call `finish`

### Required behavior
This stage must be protected by a completion guard:
- required outputs list
- latest-values-only re-read
- final existence check

### Deliverables
- required result files
- finish summary

---

# 5. Why Stages Are Better Than Modes

## 5.1 Stages are generic
“Planning mode” and “build mode” can become task-specific or tool-specific.  
Stages are more universal:
- every task has intake
- most tasks have discovery
- every non-trivial task benefits from planning
- most tasks have execution
- every serious task needs verification and finalization

## 5.2 Stages fit file-based memory
This project already persists memory via:
- markdown files
- checkpoint JSON
- context summary
- daily logs

That means stage state can also be persisted simply:
- checkpoint fields
- markdown summaries
- execution contract files

No graph runtime is required.

## 5.3 Stages support resumability
If the run is interrupted:
- reload checkpoint
- reload current stage
- reload stage outputs
- continue from that stage instead of re-deriving everything

This is cleaner than trying to infer where the model “probably was.”

---

# 6. Recommended Runtime Design

## 6.1 Add stage state to checkpoint
Extend checkpoint with:

```json
{
  "stageState": {
    "currentStage": "planning",
    "stageStep": 3,
    "stageStartedAt": "...",
    "stageCompletedAt": null,
    "lockedTargets": [
      "playground_app/task_tracker_cli"
    ],
    "requiredOutputs": [
      "result/BUILD_COMMAND_LOG.md",
      "result/BUILD_VALIDATION_REPORT.md",
      "result/BUILD_VALIDATION_STATUS.json"
    ],
    "executionContractPath": ".agent/execution-contract.md",
    "discoverySummaryPath": ".agent/discovery-summary.md",
    "verificationSummaryPath": ".agent/verification-summary.md"
  }
}
```
