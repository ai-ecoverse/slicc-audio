import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { loadOrtllama, runtimeFix } from '../../host/engines.mjs';
import { schear } from '../../host/hear.mjs';
import { scsay } from '../../host/say.mjs';
import { existsSync, fakeServer, run, temp, tone, writeFileSync } from './fakes.mjs';

const server = await fakeServer();
beforeEach(() => server.reset());

const noNode = async () => {
  throw new Error('ortllama on Node needs onnxruntime-node: npm install onnxruntime-node');
};
const noWeb = async () => {
  throw new Error('Cannot find package onnxruntime-web');
};
const web = async () => ({ track: 'web' });
const fix = runtimeFix('1.30.0');

function clip() {
  const file = join(temp('clip'), 'clip.wav');
  writeFileSync(file, tone());
  return file;
}

describe('the ONNX Runtime behind ortllama', () => {
  it('finds slicc-ortllama runtimes and runs on onnxruntime-web without onnxruntime-node', async () => {
    const mod = await loadOrtllama();
    assert.equal(typeof mod.startServer, 'function');
    assert.equal(typeof mod.createRuntime, 'function');
    assert.match(mod.onnx, /^\d+\.\d+\.\d+$/);
    assert.equal(mod.backends.length, 1);
    assert.equal((await mod.backends[0]({ env: {} })).track, 'web');
    assert.match(
      fix,
      /^npm install --prefix .+ --no-save --ignore-scripts onnxruntime-node@1\.30\.0$/
    );
  });

  it('lets schear transcribe on WASM when onnxruntime-node is missing', async () => {
    server.models.ortllama = ['transcribe'];
    server.backends.splice(0, 1, noNode, web);
    const r = await run(schear, { argv: ['--file', clip()], ortllama: server.ortllama });
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, 'hello from the server\n');
    assert.equal(r.code, 0);
    assert.deepEqual(server.runtimes, ['web']);
  });

  it('lets scsay speak on WASM when onnxruntime-node is missing', async () => {
    server.models.ortllama = ['speech'];
    server.backends.splice(0, 1, noNode, web);
    const out = join(temp('say'), 'out.wav');
    const r = await run(scsay, { argv: ['-o', out, 'hi'], ortllama: server.ortllama });
    assert.equal(r.stderr, '');
    assert.equal(r.code, 0);
    assert.ok(existsSync(out));
    assert.deepEqual(server.runtimes, ['web']);
  });

  it('never calls schear ortllama ready without a runtime, and names the fix', async () => {
    server.models.ortllama = ['transcribe'];
    server.backends.splice(0, 1, noNode, noWeb);
    let r = await run(schear, { argv: ['--status'], ortllama: server.ortllama });
    assert.equal(r.code, 0);
    assert.match(
      r.stdout,
      new RegExp(`^ortllama: no ONNX Runtime \\(${RegExp.escape(fix)}\\)$`, 'm')
    );
    for (const argv of [
      ['--file', clip()],
      ['--engine', 'ortllama', '--warmup'],
    ]) {
      r = await run(schear, { argv, ortllama: server.ortllama });
      assert.equal(r.code, 1);
      assert.match(
        r.stderr,
        new RegExp(`^ {2}ortllama: no ONNX Runtime \\(${RegExp.escape(fix)}\\)$`, 'm')
      );
    }
    assert.deepEqual(server.started, []);
  });

  it('never calls scsay ortllama ready without a runtime, and names the fix', async () => {
    server.models.ortllama = ['speech'];
    server.backends.splice(0, 1, noNode, noWeb);
    let r = await run(scsay, {
      argv: ['--status', '--engine=ortllama'],
      ortllama: server.ortllama,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `ortllama: no ONNX Runtime (${fix})\n`);
    for (const argv of [
      ['-o', join(temp('say'), 'out.wav'), 'hi'],
      ['--engine=ortllama', '--warmup'],
    ]) {
      r = await run(scsay, { argv, ortllama: server.ortllama });
      assert.equal(r.code, 1);
      assert.match(
        r.stderr,
        new RegExp(`^ {2}ortllama: no ONNX Runtime \\(${RegExp.escape(fix)}\\)$`, 'm')
      );
    }
    assert.deepEqual(server.started, []);
  });
});
