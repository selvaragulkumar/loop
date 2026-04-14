// advanced-agent-loop/src/config.js
// Central configuration — all tunables in one place.
// Designed for the longest-running, most stable autonomous agent loop.

// ── Model Profiles ────────────────────────────────────────────────
// Pre-tuned settings per model. Selected via AGENT_PROFILE env var or
// auto-matched from AGENT_MODEL. All values can still be overridden
// by their individual env vars (AGENT_CONTEXT_WINDOW, etc.).
const MODEL_PROFILES = {
  // Local vLLM models
  'gpt-oss-120b': {
    provider: 'vllm',
    temperature: 0.15,
    contextWindow: 32000,
    maxOutputTokens: 6144,
    notes: 'Largest local model. Clean code but slow (~10-20s/step). Gets stuck on subtle import issues. Shared server hits 429 rate limits. Use qwen3-coder for speed.',
  },
  'gpt-oss-20b': {
    provider: 'vllm',
    temperature: 0.2,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    notes: 'Smaller variant of gpt-oss. Faster but less capable for multi-file tasks.',
  },
  'minimax-m2.1-reap': {
    provider: 'vllm',
    temperature: 0.2,
    contextWindow: 16384,
    maxOutputTokens: 2949,
    noThinking: true,
    notes: 'Good reasoning via REAP but slow (~60s/step). Generates typos in code (glass/snike). Struggles with edit_file whitespace matching. Write churn on multi-file tasks. OK for simple bug fixes.',
  },
  'qwen2.5-coder-32b': {
    provider: 'vllm',
    temperature: 0.1,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    notes: 'Code-specialized. Strong JSON discipline. Best for pure coding tasks.',
  },
  'qwen3-coder-30b': {
    provider: 'vllm',
    temperature: 0.1,
    contextWindow: 16384,
    maxOutputTokens: 2949,
    noThinking: true,
    notes: 'Best local model for agent loop. 1-3s/step, 0 truncations, clean JSON. MoE 30B/3B. Requires AGENT_NO_THINKING=1. Tested: 9-file project in 47s/20 steps, 11-file in 141s/34 steps.',
  },
  'qwen3-30b': {
    provider: 'vllm',
    temperature: 0.2,
    contextWindow: 16384,
    maxOutputTokens: 2949,
    noThinking: true,
    notes: 'MoE 30B/3B AWQ variant. Same arch as qwen3-coder. Needs AGENT_NO_THINKING=1 or thinking tokens consume output budget.',
  },
  'qwen3-8b': {
    provider: 'vllm',
    temperature: 0.2,
    contextWindow: 32000,
    maxOutputTokens: 2048,
    noThinking: true,
    notes: 'Smallest Qwen3. Fast but limited reasoning. Needs AGENT_NO_THINKING=1.',
  },
  'nemotron-30b': {
    provider: 'vllm',
    temperature: 0.1,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    notes: 'NVIDIA Nemotron-3 Nano 30B. MoE 30B/3B BF16. Use for coding tasks.',
  },
  // API models
  'claude': {
    provider: 'anthropic',
    temperature: 0.1,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    notes: 'Best overall. Huge context, excellent JSON, strong coding. API cost applies.',
  },
  'codex': {
    provider: 'openai',
    temperature: 0.1,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    notes: 'OpenAI Codex. Large context, strong at code generation. API cost applies.',
  },
  'gpt-4o': {
    provider: 'openai',
    temperature: 0.1,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    notes: 'GPT-4o. Good all-around. API cost applies.',
  },
};

function matchProfile(modelId) {
  const id = String(modelId || '').toLowerCase();
  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    if (id.includes(key.replace(/-/g, '').replace(/\./g, '')) || id.includes(key)) return profile;
  }
  // Fuzzy match common patterns
  if (id.includes('minimax') && id.includes('reap')) return MODEL_PROFILES['minimax-m2.1-reap'];
  if (id.includes('qwen3') && id.includes('coder')) return MODEL_PROFILES['qwen3-coder-30b'];
  if (id.includes('qwen') && id.includes('coder') && id.includes('2.5')) return MODEL_PROFILES['qwen2.5-coder-32b'];
  if (id.includes('qwen') && id.includes('coder')) return MODEL_PROFILES['qwen3-coder-30b'];
  if (id.includes('qwen3') && id.includes('30b')) return MODEL_PROFILES['qwen3-30b'];
  if (id.includes('qwen3') && id.includes('8b')) return MODEL_PROFILES['qwen3-8b'];
  if (id.includes('nemotron')) return MODEL_PROFILES['nemotron-30b'];
  if (id.includes('claude')) return MODEL_PROFILES['claude'];
  if (id.includes('codex')) return MODEL_PROFILES['codex'];
  if (id.includes('gpt-4o')) return MODEL_PROFILES['gpt-4o'];
  if (id.includes('gpt-oss') && id.includes('120')) return MODEL_PROFILES['gpt-oss-120b'];
  if (id.includes('gpt-oss')) return MODEL_PROFILES['gpt-oss-20b'];
  return null;
}

// Resolve profile: explicit AGENT_PROFILE > auto-match from model name > defaults
const modelId = process.env.AGENT_MODEL || process.env.OPENAI_MODEL || 'gpt-oss-120b';
const explicitProfile = process.env.AGENT_PROFILE ? MODEL_PROFILES[process.env.AGENT_PROFILE] : null;
const autoProfile = matchProfile(modelId);
const profile = explicitProfile || autoProfile || {};

// Auto-set AGENT_NO_THINKING for models that need it (Qwen3 thinking token issue)
if (profile.noThinking && !process.env.AGENT_NO_THINKING) {
  process.env.AGENT_NO_THINKING = '1';
}

const config = {
  // ── LLM Provider ──────────────────────────────────────────────
  provider: profile.provider || 'vllm',
  baseURL: process.env.AGENT_BASE_URL || process.env.OPENAI_BASE_URL || 'http://localhost:8000/v1',
  model: modelId,
  apiKey: process.env.AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  contextWindow: parseInt(process.env.AGENT_CONTEXT_WINDOW || String(profile.contextWindow || 32000), 10),
  maxOutputTokens: parseInt(process.env.AGENT_MAX_OUTPUT || String(profile.maxOutputTokens || 4096), 10),
  temperature: parseFloat(process.env.AGENT_TEMPERATURE || String(profile.temperature || 0.2)),
  modelProfile: profile,  // expose for logging

  // ── Loop Budgets ──────────────────────────────────────────────
  maxSteps: parseInt(process.env.AGENT_MAX_STEPS || '0', 10),         // 0 disables the hard max-step stop
  maxTotalChars: parseInt(process.env.AGENT_MAX_CHARS || '0', 10), // 0 disables the cumulative char budget hard-stop
  enableStages: process.env.AGENT_ENABLE_STAGES !== 'false',
  stageBudgetRatios: {
    intake: 0.05,
    discovery: 0.10,
    planning: 0.10,
    execution: 0.55,
    verification: 0.10,
    finalization: 0.10,
  },

  // ── Memory & Compaction ───────────────────────────────────────
  workingMemoryWindow: parseInt(process.env.AGENT_MEMORY_WINDOW || '20', 10),       // keep last N steps
  compactionThresholdChars: parseInt(process.env.AGENT_COMPACT_THRESHOLD || '20000', 10),
  compactionIntervalSteps: parseInt(process.env.AGENT_COMPACT_INTERVAL || '15', 10),
  memoryFlushEnabled: true,    // Pre-compaction memory flush (OpenClaw-inspired)
  memoryHeartbeatInterval: parseInt(process.env.AGENT_HEARTBEAT || '10', 10),      // save heartbeat every N steps

  // ── Focus & Anti-Drift ────────────────────────────────────────
  maxConsecutiveErrors: parseInt(process.env.AGENT_MAX_ERRORS || '8', 10),
  maxSameToolErrors: parseInt(process.env.AGENT_MAX_SAME_ERRORS || '3', 10),
  verifyMaxFailures: parseInt(process.env.AGENT_VERIFY_MAX_FAILURES || '3', 10),
  requireSmokeTest: process.env.AGENT_REQUIRE_SMOKE_TEST !== 'false',  // Set to 'false' to skip smoke test gate

  // ── Identity Layer (OpenClaw SOUL.md System) ──────────────────
  soulFile: 'SOUL.md',                        // Agent identity — who it is
  agentsFile: 'AGENTS.md',                    // Operating protocol — how it works
  userFile: 'USER.md',                        // User profile — who it serves
  memoryFile: 'MEMORY.md',                    // Curated long-term memory

  // ── Agent State Directory ─────────────────────────────────────
  agentDir: '.agent',
  taskFile: '.agent/task.md',
  planFile: '.agent/plan.md',
  progressFile: '.agent/progress.md',
  contextSummaryFile: '.agent/context-summary.md',
  checkpointFile: '.agent/checkpoint.json',
  focusChainFile: '.agent/focus-chain.md',     // Human-editable focus chain

  // ── Persistent Memory ─────────────────────────────────────────
  memoryDir: '.agent/memory',                  // Daily logs + structured memories
  filesTouchedFile: '.agent/memory/files-touched.json',
  commandsRunFile: '.agent/memory/commands-run.json',
  recoveryEventsFile: '.agent/memory/recovery-events.json',
  learningsFile: '.agent/memory/learnings.md',

  // ── Skills System ─────────────────────────────────────────────
  skillsDir: '.agent/skills',                  // Agent-created skills live here

  // ── Tool Limits ───────────────────────────────────────────────
  maxToolOutputChars: 400_000,
  maxTerminalLines: 1000,
  maxFileReadLines: 500,
};

export default config;
