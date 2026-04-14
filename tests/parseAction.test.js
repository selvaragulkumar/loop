// tests/parseAction.test.js
// Comprehensive test suite for parseAction in src/loop.js
// Covers plain JSON, backticks/fences, embedded JSON, thinking blocks,
// truncated JSON repair, XML tool calls, error classifications, and file type recognition.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction } from '../src/loop.js';

// Helper: wraps parseAction, returns error message on throw
function parseAndExtract(input) {
  try {
    const result = parseAction(input);
    return { tool: result.tool, args: result.args, thought: result.thought, error: null };
  } catch (e) {
    return { tool: null, args: null, thought: null, error: e.message };
  }
}

describe('parseAction - Plain JSON Parsing', () => {
  test('1.1 Minimal valid action', () => {
    const { tool, args } = parseAndExtract('{"thought": "ok", "tool": "think", "args": {}}');
    assert.equal(tool, 'think');
    assert.deepEqual(args, {});
  });

  test('1.2 Action with args', () => {
    const { tool, args } = parseAndExtract('{"thought": "ok", "tool": "read_file", "args": {"path": "src/index.js"}}');
    assert.equal(tool, 'read_file');
    assert.equal(args.path, 'src/index.js');
  });

  test('1.3 Preserves thought field', () => {
    const { thought, tool } = parseAndExtract('{"thought": "all tasks complete", "tool": "finish", "args": {"summary": "done"}}');
    assert.equal(thought, 'all tasks complete');
    assert.equal(tool, 'finish');
  });

  test('1.4 Whitespace tolerance', () => {
    const { tool } = parseAndExtract('\n  {"thought": "ok", "tool": "think", "args": {}}  \n');
    assert.equal(tool, 'think');
  });

  test('1.5 Missing args defaults to empty object', () => {
    const { args } = parseAndExtract('{"thought": "x", "tool": "think"}');
    assert.deepEqual(args, {});
  });

  test('1.6 Non-object args defaults to empty object', () => {
    const { args } = parseAndExtract('{"thought": "x", "tool": "think", "args": "string"}');
    assert.deepEqual(args, {});
  });

  test('1.7 Array args defaults to empty object', () => {
    const { args } = parseAndExtract('{"thought": "x", "tool": "think", "args": [1, 2]}');
    assert.deepEqual(args, {});
  });

  test('1.8 Missing tool field throws SCHEMA_INVALID', () => {
    const { error } = parseAndExtract('{"thought": "x"}');
    assert.match(error, /SCHEMA_INVALID/);
  });
});

describe('parseAction - File Content with Backticks (Regression)', () => {
  test('2.1 write_file with markdown fences', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "README.md", "content": "# README\\n\\nInstall:\\n```bash\\nnpm install\\n```\\n\\nUsage:\\n```js\\nconst x = 1;\\n```\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'README.md');
    assert.ok(args.content.includes('```bash'));
    assert.ok(args.content.includes('```js'));
  });

  test('2.2 write_file with nested triple backticks', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "docs/example.md", "content": "Example:\\n````markdown\\n```json\\n{\\"key\\": \\"value\\"}\\n```\\n````\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('````markdown'));
    assert.ok(args.content.includes('```json'));
  });

  test('2.3 write_file with Python docstring + code fences', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "app.py", "content": "def foo():\\n    \\"\\"\\"This function does stuff.\\n    \\n    Example:\\n    ```python\\n    foo()\\n    ```\\n    \\"\\"\\"\\n    pass\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('```python'));
  });

  test('2.4 write_file with shell heredoc', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "run.sh", "content": "#!/bin/bash\\ncat <<EOF\\nHello world\\nEOF\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('cat <<EOF'));
  });

  test('2.5 write_file with Dockerfile', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "Dockerfile", "content": "FROM node:18\\nRUN apt-get update && \\\\\\n    apt-get install -y curl\\nCOPY . /app\\nCMD [\\"node\\", \\"index.js\\"]\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'Dockerfile');
  });

  test('2.6 write_file with JSON content (nested JSON)', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "package.json", "content": "{\\n  \\"name\\": \\"my-app\\",\\n  \\"version\\": \\"1.0.0\\"\\n}\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('"name": "my-app"'));
  });

  test('2.7 write_file with YAML content', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": ".github/workflows/ci.yml", "content": "name: CI\\non: [push]\\njobs:\\n  build:\\n    runs-on: ubuntu-latest\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, '.github/workflows/ci.yml');
  });

  test('2.8 write_file with HTML containing script tags', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "index.html", "content": "<!DOCTYPE html>\\n<html>\\n<body>\\n<script>\\n  const data = {\\"key\\": \\"value\\"};\\n</script>\\n</body>\\n</html>\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('<script>'));
  });

  test('2.9 write_file with CSS', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "style.css", "content": "body { margin: 0; }\\n.container { max-width: 1200px; }\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'style.css');
  });

  test('2.10 write_file with SQL', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "schema.sql", "content": "CREATE TABLE users (\\n  id INTEGER PRIMARY KEY,\\n  name TEXT NOT NULL\\n);\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'schema.sql');
  });

  test('2.11 write_file with TypeScript generics', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": "types.ts", "content": "interface Response<T> {\\n  data: T;\\n  error?: string;\\n}\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('Response<T>'));
  });

  test('2.12 write_file with .env content', () => {
    const input = '{"thought": "writing file", "tool": "write_file", "args": {"path": ".env", "content": "DATABASE_URL=postgres://localhost:5432/mydb\\nAPI_KEY=sk-test-12345\\nNODE_ENV=production\\n"}}';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, '.env');
  });
});

describe('parseAction - Fenced JSON Blocks', () => {
  test('3.1 ```json fence around action', () => {
    const input = '```json\n{"thought": "ok", "tool": "finish", "args": {"summary": "ok"}}\n```';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'finish');
    assert.equal(args.summary, 'ok');
  });

  test('3.2 ```javascript fence around action', () => {
    const input = '```javascript\n{"thought": "ok", "tool": "think", "args": {"thought": "hmm"}}\n```';
    const { tool } = parseAndExtract(input);
    assert.equal(tool, 'think');
  });

  test('3.3 Prose before fenced action', () => {
    const input = 'Here is my action:\n```json\n{"thought": "ok", "tool": "read_file", "args": {"path": "x.js"}}\n```';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'read_file');
    assert.equal(args.path, 'x.js');
  });

  test('3.4 Prose before AND after fenced action', () => {
    const input = 'I will list the directory.\n```json\n{"thought": "ok", "tool": "list_dir", "args": {"path": "."}}\n```\nThat should work.';
    const { tool } = parseAndExtract(input);
    assert.equal(tool, 'list_dir');
  });
});

describe('parseAction - JSON Embedded in Prose', () => {
  test('4.1 Action JSON after prose text', () => {
    const input = 'Let me think about this.\n{"thought": "reasoning", "tool": "think", "args": {"thought": "reasoning"}}';
    const { tool } = parseAndExtract(input);
    assert.equal(tool, 'think');
  });

  test('4.2 Action JSON between prose paragraphs', () => {
    const input = 'Analysis complete.\n{"thought": "ok", "tool": "finish", "args": {"summary": "done"}}\nEnd of response.';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'finish');
    assert.equal(args.summary, 'done');
  });

  test('4.3 Multiple JSON objects - picks first with tool field', () => {
    const input = 'Some text {"irrelevant": true} more text {"thought": "ok", "tool": "read_file", "args": {"path": "a.js"}} end';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'read_file');
    assert.equal(args.path, 'a.js');
  });
});

describe('parseAction - Thinking Blocks', () => {
  test('5.1 <think> block stripped, action after it parsed', () => {
    const input = '<think>Let me consider...</think>\n{"thought": "ok", "tool": "read_file", "args": {"path": "x.js"}}';
    const { tool } = parseAndExtract(input);
    assert.equal(tool, 'read_file');
  });

  test('5.2 <thinking> block stripped, action after it parsed', () => {
    const input = '<thinking>Deep thought here</thinking>\n{"thought": "ok", "tool": "finish", "args": {"summary": "done"}}';
    const { tool } = parseAndExtract(input);
    assert.equal(tool, 'finish');
  });

  test('5.3 Only thinking block with JSON inside extracts action', () => {
    const input = '<think>I should write the file. {"thought": "ok", "tool": "write_file", "args": {"path": "x.js", "content": "hello"}}</think>';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'x.js');
  });

  test('5.4 Only thinking block with no JSON synthesizes think action', () => {
    const input = '<think>Just reasoning with no action at all</think>';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'think');
    assert.ok(args.thought.includes('Just reasoning'));
  });
});

describe('parseAction - Truncated JSON Repair', () => {
  test('6.1 Missing closing brace is repaired', () => {
    const input = '{"thought": "ok", "tool": "think", "args": {}';
    const { tool } = parseAndExtract(input);
    assert.equal(tool, 'think');
  });

  test('6.2 Missing nested closing braces are repaired', () => {
    const input = '{"thought": "ok", "tool": "write_file", "args": {"path": "x.js", "content": "hi"';
    const { tool } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
  });

  test('6.3 Missing closing bracket and brace', () => {
    const input = '{"thought": "ok", "tool": "run_command", "args": {"cmd": "ls", "flags": ["-la"';
    const { tool } = parseAndExtract(input);
    assert.equal(tool, 'run_command');
  });

  test('6.4 Truncated inside string value is NOT repaired', () => {
    const input = '{"thought": "ok", "tool": "write_file", "args": {"path": "x.js", "content": "hello wor';
    const { error } = parseAndExtract(input);
    assert.ok(error, 'Should throw when truncated inside string');
  });
});

describe('parseAction - MiniMax XML Tool Calls', () => {
  test('7.1 Basic XML tool call', () => {
    const input = '<minimax:tool_call>\n<tool name="list_dir" path="."/>\n</tool>';
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'list_dir');
    assert.equal(args.path, '.');
  });

  test('7.2 XML tool call with thought text before it', () => {
    const input = 'I need to read the file.\n<minimax:tool_call>\n<tool name="read_file" path="src/index.js"/>';
    const { tool, args, thought } = parseAndExtract(input);
    assert.equal(tool, 'read_file');
    assert.equal(args.path, 'src/index.js');
    assert.ok(thought.includes('read the file'));
  });
});

describe('parseAction - Error Classifications', () => {
  test('8.1 Pure prose throws PROSE_ONLY_RESPONSE', () => {
    const { error } = parseAndExtract('I think we should implement the feature next.');
    assert.match(error, /PROSE_ONLY_RESPONSE/);
  });

  test('8.2 Invalid JSON with braces throws error', () => {
    const { error } = parseAndExtract('{not valid json at all}');
    assert.ok(error, 'Should throw for invalid JSON');
  });

  test('8.3 JSON without tool field throws SCHEMA_INVALID', () => {
    const { error } = parseAndExtract('{"thought": "x", "action": "read"}');
    assert.match(error, /SCHEMA_INVALID/);
  });

  test('8.4 Empty string throws', () => {
    const { error } = parseAndExtract('');
    assert.ok(error, 'Should throw for empty string');
  });

  test('8.5 Only whitespace throws', () => {
    const { error } = parseAndExtract('   \n\t  ');
    assert.ok(error, 'Should throw for whitespace only');
  });
});

describe('parseAction - Diverse File Types in write_file', () => {
  test('9.1 .gitignore', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: '.gitignore', content: 'node_modules/\ndist/\n*.log\n.env\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, '.gitignore');
    assert.ok(args.content.includes('node_modules/'));
  });

  test('9.2 Makefile', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'Makefile', content: '.PHONY: build test\n\nbuild:\n\tgcc -o main main.c\n\ntest: build\n\t./main --test\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('.PHONY'));
  });

  test('9.3 TOML config', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'pyproject.toml', content: '[tool.pytest.ini_options]\naddopts = "-v --tb=short"\ntestpaths = ["tests"]\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'pyproject.toml');
  });

  test('9.4 XML file', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'pom.xml', content: '<?xml version="1.0" encoding="UTF-8"?>\n<project>\n  <groupId>com.example</groupId>\n</project>\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('<?xml'));
  });

  test('9.5 Rust file', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'main.rs', content: 'fn main() {\n    let items: Vec<&str> = vec!["a", "b"];\n    println!("{:?}", items);\n}\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('Vec<&str>'));
  });

  test('9.6 Go file', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'main.go', content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello")\n}\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'main.go');
  });

  test('9.7 SVG file', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'icon.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">\n  <circle cx="12" cy="12" r="10"/>\n</svg>\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('<svg'));
  });

  test('9.8 Terraform file', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'main.tf', content: 'resource "aws_instance" "web" {\n  ami           = "ami-12345"\n  instance_type = "t2.micro"\n}\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'main.tf');
  });

  test('9.9 ESM JavaScript', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'utils.mjs', content: 'import { readFile } from "node:fs/promises";\n\nexport async function loadConfig(p) {\n  return JSON.parse(await readFile(p, "utf-8"));\n}\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('import'));
  });

  test('9.10 CSV data', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'data.csv', content: 'id,name,email\n1,Alice,alice@example.com\n2,"Bob, Jr.",bob@example.com\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.path, 'data.csv');
  });

  test('9.11 Nginx config', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'nginx.conf', content: 'server {\n    listen 80;\n    server_name example.com;\n    location / {\n        proxy_pass http://localhost:3000;\n    }\n}\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('proxy_pass'));
  });
});

describe('parseAction - Special Characters in File Content', () => {
  test('10.1 Backslashes (regex, Windows paths)', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'regex.js', content: 'const re = /\\d+\\.\\d+/;\nconst p = "C:\\\\Users\\\\dev";\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('\\d+'));
  });

  test('10.2 Unicode characters', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'i18n.js', content: '// 你好世界\nconst greeting = "こんにちは";\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('你好世界'));
  });

  test('10.3 Template literals with ${}', () => {
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'template.js', content: 'const msg = `Hello, ${name}!`;\n' } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.ok(args.content.includes('${name}'));
  });

  test('10.4 Large file content (10KB+)', () => {
    const line = 'const x = "abcdefghijklmnopqrstuvwxyz0123456789";\n';
    const content = line.repeat(200);
    const input = JSON.stringify({ thought: 'ok', tool: 'write_file', args: { path: 'big.js', content } });
    const { tool, args } = parseAndExtract(input);
    assert.equal(tool, 'write_file');
    assert.equal(args.content.length, content.length);
  });
});
