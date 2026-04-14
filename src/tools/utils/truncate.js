import config from '../../config.js';

export function truncateResult(text) {
  if (text.length <= config.maxToolOutputChars) return text;
  const half = Math.floor(config.maxToolOutputChars / 2);
  return text.slice(0, half) + `\n\n... [truncated ${text.length - config.maxToolOutputChars} chars] ...\n\n` + text.slice(-half);
}
