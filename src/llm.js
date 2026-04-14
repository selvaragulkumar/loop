// advanced-agent-loop/src/llm.js
// Minimal LLM client for vLLM / OpenAI-compatible endpoints.
// Zero dependencies — uses Node's native fetch.

import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

// ── LLM Output Logger ──────────────────────────────────────────
// Logs every LLM request/response to .agent/llm-log.jsonl for analysis.
let _logFile = null;

export function setLLMLogDir(workspace) {
  const agentDir = path.join(workspace, config.agentDir || '.agent');
  if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
  _logFile = path.join(agentDir, 'llm-log.jsonl');
}

function logLLMCall(entry) {
  if (!_logFile) return;
  try {
    fs.appendFileSync(_logFile, JSON.stringify(entry) + '\n');
  } catch { /* non-critical */ }
}

// Status codes that are safe to retry (transient server-side issues)
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 3;
// 429 rate-limits need much longer backoff — server may be saturated for minutes
const RATE_LIMIT_MAX_RETRIES = 8;
const RATE_LIMIT_BASE_DELAY_MS = 5000;

/**
 * fetch() wrapper with exponential backoff.
 * Retries on network errors (fetch failed / ECONNRESET / ETIMEDOUT) and
 * on retryable HTTP status codes (429, 5xx).
 * 429 gets extra-long retries (up to 8 attempts with 5s/10s/20s/40s... backoff).
 */
async function fetchWithRetry(url, opts) {
  let lastErr;
  let maxAttempts = MAX_RETRIES;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = lastErr?.is429
        ? Math.min(RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt - 1), 60000)
        : RETRY_DELAY_MS * attempt;
      const tag = lastErr?.is429 ? '429 rate-limit' : 'retry';
      console.error(`  [${tag}] waiting ${(delay / 1000).toFixed(0)}s before attempt ${attempt + 1}/${maxAttempts}...`);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const timeoutMs = parseInt(process.env.AGENT_LLM_TIMEOUT_MS || '120000', 10);
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      // 429 rate-limit — use extended retry budget
      if (res.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES - 1) {
        lastErr = Object.assign(new Error('HTTP 429'), { is429: true });
        maxAttempts = RATE_LIMIT_MAX_RETRIES;
        continue;
      }
      // Other retryable HTTP errors — standard retry budget
      if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES - 1) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      // Network error (fetch failed, ECONNRESET, etc.) — retry
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Send a chat completion request.
 * Retries once on transient HTTP errors (429, 5xx) before throwing.
 * @param {Array<{role:string, content:string}>} messages
 * @param {Object} opts - Override config for this call
 * @returns {Promise<{content:string, usage:{prompt_tokens:number, completion_tokens:number, total_tokens:number}}>}
 */
export async function chatCompletion(messages, opts = {}) {
  const url = `${opts.baseURL || config.baseURL}/chat/completions`;
  const body = {
    model: opts.model || config.model,
    messages,
    temperature: opts.temperature ?? config.temperature,
    max_tokens: opts.maxOutputTokens || config.maxOutputTokens,
    stream: false,
    // Disable extended thinking for Qwen/QwQ/DeepSeek/MiniMax when requested.
    // Without this, thinking tokens can consume the entire output budget before JSON is emitted.
    ...(process.env.AGENT_NO_THINKING === '1' && { chat_template_kwargs: { enable_thinking: false } }),
  };

  const requestOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  const apiKey = opts.apiKey ?? config.apiKey;
  if (apiKey) {
    requestOpts.headers.Authorization = `Bearer ${apiKey}`;
    requestOpts.headers['X-API-KEY'] = apiKey;
  }

  const res = await fetchWithRetry(url, requestOpts);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('LLM returned no choices');

  // Some thinking/reasoning models return content as an array of blocks
  // (e.g. {type:"thinking", thinking:"..."} + {type:"text", text:"..."})
  // Others separate reasoning into a `reasoning_content` field.
  let content = choice.message?.content;
  if (Array.isArray(content)) {
    // Keep only text blocks; skip thinking/reasoning blocks
    content = content
      .filter(block => block.type === 'text')
      .map(block => block.text || '')
      .join('');
  } else if (!content && choice.message?.reasoning_content) {
    // Fallback: some vLLM builds put the full output (thinking + action) in reasoning_content
    content = choice.message.reasoning_content;
  }

  const result = {
    content: content || '',
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    finishReason: choice.finish_reason || 'stop',
  };

  // Log full request/response for vLLM optimization
  logLLMCall({
    ts: new Date().toISOString(),
    model: body.model,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    prompt_tokens: result.usage.prompt_tokens,
    completion_tokens: result.usage.completion_tokens,
    total_tokens: result.usage.total_tokens,
    finish_reason: result.finishReason,
    input_messages: messages.map(m => ({ role: m.role, content_length: (m.content || '').length })),
    output_length: result.content.length,
    output_raw: result.content,
  });

  return result;
}

/**
 * Count characters across messages array (cheap token proxy).
 */
export function countMessageChars(messages) {
  return messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
}
