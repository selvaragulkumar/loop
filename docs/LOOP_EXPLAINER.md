# Advanced Agent Loop — Architecture & Design Deep Dive

> A production-grade autonomous coding agent built on a pure while-loop.
> No LangChain. No graph framework. No dependencies. Just Node.js.

---

## Table of Contents

1. [What It Is](#1-what-it-is)
2. [Inspirations & Sources](#2-inspirations--sources)
3. [High-Level Architecture](#3-high-level-architecture)
4. [The Core Loop — Step by Step](#4-the-core-loop--step-by-step)
5. [Context Assembly — 5 Layers](#5-context-assembly--5-layers)
6. [Memory System](#6-memory-system)
7. [Identity Layer — SOUL, AGENTS, USER, MEMORY](#7-identity-layer--soul-agents-user-memory)
8. [Stage Lifecycle — 6 Phases](#8-stage-lifecycle--6-phases)
9. [JSON Parser — 6 Strategies](#9-json-parser--6-strategies)
10. [Thinking Mode](#10-thinking-mode)
11. [Stall Detection & Recovery Guards](#11-stall-detection--recovery-guards)
12. [Sandbox Verifier — 3-Source Evidence Model](#12-sandbox-verifier--3-source-evidence-model)
13. [Tool System & Dynamic Skills](#13-tool-system--dynamic-skills)
14. [Auto-Scaling Config](#14-auto-scaling-config)
15. [Crash Safety & Checkpointing](#15-crash-safety--checkpointing)
16. [End-to-End Example Walk-Through](#16-end-to-end-example-walk-through)
17. [What We Built With It](#17-what-we-built-with-it)
18. [Design Philosophy & Tradeoffs](#18-design-philosophy--tradeoffs)

---

## 1. What It Is

The **Advanced Agent Loop** is an autonomous LLM agent runtime that executes complex multi-step coding tasks — writing files, running commands, reading output, fixing errors — fully on its own for hundreds of steps without human intervention.

**Key properties:**

| Property | Value |
|----------|-------|
| Language | Node.js (zero npm dependencies) |
| LLM interface | OpenAI-compatible REST (works with vLLM, Ollama, OpenAI, Anthropic, LiteLLM) |
| State model | File-based (everything persists to disk, nothing in RAM only) |
| Max tested steps | 155+ steps on a single task |
| Recovery | Full crash-resume via checkpoint |
| Models tested | MiniMax-REAP, Qwen3-Coder, GPT-OSS-120B, Nemotron |

---

## 2. Inspirations & Sources

Every major feature traces back to published research, open-source systems, or industry practice. None are invented from scratch.

---

### 2.1 Tool Call Format — OpenCode (open-source)

**Source:** [OpenCode by Sst](https://github.com/sst/opencode)
**What we took:** The idea of exposing a small, structured set of tools (read_file, write_file, edit_file, run_command) as JSON actions the model emits. OpenCode pioneered the minimal-tool-surface approach — instead of 30+ tools, expose 4–6 per step based on what's needed.

**Our adaptation:**
- Deterministic router picks tool category each step (no LLM needed to decide which category)
- Tool freezing: after a write, the same tool is forced next step (forces completion before moving on)
- Maximum 4 tools exposed per step to keep the prompt lean

```
OpenCode concept: "give the model exactly the tools it needs right now"
Our implementation: keyword-scored router → category → 4 tools max
```

---

### 2.2 Agent Identity (SOUL) — OpenClaw (open-source)

**Source:** [OpenClaw / SWE-agent identity research](https://github.com/OpenAdaptAI/OpenAdapt)
**What we took:** The concept that an agent needs a persistent self — a description of who it is, how it operates, and what it values — that survives across sessions and memory compression. OpenClaw called this the "SOUL" file.

**Our 4-file identity system:**

| File | Purpose | Survives Compaction? |
|------|---------|----------------------|
| `SOUL.md` | Who the agent is (persona, values, continuity) | ✅ Yes — injected every step |
| `AGENTS.md` | Operating protocol (how to work, error recovery) | ✅ Yes — injected every step |
| `USER.md` | User profile (preferences, context, communication style) | ✅ Yes — in context |
| `MEMORY.md` | Curated long-term knowledge (facts, gotchas, decisions) | ✅ Yes — in context |

**SOUL.md content (example):**
```markdown
I am a methodical, reliable coding agent. I think before acting.
I write things down — markdown files are my memory.
I do not rely on what I remember from previous messages.
I earn trust by completing tasks correctly, not quickly.
```

**Why this matters:** Without identity injection, the agent "forgets" who it is after memory compaction and starts behaving inconsistently. The SOUL makes it stable across 100+ step sessions.

---

### 2.3 Pre-Compaction Memory Flush — OpenClaw

**Source:** OpenClaw memory management patterns
**What we took:** Before compressing old working memory, flush important context to persistent files first. This prevents losing key decisions during the compression step.

**Our implementation:**
```
Pre-compaction flush:
  1. Scan working memory entries from the last window
  2. Identify high-signal entries (milestones, discoveries, errors fixed)
  3. Append to .agent/memory/YYYY-MM-DD.md (append-only, never overwritten)
  4. THEN compress the old entries with LLM
```

Result: Even if the LLM summary loses nuance, the raw milestones are preserved in the daily log. The agent can always re-read them.

---

### 2.4 Sandbox Verifier — OpenAI Codex & SWE-bench

**Source:** [OpenAI Codex evaluation harness](https://github.com/openai/human-eval), [SWE-bench verification methodology](https://www.swebench.com/)
**What we took:** The principle that an agent claiming to be done must be verified by running the actual test suite, not just by the agent saying "I'm done." SWE-bench uses authoritative test files to judge success. OpenAI's Codex eval runs the code.

**Our 3-source evidence model:**
```
Source 1: Workspace diff
  → Which files were actually changed? (SHA256 hash comparison)
  → Hard rule: Zero changes = reject immediately

Source 2: Action log
  → What meaningful actions did the agent take?
  → Hard rule: Only meta-actions (think, loop_guard) = reject

Source 3: Spot checks
  → Run verification commands from task description
  → Run syntax checks on modified files
  → Run any pre-existing test files (non-negotiable — must pass)
  → Hard rule: Authoritative test fails = reject immediately

Final: LLM judge
  → Sees all 3 sources, returns { verified: bool, reason: string }
```

The key insight from SWE-bench: **the agent cannot be trusted to verify itself**. External evidence is required.

---

### 2.5 Thinking Mode — DeepSeek-R1, QwQ, Qwen3

**Source:** [DeepSeek-R1 paper](https://arxiv.org/abs/2501.12948), [QwQ model](https://qwenlm.github.io/blog/qwq-32b/), [Qwen3 technical report](https://qwenlm.github.io/blog/qwen3/)
**What we took:** Modern reasoning models emit a `<think>...</think>` block before their action. This is chain-of-thought reasoning made explicit. Models like QwQ-32B, DeepSeek-R1, and Qwen3 use this heavily.

**Our handling:**

```javascript
// Parser: strip thinking blocks first, then parse action
function parseAction(text) {
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/);
  const thinking = thinkMatch ? thinkMatch[1] : null;

  // Strip <think> block from text before JSON parsing
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  if (!stripped) {
    // Model only output thinking — search INSIDE thinking for JSON
    return parseFromThinkingContent(thinking);
  }

  return parseJSON(stripped);
}
```

**AGENT_NO_THINKING=1 flag:**
For models like Qwen3-Coder, thinking tokens consume massive context. We added an env flag that injects `"enable_thinking": false` into the chat_template_kwargs, disabling thinking tokens entirely. This doubles effective steps per context window.

---

### 2.6 Context Window Auto-Scaling — vLLM & Hugging Face

**Source:** [vLLM OpenAI API](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html)
**What we took:** vLLM exposes `/v1/models` with `max_model_len` metadata. We query this at startup and auto-scale all parameters proportionally.

**Auto-scale formula:**
```javascript
function scaleToContextWindow(maxLen) {
  return {
    maxOutputTokens: Math.min(8192, Math.floor(maxLen * 0.18)),
    workingMemoryWindow: Math.min(50, Math.floor((maxLen * 0.70 - 6500) / 250)),
    compactionThresholdChars: Math.floor((maxLen * 0.70 - 6500) * 0.60 * 4),
    compactionIntervalSteps: Math.min(30, Math.max(7, Math.floor(maxLen / 1600))),
  };
}
```

| Context | Memory Window | Compact Interval | Max Output |
|---------|--------------|-----------------|-----------|
| 12k tokens | 7 steps | every 7 steps | 2,160 tokens |
| 25k tokens | 19 steps | every 10 steps | 4,500 tokens |
| 32k tokens | 20 steps | every 20 steps | 5,760 tokens |
| 128k tokens | 50 steps | every 30 steps | 8,192 tokens |

---

### 2.7 Stage-Based Tool Gating — Claude Code & SWE-agent

**Source:** [SWE-agent framework](https://swe-agent.com/), [Claude Code planning stages](https://docs.anthropic.com/claude/docs)
**What we took:** The idea that an agent should move through phases (understand → plan → implement → verify → finish) and different tools should be available in each phase. This prevents the agent from running tests before implementing, or writing files during the intake scan.

**Our 6-phase system:**
```
intake → discovery → planning → execution → verification → finalization
  5%        10%        10%        55%          10%            10%
  (% of total step budget allocated per phase)
```

**Tool gates per phase:**

| Phase | Available Tools |
|-------|----------------|
| intake | read_file, list_dir, write_file, save_memory |
| discovery | + search_files, glob, run_command |
| planning | + update_plan, todowrite, todoread |
| execution | All tools |
| verification | run_command, read_file, write_file, edit_file, search_files |
| finalization | write_file, edit_file, run_command, finish |

---

### 2.8 File-Based State Machine — Inspired by Make & Unix

**Source:** Unix philosophy (everything is a file), GNU Make (targets + dependencies)
**What we took:** All loop state — checkpoint, plan, memory, context summary, identity — lives in plain files. The loop is stateless between steps; each step rebuilds context from disk.

**Why this is powerful:**
1. **Crash safety:** If the process dies mid-step, resume loads checkpoint and continues
2. **Human-readable:** You can inspect `.agent/checkpoint.json`, edit `plan.md`, and the agent picks up your changes
3. **Debuggable:** Every LLM call is logged to `.agent/llm-log.jsonl`
4. **Introspectable:** Watch `.agent/context-summary.md` grow as the agent works

---

## 3. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           ADVANCED AGENT LOOP                              │
│                                                                            │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────────────────────┐   │
│  │  IDENTITY    │    │   MEMORY     │    │      TASK FILE             │   │
│  │  LAYER       │    │   SYSTEM     │    │  (Markdown spec)           │   │
│  │              │    │              │    │                            │   │
│  │  SOUL.md     │    │ Working Mem  │    │  Requirements              │   │
│  │  AGENTS.md   │    │ (last N)     │    │  Verification cmds         │   │
│  │  USER.md     │    │              │    │  Rules                     │   │
│  │  MEMORY.md   │    │ Daily Logs   │    │                            │   │
│  └──────┬───────┘    │ YYYY-MM-DD   │    └──────────────┬─────────────┘   │
│         │            │              │                   │                  │
│         └────────────┤ Summary.md   ├───────────────────┘                 │
│                      │ (compacted)  │                                      │
│                      └──────┬───────┘                                     │
│                             │                                              │
│  ┌──────────────────────────▼────────────────────────────────────────┐    │
│  │                    CONTEXT ASSEMBLER (5 layers)                    │    │
│  │  Layer 1: Identity  |  Layer 2: Knowledge  |  Layer 3: State      │    │
│  │  Layer 4: Session   |  Layer 5: Guidance                          │    │
│  └──────────────────────────┬────────────────────────────────────────┘    │
│                             │                                              │
│                    ┌────────▼────────┐                                     │
│                    │   LLM CALL      │ ← vLLM / OpenAI / Ollama           │
│                    │  (with retry)   │                                     │
│                    └────────┬────────┘                                     │
│                             │                                              │
│                    ┌────────▼────────┐                                     │
│                    │  JSON PARSER    │ ← 6 fallback strategies             │
│                    │  (6 strategies) │                                     │
│                    └────────┬────────┘                                     │
│                             │                                              │
│                    ┌────────▼────────┐                                     │
│                    │  GUARD SYSTEM   │ ← repeat, thrash, protected,       │
│                    │  (5 guards)     │   premature, stage-misaligned       │
│                    └────────┬────────┘                                     │
│                             │                                              │
│                    ┌────────▼────────┐                                     │
│                    │ TOOL EXECUTOR   │ ← read_file, write_file, edit_file, │
│                    │                 │   run_command, think, finish...     │
│                    └────────┬────────┘                                     │
│                             │                                              │
│           ┌─────────────────┼──────────────────────┐                      │
│           │                 │                      │                       │
│  ┌────────▼──────┐ ┌───────▼────────┐  ┌─────────▼──────────┐            │
│  │ STAGE SYSTEM  │ │  LOOP GUARD /  │  │  CHECKPOINT WRITER │            │
│  │ 6 phases      │ │  STALL DETECT  │  │  (atomic, every    │            │
│  │               │ │                │  │   step)            │            │
│  └───────────────┘ └────────────────┘  └────────────────────┘            │
│                                                                            │
│                    ┌──────────────────┐                                    │
│                    │  SANDBOX VERIFIER│ ← on finish signal                │
│                    │  3-source model  │                                    │
│                    └──────────────────┘                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. The Core Loop — Step by Step

Every step executes this exact sequence in `src/loop.js`:

```
STEP N:
  │
  ├─ 1. COMPACTION CHECK
  │     If memory > threshold OR interval reached:
  │       → pre-flush important context to daily log
  │       → LLM-summarize old entries → context-summary.md
  │       → trim working memory to window
  │       → set postCompaction = true
  │
  ├─ 2. HEARTBEAT
  │     Every 10 steps: save milestone to daily memory log
  │
  ├─ 3. STAGE TICK
  │     Check if current phase should advance
  │     → Verify required artifacts exist
  │     → Verify required commands ran
  │     → Advance if ready, block if not
  │
  ├─ 4. CONTEXT ASSEMBLY
  │     Router: score task keywords → pick tool category
  │     Tool Manager: expose 4 tools from category (stage-filtered)
  │     Builder: assemble 5-layer prompt from files
  │
  ├─ 5. LLM DECISION
  │     Option A: Force inject recovery action (if parseErrorStreak ≥ 3)
  │     Option B: Call LLM → get response → strip <think> → parse JSON
  │
  ├─ 6. GUARD CHECKS (in order)
  │     Guard 1: Repeat guard (same action 3+ times?)
  │     Guard 2: Premature artifact guard (writing success before verified?)
  │     Guard 3: Thrash-block guard (file hard-blocked?)
  │     Guard 4: Protected file guard (authoritative test file?)
  │     Guard 5: Missing artifact guard (required outputs missing?)
  │     → Each guard that fires: block + inject guidance, continue loop
  │
  ├─ 7. TOOL EXECUTION
  │     executeTool(action.tool, action.args)
  │     Log before + after (crash safety)
  │     Track file writes, skill creation
  │
  ├─ 8. MEMORY & STALL DETECTION
  │     Push to working memory
  │     Detect: same-tool loops, write thrash, parse error bursts
  │     Inject guidance if stall detected
  │
  ├─ 9. FINISH CHECK
  │     If tool == finish:
  │       → Stage gate check
  │       → Smoke test gate check
  │       → Completion guard (missing artifacts?)
  │       → Sandbox verify (3-source evidence)
  │       → If verified: EXIT with summary
  │       → If not: block, inject escalation, continue loop
  │
  └─ 10. CHECKPOINT
        Write .agent/checkpoint.json (atomic via tmp + rename)
        Step counter advances
        Loop repeats
```

---

## 5. Context Assembly — 5 Layers

The context prompt is rebuilt fresh from files every step. Nothing is carried over from the previous LLM call.

```
┌─────────────────────────────────────────────────────────┐
│ LAYER 1: IDENTITY                                        │
│  ┌────────────┐ ┌────────────┐                          │
│  │  SOUL.md   │ │ AGENTS.md  │  + recovery prompt       │
│  │ (who I am) │ │ (protocol) │    (if post-compaction)  │
│  └────────────┘ └────────────┘                          │
├─────────────────────────────────────────────────────────┤
│ LAYER 2: KNOWLEDGE                                       │
│  ┌───────────┐ ┌──────────┐ ┌──────────┐               │
│  │  Task.md  │ │ MEMORY.md│ │ Recent   │               │
│  │ (truncated│ │ (curated)│ │ memories │               │
│  │ to 2000ch)│ │          │ │ (daily   │               │
│  └───────────┘ └──────────┘ │  logs)   │               │
│                              └──────────┘               │
├─────────────────────────────────────────────────────────┤
│ LAYER 3: STATE                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────────┐│
│  │ Plan.md  │ │ Progress │ │ Context Summary           ││
│  │ (current │ │ (digest) │ │ (compacted history,       ││
│  │  phase)  │ │          │ │  head + tail, 15% budget) ││
│  └──────────┘ └──────────┘ └──────────────────────────┘│
│  Stage status (current phase, locked targets, repairs)  │
├─────────────────────────────────────────────────────────┤
│ LAYER 4: SESSION (live state)                           │
│  ┌────────────────┐ ┌──────────────────────────────────┐│
│  │ Tool defs      │ │ Working Memory (last N steps)    ││
│  │ (4 tools max)  │ │ • Collapsed duplicates           ││
│  │ + quick ref    │ │ • Truncated large args           ││
│  └────────────────┘ │ • step | action | result         ││
│                      └──────────────────────────────────┘│
│  Stale file alerts (files read before modification)     │
├─────────────────────────────────────────────────────────┤
│ LAYER 5: GUIDANCE                                        │
│  Stage guidance (what to do in this phase)              │
│  Focus prompt (step count, warnings at 50/100/250)      │
│  Runtime guidance (error recovery, stall hints)         │
│  Response format instruction (return JSON, no prose)    │
└─────────────────────────────────────────────────────────┘
```

**Sizing strategy:**

| Component | Budget |
|-----------|--------|
| Identity (SOUL + AGENTS) | ~2,000 chars fixed |
| Task (truncated) | 2,000 chars max |
| MEMORY.md | 1,500 chars |
| Context summary | 15% of context window |
| Plan + stage | 1,000 chars |
| Working memory | (window × ~250 chars/entry) |
| Tool definitions | ~800 chars (4 tools) |
| Guidance | ~500 chars |
| Response format | ~300 chars |

---

## 6. Memory System

Three-tier memory architecture:

```
┌──────────────────────────────────────────────────────────┐
│ TIER 1: WORKING MEMORY (fast, volatile)                  │
│  • Last N steps in RAM + checkpoint                      │
│  • Access: O(1), always in prompt                        │
│  • Retention: current session (until compaction)         │
│  • Content: action, args, result, error per step         │
│  • Deduplication: identical consecutive actions collapse │
├──────────────────────────────────────────────────────────┤
│ TIER 2: COMPRESSED SUMMARY (medium, semi-persistent)     │
│  • .agent/context-summary.md                             │
│  • Written by LLM during compaction                      │
│  • Format: 7 sections (Task Anchor, Files Changed,       │
│    Commands Run, Key Decisions, Current State,           │
│    Learnings, Where I Left Off)                          │
│  • Retention: grows across sessions, bounded to 15%      │
│    of context window (head + tail visible)               │
│  • Fallback: deterministic (no LLM) if compaction fails  │
├──────────────────────────────────────────────────────────┤
│ TIER 3: PERSISTENT LOGS (slow, permanent)                │
│  • .agent/memory/YYYY-MM-DD.md (daily logs, append-only) │
│  • MEMORY.md (curated knowledge, agent-maintained)       │
│  • .agent/memory/learnings.md (extracted insights)       │
│  • Access: grep-based search                             │
│  • Retention: permanent (rotation at 50KB / 200KB)       │
│  • Content: milestones, discoveries, decisions, gotchas  │
└──────────────────────────────────────────────────────────┘
```

**Compaction flow (inspired by OpenClaw):**

```
Compaction triggered (size > threshold OR interval reached)
         │
         ▼
   Pre-flush: save important entries to daily log (.md)
         │
         ▼
   Segment compression: collapse parse_error / loop_guard runs
         │
         ▼
   LLM summarization (temp=0.1, 7-section template)
         │         │
    Success      Failure (network/parse/truncation)
         │         │
         │    Deterministic fallback:
         │    (file diff log + command history + last N entries)
         │         │
         └────┬────┘
              ▼
   Write context-summary.md + verification snapshot
              │
              ▼
   Trim working memory → keep only last N entries
              │
              ▼
   Set postCompaction = true
              │
              ▼
   Next step: inject full identity recovery prompt
```

---

## 7. Identity Layer — SOUL, AGENTS, USER, MEMORY

**Concept source:** OpenClaw (persistent agent persona)
**Purpose:** Give the agent a stable self that survives memory compression.

### SOUL.md — Who the Agent Is

```markdown
I am a methodical, reliable software engineer agent.

My core identity:
- I think carefully before acting
- I write things down — my files ARE my memory
- I do not trust what I think I remember; I re-read
- I earn trust by completing tasks correctly, not quickly

When I make a mistake, I diagnose the root cause.
When I'm stuck, I step back and re-read the plan.
When memory is compressed, I re-read SOUL.md to recover myself.
```

### AGENTS.md — Operating Protocol

```markdown
## Session Startup Ritual
1. Read SOUL.md — remember who I am
2. Read MEMORY.md — recall what I know
3. Read plan.md — recall what I'm doing
4. Read context-summary.md — recall where I left off

## Rule #1: Write It Down
Mental notes do NOT survive compaction.
Every decision → update_plan or save_memory.
Every discovery → save_memory.
Every error fixed → save_memory.

## Every ~10 Steps
Update plan.md with progress.
Save any new learnings.

## When Stuck
Read the error message literally.
Re-read the file that's failing.
Do NOT repeat the same action.
```

### MEMORY.md — Curated Knowledge

Agent-maintained. Updated with `update_memory`. Examples of what accumulates:

```markdown
## Project Facts
- Workspace: /home/.../project
- Language: Python 3.11 + Node.js
- Entry point: src/main.py

## Known Gotchas
- products.js uses '../products.json' (not './') because it lives in js/
- Board uses screen offset +1 row for score line

## Architecture Decisions
- No framework: pure while-loop for stability
- State is file-based for crash safety
```

**Why this matters:** After compaction, the agent that resumes isn't the same call as the one that started. Without persistent identity files, it drifts. With them, it "wakes up" with full context.

---

## 8. Stage Lifecycle — 6 Phases

**Concept source:** SWE-agent (phased tool gating), Claude Code (planning stages)

```
intake ──► discovery ──► planning ──► execution ──► verification ──► finalization
  5%          10%           10%           55%           10%               10%
                                                                           │
                                                                         FINISH
```

### Phase Details

**intake** (5% of steps, ~5 steps)
- Goal: Understand the task and workspace structure
- Tools: read_file, list_dir, write_file, save_memory
- Advance when: Plan exists + workspace scanned

**discovery** (10%, ~10 steps)
- Goal: Map architecture, find relevant files
- Tools: + search_files, glob, run_command
- Advance when: Key files identified, architecture understood

**planning** (10%, ~10 steps)
- Goal: Create detailed implementation plan
- Tools: + update_plan, todowrite, todoread
- Advance when: Plan has execution phases, subtasks defined

**execution** (55%, ~55 steps)
- Goal: Implement everything
- Tools: All tools available
- Advance when: Required output files created + verification commands ran

**verification** (10%, ~10 steps)
- Goal: All tests pass
- Tools: run_command, read_file, write_file, edit_file, search_files
- Special: **repair mode** — if a required command fails, tools narrow to repair-only until it passes
- Advance when: All verification commands pass

**finalization** (10%, ~10 steps)
- Goal: Polish, summarize, finish
- Tools: write_file, edit_file, run_command, finish
- Only phase where `finish` action is accepted

### Fast-Track Conditions

A common failure mode: fast models write code while still in `planning` phase, then try to call `finish` which is blocked. We added fast-track conditions:

```javascript
// If implementation already started and significant code exists → skip to execution
if (implementationStarted && executionContractText.length > 100) return true;
// If verification already complete → skip to finalization
if (runtime.verificationComplete) return true;
```

---

## 9. JSON Parser — 6 Strategies

Every LLM response goes through `parseAction()` which tries 6 strategies in order:

```
Input: raw LLM response text
            │
            ▼
  1. Strip <think>...</think> blocks
            │
            ▼
  2. If empty after strip → search INSIDE thinking for JSON
            │
            ▼
  3. Direct JSON.parse()   ← succeeds for well-formed responses
            │ (fail)
            ▼
  4. Conservative repair: close unclosed } and ] only
     (never invent string content — prevents garbling)
            │ (fail)
            ▼
  5. Extract JSON objects from prose
     (model wrapped JSON in explanation text)
            │ (fail)
            ▼
  6. Unwrap markdown fences: ```json ... ```
     (model used code block format)
            │ (fail)
            ▼
  7. MiniMax XML format: <tool name="x" path="y"/>
            │ (fail)
            ▼
  Classify failure:
    PROSE_ONLY_RESPONSE    → no JSON found
    TRUNCATED_STRING       → ends mid-string (output cut off)
    FENCED_JSON_INVALID    → JSON in fence but malformed
    MULTIPLE_JSON_OBJECTS  → more than one JSON object
    NO_JSON_FOUND          → nothing found
    SCHEMA_INVALID         → JSON but missing "tool" field
```

**Why this order matters (our bug fix from March 2026):**

> *Root cause of bug:* We originally ran the code-block regex BEFORE `JSON.parse`. When the model wrote files containing triple-backtick fences (e.g., a README with ```bash blocks), the regex matched those backticks inside the JSON string value and extracted garbage. Fix: always `JSON.parse` first. Only attempt code-block extraction if the text begins with a backtick.

**Parse error recovery:**
- 1–2 errors: inject guidance ("return exactly one JSON object")
- 3 errors: force-inject a `think` action (breaks the burst, doesn't crash)
- 8+ errors: hard exit

---

## 10. Thinking Mode

**Source:** DeepSeek-R1, QwQ-32B, Qwen3 chain-of-thought reasoning
**What it is:** Some models emit a `<think>` block containing step-by-step reasoning before the final action. This is visible chain-of-thought.

```
Model output:
<think>
The error says "FileNotFoundError: products.json" in js/products.js.
That file lives in js/ so it should use '../products.json' not './products.json'.
I need to edit js/products.js line 4 to fix the path.
</think>
{"tool": "edit_file", "args": {"path": "js/products.js", "oldString": "./products.json", "newString": "../products.json"}}
```

**Our handling:**
1. Parser strips `<think>` block (doesn't go into context)
2. Captured separately as `thinking` for debugging
3. If response is ONLY thinking (no action after it), search inside thinking for JSON
4. If nothing found inside thinking, synthesize `think` action as fallback

**AGENT_NO_THINKING=1:**
Injects `"chat_template_kwargs": {"enable_thinking": false}` into the vLLM request. Disables thinking tokens entirely. Required for Qwen3-Coder to avoid blowing through the context window on every step.

---

## 11. Stall Detection & Recovery Guards

The loop has 5 hard guards + multi-level loop detection:

### Guard System (`src/guards.js`)

**Guard 1 — Repeat Guard**
```
Same tool + same args 3+ consecutive times → BLOCKED
Agent is told: "Change your approach"
Hard stop at 4 identical steps
```

**Guard 2 — Premature Artifact Guard**
```
In verification/finalization:
  Writing to a required output before all tests pass → BLOCKED
Agent must fix failing tests before claiming success
```

**Guard 3 — Thrash-Block Guard**
```
A file written 5+ times in one compaction window:
  → Identify CALLER (which file is triggering the writes)
  → Hard-block the thrashed file for 3 steps
  → Force agent to fix the caller instead
```

**Guard 4 — Protected File Guard**
```
Pre-existing test files in workspace:
  _smoke_test.py, _render_check.py, etc.
  → These cannot be overwritten by the agent
  → Agent must fix source code to make tests pass
```

**Guard 5 — Missing Artifact Guard**
```
Required output files not yet created:
  → Block writes to unrelated files
  → Force focus on deliverables
```

### Loop Detection (`detectLoopGuard()`)

| Pattern | Steps | Action |
|---------|-------|--------|
| Same-tool + same-args | 3+ | Inject guidance |
| Same-tool + same-args | 4+ | Hard stop |
| Similar args (same file edit) | 5+ | Inject guidance |
| Read-only repeats same result | 4+ | Guidance + suggest verify |
| Parse errors burst | ≥3 | Force-think injection |
| File write churn (same file) | ≥3 in 16 steps | Guidance |
| Baseline reset | 2+ times | Don't restart phase 1 |

### Write-Thrash Redirect (Advanced)

When the agent loops on rewriting the same file:
1. Extract the caller from the Python/Node traceback in the last error
2. Hard-block the thrashed file for 3 steps
3. Inject guidance naming the actual caller that needs fixing
4. Agent is forced to look at the root cause, not the symptom

---

## 12. Sandbox Verifier — 3-Source Evidence Model

**Concept source:** SWE-bench evaluation methodology, OpenAI Codex eval harness

The agent cannot be trusted to verify itself. External evidence is required before accepting a `finish` signal.

### Source 1: Workspace Diff

```javascript
// Snapshot on start: SHA256 hash of every file
const snapshot = hashWorkspace(workspace);

// On finish: compare against snapshot
const diff = compareWorkspace(workspace, snapshot);
// diff = { added: [...], modified: [...], deleted: [...] }

// Hard rule: zero changes = reject immediately
if (diff.added.length === 0 && diff.modified.length === 0) {
  return { verified: false, reason: "No workspace changes detected" };
}
```

### Source 2: Action Log

```javascript
// Review working memory
const meaningfulActions = memory.filter(e =>
  !['parse_error', 'loop_guard', 'think'].includes(e.action)
);

// Hard rule: only meta-actions = reject
if (meaningfulActions.length === 0) {
  return { verified: false, reason: "No meaningful actions in session" };
}
```

### Source 3: Spot Checks

```javascript
// Extract verification commands from task markdown
// (```bash blocks under ## Verification heading)
const cmds = extractVerificationCommands(taskText);

for (const cmd of cmds) {
  const result = await runCommand(cmd, workspace, { timeout: 30000 });

  // Hard rule: authoritative test file fails = reject immediately
  if (isAuthoritativeTest(cmd) && result.exitCode !== 0) {
    return { verified: false, reason: `Test failed: ${cmd}` };
  }
}

// Syntax check: parse all modified JS/Python files
for (const file of diff.modified) {
  if (hasSyntaxError(file)) {
    return { verified: false, reason: `Syntax error in ${file}` };
  }
}
```

### LLM Judge

After hard rules pass, send all evidence to an LLM judge:

```
Evidence package:
  - Files added/modified/deleted (workspace diff)
  - Meaningful actions executed (action log)
  - Verification command results (pass/fail + output snippets)

Prompt: "Did the agent complete the task?
         Return { verified: true/false, reason: '...' }"
```

If not verified: increment `verificationFailures`, clear command dedup (allow re-running the same commands), continue loop with escalation.

---

## 13. Tool System & Dynamic Skills

**Tool source:** OpenCode (minimal tool surface design)

### Tool Categories & Routing

The **router** (`src/routing/router.js`) is 100% deterministic — no LLM, no async:

```javascript
// Score task text + last action against categories
const scores = {
  filesystem: scoreKeywords(text, ['file', 'read', 'write', 'edit', 'create']),
  execution:  scoreKeywords(text, ['run', 'test', 'command', 'execute', 'install']),
  planning:   scoreKeywords(text, ['plan', 'todo', 'task', 'phase', 'next']),
  memory:     scoreKeywords(text, ['remember', 'learn', 'save', 'memory']),
  identity:   scoreKeywords(text, ['soul', 'identity', 'profile']),
  skills:     scoreKeywords(text, ['skill', 'create', 'reusable']),
};
// Return highest-scoring category
```

**Tool Freeze mechanism:**
- After writing a file, the same `write_file` tool is forced next step
- Prevents the agent from switching to a different file before finishing the current one
- Disabled if the action errored

### Core Tools

| Category | Tools |
|----------|-------|
| Filesystem | read_file, write_file, edit_file, list_dir, search_files, glob, patch |
| Execution | run_command, webfetch, websearch, lsp |
| Planning | think, update_plan, todowrite, todoread, add_learning, finish |
| Memory | save_memory, search_memory, update_memory |
| Identity | update_identity |
| Skills | create_skill |

### Dynamic Skills System

The agent can create its own reusable tools at runtime:

```markdown
# Skill: validate_json_schema

## Description
Validates a JSON file against a required schema

## Parameters
- filePath: string — path to JSON file
- requiredKeys: array — keys that must exist in every item

## Implementation
```javascript
return async ({ filePath, requiredKeys }) => {
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  for (const item of data) {
    for (const key of requiredKeys) {
      if (!(key in item)) throw new Error(`Missing key: ${key} in item ${item.id}`);
    }
  }
  return `Validated ${data.length} items ✓`;
};
```
```

Skills are:
- Stored in `.agent/skills/` as markdown files
- Parsed and loaded into the tool registry on creation
- Executed in a minimal VM sandbox
- Available to the agent immediately without restart

---

## 14. Auto-Scaling Config

**Source:** vLLM `/v1/models` API

At startup, `src/cli.js` auto-detects the model's context window and scales every parameter:

```javascript
// Step 1: Query vLLM for max_model_len
const models = await fetch(`${OPENAI_BASE_URL}/v1/models`).then(r => r.json());
const maxLen = models.data[0].max_model_len;

// Step 2: Scale all parameters proportionally
const config = scaleToContextWindow(maxLen);
```

**Model profiles (13 pre-tuned):**

| Model | Context | Temp | Notes |
|-------|---------|------|-------|
| Qwen3-Coder-30B | 32k | 0.5 | noThinking=true |
| Qwen3-8B | 32k | 0.6 | noThinking=true |
| MiniMax-M2.1-REAP | 18k | 0.3 | XML tool format |
| GPT-OSS-120B | 32k | 0.4 | Strong reasoning |
| Nemotron-30B | 32k | 0.4 | Code-focused |
| Claude (API) | 200k | 0.5 | Official API |

**Env var compatibility:**
- `AGENT_*` vars take precedence
- `OPENAI_*` vars accepted as aliases (compatible with OpenAI client libraries)

---

## 15. Crash Safety & Checkpointing

Every step ends with an atomic checkpoint write:

```javascript
// Write to temp file first (never corrupt the real checkpoint)
fs.writeFileSync(checkpointPath + '.tmp', JSON.stringify(state, null, 2));
// Atomic rename (POSIX atomic on Linux)
fs.renameSync(checkpointPath + '.tmp', checkpointPath);
```

**Checkpoint contains:**

```json
{
  "step": 42,
  "consecutiveErrors": 0,
  "parseErrorStreak": 0,
  "compactionCount": 3,
  "memoriesFlushed": 28,
  "fileWriteCounters": { "src/game.py": 2 },
  "thrashBlock": null,
  "stageState": { "currentStage": "execution", ... },
  "workingMemory": [ ... last N entries ... ],
  "verificationFailures": 0,
  "savedAt": "2026-03-24T14:30:00.000Z"
}
```

**Resume flow:**

```bash
# Process crashes at step 67
# Server restarts at step 68 with:
node src/cli.js --workspace ./my-project --task-file task.md --resume
#                                                                ↑
#                              Loads checkpoint, continues from step 68
```

The resume is seamless — same step, same memory, same guards, same stage.

---

## 16. End-to-End Example Walk-Through

**Task:** Fix a Python project — wrong layout, broken game loop, broken input handling.

```
Step 1:  [read_file] task.md → understand requirements
Step 2:  [write_file] data.json → create initial data
Step 3:  [run_command] python3 -c "import json..." → data validates ✓
Step 4:  [write_file] project/layout.py → write layout module
Step 5:  [run_command] python3 -c "from project.layout..." → layout OK ✓
...
Step 15: [write_file] project/game.py → write tick() + handle_input()
Step 16: [run_command] python3 -c "from project.game..." → handle_input OK ✓
Step 17: [write_file] project/main.py → write main loop
...
Step 25: [run_command] python3 _smoke_test.py → SMOKE OK ✓
Step 26: [finish] "Fixed all 3 files, all tests pass"
         → Sandbox verify:
            Source 1: layout.py + game.py + main.py modified ✓
            Source 2: 26 meaningful actions ✓
            Source 3: python3 -c "from project.layout..." passes ✓
                      python3 _smoke_test.py passes ✓
            LLM judge: verified=true ✓
         → EXIT: completed
```

**What happened internally at step 15 (write game.py):**

```
Context assembled:
  SOUL.md: "I am methodical, write things down"
  Task: "Fix game.py — handle_input broken, tick() missing"
  Memory: "layout.py fixed at step 4."
  Stage: execution (45% through)
  Working memory: last 14 steps
  Tools exposed: [write_file, edit_file, read_file, run_command]

LLM decision:
  <think>
  I need to write game.py. handle_input should accept 'up'/'down'/'left'/'right'
  strings because main.py calls game.handle_input('up'). The tick() should move
  the player using _pending_direction, update state, and check win/lose conditions.
  </think>
  {"tool":"write_file","args":{"path":"project/game.py","content":"..."}}

Guards: All pass (new file, not protected, not repeated)
Execute: write_file → File written: project/game.py (2290 chars)
Memory: push {step:15, action:write_file, result:"File written..."}
Checkpoint: saved
```

---

## 17. What We Built With It

The loop has been validated through multiple complete projects (games, web apps) implemented entirely autonomously. Key observations from real runs:

- Sessions routinely exceed 80-155 steps without manual intervention
- The compaction system keeps context manageable even at 150+ steps (e.g. 15 compactions in a 155-step session)
- Parse errors are rare (~5 per long session) and all self-recover via the classification + guidance pipeline
- Anti-stall guards catch real bugs (e.g. infinite loops, wrong argument types, repeated file writes)
- The sandbox verifier catches incomplete work before the loop exits

### Key Stats Across Sessions

| Metric | Value |
|--------|-------|
| Longest session | 155+ steps |
| Typical compactions (long run) | 15 |
| Parse errors (long run) | ~5 (all recovered) |
| Stall recoveries | Multiple per session |
| Exit code | 0 (clean completion) |

---

## 18. Design Philosophy & Tradeoffs

### Why No Framework (LangChain, LlamaIndex, CrewAI)?

```
Frameworks add:
  ✗ Version upgrade risk (breaking changes)
  ✗ Graph/DAG execution overhead
  ✗ Opaque state management
  ✗ npm dependency surface (vulnerabilities)
  ✗ Implicit state that can diverge from files

Pure loop adds:
  ✓ Zero dependencies (only Node.js stdlib)
  ✓ Every step is a predictable while-loop iteration
  ✓ Full control over context, guards, recovery
  ✓ Debuggable: every step logged
  ✓ Resumable: checkpoint is single source of truth
```

### Why File-Based State?

```
File-based:
  ✓ Crash safe (atomic writes)
  ✓ Human readable (inspect & edit mid-session)
  ✓ Stateless steps (rebuild context from disk every time)
  ✓ True persistence (survives process restarts)

In-memory:
  ✗ Lost on crash
  ✗ Can diverge from actual disk state
  ✗ Not human-inspectable without debugger
```

### Why Synchronous Tools?

```
Synchronous:
  ✓ Simple, no callback hell
  ✓ Deterministic step ordering
  ✓ No partial-execution bugs
  ✓ Easy to test

Async:
  ✓ Could parallelize tools
  ✗ Complexity: partial states, race conditions
  ✗ Context assembly becomes harder if tools overlap
```

### The Core Stability Insight

> **The loop is stable because every step is independent.** No implicit state flows from step N to step N+1. Everything the agent "knows" about step N is written to disk before step N+1 starts. If a step crashes, the next step starts from the last checkpoint with no knowledge of what was happening in memory.

This is the same principle as **stateless HTTP** — each request carries all its context. It's why the loop can run for 155 steps with 15 compactions and still work correctly.

---

## Appendix: File Structure

```
/Advanced-agent-loop/
├── src/
│   ├── cli.js              Entry point, auto-scale config, launch loop
│   ├── loop.js             Core loop (~1200 lines)
│   ├── context.js          5-layer context assembler
│   ├── memory.js           Working memory (last N steps)
│   ├── memory-store.js     Persistent memory (daily logs, MEMORY.md)
│   ├── compaction.js       LLM/deterministic summarization
│   ├── stages.js           6-phase lifecycle (~800 lines)
│   ├── guards.js           5 guards + loop detection
│   ├── parser.js           JSON parser (6 strategies)
│   ├── recovery.js         Error classification + guidance injection
│   ├── config.js           Auto-scaling, model profiles, env vars
│   ├── llm.js              OpenAI-compatible client with retry
│   ├── state.js            File freshness tracking, checkpoint R/W
│   ├── plan.js             plan.md parser
│   ├── identity.js         SOUL/AGENTS/USER/MEMORY bootstrap
│   ├── sandbox-verifier.js 3-source evidence verifier
│   └── tools/
│       ├── index.js        Tool dispatcher
│       ├── filesystem/     read_file, write_file, edit_file, ...
│       ├── execution/      run_command, webfetch, lsp
│       └── planning/       think, update_plan, finish, ...
│
└── LOOP_EXPLAINER.md       ← This file
```

---

## Appendix: Running the Loop

```bash
# Basic run
OPENAI_BASE_URL="http://localhost:8000/v1" \
OPENAI_MODEL="Qwen/Qwen3-Coder-Next-FP8" \
AGENT_API_KEY="placeholder" \
AGENT_NO_THINKING=1 \
node src/cli.js \
  --workspace /path/to/project \
  --task-file /path/to/task.md

# Resume after crash
node src/cli.js \
  --workspace /path/to/project \
  --task-file /path/to/task.md \
  --resume

# Disable stages (simpler, fewer constraints)
AGENT_DISABLE_STAGES=1 node src/cli.js ...

# Force specific context window
AGENT_CONTEXT_WINDOW=32000 node src/cli.js ...
```

---

*Document prepared for: Internal Architecture Review Meeting*
*Date: March 2026*
*Based on: Working codebase at `/path/to/Advanced-agent-loop`*
