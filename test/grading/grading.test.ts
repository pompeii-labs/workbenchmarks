import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paths } from '../../src/core/runtime.ts';
import { loadTask, type Verdict, validateTask } from '../../src/core/spec.ts';
import {
    gateStatus,
    prepareFixture,
    type TrialResult,
    tally,
} from '../../src/execution/trial.ts';
import { gradingBrief, submissionArchiveCommand } from '../../src/grading/grading.ts';
import { assessmentTable } from '../../src/results/report.ts';

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

test('browser infrastructure blockers are not submission failures', () => {
    const blocker = JSON.stringify({
        version: 1,
        probes: [{ id: 'infrastructure', status: 'not-tested' }],
    });
    expect(gateStatus(2, blocker)).toBe('not-tested');
    expect(gateStatus(2, 'unstructured error')).toBe('fail');
    expect(gateStatus(1, blocker)).toBe('fail');
    expect(gateStatus(0, '')).toBe('pass');
    expect(
        gateStatus(
            2,
            JSON.stringify({
                version: 1,
                probes: [
                    { id: 'infrastructure', status: 'not-tested' },
                    { id: 'contrast', status: 'fail' },
                ],
            })
        )
    ).toBe('fail');
});

test('required gate failures remain failures while passing dimensions remain visible', () => {
    const verdicts = [
        {
            id: 'functionality',
            kind: 'gate',
            title: 'Functionality',
            status: 'pass',
            pass: true,
        },
        {
            id: 'health-endpoint',
            kind: 'gate',
            title: 'Health endpoint',
            status: 'fail',
            pass: false,
        },
        { id: 'style', kind: 'criterion', title: 'Style', status: 'pass', pass: true },
    ] as TrialResult['verdicts'];
    expect(tally(verdicts).status).toBe('failed');
    const table = assessmentTable([
        { task: 'example', arm: 'plain', rep: 1, verdicts } as TrialResult,
    ]);
    expect(table).toContain('| functionality | pass |');
    expect(table).toContain('| health-endpoint | fail |');
    expect(table).toContain('| style | pass |');
});

test('example-hello has a deterministic gate and no judged criteria', () => {
    const task = loadTask(join(import.meta.dir, '../..', 'tasks'), 'example-hello');
    expect(task.fixture).toEqual({ kind: 'dir', path: 'fixture' });
    expect(task.criteria ?? []).toEqual([]);
    expect(task.gates?.map((g) => g.id)).toEqual(['health-endpoint']);
});

test('actor staging contains only the fixture and baseline Git metadata', async () => {
    const tasks = join(import.meta.dir, '../..', 'tasks');
    const task = loadTask(tasks, 'example-hello');
    const scratch = mkdtempSync(join(tmpdir(), 'wb-fixture-'));
    const project = join(scratch, 'project');
    try {
        await prepareFixture({ tasks } as Paths, task, project, scratch);
        expect(readdirSync(project).sort()).toEqual([
            '.git',
            'package.json',
            'server.js',
        ]);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

const verdict = (
    status: Verdict['status'],
    kind: Verdict['kind'] = 'criterion'
): Verdict => ({
    id: 'works',
    title: 'Works',
    kind,
    status,
    pass: status === 'pass',
    evidence: 'Executed a probe',
});

// Archives through a real container, so it needs a Docker engine, and may
// first pull its alpine image: allow well past bun's 5 s default.
test.skipIf(!Bun.which('docker'))(
    'submission archive excludes node_modules and task-declared paths, not unrelated directories',
    () => {
        const root = directory();
        const project = join(root, 'project with spaces');
        mkdirSync(join(project, 'scratch', '.cache'), { recursive: true });
        mkdirSync(join(project, 'other'), { recursive: true });
        mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(
            join(project, 'scratch', '.cache', 'start-secrets'),
            'runtime-only',
            {
                mode: 0o000,
            }
        );
        writeFileSync(join(project, 'other', 'data.txt'), 'kept');
        writeFileSync(
            join(project, 'node_modules', 'dep', 'index.js'),
            'module.exports = 1;'
        );
        writeFileSync(join(project, 'app.js'), 'export default 1;');
        const archive = join(root, 'submission.tar.gz');
        const result = Bun.spawnSync([
            'bash',
            '-c',
            submissionArchiveCommand(project, archive, ['scratch/.cache']),
        ]);
        expect(result.exitCode).toBe(0);
        const listing = Bun.spawnSync(['tar', '-tzf', archive]);
        expect(listing.exitCode).toBe(0);
        const names = listing.stdout.toString();
        expect(names).not.toContain('scratch/.cache');
        expect(names).not.toContain('node_modules');
        for (const file of ['other/data.txt', 'app.js']) expect(names).toContain(file);
        const content = Bun.spawnSync(['tar', '-xOzf', archive, './other/data.txt']);
        expect(content.exitCode).toBe(0);
        expect(content.stdout.toString()).toBe('kept');
    },
    60_000
);

test('missing coverage is inconclusive; practices do not change working status', () => {
    expect(tally([verdict('not-tested')]).status).toBe('inconclusive');
    expect(tally([verdict('pass'), verdict('fail', 'practice')]).works).toBe(true);
    expect(tally([verdict('fail'), verdict('not-tested')]).status).toBe('failed');
    expect(tally([]).works).toBe(false);
});

test('brief has no arm, agent transcript, or benchmark repository mount', () => {
    const brief = gradingBrief(
        validateTask(task()),
        'Do this',
        '/evidence/result.json',
        '/evidence/checks',
        []
    );
    expect(brief).not.toContain('plain');
    expect(brief).not.toContain('/bench');
    expect(brief).toContain('Do this');
});
