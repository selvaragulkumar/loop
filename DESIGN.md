# Advanced Agent Loop v2.0 — Design Document

> **Goal:** Build the longest-running, most stable autonomous agent loop possible.
> Features: SOUL.md identity, persistent memory with pre-compaction flush, dynamic skill creation, focus chains.
> No LangGraph. No framework. Just a pure execution loop with battle-tested state/memory/context management.

---

## The Problem

LangGraph and similar frameworks exist because early LLMs were unreliable — they hallucinated, lost track of state, and drifted off-task. The solution was to externalize state management into a directed graph runtime.

**But that era is over.** Modern agents (OpenDevin, Cline, SWE-Agent) prove that you can run hundreds of steps stably if you solve three things at the loop level:

1. **Context window management** — The LLM forgets once you exceed its window. You must compact intelligently.
2. **State-as-files** — Instead of in-memory graphs, persist state to markdown/JSON. The filesystem IS the state machine.
3. **Anti-drift** — The LLM wanders. You need focus mechanisms that scale with loop length.

---

## Research Findings

### OpenDevin Architecture
- **Core loop:** Simple `for i in range(max_iterations): action = agent.step(state)` — no graph.
- **Two-tier memory:**
  - Short-term: In-memory `Monologue` list, compacted via LLM summarization when >20K chars
  - Long-term: ChromaDB vector store, never pruned, searchable via `recall` action
- **State lifecycle:** Tasks go `open → in_progress → completed → verified → abandoned` with cascade rules
- **Budget:** Dual limit — max iterations (100) + max characters (5M chars ≈ 1M tokens)
- **Anti-drift:** Task in every prompt, dynamic hints based on last action type, think-action alternation rule
- **Compaction trigger:** Character count threshold (20K), summarizes entire thought array

### Cline Architecture
- **Two compaction strategies:**
  - Programmatic: Delete middle messages, keep first+last, inject truncation notice
  - Auto-Condense: LLM generates 10-section summary, loads key files, replaces entire history
- **File tracking:** chokidar watchers, stale file alerts, edit timestamps per file
- **Focus chain:** Markdown checklist, periodic reminders (every 6 requests), escalating urgency
- **Checkpoint system:** Shadow git repo, commits at every tool call, full workspace rollback
- **Duplicate optimization:** Detects repeated file reads, replaces earlier reads with notices (saves 30%+ context)
- **Mistake detection:** Consecutive error counter, auto-pauses after N failures

### Key Patterns Extracted

| Pattern | OpenDevin | Cline | Our Approach |
|---------|-----------|-------|------------|
| Compaction trigger | 20K char threshold | Token count vs model limit | Hybrid: char threshold + token estimate |
| What gets compacted | Entire thought array | Middle messages or full rewrite | Tiered: keep anchors, summarize middle, preserve recent |
| Long-term memory | Vector DB (ChromaDB) | Disk files (JSON) | Markdown workspace files (searchable, human-readable) |
| State management | Python dataclass + Plan tree | JSON files per task | Markdown task file + JSON checkpoint |
| Focus mechanism | Task in prompt + hints | Checklist + periodic reminders | Structured progress file + adaptive reminders |
| Duplicate detection | None | File read dedup (30% savings) | Tool result fingerprinting + dedup |
| Anti-drift | Think-action alternation | Consecutive mistake detection | Both + scope decay detection |

---

## Architecture Blueprint

### Core Principle: **The Filesystem IS the State Machine**

Instead of in-memory state objects, the agent reads and writes its own state files. The loop just orchestrates the read→think→act→write cycle. If the process crashes, restart it — the files tell the agent exactly where it was.

```
workspace/
├── SOUL.md                  ← Agent identity: persona, tone, boundaries
├── AGENTS.md                ← Operating protocol: startup ritual, memory discipline
├── USER.md                  ← User profile: preferences, context, communication style
├── MEMORY.md                ← Curated long-term knowledge (agent-maintained)
├── .agent/
│   ├── task.md              ← Original task + refined understanding
│   ├── plan.md              ← Living plan: phases, subtasks, status
│   ├── progress.md          ← Step-by-step log of what was done
│   ├── context-summary.md   ← LLM-generated compaction of old context
│   ├── checkpoint.json      ← Machine-readable state snapshot (crash recovery)
│   ├── focus-chain.md       ← Human-editable priority steering
│   ├── memory/
│   │   ├── YYYY-MM-DD.md    ← Daily memory logs (auto-persisted)
│   │   ├── files-touched.json    ← File read/write tracking
│   │   ├── commands-run.json     ← Shell command history + outcomes
│   │   └── learnings.md          ← Agent's extracted learnings/notes
│   └── skills/
│       └── *.md             ← Agent-created reusable tools (dynamic loading)
```

### Layer 1: The Execution Loop

The simplest possible loop. No framework, no graph, no state machine runtime:

```
initialize(task)
for step in 1..MAX_STEPS:
    context = buildContext(step)       // Assemble what the LLM sees
    action  = llm.decide(context)      // LLM returns one action
    result  = execute(action)          // Run the tool
    record(step, action, result)       // Persist to progress.md + checkpoint
    if action.type == 'finish':
        verify(result)                 // Double-check before accepting
        break
    if shouldCompact(step):
        compact()                      // Summarize old context
```

**Key properties:**
- Each step is fully persisted before the next begins (crash-safe)
- The LLM sees the task, plan, recent actions, and context summary — never raw history
- Compaction happens mid-loop, not after

### Layer 2: 5-Layer Context Assembly (What the LLM Sees)

Every step, the LLM receives a prompt built from files, not from conversation history.
Inspired by OpenClaw's SOUL.md research — 5 layers that survive compaction:

```
[System Prompt — Layer 1: Identity]
  - SOUL.md content (who I am, my strengths, boundaries)
  - AGENTS.md rules (operating protocol)
  - Available tools (builtin + dynamically-loaded skills)

[User Message — Layers 2-5]

  Layer 2: Knowledge
  - Task description (from task.md)
  - Custom skills available
  - Persistent memory summary (count of daily logs, MEMORY.md status)

  Layer 3: State
  - Plan status (from plan.md — phases, progress)
  - Focus chain (from focus-chain.md — human-set priorities)
  - Context summary (compacted history from context-summary.md)
  - Key learnings (from learnings.md)
  - Recent persistent memories (today's daily log entries)

  Layer 4: Session
  - Recent actions/results (working memory — last N steps)
  - Stale file alerts

  Layer 5: Guidance
  - Post-compaction recovery prompt (if just compacted)
  - Pre-compaction flush prompt (if about to compact)
  - Error warnings (escalating based on consecutive failures)
  - Focus prompt (escalating based on step count)
  - Step instruction

[Environment Context]
  - Files modified since last read (stale file alerts)
  - Current directory state
  - Error patterns detected

[Focus Prompt]       ← adaptive, gets more urgent over time
  - "You are on step X of Y"
  - "Your current subtask is: ..."
  - "Files you've changed so far: ..."
```

**Why this works for long loops:** The LLM never sees old conversation turns. It sees a structured summary built from files. Whether you're on step 5 or step 500, the context is the same size — only the summary grows denser.

### Layer 3: Context Compaction (How Memory Scales)

Three tiers of memory, inspired by human cognition:

**Tier 1: Working Memory (last N steps)**
- Raw action-result pairs from recent steps
- Kept in full detail — the LLM needs this for continuity
- Window size: ~8-12 steps (tunable)

**Tier 2: Episode Memory (compacted history)**
- LLM-generated summary of completed work segments
- Stored in `context-summary.md`
- Updated every ~15-20 steps or when working memory fills up
- Format: structured sections (files changed, commands run, decisions made, learnings)

**Tier 3: Reference Memory (persistent artifacts)**
- `plan.md` — always shows full plan status
- `files-touched.json` — every file read/written with timestamps
- `commands-run.json` — every shell command with exit code
- `learnings.md` — agent-extracted notes ("this API requires auth", "build needs Node 18")
- These are NEVER compacted, only appended

**Compaction trigger:** When working memory exceeds the char threshold OR at fixed interval (every N steps).

**Compaction process:**
1. LLM summarizes the oldest half of working memory into a structured update
2. Update is appended to `context-summary.md`
3. Working memory is trimmed: old steps removed, summary reference retained
4. File/command tracking remains in JSON (never lost)

### Layer 4: State Lifecycle (Plan-Driven Execution)

The agent manages its own plan via tool calls:

```markdown
# plan.md

## Task: Build a full-stack todo app

### Phase 1: Backend Setup [COMPLETED]
- [x] Create Express server with CRUD routes
- [x] Add in-memory data store
- [x] Verify server starts

### Phase 2: Frontend [IN_PROGRESS]  
- [x] Create index.html skeleton
- [ ] Add vanilla JS fetch logic       ← CURRENT
- [ ] Style with basic CSS

### Phase 3: Integration [BLOCKED_BY: Phase 2]
- [ ] Wire frontend to backend API
- [ ] End-to-end test
```

**State transitions:**
- `PENDING → IN_PROGRESS → COMPLETED → VERIFIED`
- `→ BLOCKED` (waiting for dependency)
- `→ ABANDONED` (agent decides it's not needed)
- Completion cascades down (completing a phase completes all its items)
- Starting cascades up (starting an item starts its phase)

**The agent updates plan.md itself** via `update_plan` tool. The loop reads it every step.

### Layer 5: Anti-Drift & Focus Management

**Adaptive focus reminders** (increase urgency with step count):

| Step Range | Reminder Level |
|-----------|---------------|
| 1-20 | None (agent is fresh) |
| 21-50 | Light: "You're on step X. Current task: ..." |
| 51-100 | Medium: "FOCUS CHECK: You've been working for X steps. Status: ..." + show plan |
| 101+ | Urgent: "DRIFT WARNING: X steps without completing current subtask. Take action NOW or mark blocked." |

**Scope decay detection:**
- Track what percentage of recent tool calls relate to the current subtask
- If <50% of last 5 actions are on-task → inject scope warning
- If agent reads files unrelated to current subtask → flag immediately

**Error loop breaker:**
- Track consecutive failures per tool type
- After 3 same-tool failures → force strategy change message
- After 5 total consecutive failures → pause and require re-planning

**Completion verification (double-check):**
- When agent says "finish" → LLM second opinion check: "Given the task and what was done, is this actually complete?"
- Prevents premature termination from hallucinated success

### Layer 6: Crash Recovery & Resume

**Every step writes before proceeding:**
1. Action is logged to `progress.md` before execution
2. Result is appended after execution
3. `checkpoint.json` is updated with current state

**On restart/resume:**
1. Read `checkpoint.json` — get step number, current phase, working memory window
2. Read `plan.md` — see what's done vs pending
3. Read `context-summary.md` — recover compacted history
4. Read `progress.md` tail — get recent actions for working memory
5. Inject resume context: "You are resuming from step X. Last action was: ..."
6. Continue the loop from the exact point of interruption

**No re-planning, no re-decomposition, no lost work.**

---

## What Makes This Different

| Aspect | LangGraph | Our Approach |
|--------|-----------|-------------|
| State | In-memory graph nodes | Filesystem (markdown + JSON) |
| Recovery | Re-run from checkpoint node | Read files, continue from exact step |
| Context | Full conversation history | Structured assembly from files |
| Scalability | Grows with conversation | Fixed-size context via compaction |
| Human readability | Graph visualization | Read the markdown files directly |
| Debuggability | Trace graph execution | Read progress.md + plan.md |
| Framework dependency | LangGraph/LangChain | None — pure loop |

---

## Implementation Plan

### Phase 1: Core Loop + File State
- `loop.js` — The execution engine
- `context.js` — Context assembly from files
- `state.js` — File-based state read/write  
- `tools.js` — Tool definitions + execution

### Phase 2: Memory & Compaction
- `memory.js` — Working memory window management
- `compaction.js` — LLM summarization of old context
- `tracking.js` — File/command/error tracking in JSON

### Phase 3: Plan Management
- `plan.js` — Plan parsing, status tracking, transition rules
- `update_plan` tool — Agent writes to plan.md
- Focus/anti-drift injection logic

### Phase 4: Resume & Recovery
- `checkpoint.js` — Snapshot + restore
- `resume.js` — Reconstruct state from files
- Crash-safe write ordering

### Phase 5: Hardening & Testing
- Error loop breaking
- Completion verification
- Long-run stress tests (100+ step tasks)
- Context window budget tracking

---

## Open Questions

1. **Compaction quality:** LLM summarization is lossy. How much do we lose at step 200? Need empirical testing.
2. **File state vs message state:** Should the LLM ever see raw conversation messages, or always assembled context?
3. **Plan granularity:** How deep should the plan tree go? One level of subtasks, or arbitrary depth?
4. **Memory search:** Do we need vector search (like OpenDevin's ChromaDB) or is structured markdown + grep enough?
5. **Multi-file coordination:** When modifying many files, how does the agent track which are in a consistent state?
