#!/usr/bin/env node
// advanced-agent-loop/src/cli.js
// CLI entry point — parse args, set workspace, bootstrap identity, run the loop.

import { runLoop } from './loop.js';
import { setWorkspace, loadCheckpoint, readTask } from './state.js';
import { setLLMLogDir } from './llm.js';
import config from './config.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Query the vLLM /v1/models endpoint to discover the model's real max_model_len,
 * then scale all context-dependent config parameters proportionally.
 * Only runs if the user has NOT set AGENT_CONTEXT_WINDOW explicitly.
 */
async function autoDetectAndScale() {
  // If user didn't pin the context window, try to detect it from the server
  if (!process.env.AGENT_CONTEXT_WINDOW) {
    let detected = null;

    // Strategy 1: Read max_model_len from /v1/models (works with native vLLM)
    try {
      const res = await fetch(`${config.baseURL}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        const modelInfo = data.data?.find(m => m.id === config.model) || data.data?.[0];
        detected = modelInfo?.max_model_len;
        if (typeof detected !== 'number' || detected <= 0) detected = null;
      }
    } catch {
      // Server not reachable — keep default
    }

    // Strategy 2: Probe with absurd max_tokens to extract limit from 400 error.
    // Many gateways (ollama-gateway, litellm) strip max_model_len from /v1/models
    // but the underlying vLLM still returns it in error messages.
    if (!detected) {
      try {
        const probeRes = await fetch(`${config.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 999999,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!probeRes.ok) {
          const errBody = await probeRes.text();
          // Parse patterns like "max_model_len=16384" or "max_total_tokens=16384"
          // or "context length is only 16384 tokens"
          const match = errBody.match(/max_model_len[=:]?\s*(\d+)/)
            || errBody.match(/max_total_tokens[=:]?\s*(\d+)/)
            || errBody.match(/context length is(?: only)?\s*(\d+)/);
          if (match) {
            detected = parseInt(match[1], 10);
            if (detected <= 0) detected = null;
          }
        }
      } catch {
        // Probe failed — keep default
      }
    }

    if (detected) {
      config.contextWindow = detected;
      scaleToContextWindow(detected);
      console.error(`[auto-detect] max_model_len=${detected}`);
    }
  }
}

/**
 * Scale memory/compaction/output parameters to fit within the given context window.
 * Formula rationale:
 *   - Reserve 70% of context for input (static prompt + working memory)
 *   - Static prompt ≈ 6500 tokens (identity, task, plan, learnings)
 *   - Each working memory entry ≈ 250 tokens
 *   - Output budget: 17–20% of context window, capped at 8192
 */
function scaleToContextWindow(ctxTokens) {
  const STATIC_TOKENS = 6500;       // approximate fixed overhead per step
  const TOKENS_PER_ENTRY = 250;     // average working memory entry cost
  const INPUT_FRACTION = 0.70;      // portion of context reserved for input
  const CHARS_PER_TOKEN = 3;        // conservative estimate for code-heavy content

  // Only override if env vars not set (respect explicit user config)
  if (!process.env.AGENT_MAX_OUTPUT) {
    config.maxOutputTokens = Math.min(8192, Math.max(1024, Math.floor(ctxTokens * 0.18)));
  }
  if (!process.env.AGENT_MEMORY_WINDOW) {
    const inputBudgetTokens = ctxTokens * INPUT_FRACTION - STATIC_TOKENS;
    config.workingMemoryWindow = Math.min(50, Math.max(6, Math.floor(inputBudgetTokens / TOKENS_PER_ENTRY)));
  }
  if (!process.env.AGENT_COMPACT_THRESHOLD) {
    // Threshold in chars — trigger compaction when old working memory exceeds this
    const memBudgetChars = (ctxTokens * INPUT_FRACTION - STATIC_TOKENS) * CHARS_PER_TOKEN;
    config.compactionThresholdChars = Math.max(4000, Math.floor(memBudgetChars * 0.6));
  }
  if (!process.env.AGENT_COMPACT_INTERVAL) {
    // Compact more often on small contexts, less often on large ones
    config.compactionIntervalSteps = Math.min(30, Math.max(7, Math.floor(ctxTokens / 1600)));
  }
}

const HELP = `
Advanced Agent Loop — Autonomous agent. No framework. Pure loop + file-based state.

Usage:
  agent "Build a REST API with Express"       Run a new task in current directory
  agent --resume                              Resume from checkpoint
  agent --task-file task.txt                  Read task from file
  agent --workspace /path/to/project "task"   Specify workspace directory

Options:
  --task, -t TASK        Set task description directly
  --resume, -r          Resume from .agent/checkpoint.json
  --workspace, -w DIR   Set workspace directory (default: cwd)
  --task-file, -f FILE  Read task description from file
  --max-steps N         Override max steps (default: ${config.maxSteps > 0 ? config.maxSteps : 'disabled'})
  --help, -h            Show this help
  --dry-run             Show what would happen without executing

Identity Layer:
  SOUL.md               Agent personality and identity (auto-created)
  AGENTS.md             Operating protocol and rules (auto-created)
  USER.md               User preferences learned over time
  MEMORY.md             Curated long-term knowledge

Persistence:
  .agent/memory/        Daily logs (YYYY-MM-DD.md), learnings, file tracking
  .agent/skills/        Agent-created reusable tools (.md files)
  .agent/checkpoint.json Crash recovery state
  .agent/plan.md        Task plan with progress tracking
  .agent/focus-chain.md Human-editable priority steering

Environment:
  AGENT_BASE_URL        LLM endpoint (default: ${config.baseURL})
  AGENT_MODEL           Model name (default: ${config.model})
  AGENT_MAX_STEPS       Max loop steps (default: ${config.maxSteps > 0 ? config.maxSteps : 'disabled'})
  AGENT_CONTEXT_WINDOW  Context window size (default: ${config.contextWindow})
`;

function formatMaxSteps(value) {
  return value > 0 ? String(value) : 'disabled';
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  // Parse arguments
  let resume = false;
  let workspace = process.cwd();
  let taskFile = null;
  let task = null;
  let dryRun = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--resume': case '-r':
        resume = true;
        break;
      case '--workspace': case '-w':
        workspace = path.resolve(args[++i]);
        break;
      case '--task': case '-t':
        task = args[++i];
        break;
      case '--task-file': case '-f':
        taskFile = args[++i];
        break;
      case '--max-steps':
        config.maxSteps = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        positional.push(args[i]);
    }
  }

  // Set workspace
  setWorkspace(workspace);
  setLLMLogDir(workspace);
  console.error(`Workspace: ${workspace}`);

  // Determine task
  if (resume) {
    const cp = loadCheckpoint();
    if (cp && cp.step > 0) {
      task = readTask();
      console.error(`Resuming from step ${cp.step}`);
    } else {
      console.error('No checkpoint found. Start a new task instead.');
      process.exit(1);
    }
  } else if (taskFile) {
    const abs = path.resolve(workspace, taskFile);
    if (!fs.existsSync(abs)) {
      console.error(`Task file not found: ${abs}`);
      process.exit(1);
    }
    task = fs.readFileSync(abs, 'utf-8').trim();

    // If task file is markdown (.md), copy it into .agent/ as a reference file
    // so the agent can read the full content without it bloating the prompt.
    if (taskFile.endsWith('.md')) {
      const agentDir = path.resolve(workspace, config.agentDir);
      fs.mkdirSync(agentDir, { recursive: true });
      const refName = path.basename(taskFile);
      const refPath = path.resolve(agentDir, `task-reference-${refName}`);
      fs.copyFileSync(abs, refPath);
      // Store the reference path relative to workspace so context.js can use it
      const relRef = path.relative(workspace, refPath);
      task = `__MD_TASK_REF__:${relRef}\n${task}`;
    }
  } else if (positional.length > 0) {
    task = positional.join(' ');
  }

  if (!task) {
    console.error('No task provided. Use: agent "your task" or agent --resume');
    process.exit(1);
  }

  // Dry run: show what would happen
  if (dryRun) {
    console.log('=== DRY RUN ===');
    console.log(`Task: ${task}`);
    console.log(`Workspace: ${workspace}`);
    console.log(`Max steps: ${formatMaxSteps(config.maxSteps)}`);
    console.log(`Model: ${config.model}`);
    console.log(`Resume: ${resume}`);
    console.log('');
    console.log('Identity files: SOUL.md, AGENTS.md, USER.md, MEMORY.md');
    console.log('Memory dir: .agent/memory/');
    console.log('Skills dir: .agent/skills/');
    console.log('Features: pre-compaction flush, post-compaction recovery, dynamic skills');
    process.exit(0);
  }

  // Auto-detect model context window and scale config proportionally
  await autoDetectAndScale();

  // Banner
  console.error('╔══════════════════════════════════════════════════╗');
  console.error('║            Advanced Agent Loop                   ║');
  console.error('║  Identity | Persistent Memory | Skills | Plans   ║');
  console.error('║  No framework. Pure loop. Maximum stability.     ║');
  console.error('╚══════════════════════════════════════════════════╝');
  console.error(`Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);
  const profileNote = config.modelProfile?.notes ? ` (${config.modelProfile.notes.split('.')[0]})` : '';
  console.error(`Max steps: ${formatMaxSteps(config.maxSteps)} | Model: ${config.model}${profileNote}`);
  console.error(`Context: ${config.contextWindow} tokens | Output: ${config.maxOutputTokens} | Memory window: ${config.workingMemoryWindow} | Compact every: ${config.compactionIntervalSteps} steps`);
  console.error('Features: identity layer, memory flush, skill creation, focus chain');
  console.error('');

  // Run
  const startTime = Date.now();

  const result = await runLoop({
    task,
    workspace,
    resume,
    onStep: (step, action, toolResult) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const truncResult = toolResult.slice(0, 80).replace(/\n/g, ' ');
      console.error(`  [${elapsed}s] Step ${step}: ${action.tool}(${JSON.stringify(action.args).slice(0, 60)}) → ${truncResult}`);
    },
  });

  // Final report
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error('');
  console.error('═══════════════════════════════════════════════════');
  console.error(`Exit: ${result.exitReason}`);
  console.error(`Steps: ${result.totalSteps}`);
  console.error(`Time: ${elapsed}s`);
  console.error(`Chars: ${result.totalCharsUsed.toLocaleString()}`);
  console.error(`Compactions: ${result.compactionCount}`);
  console.error(`Memories flushed: ${result.memoriesFlushed}`);
  console.error(`Skills created: ${result.skillsCreated}`);
  console.error('═══════════════════════════════════════════════════');
  console.error(`Summary: ${result.summary}`);

  // Exit code
  process.exit(result.exitReason === 'completed' ? 0 : 1);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
