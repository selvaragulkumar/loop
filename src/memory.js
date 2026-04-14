// advanced-agent-loop/src/memory.js
// Working memory management — the sliding window of recent steps.
// Keeps the last N steps in full detail. Older steps get compacted.

import config from './config.js';

/**
 * @typedef {Object} MemoryEntry
 * @property {number} step
 * @property {string} action - Tool name or 'think'
 * @property {Object} args - Tool arguments
 * @property {string} result - Tool result or thought content
 * @property {boolean} error - Whether the action errored
 * @property {number} timestamp
 */

/**
 * WorkingMemory manages the agent's short-term recall.
 * It's the "last N steps" that go into the LLM context in full detail.
 */
export class WorkingMemory {
  /** @param {MemoryEntry[]} entries */
  constructor(entries = []) {
    this.entries = entries;
  }

  /** Add a new step to working memory.
   * Truncates large string args at storage time so checkpoint.json stays lean.
   * formatForContext() does a second truncation for display — this is the source-of-truth limit.
   */
  push(entry) {
    const last = this.entries[this.entries.length - 1];
    const MAX_ARG_CHARS = 500;
    const args = {};
    for (const [k, v] of Object.entries(entry.args || {})) {
      args[k] = typeof v === 'string' && v.length > MAX_ARG_CHARS
        ? v.slice(0, MAX_ARG_CHARS) + `…[${v.length} chars total]`
        : v;
    }
    // Compare using the stored (already-truncated) args of the last entry
    // so both sides have the same truncation applied
    const duplicate = Boolean(
      last
      && last.action === entry.action
      && JSON.stringify(last.args || {}) === JSON.stringify(args)
    );
    this.entries.push({ ...entry, args, _duplicate: duplicate });
  }

  /** Get the last N entries (the active working window). */
  getRecent(n = config.workingMemoryWindow) {
    return this.entries.slice(-n);
  }

  /** Get entries that are OUTSIDE the working window (candidates for compaction). */
  getOld(n = config.workingMemoryWindow) {
    if (this.entries.length <= n) return [];
    return this.entries.slice(0, this.entries.length - n);
  }

  /** Remove old entries after compaction (keep only the working window). */
  trimToWindow(n = config.workingMemoryWindow) {
    if (this.entries.length > n) {
      this.entries = this.entries.slice(-n);
    }
  }

  /** Total character count across all entries. */
  totalChars() {
    return this.entries.reduce((sum, e) => {
      return sum + (e.result?.length || 0) + (JSON.stringify(e.args)?.length || 0);
    }, 0);
  }

  /** Check if compaction is needed. */
  needsCompaction() {
    const oldEntries = this.getOld();
    if (oldEntries.length === 0) return false;

    const oldChars = oldEntries.reduce((sum, e) => sum + (e.result?.length || 0), 0);
    return oldChars > config.compactionThresholdChars;
  }

  /** Serialize for checkpoint. */
  toJSON() {
    return this.entries;
  }

  /** Restore from checkpoint. */
  static fromJSON(data) {
    return new WorkingMemory(data || []);
  }

  /** Format old entries for LLM summarization. */
  formatForCompaction(oldEntries) {
    return oldEntries.map(e => {
      const argsStr = e.args ? JSON.stringify(e.args).slice(0, 200) : '';
      const resultStr = (e.result || '').slice(0, 500);
      return `Step ${e.step}: ${e.action}(${argsStr}) → ${e.error ? 'ERROR: ' : ''}${resultStr}`;
    }).join('\n');
  }

  /** Format recent entries for the LLM prompt. */
  formatForContext() {
    const recent = this.getRecent();
    const collapsed = [];
    for (const e of recent) {
      const prev = collapsed[collapsed.length - 1];
      if (prev && e._duplicate && prev.action === e.action && JSON.stringify(prev.args || {}) === JSON.stringify(e.args || {})) {
        prev._repeatCount = (prev._repeatCount || 1) + 1;
        continue;
      }
      collapsed.push({ ...e, _repeatCount: 1 });
    }

    return collapsed.map(e => {
      const header = `### Step ${e.step}: ${e.action}`;
      let body = '';
      if (e.args && Object.keys(e.args).length > 0) {
        // Truncate large string args (e.g. write_file content) to avoid context bloat.
        // The agent already knows what it wrote — it doesn't need the full content re-injected.
        const displayArgs = {};
        for (const [k, v] of Object.entries(e.args)) {
          displayArgs[k] = typeof v === 'string' && v.length > 200
            ? v.slice(0, 200) + `... [${v.length} chars]`
            : v;
        }
        body += `**Args:** ${JSON.stringify(displayArgs)}\n`;
      }
      if (e.result) {
        let display;
        if (e.result.length > 1000) {
          // Show head + tail so summaries at the end (e.g. test pass/fail counts) are visible.
          display = e.result.slice(0, 400) + '\n... [truncated] ...\n' + e.result.slice(-400);
        } else {
          display = e.result;
        }
        body += `**Result:** ${e.error ? '❌ ERROR: ' : ''}${display}`;
      }
      if ((e._repeatCount || 1) > 1) {
        body += `\n**Note:** repeated ×${e._repeatCount}`;
      }
      return `${header}\n${body}`;
    }).join('\n\n');
  }
}
