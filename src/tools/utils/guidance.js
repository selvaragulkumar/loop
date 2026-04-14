export function withToolGuidance(toolName, rawResult) {
  const text = String(rawResult || '');
  const guidance = classifyToolGuidance(toolName, text);
  if (!guidance) return text;
  return `${text}\n\n[Tool Guidance]\nRetryable: ${guidance.retryable ? 'yes' : 'no'}\nHint: ${guidance.hint}`;
}

export function classifyToolGuidance(toolName, text) {
  const lower = text.toLowerCase();

  if (lower.includes('unknown tool')) {
    return {
      retryable: false,
      hint: 'Do NOT retry the same call. Use one of the available tools listed in the system prompt.',
    };
  }

  if (toolName === 'read_file' && lower.includes('eisdir')) {
    return {
      retryable: false,
      hint: 'Target is a directory, not a file. Use list_dir on that path, then read an actual file path.',
    };
  }

  if (toolName === 'read_file' && lower.includes('file not found')) {
    return {
      retryable: false,
      hint: 'Path does not exist. Use list_dir/search_files first and then retry with the resolved path.',
    };
  }

  if (toolName.startsWith('skill_') && lower.includes('already been declared')) {
    return {
      retryable: false,
      hint: 'Skill implementation has a declaration conflict. Do NOT retry unchanged; edit/recreate the skill code first.',
    };
  }

  if (toolName === 'run_command' && lower.includes('exit code')) {
    return {
      retryable: false,
      hint: 'Command failed. Inspect stderr/stdout in this result and modify the command or inputs before retrying.',
    };
  }

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return {
      retryable: true,
      hint: 'Likely transient timeout. Retry once or simplify/split the operation if it keeps failing.',
    };
  }

  return null;
}
