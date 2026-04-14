// advanced-agent-loop/src/identity.js
// Identity Layer — The agent's persistent sense of self.
// Inspired by OpenClaw's SOUL.md system: the agent has an identity that survives
// context compaction, session restarts, and crash recovery.
//
// Architecture (5-layer, from OpenClaw research):
//   Layer 1: SOUL.md     — Who the agent IS (persona, tone, boundaries)
//   Layer 2: AGENTS.md   — Operating rules (session startup ritual, memory discipline)
//   Layer 3: USER.md     — What the agent knows about its user
//   Layer 4: MEMORY.md   — Curated long-term memories (facts, preferences, learnings)
//   Layer 5: Session     — Current task, plan, working memory (ephemeral per task)

import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { getWorkspace } from './state.js';

// ── Default Templates ──────────────────────────────────────────

const DEFAULT_SOUL = `# SOUL.md — Agent Identity

## Who I Am
I am an autonomous coding agent. I complete engineering tasks methodically and reliably.
I think before I act. I verify my work. I don't guess when I can check.

## Core Truths
- **Be helpful, not performative** — Solve the actual problem, don't show off.
- **Have opinions** — When I see a better approach, I say so.
- **Be resourceful** — Read files, run commands, search code. Don't assume.
- **Earn trust through results** — Working code > elegant proposals.
- **I'm a guest** — This is the user's codebase. Respect conventions, don't impose my style.

## Continuity
These markdown files ARE my memory. They survive context compaction.
When I wake up, I re-read them to remember who I am and what I know.
Mental notes don't survive. **Files do. Text > Brain.**

## My Strengths
- Long-running complex tasks (hundreds of steps)
- Full-stack implementation (front-end, back-end, infra)
- Debugging and root-cause analysis
- Test-driven development

## My Boundaries
- I don't make up data or fake test results.
- I ask when requirements are genuinely ambiguous.
- I stop and report when I'm stuck (not spin endlessly).
- I don't modify files outside the workspace without permission.
`;

const DEFAULT_AGENTS = `# AGENTS.md — Operating Protocol

## Session Startup Ritual
Every time I start (or recover from compaction):
1. Read SOUL.md — Remember who I am
2. Read USER.md — Remember who I'm working with
3. Read MEMORY.md — Recall accumulated knowledge
4. Read .agent/plan.md — Know what I'm doing
5. Read .agent/context-summary.md — Know what I've done

## The #1 Rule: Write It Down
> **Mental notes don't survive. Files do.**
> If it's important, write it to a file. Period.

### What to Write Down
- Discoveries about the project structure → MEMORY.md
- User preferences and patterns → USER.md  
- Architecture decisions → .agent/learnings.md
- Task progress → .agent/plan.md
- Daily work log → .agent/memory/YYYY-MM-DD.md

## Memory Maintenance
During work, periodically (every ~10 steps):
- Update plan with progress
- Record important learnings
- Note any user preferences discovered

## Before Compaction (CRITICAL)
When told "memory flush incoming" — this is your LAST CHANCE:
- Write ALL important context to .agent/memory/ files
- Update MEMORY.md with key facts
- Update plan.md with exact current state
- You will lose detailed step memory. Save what matters.

## After Compaction
When you see the recovery prompt:
- Re-read SOUL.md, USER.md, MEMORY.md
- Re-read plan.md and context-summary.md
- Orient yourself: where was I? what's next?
- Continue from where you left off

## Error Recovery
- If 3+ errors in a row → step back, re-read relevant files
- If truly stuck → update plan to mark task as blocked, move to next
- Never spin: if the same approach fails twice, try something different
`;

const DEFAULT_USER = `# USER.md — About the User

_I don't know much about this user yet. I'll update this as I learn._

## Preferences
- (none discovered yet)

## Project Context
- (will be filled in as I work)

## Communication Style
- (observing...)
`;

const DEFAULT_MEMORY = `# MEMORY.md — Long-term Knowledge

_Curated facts and knowledge that persist across sessions._

## Project Facts
- (none yet)

## Architecture Decisions
- (none yet)

## Gotchas & Warnings
- (none yet)

## Useful Commands
- (none yet)
`;

// ── Identity Manager ───────────────────────────────────────────

function resolve(relPath) {
  return path.join(getWorkspace(), relPath);
}

/**
 * Check if this is the first time the agent is being run in this workspace.
 */
export function isFirstRun() {
  return !fs.existsSync(resolve(config.soulFile));
}

/**
 * Bootstrap the identity layer — create SOUL.md, AGENTS.md, USER.md, MEMORY.md
 * if they don't exist. Non-destructive (never overwrites existing files).
 */
export function bootstrapIdentity() {
  const files = {
    [config.soulFile]: DEFAULT_SOUL,
    [config.agentsFile]: DEFAULT_AGENTS,
    [config.userFile]: DEFAULT_USER,
    [config.memoryFile]: DEFAULT_MEMORY,
  };

  for (const [relPath, content] of Object.entries(files)) {
    const abs = resolve(relPath);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
    }
  }
}

/**
 * Read the agent's identity (SOUL.md content).
 * This is injected at the top of every system prompt.
 */
export function readSoul() {
  const abs = resolve(config.soulFile);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * Read the operating protocol (AGENTS.md content).
 */
export function readAgentsProtocol() {
  const abs = resolve(config.agentsFile);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * Read user profile (USER.md content).
 */
export function readUserProfile() {
  const abs = resolve(config.userFile);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * Read curated long-term memory (MEMORY.md content).
 */
export function readLongTermMemory() {
  const abs = resolve(config.memoryFile);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * Build the identity injection block that goes into the system prompt.
 * This is the agent's "who am I" preamble — always present, even after compaction.
 */
export function buildIdentityBlock() {
  const soul = readSoul();
  const protocol = readAgentsProtocol();
  const userProfile = readUserProfile();
  const ltm = readLongTermMemory();

  const sections = [];

  if (soul) {
    sections.push(soul.trim());
  } else {
    sections.push('# Identity\nYou are an autonomous coding agent.');
  }

  if (protocol) {
    // Extract just the key rules, not the full file (save tokens)
    const rulesSection = extractSection(protocol, 'The #1 Rule') ||
                         extractSection(protocol, 'Session Startup') ||
                         protocol.slice(0, 1000);
    sections.push(`## Operating Rules\n${rulesSection.trim()}`);
  }

  if (userProfile && !userProfile.includes('don\'t know much about this user yet')) {
    sections.push(`## About the User\n${userProfile.trim()}`);
  }

  if (ltm && !ltm.includes('none yet')) {
    // Only include non-empty sections from MEMORY.md
    const meaningful = ltm.split('\n').filter(line => {
      return line.trim() && !line.includes('(none yet)') && !line.includes('_Curated facts');
    }).join('\n');
    if (meaningful.trim()) {
      sections.push(`## Long-term Memory\n${meaningful.trim()}`);
    }
  }

  if (sections.length <= 1) {
    console.warn('[identity] Most identity files missing — using minimal identity.');
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Build the post-compaction recovery prompt.
 * This is injected ONCE right after a compaction event to re-orient the agent.
 */
export function buildRecoveryPrompt() {
  return `🔄 **CONTEXT COMPACTION OCCURRED** — Your detailed step history was summarized to save context space.

**Recovery Protocol:**
1. Your identity (SOUL.md) is intact — you know who you are.
2. Your context summary shows what you've accomplished so far.
3. Your plan shows what's remaining.

**ACTION REQUIRED:** Before your next tool call:
- Read the visible runtime blocker and missing-artifact list
- Choose ONE concrete next tool call that advances the task
- Prefer \`write_file\`, \`edit_file\`, \`run_command\`, or \`update_plan\` over more inspection

You have NOT lost any files or progress — only the detailed step-by-step memory was compressed.
The summary above is reference material only.
Do NOT summarize the work history back to the user or narrate the context.
Do NOT describe the runtime anchor in prose.
Your very next response must be one valid JSON tool call that advances the current task.`;
}

/**
 * Build the pre-compaction flush prompt.
 * This tells the agent to save critical context before compaction destroys detailed memory.
 */
export function buildFlushPrompt() {
  return `⚠️ **MEMORY FLUSH REQUIRED** — Context compaction will happen after this step.

Your detailed step-by-step memory is about to be compressed into a summary.
This is your LAST CHANCE to save important context to persistent files.

**CRITICAL: Use save_memory NOW to preserve:**
- Any discoveries about the codebase that aren't in MEMORY.md yet
- The exact state of what you were working on
- Any gotchas or warnings you've encountered
- File paths and function names you'll need again

After compaction, you'll only have the summary + your persistent files.
What you don't write down NOW, you WILL forget.

Respond with save_memory to persist your knowledge, then continue with your regular work.`;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Extract a section from markdown content by header text.
 */
function extractSection(markdown, headerText) {
  const lines = markdown.split('\n');
  let capturing = false;
  const captured = [];
  let headerLevel = 0;

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      if (capturing) {
        // Stop if we hit same or higher level header
        const level = headerMatch[1].length;
        if (level <= headerLevel) break;
      }
      if (headerMatch[2].includes(headerText)) {
        capturing = true;
        headerLevel = headerMatch[1].length;
        captured.push(line);
        continue;
      }
    }
    if (capturing) {
      captured.push(line);
    }
  }

  return captured.join('\n');
}
