// advanced-agent-loop/src/parser.js
// Pure JSON/XML action parsing — zero dependencies.
// Extracted from loop.js for isolated testing and reduced blast radius.

/**
 * Strip inline thinking/reasoning blocks that models like MiniMax-M2.1 and
 * DeepSeek-R1 emit before the actual JSON action.
 * Handles: <think>...</think>, <thinking>...</thinking>
 */
function stripThinkingBlocks(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

export function parseAction(raw) {
  // Try to extract JSON from the response
  let text = raw.trim();

  // Capture thinking block content BEFORE stripping, so we can search inside it
  // if the model forgot to output the JSON action outside the thinking block.
  // MiniMax-M2.1 (REAP), DeepSeek-R1, QwQ and similar models emit
  // <think>...</think> wrapping their chain-of-thought inline in content.
  const thinkBlockMatch = text.match(/<think>([\s\S]*?)<\/think>/i)
    || text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  const thinkContent = thinkBlockMatch ? thinkBlockMatch[1].trim() : '';

  text = stripThinkingBlocks(text);

  // If the entire response was inside a thinking block (nothing left after strip),
  // try two fallbacks in order:
  //   1. Search inside the thinking content for a JSON tool action
  //   2. Synthesize a `think` action from the reasoning so the loop can continue
  if (!text.trim() && thinkContent) {
    const innerCandidates = extractJsonObjects(thinkContent);
    for (const candidate of innerCandidates) {
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === 'object' && obj.tool) {
          return {
            thought: obj.thought || thinkContent.slice(0, 200),
            tool: obj.tool,
            args: obj.args || {},
          };
        }
      } catch {
        // keep trying
      }
    }
    // No JSON action found inside thinking block — synthesize a think action so
    // the loop advances and the think-guard can break the stall next step.
    return {
      thought: thinkContent.slice(0, 300),
      tool: 'think',
      args: { thought: thinkContent.slice(0, 2000) },
    };
  }

  // ── Parsing order (IMPORTANT: JSON-first to avoid corrupting valid JSON) ─────
  // JSON string values may contain triple-backticks (e.g. write_file content with
  // markdown code fences). Extracting a "code block" before parsing would destroy
  // the JSON. So: try JSON.parse first, fall back to other strategies only on failure.

  let parsed;

  // 1. Direct JSON parse (handles trimmed JSON and JSON with leading/trailing whitespace)
  try {
    parsed = JSON.parse(text);
  } catch {
    // 1b. Conservative repair for responses that are complete except for missing
    // trailing braces/brackets/fences. This does NOT invent missing string content.
    const repaired = closeJsonContainersOnly(text);
    if (repaired) {
      try {
        const obj = JSON.parse(repaired);
        if (obj && typeof obj === 'object' && obj.tool) parsed = obj;
      } catch {
        // keep falling through to the normal recovery path
      }
    }

    // 2. Extract JSON objects from mixed text (e.g. prose + JSON on same response)
    //    Also try closeJsonContainersOnly on each candidate that fails to parse on
    //    its own — catches objects that extractJsonObjects found incomplete.
    if (!parsed) {
      const candidates = extractJsonObjects(text);
      for (const candidate of candidates) {
        try {
          const obj = JSON.parse(candidate);
          if (obj && typeof obj === 'object' && obj.tool) {
            parsed = obj;
            break;
          }
        } catch {
          // candidate failed strict parse — try repair on it
          const repairedCandidate = closeJsonContainersOnly(candidate);
          if (repairedCandidate) {
            try {
              const obj = JSON.parse(repairedCandidate);
              if (obj && typeof obj === 'object' && obj.tool) {
                parsed = obj;
                break;
              }
            } catch {
              // keep trying next candidate
            }
          }
        }
      }
    }

    // 3. Fenced-block unwrap — scan for ```json / ``` blocks anywhere in the text,
    //    not just when the response starts with a backtick. Handles cases like:
    //    "Here is my action:\n```json\n{...}\n```"
    if (!parsed) {
      let foundFencedInvalidJson = false;
      for (const fenceMatch of text.matchAll(/```(?:json|javascript|js)?\s*\n([\s\S]*?)\n?```/g)) {
        const inner = fenceMatch[1].trim();
        if (!inner) continue;
        try {
          const obj = JSON.parse(inner);
          if (obj && typeof obj === 'object' && obj.tool) {
            parsed = obj;
            break;
          }
        } catch {
          foundFencedInvalidJson = true;
          // try repair on fenced content too
          const repairedFence = closeJsonContainersOnly(inner);
          if (repairedFence) {
            try {
              const obj = JSON.parse(repairedFence);
              if (obj && typeof obj === 'object' && obj.tool) {
                parsed = obj;
                break;
              }
            } catch {
              // keep trying next fence
            }
          }
        }
      }

      // If we found fenced content but it was invalid JSON, record that for classification
      if (!parsed && foundFencedInvalidJson) {
        // Will be caught below in the failure classification block
        parsed = null;
      }
    }

    if (!parsed) {
      // 4. MiniMax-style XML tool calls
      const xmlAction = parseMiniMaxToolCall(text);
      if (xmlAction) {
        parsed = xmlAction;
      } else {
        // ── Structured failure classification ───────────────────────────────
        // Classify the parse failure so buildParseRecoveryGuidance can give
        // targeted feedback instead of a generic "no JSON found" message.
        const hasBrace = text.includes('{');
        const isTruncatedString = (() => {
          // Re-run char scanner to check if we ended inside a string literal
          let inStr = false, esc = false;
          for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
              if (esc) { esc = false; }
              else if (ch === '\\') { esc = true; }
              else if (ch === '"') { inStr = false; }
            } else if (ch === '"') { inStr = true; }
          }
          return inStr;
        })();
        const hasFencedBlock = /```(?:json|javascript|js)?\s*\n[\s\S]*?```/g.test(text);
        const candidateCount = extractJsonObjects(text).length;

        let classification;
        if (!hasBrace) {
          classification = 'PROSE_ONLY_RESPONSE';
        } else if (isTruncatedString) {
          classification = 'TRUNCATED_STRING';
        } else if (hasFencedBlock) {
          classification = 'FENCED_JSON_INVALID';
        } else if (candidateCount > 1) {
          classification = 'MULTIPLE_JSON_OBJECTS';
        } else {
          classification = 'NO_JSON_FOUND';
        }
        throw new Error(`${classification}: No valid JSON action found in response`);
      }
    }
  }

  if (!parsed.tool) throw new Error('SCHEMA_INVALID: Missing "tool" field in response');

  return {
    thought: parsed.thought || '',
    tool: parsed.tool,
    // Normalize args: if model returned a non-object (string, array, null), default to {}
    args: (parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args))
      ? parsed.args
      : {},
  };
}

function parseMiniMaxToolCall(text) {
  // Supports forms like:
  // <minimax:tool_call>
  // <tool name="list_dir"\npath="."/>
  // </tool>
  // or self-closed <tool .../>
  const attrsBlob = extractToolAttrsBlob(text);
  if (!attrsBlob) return null;

  const attrs = extractXmlAttributes(attrsBlob);
  const tool = attrs.name || extractLooseXmlAttribute(attrsBlob, 'name');
  if (!tool) return null;

  delete attrs.name;

  // If args is provided as JSON string, merge it.
  let args = { ...attrs };
  const rawArgsAttr = typeof attrs.args === 'string' ? attrs.args : extractLooseXmlAttribute(attrsBlob, 'args');
  if (typeof rawArgsAttr === 'string') {
    try {
      const parsedArgs = JSON.parse(rawArgsAttr);
      if (parsedArgs && typeof parsedArgs === 'object') {
        args = { ...attrs, ...parsedArgs };
      }
    } catch {
      // keep raw args string if not valid JSON
    }
    delete args.args;
  }

  const thought = text.split(/<minimax:tool_call>|<tool\s+/i)[0].trim();
  return { thought, tool, args };
}

function extractXmlAttributes(blob) {
  const attrs = {};
  const re = /(\w+)=(?:"([\s\S]*?)"|'([\s\S]*?)')/g;
  let match;
  while ((match = re.exec(blob)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? '';
    attrs[key] = value;
  }
  return attrs;
}

function extractToolAttrsBlob(text) {
  const openIndex = text.search(/<tool\b/i);
  if (openIndex === -1) return '';

  const selfCloseIndex = text.indexOf('/>', openIndex);
  const closeTagIndex = text.indexOf('>', openIndex);
  if (selfCloseIndex !== -1 && (closeTagIndex === -1 || selfCloseIndex < closeTagIndex + 2000)) {
    return text.slice(openIndex, selfCloseIndex + 2).replace(/^<tool\s*/i, '').replace(/\/>$/, '').trim();
  }

  if (closeTagIndex === -1) return '';
  return text.slice(openIndex, closeTagIndex + 1).replace(/^<tool\s*/i, '').replace(/>$/, '').trim();
}

function extractLooseXmlAttribute(blob, key) {
  const regex = new RegExp(`${key}\\s*=\\s*(?:"([\\s\\S]*?)"|'([\\s\\S]*?)'|(\\{[\\s\\S]*?\\})(?=\\s+\\w+\\s*=|$))`, 'i');
  const match = blob.match(regex);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

/**
 * Truncate text at maxChars without breaking UTF-16 surrogate pairs.
 */
export function safeSlice(str, maxChars) {
  const text = String(str || '');
  if (text.length <= maxChars) return text;
  let end = maxChars;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end--;
    else break;
  }
  return text.slice(0, end);
}

function extractJsonObjects(text, maxObjects = 8) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        out.push(text.slice(start, i + 1));
        start = -1;
        if (out.length >= maxObjects) break;
      }
    }
  }

  return out;
}

function closeJsonContainersOnly(text) {
  const src = String(text || '').trim();
  if (!src.startsWith('{') || !/"tool"\s*:/.test(src)) return '';

  let depthCurly = 0;
  let depthSquare = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depthCurly++;
    else if (ch === '}') depthCurly = Math.max(0, depthCurly - 1);
    else if (ch === '[') depthSquare++;
    else if (ch === ']') depthSquare = Math.max(0, depthSquare - 1);
  }

  // If the response was cut off inside a string, do not guess the remainder.
  if (inString) return '';

  if (depthCurly === 0 && depthSquare === 0) return '';
  return `${src}${']'.repeat(depthSquare)}${'}'.repeat(depthCurly)}`;
}
