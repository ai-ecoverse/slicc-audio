import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const installPs1 = join(root, 'install.ps1');
const onWindows = process.platform === 'win32';
const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const powershell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmd = join(system, 'cmd.exe');
const COMMANDS = ['scsay', 'schear', 'scplay', 'scchime'];
const VARS = COMMANDS.map((name) => `${name.toUpperCase()}_INSTALL_DIR`);

function withPath(env, value) {
  const out = {};
  for (const [key, entry] of Object.entries(env)) {
    if (key.toUpperCase() !== 'PATH') out[key] = entry;
  }
  out.PATH = value;
  return out;
}

function clean(extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (![...VARS, 'NODE_OPTIONS', 'PSMODULEPATH'].includes(key.toUpperCase())) {
      out[key] = value;
    }
  }
  return { ...out, ...extra };
}

function run(file, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => done({ status: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function lines(text) {
  return text.split(/\r?\n/).filter(Boolean);
}

function ps(shell, script, env) {
  return run(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env,
    }
  );
}

function batch(line, env) {
  return run(cmd, ['/d', '/s', '/c', `"${line}"`], { env, windowsVerbatimArguments: true });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('on real Windows', { skip: !onWindows && 'not Windows' }, () => {
  let scratch;
  let server;
  let url;
  let served;
  let userPath;
  let pwsh;

  function npm(args, cwd) {
    const cli = /\.c?js$/.test(process.env.npm_execpath ?? '')
      ? process.env.npm_execpath
      : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  }

  function release(name, as) {
    const dir = join(served, name);
    mkdirSync(dir, { recursive: true });
    const source = mkdtempSync(join(scratch, 'source-'));
    for (const file of ['LICENSE', 'README.md', 'package.json', 'host']) {
      cpSync(join(root, file), join(source, file), { recursive: true });
    }
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    pkg.version = as;
    delete pkg.scripts;
    delete pkg.optionalDependencies;
    writeFileSync(join(source, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    copyFileSync(installPs1, join(dir, 'install.ps1'));
    const pack = npm(['pack', '--ignore-scripts', '--pack-destination', dir], source);
    assert.equal(pack.status, 0, `${pack.stdout}${pack.stderr}${pack.error?.message ?? ''}`);
    const assets = spawnSync(process.execPath, [join(root, 'scripts', 'assets.mjs'), dir, as], {
      encoding: 'utf8',
    });
    assert.equal(assets.status, 0, assets.stderr);
    return `${url}/${name}`;
  }

  function install(shell, dir, local, base, extra = {}) {
    return run(
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        installPs1,
        '-Dir',
        dir,
      ],
      { env: clean({ LOCALAPPDATA: local, SLICC_INSTALL_BASE_URL: base, ...extra }) }
    );
  }

  before(async () => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'slicc-audio-windows-')));
    served = join(scratch, 'served');
    mkdirSync(served);
    server = createServer((request, response) => {
      const path = resolve(served, `.${decodeURIComponent(request.url.split('?')[0])}`);
      if (!path.startsWith(served + sep) || !existsSync(path)) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(readFileSync(path));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${server.address().port}`;
    const saved = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
      ],
      { encoding: 'utf8' }
    );
    userPath = saved.stdout.replace(/\r?\n$/, '');
    pwsh =
      spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0 ? 'pwsh' : undefined;
  });

  after(() => {
    server?.close();
    spawnSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Environment]::SetEnvironmentVariable('Path', $(if ($env:SLICC_USER_PATH) { $env:SLICC_USER_PATH } else { $null }), 'User')",
      ],
      { env: { ...process.env, SLICC_USER_PATH: userPath } }
    );
    if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 20 });
  });

  for (const shell of ['powershell.exe', 'pwsh']) {
    it(`installs with ${shell}, and every launcher runs, keeps its arguments and leaks nothing`, async (t) => {
      const exe = shell === 'pwsh' ? pwsh : powershell;
      if (!exe) {
        t.skip('pwsh is not installed');
        return;
      }
      const base = release(`r-${shell}`, version);
      const local = mkdtempSync(join(scratch, 'local-'));
      const bin = join(local, "my 'bin' (x86) & 100%");
      const result = await install(exe, bin, local, base);
      assert.equal(result.status, 0, result.stderr);
      const out = lines(result.stdout);
      assert.deepEqual(
        out.slice(0, COMMANDS.length),
        COMMANDS.map((name) => `${name} ${version} installed to ${join(bin, `${name}.ps1`)}`)
      );
      const env = clean();
      const entry = (name) => join(local, 'slicc-audio', version, 'host', `${name}.mjs`);
      const generic = (name, ext) =>
        readFileSync(join(bin, `${name}.${ext}`), 'utf8')
          .replaceAll(name, '@')
          .replaceAll(name.toUpperCase(), '@');

      for (const name of COMMANDS) {
        assert.ok(existsSync(entry(name)));
        const ps1 = join(bin, `${name}.ps1`);
        const launcher = join(bin, `${name}.cmd`);
        assert.deepEqual([...readFileSync(ps1).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
        assert.equal(generic(name, 'ps1'), generic('scsay', 'ps1'), name);
        assert.equal(generic(name, 'cmd'), generic('scsay', 'cmd'), name);
        for (const argv of [['--version'], ['--help']]) {
          const viaCmd = await batch(`"${launcher}" ${argv.join(' ')}`, env);
          const viaPs = await ps(exe, `& $env:T_LAUNCHER ${argv.join(' ')}; exit $LASTEXITCODE`, {
            ...env,
            T_LAUNCHER: ps1,
          });
          for (const [how, got] of [
            ['cmd', viaCmd],
            ['ps1', viaPs],
          ]) {
            assert.equal(got.status, 0, `${name} ${how} ${argv}: ${got.stderr}`);
            if (argv[0] === '--version') assert.equal(got.stdout.trim(), version, how);
            else assert.match(got.stdout, new RegExp(`^usage: ${name}\\b`), how);
          }
        }
        assert.equal((await batch(`"${launcher}" --nope`, env)).status, 2, name);
        assert.equal(
          (
            await ps(exe, '& $env:T_LAUNCHER --nope 2>$null; exit $LASTEXITCODE', {
              ...env,
              T_LAUNCHER: ps1,
            })
          ).status,
          2,
          name
        );
        const exited = await ps(exe, `& $env:T_LAUNCHER --nope 2>$null; exit $LASTEXITCODE`, {
          ...env,
          T_LAUNCHER: launcher,
        });
        assert.equal(exited.status, 2, `${name}.cmd from PowerShell`);
      }

      const launcher = join(bin, 'scsay.cmd');
      const ps1 = join(bin, 'scsay.ps1');
      const pages = await batch(`chcp & "${launcher}" --version & chcp`, env);
      const [before, , after] = lines(pages.stdout);
      assert.equal(before, after, pages.stdout);

      const leak = await batch(`"${launcher}" --version & set SCSAY_INSTALL_DIR`, env);
      assert.equal(leak.stdout.trim(), version, leak.stdout);
      const show =
        "'dir=' + $(if ($null -eq $env:SCSAY_INSTALL_DIR) { 'unset' } else { $env:SCSAY_INSTALL_DIR })";
      for (const [setup, dir] of [
        ["$env:SCSAY_INSTALL_DIR = 'before'", 'before'],
        ['', 'unset'],
      ]) {
        const session = await ps(
          exe,
          `${setup}; & $env:T_LAUNCHER --version | Out-Null; 'code=' + $LASTEXITCODE; ${show}`,
          { ...env, T_LAUNCHER: ps1 }
        );
        assert.deepEqual(lines(session.stdout), ['code=0', `dir=${dir}`], session.stderr);
      }

      const argv = join(local, 'argv.mjs');
      writeFileSync(
        argv,
        'process.stdout.write(JSON.stringify([process.env.SCSAY_INSTALL_DIR, ...process.argv.slice(2)]) + "\\n");\n'
      );
      const probePs1 = join(bin, 'argv.ps1');
      const probeCmd = join(bin, 'argv.cmd');
      const ps1Text = readFileSync(ps1, 'utf8');
      const cmdText = readFileSync(launcher, 'utf8');
      assert.ok(ps1Text.includes(`'${entry('scsay')}'`));
      assert.ok(cmdText.includes(`"${entry('scsay')}"`));
      writeFileSync(probePs1, ps1Text.replace(`'${entry('scsay')}'`, `'${argv}'`));
      writeFileSync(probeCmd, cmdText.replace(`"${entry('scsay')}"`, `"${argv}"`));
      const tricky = ['a )&%^ b "q" c', 'x"y\\', 'sp ace\\', 'tail\\', '', '%SCSAY_NOPE%', "it's"];
      const modes =
        shell === 'pwsh'
          ? [
              '',
              "$PSNativeCommandArgumentPassing = 'Legacy'; ",
              'Remove-Variable PSNativeCommandArgumentPassing; ',
            ]
          : [''];
      for (const mode of modes) {
        const viaPs = await ps(
          exe,
          `${mode}$a = ConvertFrom-Json $env:T_ARGS; & $env:T_LAUNCHER @a; & $env:T_LAUNCHER a,'b c' d; exit $LASTEXITCODE`,
          { ...env, T_LAUNCHER: probePs1, T_ARGS: JSON.stringify(tricky) }
        );
        assert.equal(viaPs.status, 0, `${mode}${viaPs.stderr}`);
        const [all, list] = lines(viaPs.stdout).map((line) => JSON.parse(line));
        assert.deepEqual(all, [bin, ...tricky], `ps1 ${mode}`);
        assert.deepEqual(list, [bin, 'a', 'b c', 'd'], `list ${mode}`);
      }
      const viaCmd = await batch(
        `"${probeCmd}" "a )&%^ b \\"q\\" c" "x\\"y\\" z" tail\\ %SCSAY_NOPE%`,
        env
      );
      assert.equal(viaCmd.status, 0, viaCmd.stderr);
      assert.deepEqual(JSON.parse(viaCmd.stdout), [
        bin,
        'a )&%^ b "q" c',
        'x"y" z',
        'tail\\',
        '%SCSAY_NOPE%',
      ]);

      if (shell === 'powershell.exe') {
        assert.ok(
          out.includes(
            `Added ${bin} to your user PATH; open a new terminal to use ${COMMANDS.join(', ')}`
          ),
          result.stdout
        );
        const listed = await ps(
          powershell,
          "[Environment]::GetEnvironmentVariable('Path', 'User')",
          clean()
        );
        assert.ok(listed.stdout.trim().split(';').includes(bin), listed.stdout);
      }
    });
  }

  it('upgrades in place from the installed launchers, without PSModulePath', async () => {
    const local = mkdtempSync(join(scratch, 'local-'));
    const bin = join(local, 'bin');
    const first = await install(powershell, bin, local, release('old', version));
    assert.equal(first.status, 0, first.stderr);
    const newer = release('new', '99.0.0');
    const modules = pwsh
      ? spawnSync(pwsh, ['-NoProfile', '-Command', '$env:PSModulePath'], {
          encoding: 'utf8',
        }).stdout.trim()
      : join(process.env.ProgramFiles, 'PowerShell', '7', 'Modules');
    const env = clean({
      LOCALAPPDATA: local,
      SLICC_INSTALL_BASE_URL: newer,
      PSModulePath: modules,
    });
    const upgraded = await batch(`"${join(bin, 'scsay.cmd')}" --upgrade`, env);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(upgraded.stdout, `scsay: ${version} → 99.0.0\n`);
    for (const name of COMMANDS) {
      const reported = await batch(`"${join(bin, `${name}.cmd`)}" --version`, clean());
      assert.equal(reported.stdout.trim(), '99.0.0', name);
      assert.ok(existsSync(join(local, 'slicc-audio', '99.0.0', 'host', `${name}.mjs`)));
    }
    const again = await ps(powershell, '& $env:T_LAUNCHER --upgrade; exit $LASTEXITCODE', {
      ...env,
      T_LAUNCHER: join(bin, 'scplay.ps1'),
    });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), 'scplay: already up to date (99.0.0)');
  });

  it('downloads Node as a .zip when PATH has none, and the launchers use it', async () => {
    const arch = { AMD64: 'x64', ARM64: 'arm64' }[process.env.PROCESSOR_ARCHITECTURE];
    const dist = join(served, 'dist');
    const name = `node-v24.99.0-win-${arch}`;
    const build = join(scratch, 'build');
    mkdirSync(join(build, name), { recursive: true });
    copyFileSync(process.execPath, join(build, name, 'node.exe'));
    mkdirSync(join(dist, 'v24.99.0'), { recursive: true });
    const archive = join(dist, 'v24.99.0', `${name}.zip`);
    const zipped = spawnSync(
      join(system, 'tar.exe'),
      ['-a', '-c', '--options', 'zip:compression=store', '-f', `${name}.zip`, '-C', build, name],
      { cwd: dirname(archive), encoding: 'utf8' }
    );
    assert.equal(zipped.status, 0, zipped.stderr);
    writeFileSync(
      join(dist, 'v24.99.0', 'SHASUMS256.txt'),
      `${'0'.repeat(64)}  ${name}.7z\n${sha256(archive)}  ${name}.zip\n`
    );
    writeFileSync(
      join(dist, 'index.json'),
      JSON.stringify([
        { version: 'v25.0.0', lts: false },
        { version: 'v24.99.0', lts: 'Krypton' },
        { version: 'v22.0.0', lts: 'Jod' },
      ])
    );
    const local = mkdtempSync(join(scratch, 'local-'));
    const bin = join(local, 'bin');
    const bare = `${system};${dirname(system)};${dirname(powershell)}`;
    const result = await run(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        installPs1,
        '-Dir',
        bin,
      ],
      {
        env: withPath(
          clean({
            LOCALAPPDATA: local,
            SLICC_INSTALL_BASE_URL: release('zip', version),
            SLICC_NODE_DIST_BASE: `${url}/dist`,
          }),
          bare
        ),
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Node v24\.99\.0 installed to /);
    const managed = join(local, 'slicc-audio', 'node', 'node.exe');
    assert.ok(existsSync(managed));
    for (const name of COMMANDS) {
      assert.ok(readFileSync(join(bin, `${name}.ps1`), 'utf8').includes(`'${managed}'`));
      assert.ok(readFileSync(join(bin, `${name}.cmd`), 'utf8').includes(`"${managed}"`));
    }
    const reported = await batch(`"${join(bin, 'scsay.cmd')}" --version`, withPath(clean(), bare));
    assert.equal(reported.stdout.trim(), version, reported.stderr);
  });

  it('writes speech to a WAV file with the real System.Speech', async () => {
    const out = join(mkdtempSync(join(scratch, 'say-')), 'x.wav');
    const result = await run(
      process.execPath,
      [join(root, 'host', 'scsay.mjs'), '--engine', 'platform', '-o', out, 'hello'],
      { env: withPath(clean(), `${system};${dirname(powershell)}`) }
    );
    assert.equal(result.status, 0, result.stderr);
    const wav = readFileSync(out);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.length > 1000, String(wav.length));
  });

  for (const shell of ['powershell.exe', 'pwsh']) {
    it(`passes MediaFailed through for a corrupt WAV in the real ${shell}`, async (t) => {
      const exe =
        shell === 'pwsh'
          ? pwsh &&
            spawnSync(pwsh, ['-NoProfile', '-Command', '(Get-Command pwsh).Source'], {
              encoding: 'utf8',
            }).stdout.trim()
          : powershell;
      if (!exe) {
        t.skip('pwsh is not installed');
        return;
      }
      const file = join(mkdtempSync(join(scratch, 'corrupt-')), 'bad.wav');
      writeFileSync(
        file,
        Buffer.concat([Buffer.from('RIFF\xff\xff\xff\xffWAVEjunk'), Buffer.alloc(512, 0xa5)])
      );
      const started = Date.now();
      const played = await run(process.execPath, [join(root, 'host', 'scplay.mjs'), file], {
        env: withPath(clean(), `${system};${dirname(exe)}`),
      });
      t.diagnostic(`${shell} exited ${played.status}: ${played.stderr.trim()}`);
      assert.equal(played.status, 1, played.stderr);
      assert.doesNotMatch(played.stderr, /cannot decode audio/);
      assert.match(played.stderr, /^scplay: .*0xC00D[0-9A-F]{4}/);
      assert.ok(Date.now() - started < 9000, String(Date.now() - started));
    });
  }

  for (const shell of ['powershell.exe', 'pwsh']) {
    it(`lists the voices, and plays a WAV when there is an audio device, through the real ${shell}`, async (t) => {
      const exe =
        shell === 'pwsh'
          ? pwsh &&
            spawnSync(pwsh, ['-NoProfile', '-Command', '(Get-Command pwsh).Source'], {
              encoding: 'utf8',
            }).stdout.trim()
          : powershell;
      if (!exe) {
        t.skip('pwsh is not installed');
        return;
      }
      const env = withPath(clean(), `${system};${dirname(exe)}`);
      if (shell === 'powershell.exe') {
        const voices = await run(
          process.execPath,
          [join(root, 'host', 'scsay.mjs'), '--engine', 'platform', '--list'],
          { env }
        );
        assert.equal(voices.status, 0, voices.stderr);
        assert.match(voices.stdout, /^Microsoft \S+.* \([a-z]{2}-[A-Z]{2}\) \[platform\]/m);
      }
      const devices = spawnSync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', '@(Get-CimInstance Win32_SoundDevice).Count'],
        { encoding: 'utf8' }
      );
      const played = await run(process.execPath, [join(root, 'host', 'scchime.mjs')], { env });
      if (devices.stdout.trim() === '0') {
        t.diagnostic(`no audio device, ${shell} exited ${played.status}: ${played.stderr}`);
        t.skip('no audio device on this machine');
        return;
      }
      assert.equal(played.status, 0, `${shell}: ${played.stderr}`);
    });
  }
});
