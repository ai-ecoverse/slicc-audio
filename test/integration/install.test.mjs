import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { existsSync, hideNode, mkdirSync, readFileSync, temp, writeFileSync } from './fakes.mjs';

const root = resolve(import.meta.dirname, '../..');
const sys = hideNode();
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const NODE = 'v24.9.0';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const files = new Map();
const hits = [];

const server = createServer((req, res) => {
  hits.push(req.url);
  const body = files.get(req.url);
  res.writeHead(body ? 200 : 404);
  res.end(body ?? 'missing');
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

function tar(dir, args) {
  const r = spawnSync('tar', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function release(version, { pkg = {} } = {}) {
  const dir = temp('pkg');
  const pack = join(dir, 'package');
  mkdirSync(pack);
  cpSync(join(root, 'host'), join(pack, 'host'), { recursive: true });
  const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  delete json.optionalDependencies;
  delete json.devDependencies;
  delete json.scripts;
  writeFileSync(join(pack, 'package.json'), JSON.stringify({ ...json, version, ...pkg }));
  tar(dir, ['czf', 'out.tgz', 'package']);
  return readFileSync(join(dir, 'out.tgz'));
}

function publish(prefix, tgzs, { corrupt = false } = {}) {
  const sums = [];
  for (const [version, data] of tgzs) {
    const name = `slicc-audio-${version}.tgz`;
    files.set(`${prefix}/${name}`, data);
    sums.push(`${corrupt ? sha('other') : sha(data)}  ${name}`);
  }
  const script = readFileSync(join(root, 'install.sh'));
  files.set(`${prefix}/install.sh`, script);
  sums.push(`${sha(script)}  install.sh`);
  files.set(`${prefix}/SHA256SUMS`, `${sums.join('\n')}\n`);
  return `${base}${prefix}`;
}

function nodeDist(prefix, { corrupt = false } = {}) {
  const dir = temp('dist');
  const name = `node-${NODE}-${os}-${arch}`;
  mkdirSync(join(dir, name, 'bin'), { recursive: true });
  writeFileSync(join(dir, name, 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(dir, name, 'bin', 'npm'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_NPM_LOG"\npwd >> "$FAKE_NPM_LOG"\n[ -z "$FAKE_NPM_FAIL" ] || { echo "$FAKE_NPM_FAIL" >&2; exit 1; }\nmkdir -p node_modules\n`,
    { mode: 0o755 }
  );
  tar(dir, ['cJf', `${name}.tar.xz`, name]);
  const archive = readFileSync(join(dir, `${name}.tar.xz`));
  files.set(
    `${prefix}/index.json`,
    JSON.stringify([
      { version: 'v26.1.0', lts: false },
      { version: NODE, lts: 'Krypton' },
      { version: 'v22.20.0', lts: 'Jod' },
    ])
  );
  files.set(`${prefix}/${NODE}/${name}.tar.xz`, archive);
  files.set(
    `${prefix}/${NODE}/SHASUMS256.txt`,
    `${sha('x')}  node-${NODE}-win-x64.zip\n${corrupt ? sha('y') : sha(archive)}  ${name}.tar.xz\n`
  );
  return `${base}${prefix}`;
}

function setup() {
  const home = temp('home');
  const log = join(home, 'npm.log');
  return {
    home,
    log,
    data: join(home, '.local', 'share', 'slicc-audio'),
    bin: join(home, '.local', 'bin'),
    env: { HOME: home, PATH: sys, FAKE_NPM_LOG: log, TMPDIR: temp('tmp') },
  };
}

function sh(args, env, file = join(root, 'install.sh')) {
  return new Promise((ok) => {
    const child = spawn(join(sys, 'sh'), [file, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => ok({ code, stdout, stderr }));
  });
}

function launch(cmd, args, env) {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => ok({ code, stdout, stderr }));
  });
}

const v100 = release('1.0.0');
const v110 = release('1.1.0');
const old = publish('/v1.0.0', [['1.0.0', v100]]);
const latest = publish('/latest', [['1.1.0', v110]]);
const both = publish('/both', [
  ['1.1.0', v110],
  ['1.0.0', v100],
]);
const bad = publish('/bad', [['1.2.0', release('1.2.0')]], { corrupt: true });
const dist = nodeDist('/node');
const badDist = nodeDist('/badnode', { corrupt: true });

describe('install.sh', () => {
  it('downloads Node when none is on PATH, installs the latest release and its launchers', async () => {
    const t = setup();
    hits.length = 0;
    const r = await sh([], {
      ...t.env,
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      `slicc-audio 1.1.0 installed to ${t.bin}\nAdd ${t.bin} to your PATH: export PATH="${t.bin}:$PATH"\n`
    );
    assert.match(r.stderr, /no Node 24\+ found; downloading it/);
    assert.deepEqual(hits, [
      '/node/index.json',
      `/node/${NODE}/SHASUMS256.txt`,
      `/node/${NODE}/node-${NODE}-${os}-${arch}.tar.xz`,
      '/latest/SHA256SUMS',
      '/latest/slicc-audio-1.1.0.tgz',
    ]);
    assert.ok(existsSync(join(t.data, 'node', 'bin', 'node')));
    assert.equal(readlinkSync(join(t.data, 'current')), '1.1.0');
    assert.deepEqual(JSON.parse(readFileSync(join(t.data, 'install.json'), 'utf8')), {
      version: '1.1.0',
      dir: t.bin,
    });
    assert.deepEqual(readFileSync(t.log, 'utf8').split('\n').slice(0, 1), [
      'install --omit=dev --ignore-scripts --no-audit --no-fund',
    ]);
    for (const cmd of ['scsay', 'schear', 'scplay', 'scchime']) {
      assert.equal(
        readFileSync(join(t.bin, cmd), 'utf8'),
        `#!/bin/sh\nexec "${join(t.data, 'node', 'bin', 'node')}" "${join(t.data, 'current', 'host', `${cmd}.mjs`)}" "$@"\n`
      );
      const v = await launch(join(t.bin, cmd), ['--version'], t.env);
      assert.equal(v.stdout, `${cmd} 1.1.0\n`);
    }
  });

  it('installs --version into --dir with the Node on PATH, and replaces older versions', async () => {
    const t = setup();
    const fake = temp('node');
    writeFileSync(join(fake, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(fake, 'npm'),
      `#!/bin/sh\nprintf 'path npm %s\\n' "$*" >> "$FAKE_NPM_LOG"\n`,
      { mode: 0o755 }
    );
    const dir = join(t.home, 'tools');
    const env = {
      ...t.env,
      PATH: `${dir}:${fake}:${sys}`,
      SLICC_NODE_DIST_BASE: `${base}/nowhere`,
    };
    hits.length = 0;
    let r = await sh(['--version', '1.0.0', '--dir', dir], {
      ...env,
      SLICC_INSTALL_BASE_URL: both,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `slicc-audio 1.0.0 installed to ${dir}\n`);
    assert.deepEqual(hits, ['/both/SHA256SUMS', '/both/slicc-audio-1.0.0.tgz']);
    assert.match(readFileSync(join(dir, 'scsay'), 'utf8'), new RegExp(`exec "${fake}/node"`));
    assert.equal(
      readFileSync(t.log, 'utf8'),
      'path npm install --omit=dev --ignore-scripts --no-audit --no-fund\n'
    );
    r = await sh(['--dir', dir], { ...env, SLICC_INSTALL_BASE_URL: both });
    assert.equal(r.stdout, `slicc-audio 1.1.0 installed to ${dir}\n`);
    assert.deepEqual(readdirSync(t.data).sort(), ['1.1.0', 'current', 'install.json']);
  });

  it('uses the Node it installed before, and replaces a Node older than 24', async () => {
    const t = setup();
    let r = await sh([], { ...t.env, SLICC_INSTALL_BASE_URL: latest, SLICC_NODE_DIST_BASE: dist });
    assert.equal(r.code, 0, r.stderr);
    const elderly = temp('old');
    writeFileSync(join(elderly, 'node'), '#!/bin/sh\necho v20.1.0\n', { mode: 0o755 });
    hits.length = 0;
    r = await sh([], {
      ...t.env,
      PATH: `${elderly}:${sys}`,
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(hits, ['/latest/SHA256SUMS', '/latest/slicc-audio-1.1.0.tgz']);
    const u = setup();
    r = await sh([], {
      ...u.env,
      PATH: `${elderly}:${sys}`,
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(u.data, 'node', 'bin', 'node')));
  });

  it('refuses a tarball or a Node that fails its checksum, and reports npm failures', async () => {
    let t = setup();
    let r = await sh([], {
      ...t.env,
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: badDist,
    });
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      new RegExp(`slicc-audio: checksum mismatch for node-${NODE}-${os}-${arch}\\.tar\\.xz\\n`)
    );
    assert.ok(!existsSync(join(t.data, 'node')));
    t = setup();
    r = await sh([], { ...t.env, SLICC_INSTALL_BASE_URL: bad, SLICC_NODE_DIST_BASE: dist });
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /slicc-audio: checksum mismatch for slicc-audio-1\.2\.0\.tgz\n {2}expected: /
    );
    assert.ok(!existsSync(join(t.data, '1.2.0')));
    assert.ok(!existsSync(join(t.bin, 'scsay')));
    t = setup();
    r = await sh(['--version', '9.9.9'], {
      ...t.env,
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.deepEqual(
      [r.code, r.stderr.split('\n').at(-2)],
      [1, 'slicc-audio: no checksum for slicc-audio-9.9.9.tgz in SHA256SUMS']
    );
    t = setup();
    r = await sh([], {
      ...t.env,
      SLICC_INSTALL_BASE_URL: `${base}/gone`,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`slicc-audio: cannot download ${base}/gone/SHA256SUMS\\n$`));
    t = setup();
    r = await sh([], {
      ...t.env,
      FAKE_NPM_FAIL: 'registry down',
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /registry down\nslicc-audio: npm install failed\n$/);
    assert.deepEqual(readdirSync(t.data), ['node']);
  });

  it('prints its usage, and exits 2 for an unknown option', async () => {
    const t = setup();
    let r = await sh(['--help'], t.env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Usage: sh -s -- \[--version VERSION\] \[--dir DIR\] \[--help\]\n/);
    r = await sh(['--force'], t.env);
    assert.deepEqual(
      [r.code, r.stdout, r.stderr],
      [2, '', 'slicc-audio: unknown option: --force\n']
    );
    r = await sh(['--dir'], t.env);
    assert.deepEqual([r.code, r.stderr], [2, 'slicc-audio: --dir needs a value\n']);
    r = await sh(['--version'], t.env);
    assert.deepEqual([r.code, r.stderr], [2, 'slicc-audio: --version needs a value\n']);
  });
});

describe('--upgrade', () => {
  it('runs the latest installer into the same directory and reports the versions', async () => {
    const t = setup();
    const dir = join(t.home, 'bin dir');
    const env = { ...t.env, SLICC_NODE_DIST_BASE: dist };
    let r = await sh(['--version', '1.0.0', '--dir', dir], { ...env, SLICC_INSTALL_BASE_URL: old });
    assert.equal(r.code, 0, r.stderr);
    for (const cmd of ['scsay', 'schear', 'scplay', 'scchime']) {
      r = await launch(join(dir, cmd), ['--version'], env);
      assert.equal(r.stdout, `${cmd} 1.0.0\n`);
    }
    r = await launch(join(dir, 'scsay'), ['--upgrade'], { ...env, SLICC_INSTALL_BASE_URL: latest });
    assert.deepEqual([r.code, r.stdout], [0, 'scsay: 1.0.0 → 1.1.0\n'], r.stderr);
    assert.ok(!existsSync(join(t.data, '1.0.0')));
    assert.deepEqual(JSON.parse(readFileSync(join(t.data, 'install.json'), 'utf8')), {
      version: '1.1.0',
      dir,
    });
    assert.ok(lstatSync(join(t.data, 'current')).isSymbolicLink());
    r = await launch(join(dir, 'scchime'), ['--upgrade'], {
      ...env,
      SLICC_INSTALL_BASE_URL: latest,
    });
    assert.deepEqual([r.code, r.stdout], [0, 'scchime: already up to date (1.1.0)\n'], r.stderr);
    r = await launch(join(dir, 'schear'), ['--upgrade'], { ...env, SLICC_INSTALL_BASE_URL: bad });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^slicc-audio: checksum mismatch for slicc-audio-1\.2\.0\.tgz\n/);
    r = await launch(join(dir, 'scplay'), ['--upgrade'], {
      ...env,
      SLICC_INSTALL_BASE_URL: `${base}/gone`,
    });
    assert.deepEqual(
      [r.code, r.stderr],
      [1, `scplay: cannot download ${base}/gone/install.sh: HTTP 404\n`]
    );
    r = await launch(join(dir, 'scplay'), ['--upgrade'], {
      ...env,
      SLICC_INSTALL_BASE_URL: 'http://127.0.0.1:9',
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^scplay: cannot download http:\/\/127\.0\.0\.1:9\/install\.sh: /);
  });
});
