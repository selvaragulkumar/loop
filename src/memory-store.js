// advanced-agent-loop/src/memory-store.js
// Persistent Memory Store — Retain/Recall/Reflect architecture.
//
// Inspired by OpenClaw's memory system and V2 research:
// - Daily memory logs: .agent/memory/YYYY-MM-DD.md
// - Curated MEMORY.md at workspace root (agent-maintained)
// - Text-based memory search across all memory files
// - Memory types: world (facts), experience (what happened), opinion (preferences)
// - Pre-compaction flush: save critical context before memory destruction
//
// The filesystem IS the memory backend. No database needed.
// Text search via grep is fast enough for single-workspace memory.

import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { getWorkspace } from './state.js';
import { searchInDirectory } from './tools/utils/native-search.js';

// ── Types ──────────────────────────────────────────────────────

/**
 * @typedef {'world'|'experience'|'opinion'|'decision'|'gotcha'} MemoryType
 */

/**
 * @typedef {Object} MemoryEntry
 * @property {string} content — The memory text
 * @property {MemoryType} type — Category
 * @property {string[]} tags — Searchable tags
 * @property {number} confidence — 0-1 for opinions, always 1 for facts
 * @property {string} timestamp — ISO string
 */

// ── Daily Log ──────────────────────────────────────────────────

/**
 * Get today's date string for the daily log filename.
 */
function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Get the path to today's memory log.
 */
function dailyLogPath() {
  return path.join(getWorkspace(), config.agentDir, 'memory', `${today()}.md`);
}

/**
 * Append an entry to today's daily memory log.
 * This is the primary "write it down" mechanism.
 *
 * @param {string} content — What to remember
 * @param {MemoryType} type — Category tag
 * @param {string[]} tags — Additional searchable tags
 */
export function saveMemory(content, type = 'experience', tags = []) {
  try {
    const logPath = dailyLogPath();
    const memDir = path.dirname(logPath);
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }

    // Create header if new file
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, `# Memory Log — ${today()}\n\n`, 'utf-8');
    }

    const existing = fs.readFileSync(logPath, 'utf-8');
    const tail = existing.slice(-2000);
    if (tail.includes(String(content || '').slice(0, 100))) {
      return 'Memory already saved (deduplicated).';
    }

    // Full ISO timestamp (date + time) so entries are unambiguous across midnight / multi-day runs
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    const entry = `### ${timestamp} — ${type}${tagStr}\n${content}\n\n`;

    fs.appendFileSync(logPath, entry, 'utf-8');
    return `Memory saved to ${today()}.md (${type})`;
  } catch (err) {
    console.error(`[memory-store] saveMemory failed: ${err.message}`);
    return `Memory save failed: ${err.message}`;
  }
}

// ── Recall (Search) ────────────────────────────────────────────

/**
 * Search across all memory files for a query string.
 * Uses grep for fast text search across the memory directory + MEMORY.md.
 *
 * @param {string} query — Search text (regex supported)
 * @param {Object} opts
 * @param {number} opts.maxResults — Max matches to return
 * @param {MemoryType} opts.type — Filter by memory type
 * @returns {string} Formatted search results
 */
export function searchMemory(query, opts = {}) {
  const { maxResults = 20, type } = opts;
  const workspace = getWorkspace();
  const results = [];

  // Search daily logs
  const memDir = path.join(workspace, config.agentDir, 'memory');
  if (fs.existsSync(memDir)) {
    const found = searchInDirectory(memDir, query, { maxResults, filePattern: '*.md' });
    if (found.length > 0) {
      results.push('## Daily Logs\n' + formatSearchOutput(found, config.agentDir + '/memory'));
    }
  }

  // Search MEMORY.md
  const memoryFile = path.join(workspace, config.memoryFile);
  if (fs.existsSync(memoryFile)) {
    const found = searchInDirectory(workspace, query, { maxResults, filePattern: config.memoryFile });
    if (found.length > 0) {
      results.push('## MEMORY.md\n' + formatSearchOutput(found, '.'));
    }
  }

  // Search learnings
  const learningsFile = path.join(workspace, config.agentDir, 'memory', 'learnings.md');
  if (fs.existsSync(learningsFile)) {
    const found = searchInDirectory(path.dirname(learningsFile), query, { maxResults, filePattern: 'learnings.md' });
    if (found.length > 0) {
      results.push('## Learnings\n' + formatSearchOutput(found, config.agentDir + '/memory'));
    }
  }

  // Filter by type if specified
  if (type && results.length > 0) {
    // Simple filter: only show lines that contain the type tag
    const filtered = results.map(section => {
      const lines = section.split('\n');
      const header = lines[0];
      const matchingLines = lines.slice(1).filter(l => l.toLowerCase().includes(type));
      return matchingLines.length > 0 ? `${header}\n${matchingLines.join('\n')}` : '';
    }).filter(Boolean);
    return filtered.join('\n\n') || `No memories found matching "${query}" with type "${type}".`;
  }

  return results.length > 0
    ? results.join('\n\n')
    : `No memories found matching "${query}".`;
}

/**
 * Format grep output to be more readable (strip absolute paths).
 */
function formatSearchOutput(results, basePrefix) {
  return results
    .map((r) => `${path.posix.join(basePrefix.replace(/\\/g, '/'), r.file)}:${r.line}:${r.text}`)
    .join('\n');
}

// ── Reflect (Memory Maintenance) ───────────────────────────────

/**
 * Get a summary of all memory files for context injection.
 * Used during context assembly to give the agent awareness of what it knows.
 *
 * @returns {string} Formatted memory summary
 */
export function getMemorySummary() {
  const workspace = getWorkspace();
  const memDir = path.join(workspace, config.agentDir, 'memory');
  const sections = [];

  // Count daily logs
  if (fs.existsSync(memDir)) {
    const logs = fs.readdirSync(memDir).filter(f =>
      f.match(/^\d{4}-\d{2}-\d{2}\.md$/)
    );
    if (logs.length > 0) {
      sections.push(`📅 ${logs.length} daily log(s): ${logs.slice(-3).join(', ')}`);

      // Show today's log entries count
      const todayLog = path.join(memDir, `${today()}.md`);
      if (fs.existsSync(todayLog)) {
        const content = fs.readFileSync(todayLog, 'utf-8');
        const entryCount = (content.match(/^### /gm) || []).length;
        sections.push(`  Today: ${entryCount} entries`);
      }
    }
  }

  // Check MEMORY.md
  const memoryFile = path.join(workspace, config.memoryFile);
  if (fs.existsSync(memoryFile)) {
    const content = fs.readFileSync(memoryFile, 'utf-8');
    const lineCount = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.includes('(none')).length;
    sections.push(`📚 MEMORY.md: ${lineCount} content lines`);
  }

  return sections.length > 0 ? sections.join('\n') : 'No persistent memories yet.';
}

/**
 * Get recent memories from today's log (for context injection).
 * Returns the last N entries from today.
 *
 * @param {number} maxEntries — Max entries to return
 * @returns {string} Formatted recent memories
 */
export function getRecentMemories(maxEntries = 5) {
  const logPath = dailyLogPath();
  if (!fs.existsSync(logPath)) return '';

  const content = fs.readFileSync(logPath, 'utf-8');
  // Split by entry headers (### HH:MM:SS — type)
  const entries = content.split(/(?=^### )/m).filter(e => e.startsWith('### '));

  if (entries.length === 0) return '';

  const recent = entries.slice(-maxEntries);
  return `## Today's Memories (${recent.length} of ${entries.length})\n${recent.join('\n')}`;
}

// ── Pre-Compaction Flush ───────────────────────────────────────

/**
 * Extract important facts from the working memory entries before compaction.
 * Called by the compaction system to auto-save critical context.
 *
 * @param {Array<{step:number, action:string, args:Object, result:string, error:boolean}>} entries
 * @returns {string[]} Array of memory entries to save
 */
export function extractMemoriesFromEntries(entries) {
  const memories = [];

  for (const entry of entries) {
    // Save file discoveries
    if (entry.action === 'read_file' && !entry.error && entry.args?.path) {
      const lineCount = (entry.result || '').split('\n').length;
      if (lineCount > 20) {
        memories.push({
          content: `Read ${entry.args.path} (${lineCount} lines) — file exists and was examined`,
          type: 'world',
          tags: ['file', entry.args.path],
        });
      }
    }

    // Save command outcomes
    if (entry.action === 'run_command' && entry.args?.command) {
      const cmd = entry.args.command.slice(0, 100);
      const status = entry.error ? 'FAILED' : 'succeeded';
      memories.push({
        content: `Command \`${cmd}\` ${status}${entry.error ? ': ' + (entry.result || '').slice(0, 200) : ''}`,
        type: 'experience',
        tags: ['command', status],
      });
    }

    // Save write operations
    if (entry.action === 'write_file' && !entry.error && entry.args?.path) {
      memories.push({
        content: `Created/wrote ${entry.args.path}`,
        type: 'world',
        tags: ['file', 'write', entry.args.path],
      });
    }

    // Save edit operations
    if (entry.action === 'edit_file' && !entry.error && entry.args?.path) {
      memories.push({
        content: `Edited ${entry.args.path}`,
        type: 'world',
        tags: ['file', 'edit', entry.args.path],
      });
    }

    // Save learnings
    if (entry.action === 'add_learning' && entry.args?.note) {
      memories.push({
        content: entry.args.note,
        type: 'decision',
        tags: ['learning'],
      });
    }

    // Save plan updates (planning/decision events — durable across compaction)
    if (entry.action === 'update_plan' && !entry.error && entry.args?.content) {
      // Extract just the first 200 chars of plan content as a decision record
      const planSnippet = String(entry.args.content).slice(0, 200).replace(/\n+/g, ' ');
      memories.push({
        content: `Plan updated at step ${entry.step}: ${planSnippet}`,
        type: 'decision',
        tags: ['plan', 'update_plan'],
      });
    }

    // Save skill creation (durable: skills persist but creation context should survive compaction)
    if (entry.action === 'create_skill' && !entry.error && entry.args?.name) {
      const desc = entry.args.description ? ` — ${String(entry.args.description).slice(0, 150)}` : '';
      memories.push({
        content: `Created skill "${entry.args.name}"${desc}`,
        type: 'decision',
        tags: ['skill', 'create_skill', entry.args.name],
      });
    }

    // Save errors as gotchas
    if (entry.error && entry.action !== 'parse_error') {
      memories.push({
        content: `Error in ${entry.action}: ${(entry.result || '').slice(0, 300)}`,
        type: 'gotcha',
        tags: ['error', entry.action],
      });
    }
  }

  return memories;
}

/**
 * Perform the pre-compaction memory flush.
 * Automatically saves critical context from working memory to daily log.
 *
 * @param {Array} oldEntries — Working memory entries about to be compacted
 * @returns {number} Number of memories saved
 */
export function flushMemories(oldEntries) {
  const memories = extractMemoriesFromEntries(oldEntries);
  let count = 0;

  for (const mem of memories) {
    saveMemory(mem.content, mem.type, mem.tags);
    count++;
  }

  if (count > 0) {
    saveMemory(
      `Pre-compaction flush: saved ${count} memories from steps being compacted.`,
      'experience',
      ['compaction', 'flush']
    );
  }

  return count;
}

// ── Heartbeat Memory Check ─────────────────────────────────────

/**
 * Periodic memory maintenance during the agent loop.
 * Called every N steps to ensure important context is persisted.
 *
 * @param {number} step — Current step number
 * @param {string} currentTask — What the agent is working on
 */
export function heartbeatMemoryCheck(step, currentTask) {
  if (step % config.memoryHeartbeatInterval !== 0) return;

  saveMemory(
    `Heartbeat at step ${step}: working on "${currentTask?.slice(0, 100) || 'unknown task'}"`,
    'experience',
    ['heartbeat', `step-${step}`]
  );

  // Rotate old daily logs on every heartbeat (cheap: only deletes, no reads)
  rotateDailyLogs(14);
}

/**
 * Delete daily memory logs older than maxDays.
 * Keeps disk usage bounded on long-running or repeated sessions.
 */
function rotateDailyLogs(maxDays = 14) {
  try {
    const workspace = getWorkspace();
    const memDir = path.join(workspace, config.agentDir, 'memory');
    if (!fs.existsSync(memDir)) return;

    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(memDir)) {
      if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
      const filePath = path.join(memDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // Non-critical — rotation failure should never interrupt the agent
  }
}
