const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const packageJson = require('../package.json');

const entrypoint = path.resolve(__dirname, '../lib/index.js');

test('the public package exposes only the short flow executable', () => {
    assert.deepEqual(packageJson.bin, { flow: 'lib/index.js' });
});

test('the public CLI identifies itself as flow and prints only short commands', () => {
    const version = spawnSync(process.execPath, [entrypoint, '--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), 'flow 1.74.0');

    const help = spawnSync(process.execPath, [entrypoint, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /flow template/);
    assert.match(help.stdout, /flow serve/);
    assert.doesNotMatch(help.stdout, /flow-studio (?:template|serve|run|author|tui)/);
});
