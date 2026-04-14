# Advanced Agent Loop

An autonomous coding agent that takes a task, works through it step by step, and delivers the result. It reads files, writes code, runs commands, and verifies its own work — all without human intervention.

No LangChain. No LlamaIndex. No framework. Just a while-loop, file I/O, and `fetch`.

**Works with any OpenAI-compatible LLM** — vLLM, Ollama, OpenAI, LiteLLM, or any server that speaks the `/v1/chat/completions` API.

---

## What Does It Actually Do?

You give it a task like _"Build a REST API with Express"_ or _"Fix the failing tests in this project"_. The agent then:

1. **Reads** your codebase to understand the project
2. **Plans** what needs to be done
3. **Writes code**, creates files, runs shell commands
4. **Tests** its own work (compiles, runs tests, validates)
5. **Finishes** only after verification passes

Each step is saved to disk. If the server crashes, run `--resume` and it picks up exactly where it left off.

---

## Quick Start

### Prerequisites

- **Node.js 18+** (that's it — zero npm dependencies)
- **An LLM server** running an OpenAI-compatible API (vLLM, Ollama, OpenAI, etc.)

### 1. Clone

```bash
git clone <repo-url>
cd Advanced-agent-loop
```

### 2. Configure

Set three environment variables (or copy `.env.example` to `.env`):

```bash
export OPENAI_BASE_URL="http://your-llm-server:8000/v1"   # Your LLM endpoint
export OPENAI_MODEL="your-model-id"                         # Model name on that server
export AGENT_API_KEY="your-key"                             # API key (leave empty if none needed)
```

### 3. Run

```bash
# Give it a task directly
node src/cli.js --workspace ./my-project --task "Build a REST API with Express"

# Or point to a task file
node src/cli.js --workspace ./my-project --task-file instructions.md

# Resume after a crash or server restart
node src/cli.js --workspace ./my-project --resume

# Preview config without running (dry run)
node src/cli.js --workspace ./my-project --task "..." --dry-run
```

The `--workspace` flag tells the agent which directory to work in. All agent state (plan, progress, memory) goes into a `.agent/` folder inside that workspace — it's gitignored and won't touch your code.

**That's it.** The agent auto-detects the model's context window from the server and scales all internal parameters (memory size, compaction thresholds, output limits) accordingly. No source file editing needed.

---

## How It Works (The Big Picture)

```
You give a task
     |
     v
 +-----------------------+
 |      AGENT LOOP       |   Repeats until task is done
 |                       |
 |  1. Build prompt      |   Assembled from files, not chat history
 |  2. Call LLM          |   LLM returns: {"tool": "write_file", "args": {...}}
 |  3. Execute tool      |   Agent runs the tool (read, write, shell, etc.)
 |  4. Record result     |   Saved to working memory
 |  5. Save checkpoint   |   Crash-safe — resume anytime
 |                       |
 +-----------------------+
     |
     v
 Task complete (verified)
```

### Key Concept: File-Based Context, Not Chat History

Most agent frameworks keep a growing conversation. This one doesn't. Every step, the prompt is **rebuilt from files on disk**:

- `SOUL.md` — who the agent is and its rules
- `plan.md` — what it's working on right now
- `context-summary.md` — compressed history of past work
- Working memory — just the last N steps

This means step 5 and step 500 get the same-sized prompt. The agent never runs out of context. Old work is compressed (compacted) into a summary, not lost.

### The 6-Phase Lifecycle

The agent doesn't just start coding randomly. It moves through phases:

```
intake --> discovery --> planning --> execution --> verification --> finalization
```

| Phase | What happens | Tools available |
|-------|-------------|-----------------|
| **Intake** | Reads the task, understands requirements | read_file, list_dir |
| **Discovery** | Explores the codebase, finds relevant files | read_file, search_files, glob |
| **Planning** | Creates a step-by-step plan | update_plan, think |
| **Execution** | Writes code, runs commands, builds things | All tools |
| **Verification** | Tests its work, runs smoke tests | run_command, read_file |
| **Finalization** | Calls `finish`, sandbox verifier checks work | finish |

Each phase limits which tools the agent can use. This prevents it from coding before it has a plan, or finishing before it has tested.

### Anti-Stall Guards

The agent has 42 built-in mechanisms to prevent it from getting stuck:

- **Loop detection** — if it repeats the same action 3+ times, it intervenes
- **Parse error recovery** — if the LLM outputs bad JSON, it gets targeted feedback
- **Error cap** — 8+ consecutive errors and the agent stops (doesn't burn tokens forever)
- **Think guard** — blocks two consecutive `think` calls (forces action)
- **Stage safety valve** — if stuck in wrong phase, auto-corrects

### Crash Recovery

After every step, the agent writes a checkpoint to `.agent/checkpoint.json`. If the LLM server goes down or your machine restarts:

```bash
node src/cli.js --workspace ./my-project --resume
```

It picks up at the exact step it left off. No re-planning, no lost work.

---

## Configuration Reference

### Required (3 variables)

| Variable | Example | Description |
|----------|---------|-------------|
| `OPENAI_BASE_URL` | `http://localhost:8000/v1` | Your LLM server endpoint |
| `OPENAI_MODEL` | `qwen2.5-coder-32b` | Model ID as it appears on your server |
| `AGENT_API_KEY` | `sk-...` or empty | API key (leave blank if server has no auth) |

### Optional (all auto-scaled — only set if you need to override)

| Variable | Default | What it does |
|----------|---------|-------------|
| `AGENT_CONTEXT_WINDOW` | Auto-detected from server | Total context window in tokens |
| `AGENT_MAX_OUTPUT` | Auto-scaled | Max tokens per LLM response |
| `AGENT_TEMPERATURE` | `0.2` or profile-based | How creative/random the model is |
| `AGENT_MAX_STEPS` | `0` (unlimited) | Stop after N steps no matter what |
| `AGENT_MAX_ERRORS` | `8` | Stop after N consecutive errors |
| `AGENT_MEMORY_WINDOW` | Auto-scaled | How many recent steps the agent "remembers" |
| `AGENT_COMPACT_THRESHOLD` | Auto-scaled | When to compress old memory (chars) |
| `AGENT_COMPACT_INTERVAL` | Auto-scaled | How often to check for compaction (steps) |
| `AGENT_ENABLE_STAGES` | `true` | Set `false` to disable the 6-phase lifecycle |
| `AGENT_REQUIRE_SMOKE_TEST` | `true` | Set `false` for non-code tasks (docs, chat, etc.) |
| `AGENT_NO_THINKING` | — | Set `1` for models that output thinking tokens (Qwen3, some MiniMax) |
| `AGENT_ALLOWED_COMMANDS` | — | Extra shell commands to allow, comma-separated (e.g. `kubectl,terraform`) |

**Config priority:** Environment variable > Auto-detect from server > Model profile > Default

### Model Profiles

The agent auto-matches a profile from your model ID. You can also force one with `AGENT_PROFILE=<name>`.

| Profile | Context | Best for | Notes |
|---------|---------|----------|-------|
| `qwen2.5-coder-32b` | 32k | Pure coding tasks | Strong JSON output |
| `qwen3-coder-30b` | 16k | Fast local inference (1-3s/step) | Needs `AGENT_NO_THINKING=1` |
| `qwen3-30b` | 32k | General local inference | Needs `AGENT_NO_THINKING=1` |
| `qwen3-8b` | 32k | Lightweight local option | Limited reasoning |
| `gpt-oss-120b` | 32k | Complex multi-file projects | Best reasoning |
| `minimax-m2.1-reap` | 16k | Reasoning with limited context | |
| `claude` | 200k | Best overall quality | API cost |
| `gpt-4o` | 128k | General purpose | API cost |

---

## Customizing the Agent

### Add Custom Tools

Create a file in the appropriate `src/tools/` folder:

```javascript
// src/tools/filesystem/my_tool.js
export default {
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input' }
    },
    required: ['input']
  },
  handler: async ({ input }, { workspace }) => {
    return `Result: ${input}`;
  }
};
```

Then register it in `src/tools/index.js` and add it to a category in `src/routing/toolRegistry.js`.

### Customize the Agent's Personality

The agent reads 4 markdown files from the workspace at startup:

| File | What it controls |
|------|-----------------|
| `SOUL.md` | The agent's personality, boundaries, and core rules |
| `AGENTS.md` | Operating protocol — how it plans, recovers from errors, etc. |
| `USER.md` | Info about you/your team (helps the agent tailor its approach) |
| `MEMORY.md` | Pre-loaded knowledge about the project |

Create any of these in your workspace before running. The agent won't overwrite them. Or edit the defaults in `src/identity.js`.

### Disable the Stage System

If you don't want the 6-phase lifecycle (e.g. for simple chatbot tasks):

```bash
AGENT_ENABLE_STAGES=false node src/cli.js --workspace ./my-project --task "..."
```

### Use Programmatically (Embed in Your App)

```javascript
import { runLoop } from './src/loop.js';
import { setWorkspace } from './src/state.js';
import { setLLMLogDir } from './src/llm.js';

setWorkspace('/path/to/workspace');
setLLMLogDir('/path/to/workspace');

const result = await runLoop({
  task: 'Build a CLI tool',
  workspace: '/path/to/workspace',
  resume: false,
  onStep: (step, action, toolResult) => {
    console.log(`Step ${step}: ${action.tool}`);
  },
});
// result = { exitReason, summary, totalSteps, totalCharsUsed, compactionCount, memoriesFlushed, skillsCreated }
```

---

## What the Agent Creates in Your Workspace

All agent state lives in `.agent/` (gitignored). Everything is human-readable:

```
your-project/
  .agent/                     Created by the agent (gitignored)
    checkpoint.json           Current step, memory, stage — for crash recovery
    task.md                   The original task you gave it
    plan.md                   The agent's plan (checklist format)
    progress.md               Step-by-step log with timestamps
    context-summary.md        Compressed history of all past work
    focus-chain.md            You can edit this to steer the agent's priorities
    learnings.md              Notes the agent has made about your project
    memory/
      2025-01-15.md           Daily memory logs
      files-touched.json      Which files it read/wrote
      commands-run.json       Shell commands it ran + exit codes
    skills/
      *.md                    Custom tools the agent created for itself
```

You can read any of these during a run to see what the agent is doing. You can even edit `focus-chain.md` or `plan.md` mid-run to steer it.

---

## Available Tools

The agent has access to these tools (gated by the current phase):

| Category | Tools | Description |
|----------|-------|-------------|
| **Filesystem** | `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `glob`, `patch` | Read, write, search, and navigate files |
| **Execution** | `run_command`, `webfetch`, `websearch`, `lsp` | Run shell commands, fetch URLs, search the web |
| **Planning** | `update_plan`, `think`, `finish`, `todowrite`, `todoread`, `add_learning` | Plan work, track progress, signal completion |
| **Memory** | `save_memory`, `search_memory`, `update_memory` | Persist knowledge across compaction cycles |
| **Identity** | `update_identity` | Update its own operating rules |
| **Skills** | `create_skill` | Create reusable custom tools at runtime |

---

## Project Structure

```
Advanced-agent-loop/
  src/
    cli.js              Entry point — parses args, auto-detects model, starts the loop
    loop.js             The main while-loop + JSON parser + stall guards
    context.js          Builds the prompt (5 layers: identity, knowledge, state, session, guidance)
    config.js           All settings, model profiles, env var overrides
    llm.js              Calls the LLM API with retry + exponential backoff
    stages.js           The 6-phase lifecycle (intake through finalization)
    parser.js           Multi-pass JSON parser (handles messy model output)
    guards.js           Anti-stall detection (loop, parse errors, stage misalignment)
    recovery.js         Generates error recovery guidance for the model
    compaction.js       Compresses old memory into summaries
    memory.js           Sliding window of recent steps
    memory-store.js     Persistent daily memory logs
    state.js            File I/O for checkpoints and workspace state
    identity.js         Bootstraps SOUL.md, AGENTS.md, USER.md, MEMORY.md
    plan.js             Parses and tracks the agent's plan
    skills.js           Dynamic skill system (agent creates its own tools)
    sandbox-verifier.js Verifies task completion before allowing finish
    tools/              Tool implementations (filesystem, execution, planning, memory, etc.)
    routing/            Tool routing — decides which tools to show each step
  tests/                190+ tests (run with: npm test)
  docs/                 Deep-dive documentation (architecture, workflow, guards)
  .env.example          Configuration template
  DESIGN.md             Architecture decisions and research
  AGENTS.md             Agent operating protocol (used at runtime)
  SOUL.md               Agent identity template
  USER.md               User profile template
  MEMORY.md             Long-term memory template
```

---

## Testing

```bash
# Run all tests (190+ tests, no API key needed)
npm test

# Parser tests only (57 tests)
node --test tests/parseAction.test.js
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **"fetch failed"** | Your LLM server is down or unreachable. Check `OPENAI_BASE_URL`. |
| **Agent keeps looping on the same action** | The anti-stall guard will intervene after 3 repeats. If persistent, your model may be too small for the task. |
| **JSON parse errors every step** | Your model isn't outputting valid JSON. Try a different model or check if it needs `AGENT_NO_THINKING=1`. |
| **Agent finishes too early** | The sandbox verifier should catch this. Make sure `AGENT_REQUIRE_SMOKE_TEST=true`. |
| **Agent runs forever** | Set `AGENT_MAX_STEPS=100` (or whatever limit you want). |
| **Context window errors / truncated output** | The auto-detection may have failed. Set `AGENT_CONTEXT_WINDOW` manually. |
| **Server crashed mid-run** | Just run again with `--resume`. |
| **Qwen3 models output thinking tags** | Set `AGENT_NO_THINKING=1`. |

---

## Further Reading

| Document | What you'll learn |
|----------|-------------------|
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Step-by-step walkthrough of one complete agent cycle |
| [docs/SANDBOX.md](docs/SANDBOX.md) | How the agent verifies its own work before finishing |
| [docs/LOOP_EXPLAINER.md](docs/LOOP_EXPLAINER.md) | Deep-dive into every subsystem (parser, memory, routing, guards) |
| [docs/anti-stall-guards.md](docs/anti-stall-guards.md) | All 42 guard mechanisms cataloged with source references |
| [DESIGN.md](DESIGN.md) | Why we built it this way (research, alternatives considered) |

---

## Requirements

- **Node.js 18+** (uses native `fetch`, `node:test`, `node:child_process`)
- **Any OpenAI-compatible LLM endpoint**
- **Zero npm dependencies** — runs entirely on Node.js standard library
