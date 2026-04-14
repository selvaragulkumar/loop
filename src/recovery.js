// advanced-agent-loop/src/recovery.js
// Recovery guidance builders — targeted hints for parse failures, tool errors,
// and verification repair mode.
// Extracted from loop.js for isolated testing and reduced blast radius.

import { inspectStageState } from './stages.js';
import { normalizeCommandForComparison } from './guards.js';

// ── Private Helpers ──────────────────────────────────────────

function extractWorkspacePaths(text) {
  const matches = String(text || '').match(/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:js|mjs|cjs|json|md|txt|csv)/g) || [];
  return [...new Set(matches)];
}

function getLockedWorkspaceRoot(stageState) {
  return (stageState?.lockedTargets || []).find((item) => !/\/[^/]+\.[A-Za-z0-9]+$/.test(String(item || ''))) || '';
}

function isVerificationRepairCandidate(command, stageState) {
  const text = String(command || '');
  const lockedRoot = getLockedWorkspaceRoot(stageState);
  if (/\bnode\s+--test\b/.test(text)) return true;
  if (lockedRoot && text.includes(lockedRoot)) return true;
  const targets = extractWorkspacePaths(text);
  return targets.some((target) => lockedRoot && target.startsWith(lockedRoot));
}

function contentClaimsSuccess(text) {
  const value = String(text || '');
  return /\bbuild status:\s*passed\b|\bfinal verdict\b[\s\S]{0,80}\bpass\b|\ball tests passed\b|\bvalidation (?:is )?(?:passed|successful)\b|\bfully functional\b/i.test(value)
    || /"overall"\s*:\s*"PASS"/.test(value)
    || /"status"\s*:\s*"PASS"/.test(value);
}

// ── Exported Guidance Builders ───────────────────────────────

export function getRequiredVerificationFailure(action, stageState, resultText) {
  if (action?.tool !== 'run_command' || stageState?.currentStage !== 'verification') return null;
  const executed = normalizeCommandForComparison(action.args?.command || '');
  if (!executed) return null;
  const required = (stageState.requiredCommands || []).find((command) => {
    const target = normalizeCommandForComparison(command);
    return isVerificationRepairCandidate(command, stageState)
      && (executed === target || executed.includes(target) || target.includes(executed));
  });
  if (!required) return null;
  return {
    command: required,
    targets: extractWorkspacePaths(`${action.args?.command || ''}\n${resultText || ''}`),
  };
}

export function buildParseRecoveryGuidance(rawResponse, errorMessage, parseErrorStreak) {
  const snippet = String(rawResponse || '').slice(0, 280).replace(/\s+/g, ' ').trim();
  const driftedIntoSummary = /summary of the work history|runtime anchor|previous work summary|complete, updated summary|new steps to summarize|looking at the current state|from the context|let me analyze the current situation/i.test(String(rawResponse || ''));
  const strict = parseErrorStreak >= 3
    ? 'You have repeated protocol failures. Do NOT add prose, markdown, or XML. Return exactly one JSON object.'
    : 'Return one tool action in the required protocol format.';

  // Extract classification prefix from structured error messages (e.g. "TRUNCATED_STRING: ...")
  const classMatch = String(errorMessage || '').match(/^([A-Z_]+):/);
  const classification = classMatch ? classMatch[1] : '';

  let classificationHint = '';
  switch (classification) {
    case 'PROSE_ONLY_RESPONSE':
      classificationHint = 'Your entire response was prose with no JSON object. Respond with ONLY a JSON object — no text before or after it.';
      break;
    case 'TRUNCATED_STRING':
      classificationHint = 'Your JSON was cut off mid-string — the file content payload was too large for one response. Use edit_file instead, or split the write into smaller chunks. Do NOT repeat the same large write_file call.';
      break;
    case 'FENCED_JSON_INVALID':
      classificationHint = 'You wrapped your response in ```json``` fences but the JSON inside was invalid. Remove the fences and output raw JSON only.';
      break;
    case 'MULTIPLE_JSON_OBJECTS':
      classificationHint = 'Multiple JSON objects were found in your response. Return exactly one JSON object — no more.';
      break;
    case 'SCHEMA_INVALID':
      classificationHint = 'A JSON object was parsed but it is missing the required "tool" field. Use {"thought":"...","tool":"tool_name","args":{}}.';
      break;
    default:
      classificationHint = '';
  }

  return [
    `Protocol parse failure (${errorMessage}).`,
    classificationHint,
    strict,
    parseErrorStreak >= 3 ? 'You are in a parse-error burst. Stop reconstructing state from scratch; use the visible runtime blocker and emit one exact JSON tool call.' : '',
    driftedIntoSummary ? 'You drifted into summarizing the runtime/context. Do NOT summarize the work history. Use the blocker to choose one concrete tool call.' : '',
    'Accepted format: {"thought":"...","tool":"list_dir","args":{"path":"."}}',
    `Last response snippet: ${snippet}`,
  ].filter(Boolean).join(' ');
}

export function applyVerificationRepairToolFilter(tools, stageState) {
  if (!stageState?.repairModeActive) return tools;
  const allow = new Set(['read_file', 'edit_file', 'write_file', 'run_command', 'update_plan', 'finish']);
  return tools.filter((tool) => allow.has(tool.function.name));
}

export function buildPrematureSuccessArtifactBlock(action, stageState, workspace) {
  if (!stageState || !workspace) return '';
  if (!['write_file', 'edit_file'].includes(action?.tool)) return '';
  if (!['verification', 'finalization'].includes(stageState.currentStage)) return '';

  const targetPath = String(action.args?.path || '');
  if (!targetPath || !(stageState.requiredOutputs || []).includes(targetPath)) return '';

  const runtime = inspectStageState(stageState, workspace);
  if (runtime.missingCommandEvidence.length === 0 && runtime.invalidVerificationArtifacts.length === 0) return '';

  const proposedText = action.tool === 'write_file' ? action.args?.content : action.args?.newString;
  if (!contentClaimsSuccess(proposedText)) return '';

  return `Verification is still incomplete (${[...runtime.invalidVerificationArtifacts, ...runtime.missingCommandEvidence].join('; ')}). Do not write success-claiming result artifacts yet. Repair the failing implementation/test files and rerun the missing verification command first.`;
}

export function buildToolFailureGuidance(action, resultText, stageState = null) {
  const text = String(resultText || '');
  const hintMatch = text.match(/\[Tool Guidance\][\s\S]*?Hint:\s*(.+)/i);
  if (hintMatch?.[1]) return hintMatch[1].trim();
  if (/Cannot read properties of undefined \(reading ['"]includes['"]\)/i.test(text)) {
    return 'A JS interface mismatch is likely: one file is consuming a value in a different shape than another file produces it. Re-read the producer and consumer files, align the returned object/array contract, then rerun the exact failing command once.';
  }
  if (/EDIT_ERROR_STRING_NOT_FOUND|string not found in/i.test(text)) {
    return 'The edit target did not match exact file text. Re-read a narrower line range around the intended change using read_file with startLine/endLine, then retry with the exact snippet or use write_file for a full rewrite if the change is broad.';
  }
  if (action?.tool === 'run_command' && /Exit code \d+:/i.test(text) && stageState?.currentStage === 'verification') {
    const targets = extractWorkspacePaths(`${action.args?.command || ''}\n${text}`);
    if (targets.length > 0) {
      return `A required verification command failed. Do not summarize or finalize. Read the failing workspace files directly (${targets.join(', ')}), repair the implementation/test mismatch, then rerun this exact validation command once.`;
    }
    if (stageState?.repairModeActive && stageState.relatedRepairTargets?.length) {
      return `A required verification command failed. Stay in local repair mode. Read these files directly (${stageState.relatedRepairTargets.join(', ')}), make one concrete fix, then rerun the same validation command once.`;
    }
  }
  if (/Exit code \d+:/i.test(text) && /(tests? failed|✖|failing tests|assertion|expected .* got)/i.test(text)) {
    return 'A validation command failed. Do not finalize. Inspect the failing assertion/output, read the referenced implementation and test files, repair the code or test so they agree, then rerun this exact validation command once.';
  }
  if (/Exit code \d+:/i.test(text)) {
    return 'The command failed. Inspect the failing output carefully, repair the underlying file or command arguments, then rerun the exact validation command once.';
  }
  return '';
}

export function buildCompletionGuardRecoveryGuidance(guardMessage) {
  const text = String(guardMessage || '').trim();
  if (!text) return '';

  if (text.startsWith('Cannot finish: missing required outputs:')) {
    const missing = text.replace('Cannot finish: missing required outputs:', '').trim();
    return `Finish blocked. Create or populate these required outputs before finishing: ${missing}. After writing them, re-read each required file once to confirm it is non-empty, then call finish again.`;
  }

  if (text.startsWith('Cannot finish: output contract not satisfied:')) {
    const issues = text.replace('Cannot finish: output contract not satisfied:', '').trim();
    return `Finish blocked. Repair these output contract issues: ${issues}. Fix the named files with write_file or edit_file, then re-read each affected file once and finish. Do not repeat the same read_file call without an intervening change.`;
  }

  return `Finish blocked. ${text}`;
}
