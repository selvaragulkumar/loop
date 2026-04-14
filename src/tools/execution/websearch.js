// src/tools/execution/websearch.js
// Web search via DuckDuckGo Instant Answers JSON API.
// Returns abstract text + top related topics — no API key required.

import { execFileSync } from 'node:child_process';

export const definition = {
  type: 'function',
  function: {
    name: 'websearch',
    description: 'Search the web using DuckDuckGo. Returns instant answer summary and related results. Best for factual lookups, library docs, error messages.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
};

export function handler({ query }) {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;
    const raw = execFileSync('curl', ['-s', '--max-time', '10', url], { encoding: 'utf-8', timeout: 12000 });
    const data = JSON.parse(raw);

    const results = [];

    if (data.AbstractText) {
      results.push(`**${data.Heading || query}**\n${data.AbstractText}`);
      if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
    }

    if (data.Answer) {
      results.push(`**Answer:** ${data.Answer}`);
    }

    const topics = (data.RelatedTopics || [])
      .filter(t => t.Text && t.FirstURL)
      .slice(0, 5)
      .map(t => `- ${t.Text.slice(0, 120)} (${t.FirstURL})`);

    if (topics.length > 0) {
      results.push(`\n**Related:**\n${topics.join('\n')}`);
    }

    if (results.length === 0) {
      return `No instant results for "${query}". Try webfetch with a specific documentation URL.`;
    }

    return results.join('\n\n');
  } catch (err) {
    return `Search error: ${err.message}`;
  }
}
