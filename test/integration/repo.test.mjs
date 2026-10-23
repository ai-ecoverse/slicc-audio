import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));

function walk(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
  );
}

describe('the repository', () => {
  it('has ci.yml as its only workflow, on the pipeline at the devDependency version', () => {
    assert.deepEqual(readdirSync(join(root, '.github/workflows')), ['ci.yml']);
    const ci = read('.github/workflows/ci.yml');
    const uses = [...ci.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    const version = pkg.devDependencies['@ai-ecoverse/slicc-shared-web'];
    assert.match(version, /^2\.\d+\.\d+$/);
    assert.deepEqual(uses, [
      `ai-ecoverse/slicc-shared-web/.github/workflows/pipeline.yml@v${version}`,
    ]);
    assert.match(ci, /^\s*secrets: inherit$/m);
    assert.doesNotMatch(ci, /runs-on|workflow_dispatch|schedule|#/);
    for (const scope of [
      'contents',
      'issues',
      'pull-requests',
      'statuses',
      'id-token',
      'attestations',
    ]) {
      assert.match(ci, new RegExp(`^  ${scope}: write$`, 'm'), scope);
    }
    assert.match(ci, /^ {2}actions: read$/m);
    assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    const glob = /^\s*test-glob:\s*(\S+)$/m.exec(ci)?.[1];
    assert.ok(glob && pkg.scripts.test.endsWith(` ${glob}`), pkg.scripts.test);
  });

  it('pins every devDependency exactly', () => {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(-[\w.]+)?$/, name);
    }
    assert.equal(pkg.engines.node, '>=24');
  });

  it('publishes to npm from ci.yml through semantic-release, with provenance', () => {
    assert.equal(pkg.name, '@ai-ecoverse/slicc-audio');
    assert.equal(pkg.fledgling.workflow, 'ci.yml');
    assert.equal(pkg.fledgling.repo, 'ai-ecoverse/slicc-audio');
    assert.equal(pkg.publishConfig.access, 'public');
    assert.equal(pkg.publishConfig.provenance, true);
    const release = JSON.parse(read('.releaserc.json'));
    assert.deepEqual(release.branches, ['main']);
    assert.equal(release.tagFormat, 'v${version}');
    assert.ok(release.plugins.includes('@semantic-release/npm'));
    assert.ok(release.plugins.includes('@semantic-release/github'));
    assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
  });

  it('fails closed when the shared hooks are missing', () => {
    const hooks = read('lefthook.yml');
    assert.match(hooks, /^assert_lefthook_installed: true$/m);
    assert.match(hooks, /node_modules\/@ai-ecoverse\/slicc-shared-web\/lefthook\.yml/);
    assert.match(hooks, /name: shared hooks/);
    assert.equal(pkg.scripts.prepare, 'slicc-install-hooks');
    assert.ok(existsSync(join(root, '.githooks/pre-commit')));
  });

  it('keeps unit tests and coverage out of git, and no other Markdown', () => {
    const ignored = read('.gitignore').split('\n');
    assert.ok(ignored.includes('test/unit/'));
    assert.ok(ignored.includes('coverage/'));
    const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
    assert.equal(tracked.status, 0, tracked.stderr);
    const files = tracked.stdout.split('\n').filter(Boolean);
    assert.deepEqual(files.filter((file) => file.endsWith('.md')).sort(), [
      'AGENTS.md',
      'README.md',
    ]);
    assert.ok(!files.some((file) => file.startsWith('test/unit/')));
    assert.ok(!files.some((file) => /(^|\/)CLAUDE\.md$/i.test(file)));
    assert.ok(read('AGENTS.md').length <= 1000);
  });

  it('packs the README, the licence and the package files, and no tests', () => {
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(pack.status, 0, pack.stderr);
    const files = JSON.parse(pack.stdout)[0]
      .files.map((file) => file.path)
      .sort();
    const expected = [
      'LICENSE',
      'README.md',
      'package.json',
      ...pkg.files.filter((dir) => existsSync(join(root, dir))).flatMap(walk),
    ].sort();
    assert.deepEqual(files, expected);
    for (const [name, path] of Object.entries(pkg.bin ?? {})) assert.ok(files.includes(path), name);
    for (const [name, command] of Object.entries(pkg.slicc.commands ?? {})) {
      assert.ok(files.includes(command.script), name);
    }
  });
});
