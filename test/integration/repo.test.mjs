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
    const names = release.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    assert.deepEqual(names, [
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      '@semantic-release/npm',
      '@semantic-release/exec',
      '@semantic-release/github',
    ]);
    assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
  });

  it('attaches the installers, the tarball and SHA256SUMS to every GitHub release', () => {
    const release = JSON.parse(read('.releaserc.json'));
    const plugin = (name) => release.plugins.find((p) => Array.isArray(p) && p[0] === name)[1];
    const assets = plugin('@semantic-release/github').assets.map((asset) => asset.path);
    assert.deepEqual(assets, [
      'dist/slicc-audio-*.tgz',
      'dist/SHA256SUMS',
      'dist/install.sh',
      'dist/install.ps1',
    ]);
    const cmd = plugin('@semantic-release/exec').prepareCmd;
    assert.match(cmd, /npm pack --ignore-scripts --pack-destination dist/);
    assert.match(
      cmd,
      /mv dist\/ai-ecoverse-slicc-audio-\$\{nextRelease\.version\}\.tgz dist\/slicc-audio-\$\{nextRelease\.version\}\.tgz/
    );
    assert.match(cmd, /cp install\.sh install\.ps1 dist\//);
    assert.match(
      cmd,
      /sha256sum slicc-audio-\$\{nextRelease\.version\}\.tgz install\.sh install\.ps1 > SHA256SUMS$/
    );
    assert.ok(read('.gitignore').split('\n').includes('dist/'));
    assert.ok(read('install.sh').startsWith('#!/bin/sh\n'));
    assert.match(read('install.ps1'), /^param\(/);
  });

  it('ships the four host commands, with slicc-ortllama as its only, optional, dependency', () => {
    assert.deepEqual(pkg.bin, {
      scsay: 'host/scsay.mjs',
      schear: 'host/schear.mjs',
      scplay: 'host/scplay.mjs',
      scchime: 'host/scchime.mjs',
    });
    assert.equal(pkg.dependencies, undefined);
    assert.deepEqual(Object.keys(pkg.optionalDependencies), ['@ai-ecoverse/slicc-ortllama']);
    for (const path of Object.values(pkg.bin))
      assert.ok(read(path).startsWith('#!/usr/bin/env node\n'));
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
