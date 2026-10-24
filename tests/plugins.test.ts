// Plugin loader tests: frontmatter, $ARGUMENTS, commands/agents/skills dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseFrontmatter,
  loadAgents,
  loadCommands,
  loadSkills,
  substituteArguments,
} from '../src/plugins/loader.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-plugins-'));

test('frontmatter parses yaml-lite key: value block', () => {
  const { data, body } = parseFrontmatter(
    '---\ndescription: Greet people\nname: greeter\n---\n\nBody here.\n',
  );
  assert.equal(data.description, 'Greet people');
  assert.equal(data.name, 'greeter');
  assert.match(body, /^Body here\./);
});

test('frontmatter absent or unterminated -> raw body, empty data', () => {
  assert.deepEqual(parseFrontmatter('just text').data, {});
  assert.equal(parseFrontmatter('just text').body, 'just text');
  const unterminated = parseFrontmatter('---\nno end here');
  assert.deepEqual(unterminated.data, {});
});

test('substituteArguments fills $ARGUMENTS and $N', () => {
  const out = substituteArguments('Hello $ARGUMENTS (first: $1)', 'world and friends');
  assert.equal(out, 'Hello world and friends (first: world)');
});

test('loadCommands merges project over user dir', () => {
  fs.mkdirSync(path.join(tmp, '.ardan', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.ardan', 'commands', 'deploy.md'),
    '---\ndescription: Ship it\n---\nDeploy $ARGUMENTS now.\n',
  );
  const commands = loadCommands(tmp);
  const deploy = commands.find((c) => c.name === 'deploy');
  assert.ok(deploy, 'deploy command found');
  assert.equal(deploy.description, 'Ship it');
  assert.match(deploy.prompt, /Deploy \$ARGUMENTS now/);
});

test('loadAgents reads frontmatter (name, tools, maxTurns, bypass)', () => {
  fs.mkdirSync(path.join(tmp, '.ardan', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.ardan', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmaxTurns: 3\npermissionMode: default\n---\nBe rigorous.\n',
  );
  const agents = loadAgents(tmp);
  const reviewer = agents.find((a) => a.name === 'reviewer');
  assert.ok(reviewer);
  assert.equal(reviewer.description, 'Reviews code');
  assert.deepEqual(reviewer.tools, ['Read', 'Grep']);
  assert.equal(reviewer.maxTurns, 3);
  assert.equal(reviewer.permissionMode, 'default');
  assert.match(reviewer.prompt, /Be rigorous/);
});

test('loadSkills discovers SKILL.md with allowed-tools + user-invocable', () => {
  fs.mkdirSync(path.join(tmp, '.ardan', 'skills', 'release'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.ardan', 'skills', 'release', 'SKILL.md'),
    '---\nname: release\ndescription: Cut a release\nallowed-tools: Bash, Read\nuser-invocable: true\n---\nSteps: bump version, tag.\n',
  );
  const skills = loadSkills(tmp);
  const release = skills.find((s) => s.name === 'release');
  assert.ok(release);
  assert.equal(release.description, 'Cut a release');
  assert.deepEqual(release.allowedTools, ['Bash', 'Read']);
  assert.equal(release.userInvocable, true);
  assert.match(release.file, /SKILL\.md$/);
});
