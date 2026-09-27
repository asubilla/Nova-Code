import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = path.join(repoRoot, '.opencode', 'agent');
const commandDir = path.join(repoRoot, '.opencode', 'commands');

const VALID_MODES = new Set(['primary', 'subagent', 'all', 'build', 'plan', 'bypassPermissions']);
const VALID_PERMISSION_VALUES = new Set(['allow', 'deny', 'ask']);
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

const SPECIALISTS = ['code-reviewer', 'test-writer', 'debugger', 'docs-writer', 'security-auditor'];

// Commands that must fan out at least one specialist by path.
const COMMAND_WIRING = {
  'bug-work.md': ['debugger', 'test-writer', 'code-reviewer'],
  'feature-work.md': ['test-writer', 'code-reviewer', 'security-auditor'],
  'maintenance-review.md': ['code-reviewer', 'security-auditor'],
  'as-fixes.md': ['code-reviewer', 'security-auditor'],
  'rd-fixes.md': ['code-reviewer', 'security-auditor'],
  'rd-follow-up.md': ['code-reviewer', 'security-auditor'],
  'as-follow-up.md': ['code-reviewer', 'security-auditor'],
  'docs-sync.md': ['docs-writer'],
  'triage-issues.md': ['issue-intake', 'debugger'],
};

// Specialists that must carry direct .agents/skills path pointers in their body.
const SKILL_POINTERS = {
  'code-reviewer.md': ['novacode-change-discipline'],
  'debugger.md': ['sync-state-invariants', 'performance-engineering', 'isolated-space-boundary'],
  'security-auditor.md': ['isolated-space-boundary', 'desktop-shell'],
  'test-writer.md': ['novacode-change-discipline'],
  'docs-writer.md': ['writing-for-agents', 'communication-style'],
};

const parseAgentFile = (filePath) => {
  const source = readFileSync(filePath, 'utf8');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(match, `${path.basename(filePath)}: missing YAML frontmatter delimited by ---`);
  const frontmatter = parse(match[1]);
  assert.ok(frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter),
    `${path.basename(filePath)}: frontmatter is not a mapping`);
  return { frontmatter, body: (match[2] ?? '').trim(), source };
};

const assertPermissionShape = (permission, label) => {
  if (permission === 'allow' || permission === 'deny' || permission === 'ask') return;
  assert.ok(permission && typeof permission === 'object' && !Array.isArray(permission),
    `${label}: permission must be allow|deny|ask or a mapping`);
  for (const [key, value] of Object.entries(permission)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [pattern, rule] of Object.entries(value)) {
        assert.ok(VALID_PERMISSION_VALUES.has(rule),
          `${label}: permission.${key}["${pattern}"] must be allow|deny|ask, got ${JSON.stringify(rule)}`);
      }
      continue;
    }
    assert.ok(VALID_PERMISSION_VALUES.has(value),
      `${label}: permission.${key} must be allow|deny|ask, got ${JSON.stringify(value)}`);
  }
};

test('every .opencode/agent file has valid frontmatter and a non-empty body', () => {
  const files = readdirSync(agentDir).filter((name) => name.endsWith('.md')).sort();
  assert.ok(files.length >= 11, `expected at least 11 agents, found ${files.length}: ${files.join(', ')}`);

  const seenModes = new Set();
  for (const name of files) {
    const { frontmatter, body } = parseAgentFile(path.join(agentDir, name));
    const label = `agent/${name}`;

    assert.ok(typeof frontmatter.mode === 'string' && VALID_MODES.has(frontmatter.mode),
      `${label}: mode must be one of ${[...VALID_MODES].join('|')}, got ${JSON.stringify(frontmatter.mode)}`);
    seenModes.add(frontmatter.mode);

    if (frontmatter.hidden === true) {
      // Hidden primary agents (issue-intake, summarize, bots) are invoked by workflow, not discovered by description.
    } else {
      assert.ok(typeof frontmatter.description === 'string' && frontmatter.description.trim().length >= 20,
        `${label}: visible agents need a non-trivial description`);
    }

    if (frontmatter.color !== undefined) {
      assert.match(String(frontmatter.color), HEX_COLOR, `${label}: color must be a hex color`);
    }
    if (frontmatter.hidden !== undefined) {
      assert.equal(typeof frontmatter.hidden, 'boolean', `${label}: hidden must be boolean`);
    }
    if (frontmatter.model !== undefined) {
      assert.ok(typeof frontmatter.model === 'string' && frontmatter.model.includes('/'),
        `${label}: model must be a provider/model string`);
    }
    if (frontmatter.permission !== undefined) {
      assertPermissionShape(frontmatter.permission, label);
    }

    const minBody = frontmatter.hidden === true ? 40 : 100;
    assert.ok(body.length >= minBody, `${label}: body is too short to be a usable prompt (${body.length} chars)`);
  }

  assert.ok(seenModes.has('subagent'), 'at least one subagent-mode agent is expected');
});

test('the five specialist agents exist with subagent mode and scoped permissions', () => {
  for (const name of SPECIALISTS) {
    const filePath = path.join(agentDir, `${name}.md`);
    const { frontmatter, body } = parseAgentFile(filePath);
    const label = `agent/${name}.md`;

    assert.equal(frontmatter.mode, 'subagent', `${label}: specialists are subagents`);
    assert.equal(frontmatter.hidden, undefined, `${label}: specialists stay visible for discovery`);

    assert.ok(frontmatter.permission && typeof frontmatter.permission === 'object',
      `${label}: must declare an explicit permission map`);
    assert.equal(frontmatter.permission.edit === 'deny' || frontmatter.permission.edit === 'allow', true,
      `${label}: permission.edit must be allow or deny`);
    assert.equal(frontmatter.permission.task, 'deny', `${label}: specialists must not spawn nested tasks`);
    assert.equal(frontmatter.permission.external_directory, 'deny',
      `${label}: specialists stay inside the workspace`);

    const readOnly = name === 'code-reviewer' || name === 'debugger' || name === 'security-auditor';
    if (readOnly) {
      assert.equal(frontmatter.permission.edit, 'deny', `${label}: read-only specialist must deny edit`);
    }

    assert.match(body, /AGENTS\.md/, `${label}: must follow AGENTS.md instruction order`);
    assert.ok(!/\bTODO\b|\bTBD\b/.test(body), `${label}: body must not contain TODO/TBD placeholders`);
  }
});

test('specialist prompts stay non-overlapping on their primary job', () => {
  const roles = {
    'code-reviewer': /Review only|classified findings/i,
    'test-writer': /Write tests|regression coverage/i,
    debugger: /root-cause|You diagnose/i,
    'docs-writer': /documentation|DOCUMENTATION\.md/i,
    'security-auditor': /security|supply-chain/i,
  };
  for (const [name, pattern] of Object.entries(roles)) {
    const { body } = parseAgentFile(path.join(agentDir, `${name}.md`));
    assert.match(body, pattern, `${name}.md: body must state its primary job`);
  }
});

test('every skill referenced by an agent exists under .agents/skills', () => {
  const skillRoot = path.join(repoRoot, '.agents', 'skills');
  const available = new Set(readdirSync(skillRoot).filter((name) => {
    try {
      return readFileSync(path.join(skillRoot, name, 'SKILL.md'), 'utf8').length > 0;
    } catch {
      return false;
    }
  }));

  const files = readdirSync(agentDir).filter((name) => name.endsWith('.md'));
  for (const name of files) {
    const source = readFileSync(path.join(agentDir, name), 'utf8');
    const pointers = [...source.matchAll(/\.agents\/skills\/([a-z0-9-]+)\/SKILL\.md/g)].map((m) => m[1]);
    for (const skill of pointers) {
      assert.ok(available.has(skill), `agent/${name}: references missing skill "${skill}"`);
    }
  }
});

test('every .opencode/commands file has a non-empty description', () => {
  const files = readdirSync(commandDir).filter((name) => name.endsWith('.md')).sort();
  assert.ok(files.length >= 9, `expected at least 9 commands, found ${files.length}`);
  for (const name of files) {
    const { frontmatter, body } = parseAgentFile(path.join(commandDir, name));
    assert.ok(typeof frontmatter.description === 'string' && frontmatter.description.trim().length > 0,
      `commands/${name}: description is required`);
    assert.ok(body.length >= 40, `commands/${name}: body too short`);
  }
});

test('opencode.json parses and carries power-up keys (permission, small_model, instructions)', () => {
  const config = JSON.parse(readFileSync(path.join(repoRoot, '.opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.ok(config.lsp && typeof config.lsp === 'object');
  assert.equal(config.agent, undefined, 'agents live as .opencode/agent/*.md, not inline in opencode.json');

  assert.ok(typeof config.small_model === 'string' && config.small_model.includes('/'),
    'small_model must be a provider/model string');
  assert.ok(Array.isArray(config.instructions) && config.instructions.includes('AGENTS.md'),
    'instructions must include AGENTS.md');

  assert.ok(config.permission && typeof config.permission === 'object', 'permission defaults required');
  assertPermissionShape(config.permission, 'opencode.json permission');
  assert.equal(config.permission.edit, 'ask', 'global edit default is ask (agents may override)');
  assert.equal(config.permission.external_directory, 'ask');
  assert.equal(config.permission.bash['*'], 'ask');
  assert.equal(config.permission.bash['git status*'], 'allow');
});

test('commands fan out specialists by path', () => {
  for (const [command, agents] of Object.entries(COMMAND_WIRING)) {
    const source = readFileSync(path.join(commandDir, command), 'utf8');
    for (const agent of agents) {
      assert.match(source, new RegExp(`\\.opencode/agent/${agent}\\.md`),
        `commands/${command}: must reference .opencode/agent/${agent}.md`);
    }
  }
});

test('specialist bodies carry direct skill path pointers', () => {
  for (const [file, skills] of Object.entries(SKILL_POINTERS)) {
    const source = readFileSync(path.join(agentDir, file), 'utf8');
    for (const skill of skills) {
      assert.match(source, new RegExp(`\\.agents/skills/${skill}/SKILL\\.md`),
        `agent/${file}: must point at .agents/skills/${skill}/SKILL.md`);
    }
  }
});

test('pr-reviewer carries an explicit read-only permission map', () => {
  const { frontmatter } = parseAgentFile(path.join(agentDir, 'pr-reviewer.md'));
  assert.ok(frontmatter.permission && typeof frontmatter.permission === 'object',
    'agent/pr-reviewer.md: must declare an explicit permission map');
  assert.equal(frontmatter.permission.edit, 'deny');
  assert.equal(frontmatter.permission.task, 'deny');
  assert.equal(frontmatter.permission.external_directory, 'deny');
  assert.equal(frontmatter.permission.bash['*'], 'deny');
  assert.equal(frontmatter.permission.bash['gh pr *'], 'allow');
});

test('docs-writer routes to the cheap model; judgment specialists inherit the chat model', () => {
  const docs = parseAgentFile(path.join(agentDir, 'docs-writer.md'));
  assert.equal(docs.frontmatter.model, 'opencode-go/mimo-v2.5',
    'docs-writer uses the small model (writing, not verdicts)');

  for (const name of ['code-reviewer', 'debugger', 'security-auditor', 'pr-reviewer', 'test-writer']) {
    const { frontmatter } = parseAgentFile(path.join(agentDir, `${name}.md`));
    assert.equal(frontmatter.model, undefined,
      `agent/${name}.md: judgment/work agents inherit the chat model — never force a small model`);
  }
});

test('triage-issues skill and command both name issue-intake and debugger fan-out', () => {
  const skill = readFileSync(path.join(repoRoot, '.agents', 'skills', 'triage-issues', 'SKILL.md'), 'utf8');
  for (const agent of ['issue-intake', 'debugger']) {
    assert.match(skill, new RegExp(`\\.opencode/agent/${agent}\\.md`),
      `triage-issues SKILL.md: must point at .opencode/agent/${agent}.md`);
  }
  assert.match(skill, /never hand verdicts to a smaller model/i);
});
