import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  existsSync,
  hideNode,
  mkdirSync,
  onWindows,
  readFileSync,
  temp,
  writeFileSync,
} from './fakes.mjs';

const root = resolve(import.meta.dirname, '../..');
const sys = hideNode();
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const NODE = 'v24.9.0';
const COMMANDS = ['scsay', 'schear', 'scplay', 'scchime'];
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

function release(version, { old = false, bare = false, nobin = false } = {}) {
  const dir = temp('pkg');
  const pack = join(dir, 'package');
  mkdirSync(pack);
  cpSync(join(root, 'host'), join(pack, 'host'), { recursive: true });
  if (old) {
    const file = join(pack, 'host', 'upgrade.mjs');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('write(fds[1], `${VERSION}\\n`)'));
    writeFileSync(
      file,
      text.replace('write(fds[1], `${VERSION}\\n`)', 'write(fds[1], `${name} ${VERSION}\\n`)')
    );
  }
  const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (bare) delete json.optionalDependencies;
  if (nobin) delete json.bin;
  delete json.devDependencies;
  delete json.scripts;
  writeFileSync(join(pack, 'package.json'), JSON.stringify({ ...json, version }));
  const out = temp('assets');
  tar(dir, ['czf', join(out, `ai-ecoverse-slicc-audio-${version}.tgz`), 'package']);
  const assets = spawnSync(process.execPath, [join(root, 'scripts', 'assets.mjs'), out, version], {
    encoding: 'utf8',
  });
  if (nobin) return { ...assets, dir: out };
  assert.equal(assets.status, 0, assets.stderr);
  return out;
}

function publish(prefix, dirs, { corrupt = false, truncate = false } = {}) {
  const sums = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.tgz')) continue;
      const whole = readFileSync(join(dir, name));
      const data = truncate ? whole.subarray(0, whole.length >> 1) : whole;
      files.set(`${prefix}/${name}`, data);
      sums.push(`${corrupt ? sha('other') : sha(data)}  ${name}`);
    }
  }
  for (const name of ['install.sh', 'install.ps1'])
    files.set(`${prefix}/${name}`, readFileSync(join(root, name)));
  files.set(`${prefix}/SHA256SUMS`, `${sums.join('\n')}\n`);
  return `${base}${prefix}`;
}

function nodeDist(prefix, { corrupt = false, truncate = false } = {}) {
  const dir = temp('dist');
  const name = `node-${NODE}-${os}-${arch}`;
  mkdirSync(join(dir, name, 'bin'), { recursive: true });
  writeFileSync(join(dir, name, 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(dir, name, 'bin', 'npm'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_NPM_LOG"\n[ -z "$FAKE_NPM_FAIL" ] || { echo "$FAKE_NPM_FAIL" >&2; exit 1; }\nmkdir -p node_modules\n`,
    { mode: 0o755 }
  );
  tar(dir, ['czf', `${name}.tar.gz`, name]);
  const whole = readFileSync(join(dir, `${name}.tar.gz`));
  const archive = truncate ? whole.subarray(0, whole.length >> 1) : whole;
  files.set(
    `${prefix}/index.json`,
    JSON.stringify([
      { version: 'v26.1.0', lts: false },
      { version: NODE, lts: 'Krypton' },
      { version: 'v22.20.0', lts: 'Jod' },
    ])
  );
  files.set(`${prefix}/${NODE}/${name}.tar.gz`, archive);
  files.set(
    `${prefix}/${NODE}/SHASUMS256.txt`,
    `${sha('x')}  node-${NODE}-win-x64.zip\n${corrupt ? sha('y') : sha(archive)}  ${name}.tar.gz\n`
  );
  return `${base}${prefix}`;
}

function setup() {
  const home = temp('home');
  return {
    home,
    log: join(home, 'npm.log'),
    data: join(home, '.local', 'share', 'slicc-audio'),
    bin: join(home, '.local', 'bin'),
    env: { HOME: home, PATH: sys, FAKE_NPM_LOG: join(home, 'npm.log'), TMPDIR: temp('tmp') },
  };
}

function spawned(cmd, args, env) {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => ok({ code, stdout, stderr }));
  });
}

const sh = (args, env) => spawned(join(sys, 'sh'), [join(root, 'install.sh'), ...args], env);
const installed = (version, dir) =>
  COMMANDS.map((cmd) => `${cmd} ${version} installed to ${join(dir, cmd)}\n`).join('');

const v100 = release('1.0.0');
const v110 = release('1.1.0');
const old = publish('/v1.0.0', [v100]);
const latest = publish('/latest', [v110]);
const both = publish('/both', [v110, v100]);
const bad = publish('/bad', [release('1.2.0')], { corrupt: true });
const legacy = publish('/legacy', [release('0.9.0', { old: true })]);
const plain = publish('/plain', [release('1.3.0', { bare: true })]);
const dist = nodeDist('/node');
const badDist = nodeDist('/badnode', { corrupt: true });
const cutDist = nodeDist('/cutnode', { truncate: true });
const cut = publish('/cut', [release('1.4.0')], { truncate: true });

describe('scripts/assets.mjs', () => {
  it('names the tarball slicc-audio-<version>.tgz, and SHA256SUMS covers it and both installers', () => {
    const sums = readFileSync(join(v110, 'SHA256SUMS'), 'utf8');
    const tgz = readFileSync(join(v110, 'slicc-audio-1.1.0.tgz'));
    assert.equal(
      sums,
      `${sha(tgz)}  slicc-audio-1.1.0.tgz\n${sha(readFileSync(join(root, 'install.sh')))}  install.sh\n${sha(readFileSync(join(root, 'install.ps1')))}  install.ps1\n`
    );
    assert.ok(!existsSync(join(v110, 'ai-ecoverse-slicc-audio-1.1.0.tgz')));
    const rerun = spawnSync(process.execPath, [join(root, 'scripts', 'assets.mjs'), v110, '1.1.0']);
    assert.equal(rerun.status, 0, String(rerun.stderr));
    assert.equal(readFileSync(join(v110, 'SHA256SUMS'), 'utf8'), sums);
    const noBin = release('0.6.1', { nobin: true });
    assert.equal(noBin.status, 1);
    assert.equal(
      noBin.stderr,
      'scripts/assets.mjs: slicc-audio-0.6.1.tgz lacks a package.json with bin\n'
    );
    assert.deepEqual(readdirSync(noBin.dir), ['ai-ecoverse-slicc-audio-0.6.1.tgz']);
    assert.equal(
      spawnSync(process.execPath, [join(root, 'scripts', 'assets.mjs'), v110, 'nope']).status,
      2
    );
    assert.equal(
      spawnSync(process.execPath, [join(root, 'scripts', 'assets.mjs'), temp('empty'), '1.0.0'])
        .status,
      1
    );
  });
});

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
      `${installed('1.1.0', t.bin)}Add ${t.bin} to your PATH: export PATH="${t.bin}:$PATH"\n`
    );
    assert.match(r.stderr, /install\.sh: no Node 24 or later on PATH, downloading it/);
    assert.deepEqual(hits, [
      '/node/index.json',
      `/node/${NODE}/SHASUMS256.txt`,
      `/node/${NODE}/node-${NODE}-${os}-${arch}.tar.gz`,
      '/latest/SHA256SUMS',
      '/latest/slicc-audio-1.1.0.tgz',
    ]);
    const node = join(t.data, 'node', 'bin', 'node');
    assert.ok(existsSync(node));
    assert.deepEqual(readdirSync(t.data).sort(), ['1.1.0', 'node']);
    assert.equal(
      readFileSync(t.log, 'utf8'),
      'install --omit=dev --ignore-scripts --no-audit --no-fund\n'
    );
    assert.ok(existsSync(join(t.data, '1.1.0', 'node_modules')));
    for (const cmd of COMMANDS) {
      const variable = `${cmd.toUpperCase()}_INSTALL_DIR`;
      assert.equal(
        readFileSync(join(t.bin, cmd), 'utf8'),
        `#!/bin/sh\n${variable}='${t.bin}'\nexport ${variable}\n: "\${NODE_USE_ENV_PROXY=1}"\nexport NODE_USE_ENV_PROXY\nexec '${node}' '${join(t.data, '1.1.0', 'host', `${cmd}.mjs`)}' "$@"\n`
      );
      const v = await spawned(join(t.bin, cmd), ['--version'], t.env);
      assert.equal(v.stdout, '1.1.0\n');
    }
  });

  it('installs --version into --dir with the Node on PATH, and keeps the other versions', async () => {
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
    const dir = join(t.home, "it's tools");
    const env = { ...t.env, PATH: `${fake}:${sys}`, SLICC_NODE_DIST_BASE: `${base}/nowhere` };
    hits.length = 0;
    let r = await sh(['--version', 'v1.0.0', '--dir', dir], {
      ...env,
      SLICC_INSTALL_BASE_URL: both,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.split('\n')[0], `scsay 1.0.0 installed to ${join(dir, 'scsay')}`);
    assert.deepEqual(hits, ['/both/SHA256SUMS', '/both/slicc-audio-1.0.0.tgz']);
    assert.match(readFileSync(join(dir, 'scsay'), 'utf8'), new RegExp(`exec '${fake}/node'`));
    assert.match(
      readFileSync(join(dir, 'scsay'), 'utf8'),
      /^SCSAY_INSTALL_DIR='.*it'\\''s tools'$/m
    );
    assert.equal(
      readFileSync(t.log, 'utf8'),
      'path npm install --omit=dev --ignore-scripts --no-audit --no-fund\n'
    );
    r = await sh([`--dir=${dir}`], { ...env, SLICC_INSTALL_BASE_URL: both });
    assert.equal(
      r.stdout,
      installed('1.1.0', dir) + `Add ${dir} to your PATH: export PATH="${dir}:$PATH"\n`
    );
    assert.deepEqual(readdirSync(t.data).sort(), ['1.0.0', '1.1.0']);
  });

  it('writes launchers that set NODE_USE_ENV_PROXY=1 only when it is unset', async () => {
    const t = setup();
    const r = await sh([], {
      ...t.env,
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 0, r.stderr);
    for (const cmd of COMMANDS) {
      const lines = readFileSync(join(t.bin, cmd), 'utf8').trimEnd().split('\n');
      assert.match(lines.at(-1), /^exec /);
      const probe = [
        ...lines.slice(0, -1),
        `printf "%s|%s" "$NODE_USE_ENV_PROXY" "$${cmd.toUpperCase()}_INSTALL_DIR"`,
      ].join('\n');
      for (const [extra, expected] of [
        [{}, `1|${t.bin}`],
        [{ NODE_USE_ENV_PROXY: '0' }, `0|${t.bin}`],
      ]) {
        const shown = spawnSync(join(sys, 'sh'), ['-c', probe], {
          env: { ...t.env, ...extra },
          encoding: 'utf8',
        });
        assert.equal(shown.stdout, expected, cmd);
      }
    }
  });

  it("accepts an older release's <cmd> <version>, and reuses the Node it installed before", async () => {
    const t = setup();
    let r = await sh([], { ...t.env, SLICC_INSTALL_BASE_URL: legacy, SLICC_NODE_DIST_BASE: dist });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.split('\n')[0], `scsay 0.9.0 installed to ${join(t.bin, 'scsay')}`);
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
      new RegExp(
        `install\\.sh: checksum mismatch for node-${NODE}-${os}-${arch}\\.tar\\.gz: expected `
      )
    );
    assert.ok(!existsSync(join(t.data, 'node')));
    t = setup();
    r = await sh([], { ...t.env, SLICC_INSTALL_BASE_URL: bad, SLICC_NODE_DIST_BASE: dist });
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /install\.sh: checksum mismatch for slicc-audio-1\.2\.0\.tgz: expected /
    );
    assert.ok(!existsSync(join(t.data, '1.2.0')));
    assert.ok(!existsSync(join(t.bin, 'scsay')));
    t = setup();
    r = await sh(['--version', '9.9.9'], {
      ...t.env,
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /install\.sh: could not download .*\/latest\/slicc-audio-9\.9\.9\.tgz\n$/
    );
    t = setup();
    r = await sh([], {
      ...t.env,
      SLICC_INSTALL_BASE_URL: `${base}/gone`,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      new RegExp(`install\\.sh: could not download ${base}/gone/SHA256SUMS\\n$`)
    );
    t = setup();
    r = await sh([], {
      ...t.env,
      FAKE_NPM_FAIL: 'registry down',
      SLICC_INSTALL_BASE_URL: latest,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /registry down\ninstall\.sh: npm install failed in slicc-audio-1\.1\.0\.tgz\n$/
    );
    assert.deepEqual(readdirSync(t.data), ['node']);
  });

  it('runs npm only when the package has dependencies', async () => {
    const t = setup();
    const r = await sh([], {
      ...t.env,
      FAKE_NPM_FAIL: 'npm should not run',
      SLICC_INSTALL_BASE_URL: plain,
      SLICC_NODE_DIST_BASE: dist,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(t.log));
    assert.ok(!existsSync(join(t.data, '1.3.0', 'node_modules')));
    assert.equal(r.stdout.split('\n')[0], `scsay 1.3.0 installed to ${join(t.bin, 'scsay')}`);
  });

  it('fails with exit 1 and leaves nothing behind when the tarball or Node does not unpack', async () => {
    for (const [extra, what] of [
      [{ SLICC_INSTALL_BASE_URL: cut, SLICC_NODE_DIST_BASE: dist }, 'slicc-audio-1\\.4\\.0\\.tgz'],
      [
        { SLICC_INSTALL_BASE_URL: latest, SLICC_NODE_DIST_BASE: cutDist },
        `node-${NODE}-${os}-${arch}\\.tar\\.gz`,
      ],
    ]) {
      const t = setup();
      const r = await sh([], { ...t.env, ...extra });
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`install\\.sh: could not unpack ${what}\n$`));
      assert.deepEqual(
        existsSync(t.data) ? readdirSync(t.data) : [],
        what.startsWith('node') ? [] : ['node']
      );
      assert.deepEqual(readdirSync(t.env.TMPDIR), []);
      assert.ok(!existsSync(join(t.bin, 'scsay')));
    }
  });

  it('prints its usage, and exits 2 with it for a bad option', async () => {
    const t = setup();
    let r = await sh(['--help'], t.env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^usage: install\.sh \[--version VERSION\] \[--dir DIR\] \[--help\]\n/);
    for (const [args, message] of [
      [['--force'], 'unknown option --force'],
      [['--dir'], '--dir needs a value'],
      [['--version'], '--version needs a value'],
      [['--dir='], '--dir needs a value'],
    ]) {
      r = await sh(args, t.env);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`^install\\.sh: ${message}\\nusage: install\\.sh `));
    }
  });
});

describe('--upgrade', () => {
  it('runs the latest installer into the same directory and reports the versions', async () => {
    const t = setup();
    const dir = join(t.home, 'bin dir');
    const env = { ...t.env, SLICC_NODE_DIST_BASE: dist };
    let r = await sh(['--version', '1.0.0', '--dir', dir], { ...env, SLICC_INSTALL_BASE_URL: old });
    assert.equal(r.code, 0, r.stderr);
    for (const cmd of COMMANDS) {
      r = await spawned(join(dir, cmd), ['--version'], env);
      assert.equal(r.stdout, '1.0.0\n');
    }
    r = await spawned(join(dir, 'scsay'), ['--upgrade'], {
      ...env,
      SLICC_INSTALL_BASE_URL: latest,
    });
    assert.deepEqual([r.code, r.stdout], [0, 'scsay: 1.0.0 → 1.1.0\n'], r.stderr);
    assert.match(readFileSync(join(dir, 'schear'), 'utf8'), /1\.1\.0\/host\/schear\.mjs/);
    r = await spawned(join(dir, 'scchime'), ['--upgrade'], {
      ...env,
      SLICC_INSTALL_BASE_URL: latest,
    });
    assert.deepEqual([r.code, r.stdout], [0, 'scchime: already up to date (1.1.0)\n'], r.stderr);
    r = await spawned(join(dir, 'schear'), ['--upgrade'], { ...env, SLICC_INSTALL_BASE_URL: bad });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^install\.sh: checksum mismatch for slicc-audio-1\.2\.0\.tgz/);
    r = await spawned(join(dir, 'scplay'), ['--upgrade'], {
      ...env,
      SLICC_INSTALL_BASE_URL: `${base}/gone`,
    });
    assert.deepEqual(
      [r.code, r.stderr],
      [1, `scplay: could not download ${base}/gone/install.sh: HTTP 404\n`]
    );
    r = await spawned(join(dir, 'scplay'), ['--upgrade'], {
      ...env,
      SLICC_INSTALL_BASE_URL: 'http://127.0.0.1:9',
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^scplay: could not download http:\/\/127\.0\.0\.1:9\/install\.sh: /);
  });
});

describe('install.ps1', () => {
  const installPs1 = join(root, 'install.ps1');
  const text = readFileSync(installPs1, 'utf8');

  it('writes the same launchers for every command, passing arguments and exit codes through', () => {
    for (const line of [
      "        '$~c~Previous = $env:~V~',",
      "        '$env:~V~ = ~DIR~',",
      "        '$~c~Proxy = $env:NODE_USE_ENV_PROXY',",
      "        'if ($null -eq $~c~Proxy) { $env:NODE_USE_ENV_PROXY = ''1'' }',",
      "        '$~c~Mode = Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue',",
      "        '$~c~Legacy = $PSVersionTable.PSVersion.Major -lt 7 -or \"$~c~Mode\" -eq ''Legacy'' -or ($null -eq $~c~Mode -and $PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion.Minor -lt 3)',",
      "        '$~c~Args = @(foreach ($~c~Arg in $args) { foreach ($~c~Item in @($~c~Arg)) {',",
      "        '  elseif ($~c~Text -eq '''') { ''\"\"'' }',",
      "        '    $~c~Text = $~c~Text -replace ''(\\\\*)\"'', ''$1$1\\\"''',",
      "        '$~c~Status = 1',",
      "        '$global:LASTEXITCODE = $null',",
      "        'try {',",
      "        '  & ~NODE~ ~ENTRY~ @~c~Args',",
      "        '  if ($null -ne $LASTEXITCODE) { $~c~Status = $LASTEXITCODE }',",
      "        '} catch {',",
      "        '  Write-Error -ErrorRecord $_',",
      "        '} finally {',",
      "        '  if ($null -eq $~c~Previous) { Remove-Item -LiteralPath Env:~V~ -ErrorAction SilentlyContinue } else { $env:~V~ = $~c~Previous }',",
      "        '  if ($null -eq $~c~Proxy) { Remove-Item -LiteralPath Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue }',",
      "        '}',",
      "        'exit $~c~Status',",
      '      ) -join "`r`n"), \'~(\\w+)~\', { param($m) $values[$m.Groups[1].Value] })',
    ]) {
      assert.ok(text.includes(`${line}\n`), line);
    }
    assert.ok(
      text.includes(
        '        "`"$(& $escape $Node)`" `"$(& $escape $Entry)`" %* & call :done %%ERRORLEVEL%% & call exit /b %%ERRORLEVEL%%",\n'
      )
    );
    assert.ok(
      text.includes(`        'if not defined NODE_USE_ENV_PROXY set "NODE_USE_ENV_PROXY=1"',\n`)
    );
    assert.doesNotMatch(text, /^\s+'\(',$/m);
    assert.doesNotMatch(text, /@args"/);
    assert.doesNotMatch(text, /Invoke-Expression|\biex\b|cmd(\.exe)? \/c|Start-Process/i);
  });

  const pwsh = ['pwsh', 'pwsh.exe'].find(
    (name) => spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0
  );
  it('installs launchers that keep the arguments and leak nothing, in a real pwsh', {
    skip: (!pwsh && 'pwsh is not installed') || (onWindows && 'windows.test.mjs covers Windows'),
  }, async () => {
    const shell = spawnSync(pwsh, ['-NoProfile', '-Command', '(Get-Command pwsh).Source'], {
      encoding: 'utf8',
    }).stdout.trim();
    const env = (extra = {}) => ({
      HOME: temp('home'),
      TMPDIR: temp('tmp'),
      PATH: [dirname(process.execPath), dirname(shell), sys].join(delimiter),
      ...extra,
    });
    const parse = spawnSync(
      pwsh,
      [
        '-NoProfile',
        '-Command',
        '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:T_PS1, [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.Message }; exit 1 }',
      ],
      { encoding: 'utf8', env: env({ T_PS1: installPs1 }) }
    );
    assert.equal(parse.status, 0, parse.stdout);
    const local = temp('local');
    const bin = join(local, "my 'bin'");
    const r = await spawned(
      pwsh,
      ['-NoProfile', '-NonInteractive', '-File', installPs1, '-Dir', bin],
      env({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: plain })
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      COMMANDS.map((cmd) => `${cmd} 1.3.0 installed to ${join(bin, `${cmd}.ps1`)}\n`).join('')
    );
    const entry = (cmd) => join(local, 'slicc-audio', '1.3.0', 'host', `${cmd}.mjs`);
    const generic = (cmd, ext) =>
      readFileSync(join(bin, `${cmd}.${ext}`), 'utf8')
        .replaceAll(cmd, '@')
        .replaceAll(cmd.toUpperCase(), '@');
    for (const cmd of COMMANDS) {
      assert.equal(generic(cmd, 'ps1'), generic('scsay', 'ps1'), cmd);
      assert.equal(generic(cmd, 'cmd'), generic('scsay', 'cmd'), cmd);
      assert.deepEqual(
        [...readFileSync(join(bin, `${cmd}.ps1`)).subarray(0, 3)],
        [0xef, 0xbb, 0xbf]
      );
      const lines = readFileSync(join(bin, `${cmd}.cmd`), 'utf8').split('\r\n');
      const at = lines.findIndex((line) =>
        line.endsWith(
          ` "${entry(cmd)}" %* & call :done %%ERRORLEVEL%% & call exit /b %%ERRORLEVEL%%`
        )
      );
      assert.deepEqual(lines.slice(at + 1), [
        ':done',
        'chcp %SLICC_AUDIO_CP% >nul',
        'exit /b %1',
        '',
      ]);
      const v = await spawned(
        pwsh,
        ['-NoProfile', '-File', join(bin, `${cmd}.ps1`), '--version'],
        env()
      );
      assert.equal(v.stdout.trim(), '1.3.0', v.stderr);
    }
    const launcher = join(bin, 'scsay.ps1').replaceAll("'", "''");
    const show = (name) =>
      `'${name}=' + $(if ($null -eq $env:${name}) { 'unset' } else { $env:${name} })`;
    for (const [before, after, proxy] of [
      ["$env:SCSAY_INSTALL_DIR = 'before'; $env:NODE_USE_ENV_PROXY = '0'", 'before', '0'],
      [
        'Remove-Item Env:SCSAY_INSTALL_DIR, Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue',
        'unset',
        'unset',
      ],
    ]) {
      const session = await spawned(
        pwsh,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `${before}; & '${launcher}' --nope 2>$null; 'code=' + $LASTEXITCODE; ${show('SCSAY_INSTALL_DIR')}; ${show('NODE_USE_ENV_PROXY')}`,
        ],
        env()
      );
      assert.deepEqual(session.stdout.trim().split(/\r?\n/), [
        'code=2',
        `SCSAY_INSTALL_DIR=${after}`,
        `NODE_USE_ENV_PROXY=${proxy}`,
      ]);
    }
    const proxyProbe = join(local, 'proxy.mjs');
    writeFileSync(
      proxyProbe,
      'process.stdout.write(`${process.env.NODE_USE_ENV_PROXY}|${process.env.SCSAY_INSTALL_DIR}`);\n'
    );
    const probing = join(local, 'proxy.ps1');
    writeFileSync(
      probing,
      readFileSync(join(bin, 'scsay.ps1'), 'utf8').replace(`'${entry('scsay')}'`, `'${proxyProbe}'`)
    );
    const seen = await spawned(
      pwsh,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Remove-Item Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue; & '${probing}'`,
      ],
      env()
    );
    assert.equal(seen.stdout.trim(), `1|${bin}`);
    const argv = join(local, 'argv.mjs');
    writeFileSync(
      argv,
      'process.stdout.write(JSON.stringify([process.env.SCSAY_INSTALL_DIR, ...process.argv.slice(2)]));\n'
    );
    const probe = join(local, 'argv.ps1');
    const ps1 = readFileSync(join(bin, 'scsay.ps1'), 'utf8');
    assert.ok(ps1.includes(`'${entry('scsay')}'`));
    writeFileSync(probe, ps1.replace(`'${entry('scsay')}'`, `'${argv}'`));
    const tricky = ['a )&%^ b "q" c', 'x"y\\', 'sp ace\\', 'tail\\', '', "it's"];
    for (const mode of [
      "$PSNativeCommandArgumentPassing = 'Standard'",
      "$PSNativeCommandArgumentPassing = 'Legacy'",
      'Remove-Variable PSNativeCommandArgumentPassing',
    ]) {
      const passed = await spawned(
        pwsh,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `${mode}; $a = ConvertFrom-Json $env:T_ARGS; & '${probe}' @a; & '${probe}' a,'b c' d`,
        ],
        env({ T_ARGS: JSON.stringify(tricky) })
      );
      const [all, list] = passed.stdout.split(/(?<=\])(?=\[)/).map((part) => JSON.parse(part));
      assert.deepEqual(all, [bin, ...tricky], `${mode}: ${passed.stderr}`);
      assert.deepEqual(list, [bin, 'a', 'b c', 'd'], mode);
    }
    const garbage = join(local, 'garbage');
    writeFileSync(garbage, 'not a program\n', { mode: 0o755 });
    for (const dead of [join(local, 'gone'), garbage]) {
      const broken = join(local, 'broken.ps1');
      writeFileSync(
        broken,
        readFileSync(join(bin, 'scsay.ps1'), 'utf8').replace(
          /^ {2}& '(?:[^']|'')+' /m,
          `  & '${dead}' `
        )
      );
      assert.ok(readFileSync(broken, 'utf8').includes(`& '${dead}' '${entry('scsay')}'`));
      for (const caller of [
        '',
        "$PSNativeCommandUseErrorActionPreference = $true; $ErrorActionPreference = 'Stop'; ",
        'trap { continue }; ',
      ]) {
        for (const redirect of ['', ' 2>$null']) {
          const failed = await spawned(
            pwsh,
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `${caller}& $env:T_NODE -e 0; & '${broken}' --version${redirect}; 'code=' + $LASTEXITCODE; ${show('SCSAY_INSTALL_DIR')}; ${show('NODE_USE_ENV_PROXY')}`,
            ],
            env({ T_NODE: process.execPath })
          );
          assert.deepEqual(
            failed.stdout.trim().split(/\r?\n/),
            ['code=1', 'SCSAY_INSTALL_DIR=unset', 'NODE_USE_ENV_PROXY=unset'],
            `${dead} ${caller}${redirect}: ${failed.stderr}`
          );
        }
      }
    }
    const strict =
      "$PSNativeCommandUseErrorActionPreference = $true; $ErrorActionPreference = 'Stop'";
    const strictLocal = temp('local');
    const strictBin = join(strictLocal, 'bin');
    const strictInstall = await spawned(
      pwsh,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${strict}; & $env:T_PS1 -Dir $env:T_DIR; exit $LASTEXITCODE`,
      ],
      env({
        LOCALAPPDATA: strictLocal,
        SLICC_INSTALL_BASE_URL: plain,
        T_PS1: installPs1,
        T_DIR: strictBin,
      })
    );
    assert.equal(strictInstall.code, 0, strictInstall.stderr);
    assert.equal(
      strictInstall.stdout.split(/\r?\n/)[0],
      `scsay 1.3.0 installed to ${join(strictBin, 'scsay.ps1')}`
    );
    const strictRun = await spawned(
      pwsh,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${strict}; & $env:T_LAUNCHER --nope 2>$null; 'code=' + $LASTEXITCODE; 'eap=' + $ErrorActionPreference; 'native=' + $PSNativeCommandUseErrorActionPreference`,
      ],
      env({ T_LAUNCHER: join(strictBin, 'scsay.ps1') })
    );
    assert.deepEqual(
      strictRun.stdout.trim().split(/\r?\n/),
      ['code=2', 'eap=Stop', 'native=True'],
      strictRun.stderr
    );
    const corrupt = await spawned(
      pwsh,
      ['-NoProfile', '-NonInteractive', '-File', installPs1, '-Dir', strictBin],
      env({ LOCALAPPDATA: strictLocal, SLICC_INSTALL_BASE_URL: cut })
    );
    assert.equal(corrupt.code, 1);
    assert.match(corrupt.stderr, /install\.ps1: could not unpack slicc-audio-1\.4\.0\.tgz/);
    assert.deepEqual(readdirSync(join(strictLocal, 'slicc-audio')).sort(), ['1.3.0']);
  });
});
