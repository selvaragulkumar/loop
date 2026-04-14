// central tool entry-point
// built-in tool definitions/handlers come from routing/toolRegistry.js
// so there is a single source of truth for tool registration.

import { isSkillTool, executeSkill } from '../skills.js';
import { executeRegistryTool, TOOL_DEFINITIONS } from '../routing/toolRegistry.js';
import { withToolGuidance } from './utils/guidance.js';
import { truncateResult } from './utils/truncate.js';

export { TOOL_DEFINITIONS };

export function executeTool(name, args) {
  try {
    if (isSkillTool(name)) {
      return executeSkill(name, args);
    }

    const out = executeRegistryTool(name, args);
    const result = truncateResult(String(out?.result ?? ''));
    if (out?.error) {
      return { result: withToolGuidance(name, result), error: true };
    }
    return { result, error: false };
  } catch (err) {
    return { result: withToolGuidance(name, `Tool error (${name}): ${err.message}`), error: true };
  }
}

