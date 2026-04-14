# How the Agent Loop Works — Step by Step

This document walks you through exactly what happens from the moment you run the agent to when it finishes a task. Read this if you want to understand the internals.

---

## The Loop in One Picture

```
  You run:  node src/cli.js --workspace ./project --task "Build a todo app"
                |
                v
  +----- STARTUP (cli.js) -----+
  |  1. Read env vars           |
  |  2. Auto-detect model       |
  |  3. Scale parameters        |
  |  4. Create .agent/ folder   |
  |  5. Bootstrap identity      |
  +-----------------------------+
                |
                v
  +------ MAIN LOOP (loop.js) --------+
  |                                    |    Repeats every step
  |  1. Check stage + compaction       |
  |  2. Pick tools for this step       |
  |  3. Build the prompt (5 layers)    |
  |  4. Call the LLM                   |
  |  5. Parse the JSON response        |
  |  6. Run anti-stall guards          |
  |  7. Execute the tool               |
  |  8. Save to working memory         |
  |  9. Write checkpoint to disk       |
  |                                    |
  +------------------------------------+
                |
                v
  Agent calls "finish" --> Sandbox verifier checks work --> Done
```

---

## Phase 1: Startup

**File:** `src/cli.js`

When you run the agent, this is what happens before the loop starts:

### 1. Read your configuration

The agent reads three required environment variables:

| Variable | Where it comes from |
|----------|-------------------|
| `OPENAI_BASE_URL` | Env var or `.env` file |
| `OPENAI_MODEL` | Env var or `.env` file |
| `AGENT_API_KEY` | Env var or `.env` file |

It also accepts `AGENT_BASE_URL` and `AGENT_MODEL` as aliases.

### 2. Auto-detect the model's capabilities

The agent calls your LLM server's `/v1/models` endpoint and reads `max_model_len` — the model's maximum context window. From this single number, it automatically calculates:

| Parameter | How it's scaled | Example (32k model) |
|-----------|----------------|-------------------|
| Context window | Directly from server | 32,000 tokens |
| Max output tokens | Proportional, capped at 8192 | 4,096 tokens |
| Working memory window | 7-50 steps | 20 steps |
| Compaction threshold | Proportional to context | 20,000 chars |
| Compaction interval | 7-30 steps | 15 steps |

**You don't need to set any of these.** They're calculated for you. Override any of them with env vars if needed.

### 3. Match a model profile

If your model ID contains a known string (like `qwen3`, `claude`, `gpt-4o`), the agent loads tuned defaults for temperature and output limits. See the README for the full profile table.

### 4. Create the `.agent/` directory

Inside your workspace, the agent creates:

```
your-project/.agent/
  checkpoint.json       (empty — will be populated after step 1)
  task.md               (your task, saved for reference)
  plan.md               (empty — agent will fill this during planning)
  progress.md           (will log every step)
  memory/               (daily logs, file tracking, command history)
```

### 5. Bootstrap the identity layer

The agent checks for 4 markdown files in your workspace: `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`. If they don't exist, it creates them with sensible defaults from `src/identity.js`.

These files tell the agent who it is, how to operate, and what it knows. You can edit them to customize behavior.

---

## Phase 2: The Main Loop

**File:** `src/loop.js`

This is the heart of the system. Each iteration of the loop is one "step". Here's what happens in each step:

### Step 1: Check stage and compaction

**Stages** (`src/stages.js`): The agent tracks which phase of work it's in:

```
intake --> discovery --> planning --> execution --> verification --> finalization
```

Each stage limits which tools the agent can use and defines what must happen before it can move to the next stage. For example:
- In **discovery**, the agent can read and search files but can't write code yet
- In **execution**, all tools are available
- In **verification**, the agent runs tests and validates its work

Stage transitions happen automatically when conditions are met.

**Compaction** (`src/compaction.js`): If working memory has grown too large (past the threshold), the oldest entries are compressed into a summary using the LLM. The summary is appended to `.agent/context-summary.md`. This is how the agent "remembers" work from 100 steps ago without using 100 steps of context.

If the LLM is unavailable for compaction, a deterministic fallback extracts key actions and results.

### Step 2: Pick tools for this step

**Routing** (`src/routing/`): The router decides which category of tools to offer based on:
- Keywords in the task
- What the agent just did
- What stage it's in

It picks a category (filesystem, execution, planning, memory, etc.) and exposes up to **4 tools** to the LLM. This keeps the prompt small and focused — especially important for smaller models.

**Freeze mechanism:** After using a tool, the next step only shows `[that tool, finish]`. This keeps the model focused before the router opens back up.

### Step 3: Build the prompt

**Context assembly** (`src/context.js`): The prompt is built from files, not chat history. Five layers are assembled:

| Layer | What goes in | Why |
|-------|-------------|-----|
| **Identity** | `SOUL.md` + `AGENTS.md` | Tells the agent who it is and how to operate |
| **Knowledge** | Task description, `MEMORY.md`, learnings | What the agent needs to know |
| **State** | Current plan, context summary, focus chain, stage info | Where the agent is in its work |
| **Session** | Working memory (last N tool calls and results) | What just happened |
| **Guidance** | Error feedback, stage hints, stall warnings | What to do next |

**This is the key design decision.** The LLM has no memory between calls. Everything it needs is in this prompt. Step 5 and step 500 get the same-sized prompt — only the compacted summary grows denser.

### Step 4: Call the LLM

**LLM client** (`src/llm.js`): A standard POST to `/v1/chat/completions`:

```json
{ "model": "...", "messages": [...], "temperature": 0.2, "max_tokens": 4096 }
```

If the request fails (network error, 429 rate limit, 5xx server error), it retries with exponential backoff: 2s, then 4s, up to 3 attempts. Rate-limited requests get more retries (up to 8).

### Step 5: Parse the response

**Parser** (`src/parser.js`): The LLM should return JSON like:

```json
{"thought": "I need to read the config file", "tool": "read_file", "args": {"path": "config.js"}}
```

But models don't always return clean JSON. The parser tries 6 strategies in order:

1. **Direct `JSON.parse`** — works for clean responses
2. **Repair** — closes missing `}` or `]` at the end (for truncated output)
3. **Extract from text** — scans for `{...}` objects embedded in prose
4. **Unwrap fences** — strips ` ```json ` wrappers
5. **XML format** — parses `<tool_call>` format (some models use this)
6. **Classify the failure** — tells the model exactly what went wrong

If parsing fails, the error type is sent back to the model on the next step so it can correct itself.

### Step 6: Anti-stall guards

**Guards** (`src/guards.js`): Before executing the tool, several safety checks run:

| Guard | What it catches | What happens |
|-------|----------------|--------------|
| **Think guard** | Two `think` calls in a row | Blocks the second, forces action |
| **Loop detection** | Same tool + same args 3+ times | Intervention message sent to model |
| **Parse error streak** | 3+ failed parses in a row | Forces a `think` action with recovery hints |
| **Error cap** | 8+ consecutive errors | Terminates the loop |
| **Stage mismatch** | Action wrong for current phase | Blocks with stage-specific feedback |
| **Stage safety valve** | 4+ consecutive stage blocks | Resets to execution phase |

### Step 7: Execute the tool

The agent runs the tool (read a file, write code, run a command, etc.). Every tool handler is wrapped in try/catch — errors are returned as strings, never crash the loop.

Tool aliases are resolved first (`bash` -> `run_command`, `ls` -> `list_dir`).

### Step 8: Save to working memory

The step (tool name, args, result) is pushed to the working memory array. Args are truncated to prevent checkpoint bloat. Long results show head+tail (first 400 + last 400 chars).

### Step 9: Checkpoint

Everything is written to `.agent/checkpoint.json`:

```json
{
  "step": 42,
  "workingMemory": [...],
  "consecutiveErrors": 0,
  "compactionCount": 2,
  "stageState": { "currentStage": "execution" }
}
```

If anything crashes after this point, `--resume` picks up at step 43.

---

## Phase 3: Finishing

When the agent decides it's done, it calls the `finish` tool. But it doesn't just exit — the **sandbox verifier** (`src/sandbox-verifier.js`) runs first.

### Verification Flow

```
Agent calls finish
     |
     v
1. Snapshot the workspace (SHA256 hash of every file)
     |
     v
2. Check: did anything actually change?
   - No changes + no meaningful actions --> FAIL (send back to work)
     |
     v
3. Run verification commands from the task (if any)
   - Any command fails --> FAIL
   - All pass --> PASS
     |
     v
4. Run spot-checks on changed files
   - node --check for JS files
   - python3 -m py_compile for Python files
   - Run any existing test files
     |
     v
5. LLM judge reviews: diff + action log + spot-check results
   - Returns {"verified": true/false}
     |
     v
6. If verified: loop exits, task complete
   If not verified: error message sent back, agent keeps working
```

This prevents the agent from claiming it's done when it hasn't actually completed the task.

Set `AGENT_REQUIRE_SMOKE_TEST=false` to skip verification for non-code tasks.

See [SANDBOX.md](SANDBOX.md) for the full implementation details.

---

## Key Files Reference

| File | Purpose | When to look at it |
|------|---------|-------------------|
| `src/cli.js` | Entry point, arg parsing, auto-detect | Understanding startup |
| `src/loop.js` | Main loop, orchestrates everything | Understanding the core flow |
| `src/context.js` | Builds the 5-layer prompt | Customizing what the LLM sees |
| `src/config.js` | All settings and model profiles | Tuning behavior |
| `src/stages.js` | 6-phase lifecycle, tool gates | Modifying the stage system |
| `src/parser.js` | JSON parsing with repair | Debugging parse issues |
| `src/guards.js` | Anti-stall detection | Understanding interventions |
| `src/compaction.js` | Memory compression | Tuning long-run performance |
| `src/sandbox-verifier.js` | Task verification | Understanding finish behavior |
| `src/routing/toolRegistry.js` | Tool definitions | Adding new tools |
| `src/routing/router.js` | Tool selection logic | Changing routing behavior |

---

## Running the Agent

```bash
# Inline task
OPENAI_BASE_URL="http://your-server/v1" \
OPENAI_MODEL="your-model" \
AGENT_API_KEY="your-key" \
node src/cli.js --workspace ./project --task "Fix the failing tests"

# Task from a file
node src/cli.js --workspace ./project --task-file task.md

# Resume after crash
node src/cli.js --workspace ./project --resume

# Dry run (preview config, don't execute)
node src/cli.js --workspace ./project --task "..." --dry-run
```

## Running Tests

```bash
# Full suite (190+ tests, no API key needed)
npm test

# Parser tests only (57 tests)
node --test tests/parseAction.test.js
```

---

## Design Principles

1. **Rebuild from files, not memory** — the LLM never holds state between calls. Every step gets a fresh prompt built from disk.

2. **Fail safely** — tool errors are returned as strings, never crash the loop. The agent gets feedback and adapts.

3. **Persist everything** — checkpoint after every step. `--resume` recovers from any crash instantly.

4. **Focus the model** — route to 4 tools max per step. Small models work better with fewer choices.

5. **Verify before finishing** — the sandbox verifier prevents premature completion.

6. **No framework** — just a while-loop, file I/O, and fetch. The simplest thing that works for the longest time.
