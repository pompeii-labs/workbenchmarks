import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
    listTasks,
    loadTask,
    modelSlug,
    parseGrade,
    trialName,
    validateTask,
} from '../../src/core/spec.ts';
import { tally } from '../../src/grading/grading.ts';

const task = () => ({
    version: 1,
    id: 'example',
    workbench: 'example',
    title: 'Example task',
    fixture: { kind: 'empty' },
    criteria: [{ id: 'works', text: 'It works' }],
});

test('a required (non-practice) criterion failing or untested blocks a working result', () => {
    const spec = validateTask({
        ...task(),
        criteria: [{ id: 'required-check', text: 'Must actually work' }],
    });
    for (const status of ['fail', 'not-tested'] as const) {
        const verdicts = parseGrade(
            {
                version: 1,
                verdicts: [
                    {
                        id: 'required-check',
                        status,
                        evidence: 'Synthetic contract-test observation',
                        detail: 'Requested behavior is missing or could not be executed',
                    },
                ],
            },
            spec.criteria!
        );
        expect(tally(verdicts).works).toBe(false);
        expect(tally(verdicts).status).toBe(
            status === 'fail' ? 'failed' : 'inconclusive'
        );
    }
});
test('all shipped tasks validate without results or Docker', () => {
    const root = resolve(import.meta.dir, '../../tasks');
    for (const id of listTasks(root)) expect(loadTask(root, id).version).toBe(1);
});
test('rejects recipes with missing grading, unknown fields, traversal, or duplicate IDs', () => {
    expect(() => validateTask({ ...task(), criteria: [] })).toThrow();
    expect(() => validateTask({ ...task(), image: 'task-image' })).toThrow('Unknown');
    expect(() =>
        validateTask({ ...task(), fixture: { kind: 'dir', path: '../answers' } })
    ).toThrow();
    expect(() =>
        validateTask({
            ...task(),
            gates: [{ id: 'works', title: 'duplicate', run: 'true' }],
        })
    ).toThrow('Duplicate');
    expect(() =>
        validateTask({
            ...task(),
            fixture: {
                kind: 'git',
                url: 'https://example.org/repo',
                commit: 'main',
            },
        })
    ).toThrow('SHA');
});
test('model slugs are derived from the last path segment and reject unsafe ids', () => {
    expect(modelSlug('vendor/Model-X.1')).toBe('model-x.1');
    expect(modelSlug('openai/gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(() => modelSlug('vendor/weird name!')).toThrow();
    expect(() => modelSlug('')).toThrow();
});
test('trial names embed the task, model slug, arm, and rep', () => {
    expect(trialName('task', 'vendor/Model-X', 'plain', 2)).toBe(
        'task__model-x__plain__2'
    );
    expect(trialName('task', 'openai/gpt-5.6-terra', 'workbench', 1)).toBe(
        'task__gpt-5.6-terra__workbench__1'
    );
});
test('requires complete evidenced output with actual boolean-independent statuses', () => {
    const criteria = [{ id: 'works', text: 'It works' }];
    const valid = {
        version: 1,
        verdicts: [{ id: 'works', status: 'pass', evidence: 'GET / -> 200' }],
    };
    expect(parseGrade(valid, criteria)[0]!.pass).toBe(true);
    for (const v of [
        [],
        [{ id: 'works', status: 'pass' }],
        [{ id: 'works', status: 'fail', evidence: 'error' }],
        [{ id: 'other', status: 'pass', evidence: 'x' }],
        [...valid.verdicts, ...valid.verdicts],
    ])
        expect(() => parseGrade({ version: 1, verdicts: v }, criteria)).toThrow();
    expect(() =>
        parseGrade(
            {
                version: 1,
                verdicts: [{ id: 'works', pass: 'false', evidence: 'x' }],
            },
            criteria
        )
    ).toThrow();
});
