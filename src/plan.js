// advanced-agent-loop/src/plan.js
// Plan parsing and status tracking.
// The agent manages plan.md itself — this module reads and reports on it.

import { readPlan } from './state.js';

/**
 * @typedef {Object} PlanItem
 * @property {string} text
 * @property {boolean} completed
 * @property {string} status - 'completed' | 'in_progress' | 'pending' | 'blocked'
 */

/**
 * @typedef {Object} PlanPhase
 * @property {string} name
 * @property {string} status
 * @property {PlanItem[]} items
 */

/**
 * Parse plan.md into structured phases and items.
 * Supports markdown format with headers and checkboxes.
 */
export function parsePlan() {
  const content = readPlan();
  if (!content || content.includes('_No plan yet._')) {
    return { phases: [], hasPlan: false, raw: content };
  }

  const phases = [];
  let currentPhase = null;

  for (const line of content.split('\n')) {
    // Phase header: ### Phase 1: Name [STATUS]  (exactly 3 hashes — ## is a section, #### is a sub-item)
    const phaseMatch = line.match(/^###\s+(?:Phase\s+\d+:\s*)?(.+?)(?:\s*\[(\w+(?:_\w+)?)\])?\s*$/);
    if (phaseMatch) {
      currentPhase = {
        name: phaseMatch[1].trim(),
        status: normalizeStatus(phaseMatch[2]),
        items: [],
      };
      phases.push(currentPhase);
      continue;
    }

    // Checklist item: - [x] or - [ ]
    const itemMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.+?)(?:\s*←\s*(.+))?\s*$/);
    if (itemMatch && currentPhase) {
      const completed = itemMatch[1].toLowerCase() === 'x';
      const text = itemMatch[2].trim();
      const annotation = itemMatch[3]?.trim() || '';

      let status = completed ? 'completed' : 'pending';
      if (annotation.toUpperCase() === 'CURRENT') status = 'in_progress';
      if (annotation.toUpperCase().startsWith('BLOCKED')) status = 'blocked';

      currentPhase.items.push({ text, completed, status });
    }
  }

  // Derive phase status from items
  for (const phase of phases) {
    if (phase.items.length === 0) continue;
    if (phase.items.every(i => i.completed)) phase.status = 'completed';
    else if (phase.items.every(i => i.status === 'blocked')) phase.status = 'blocked';
    else if (phase.items.some(i => i.status === 'in_progress')) phase.status = 'in_progress';
    else if (phase.items.some(i => i.completed)) phase.status = 'in_progress';
  }

  return { phases, hasPlan: true, raw: content };
}

function normalizeStatus(raw) {
  if (!raw) return 'pending';
  const lower = raw.toLowerCase();
  if (lower === 'completed' || lower === 'done') return 'completed';
  if (lower === 'in_progress' || lower === 'active') return 'in_progress';
  if (lower.startsWith('blocked')) return 'blocked';
  return 'pending';
}

/**
 * Get the current subtask the agent should be working on.
 * Returns the first non-completed item in the first non-completed phase.
 */
export function getCurrentSubtask() {
  const { phases, hasPlan } = parsePlan();
  if (!hasPlan) return null;

  for (const phase of phases) {
    if (phase.status === 'completed') continue;
    for (const item of phase.items) {
      if (!item.completed && item.status !== 'blocked') {
        return { phase: phase.name, task: item.text, status: item.status };
      }
    }
  }
  return null; // All done
}

/**
 * Generate a compact plan status string for the LLM prompt.
 */
export function getPlanStatusSummary() {
  const { phases, hasPlan } = parsePlan();
  if (!hasPlan) return 'No plan created yet. Create a plan in your first step.';

  const currentIndex = Math.max(0, phases.findIndex(p => p.status === 'in_progress' || p.status === 'pending'));
  const selected = phases.slice(currentIndex, currentIndex + 2);

  const lines = [];
  for (const phase of selected) {
    const icon = phase.status === 'completed' ? '✅' : phase.status === 'in_progress' ? '🔄' : '⏳';
    const done = phase.items.filter(i => i.completed).length;
    lines.push(`${icon} ${phase.name} (${done}/${phase.items.length})`);

    // Show pending items in active phase
    if (phase.status !== 'completed') {
      for (const item of phase.items) {
        const itemIcon = item.completed ? '  ✅' : item.status === 'in_progress' ? '  ▶️' : '  ⬜';
        lines.push(`${itemIcon} ${item.text}`);
      }
    }
  }

  return lines.join('\n');
}
