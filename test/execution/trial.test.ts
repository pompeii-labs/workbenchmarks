import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quote } from '../../src/core/runtime.ts';
import { validateTask } from '../../src/core/spec.ts';
import { checkCommand, prepareFixture } from '../../src/execution/trial.ts';

const temp: string[] = [];
function directory() {
    const dir = mkdtempSync(join(tmpdir(), 'workbenchmark-test-'));
    temp.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const task = () => ({
    version: 1,
    id: 'example',
    workbench: 'example',
    title: 'Example task',
    fixture: { kind: 'empty' },
    criteria: [{ id: 'works', text: 'It works' }],
});

test('fixture preparation preserves ordinary project only and handles spaces', async () => {
    const root = directory(),
        tasks = join(root, 'task folders'),
        project = join(root, 'project space');
    mkdirSync(join(tasks, 'example', 'fixture'), { recursive: true });
    mkdirSync(join(tasks, 'example', 'checks'));
    writeFileSync(join(tasks, 'example', 'fixture', 'README.md'), 'ordinary project');
    writeFileSync(join(tasks, 'example', 'checks', 'secret.sh'), 'exit 0');
    const spec = validateTask({ ...task(), fixture: { kind: 'dir', path: 'fixture' } });
    await prepareFixture(
        {
            bench: root,
            tasks,
            workbenches: root,
            results: root,
            work: root,
            imageCache: root,
        },
        spec,
        project,
        root
    );
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('ordinary project');
    expect(() => readFileSync(join(project, 'checks', 'secret.sh'))).toThrow();
    expect(checkCommand('./checks/seed.sh', "/path with 'quote")).toContain(
        '"$CHECKS_DIR"/seed.sh'
    );
    expect(quote("a'b")).toBe("'a'\"'\"'b'");
});
