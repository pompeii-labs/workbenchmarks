import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pinModel, stagePlainControl } from '../../src/execution/packaging.ts';

const temp: string[] = [];
function directory() {
    const dir = mkdtempSync(join(tmpdir(), 'workbenchmark-test-'));
    temp.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('both arms deliver the same scoped permissions through packaged runner config', () => {
    const bench = resolve(import.meta.dir, '../..');
    const paths = {
        bench,
        workbenches: join(bench, '.workbenches'),
        tasks: join(bench, 'tasks'),
        results: directory(),
        work: directory(),
        imageCache: directory(),
    };
    const plain = stagePlainControl(paths, paths.work, false);
    const expected = {
        '*': 'deny',
        '/workbench/*': 'allow',
        '/runtime-assets/*': 'allow',
        '/tmp/*': 'allow',
    };
    for (const pkg of [
        plain,
        ...['example', 'grader'].map((n) => join(paths.workbenches, n)),
    ]) {
        expect(readFileSync(join(pkg, 'workbench.yml'), 'utf8')).toContain(
            'runner_config: ./opencode.json'
        );
        expect(
            JSON.parse(readFileSync(join(pkg, 'opencode.json'), 'utf8')).permission
                .external_directory
        ).toEqual(expected);
    }
});

test('pinModel replaces only the declared model block, leaving the rest of the package untouched', () => {
    const dir = directory();
    writeFileSync(
        join(dir, 'workbench.yml'),
        [
            'spec: 0',
            'version: 1.0.0',
            'name: example',
            'model:',
            '  id: old/model',
            '  routes:',
            '    - provider: openrouter',
            '      model: old/model',
            'instructions: ./instructions.md',
            '',
        ].join('\n')
    );
    pinModel(dir, 'vendor/new-model');
    const updated = readFileSync(join(dir, 'workbench.yml'), 'utf8');
    expect(updated).toContain('id: vendor/new-model');
    expect(updated).toContain('model: vendor/new-model');
    expect(updated).toContain('instructions: ./instructions.md');
    expect(updated).not.toContain('old/model');
});

test('pinModel requires a declared model to replace', () => {
    const dir = directory();
    writeFileSync(join(dir, 'workbench.yml'), 'spec: 0\nname: example\n');
    expect(() => pinModel(dir, 'vendor/new-model')).toThrow();
});
