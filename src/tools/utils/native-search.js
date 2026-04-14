import fs from 'node:fs';
import path from 'node:path';

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  const normalized = String(glob || '*').replace(/\\/g, '/');
  const GLOBSTAR_DIR = '__GLOBSTAR_DIR__';
  const GLOBSTAR = '__GLOBSTAR__';

  let expr = normalized
    .replace(/\*\*\//g, GLOBSTAR_DIR)
    .replace(/\*\*/g, GLOBSTAR);

  expr = escapeRegex(expr)
    .replace(new RegExp(escapeRegex(GLOBSTAR_DIR), 'g'), '(?:.*/)?')
    .replace(new RegExp(escapeRegex(GLOBSTAR), 'g'), '.*')
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '[^/]');

  return new RegExp(`^${expr}$`);
}

function walkFiles(rootDir, out, relPrefix = '') {
  const entries = fs.readdirSync(path.join(rootDir, relPrefix), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.posix.join(relPrefix.replace(/\\/g, '/'), entry.name).replace(/^\/+/, '');
    if (entry.isDirectory()) {
      walkFiles(rootDir, out, rel);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

export function globFiles(dir, pattern = '*', maxResults = 300) {
  const files = [];
  walkFiles(dir, files);
  const regexp = globToRegExp(pattern || '*');
  return files.filter((rel) => regexp.test(rel)).slice(0, maxResults);
}

export function searchInDirectory(dir, query, opts = {}) {
  const {
    maxResults = 50,
    filePattern = '*',
    caseSensitive = false,
  } = opts;

  const results = [];
  const files = globFiles(dir, filePattern, 20000);
  const regexFlags = caseSensitive ? 'g' : 'gi';
  let regex = null;
  try {
    regex = new RegExp(String(query), regexFlags);
  } catch {
    regex = new RegExp(escapeRegex(String(query)), regexFlags);
  }

  for (const rel of files) {
    if (results.length >= maxResults) break;
    const abs = path.join(dir, rel);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        results.push({
          file: rel,
          line: i + 1,
          text: lines[i],
        });
        if (results.length >= maxResults) break;
      }
    }
  }

  return results;
}
