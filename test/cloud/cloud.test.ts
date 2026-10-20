import { afterEach, expect, test } from 'bun:test';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryApi, type RunEvent } from '../../src/cloud/api.ts';
import { readBehavior } from '../../src/cloud/behavior.ts';
import {
    attemptDirectory,
    type Grade,
    reconstructProject,
    runPost,
} from '../../src/cloud/executor.ts';
import {
    DEFAULT_VERIFICATION_PROGRAMS,
    type PostSpec,
    validatePost,
} from '../../src/cloud/post.ts';
import { buildPostData, loadAttempts } from '../../src/cloud/report.ts';
import type { Paths } from '../../src/core/runtime.ts';
import { loadTask } from '../../src/core/spec.ts';

const KEY = `wb_${'ab'.repeat(32)}`;
const COMMIT = 'a'.repeat(40);
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function post(overrides: Partial<PostSpec> = {}): PostSpec {
    return {
        version: 1,
        id: 'runner-game',
        title: 'Fable 5.1 builds a runner game',
        task: 'runner',
        attempts: 2,
        fixture: { repository: 'pompeii-labs/workbenchmarks-fixtures', commit: COMMIT },
        arms: [
            {
                id: 'vanilla',
                label: 'Fable 5.1',
                setup: 'Vanilla',
                workbench: 'bench/vanilla-fable',
            },
            {
                id: 'bench',
                label: 'Fable 5.1',
                setup: '+ threejs-game',
                workbench: 'pompeii/threejs-game',
                behavior: {
                    gatePrograms: ['tgcheck'],
                    tools: ['tgcheck', 'tgplaytest'],
                },
            },
        ],
        ...overrides,
    };
}

function workspace(): Paths {
    const root = mkdtempSync(join(tmpdir(), 'wb-post-'));
    roots.push(root);
    const paths: Paths = {
        bench: root,
        tasks: join(root, 'tasks'),
        workbenches: join(root, '.workbenches'),
        results: join(root, 'results'),
        work: join(root, '.work'),
        imageCache: join(root, '.image-cache'),
    };
    mkdirSync(join(paths.tasks, 'runner'), { recursive: true });
    writeFileSync(
        join(paths.tasks, 'runner', 'task.json'),
        JSON.stringify({
            version: 1,
            id: 'runner',
            workbench: 'threejs-game',
            title: 'Build a lane runner',
            fixture: { kind: 'empty' },
            timeoutMinutes: 20,
            gates: [{ id: 'builds', title: 'Builds', run: 'true' }],
        })
    );
    writeFileSync(
        join(paths.tasks, 'runner', 'prompt.md'),
        'Build a three-lane runner.\n'
    );
    return paths;
}

function shell(id: string, programs: string[], exit?: number): RunEvent {
    return {
        run_id: 'r',
        sequence: 0,
        timestamp: '',
        type: 'tool.completed',
        data: {
            id,
            name: 'bash',
            status: 'completed',
            programs,
            ...(exit === undefined ? {} : { exit_code: exit }),
        },
    };
}

test('a post names a task, a pinned fixture, and two to six distinct arms', () => {
    expect(validatePost(post())).toEqual(post());
    expect(() =>
        validatePost({ ...post(), fixture: { repository: 'a/b', commit: 'main' } })
    ).toThrow('full commit SHA');
    expect(() => validatePost({ ...post(), arms: [post().arms[0]] })).toThrow(
        '2 to 6 arms'
    );
    expect(() =>
        validatePost({ ...post(), arms: [post().arms[0], post().arms[0]] })
    ).toThrow('Duplicate arm id');
    expect(() =>
        validatePost({
            ...post(),
            arms: [
                post().arms[0],
                { ...post().arms[1], workbench: 'pompeii/threejs-game@0.2.3' },
            ],
        })
    ).toThrow('organization/name or { version_id }');
    expect(() => validatePost({ ...post(), extra: true })).toThrow(
        'Unknown post field: extra'
    );
});

test('behavior reads programs, the gate, and unused tools from shell events', () => {
    const events: RunEvent[] = [
        { run_id: 'r', sequence: 1, timestamp: '', type: 'turn.completed', data: {} },
        shell('a', ['npm install']),
        shell('b', ['tgcheck'], 1),
        shell('c', ['npm run build', 'tgcheck'], 0),
        {
            run_id: 'r',
            sequence: 5,
            timestamp: '',
            type: 'tool.completed',
            data: { id: 'd', name: 'write' },
        },
    ];
    expect(
        readBehavior(events, post().arms[1]!.behavior, DEFAULT_VERIFICATION_PROGRAMS)
    ).toEqual({
        available: true,
        shell_calls: 3,
        turns: 1,
        programs: ['npm install', 'tgcheck', 'npm run build'],
        checked_own_work: true,
        gate_runs: 2,
        gate_passes: 1,
        unused_tools: ['tgplaytest'],
    });
    // An engine without scrubbed programs leaves behavior unavailable, never guessed.
    const old = readBehavior(
        [
            {
                run_id: 'r',
                sequence: 1,
                timestamp: '',
                type: 'tool.completed',
                data: { name: 'bash', title: 'Run the gate' },
            },
        ],
        post().arms[1]!.behavior,
        DEFAULT_VERIFICATION_PROGRAMS
    );
    expect(old.available).toBe(false);
    expect(old.checked_own_work).toBe(false);
    // A gate whose exit status the runner does not report has unknown passes.
    expect(
        readBehavior([shell('a', ['tgcheck'])], { gatePrograms: ['tgcheck'] }, [])
            .gate_passes
    ).toBeNull();
});

/** A workbenches.dev runs API that moves each run through its statuses. */
function fakeRegistry(options: { needsInput?: string; failCreate?: boolean } = {}) {
    type FakeRun = {
        n: number;
        polls: number;
        cancelled: boolean;
        key: string;
        workbench: unknown;
    };
    const runs = new Map<string, FakeRun>();
    const created: Record<string, unknown>[] = [];
    let count = 0;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) => {
            if (request.headers.get('authorization') !== `Bearer ${KEY}`)
                return new Response('unauthorized', { status: 401 });
            const url = new URL(request.url);
            const parts = url.pathname.split('/').filter(Boolean);
            if (request.method === 'POST' && url.pathname === '/v1/runs') {
                if (options.failCreate)
                    return Response.json(
                        { error: 'payment_required' },
                        { status: 402 }
                    );
                const body = (await request.json()) as Record<string, unknown>;
                created.push(body);
                const existing = [...runs.entries()].find(
                    ([, r]) => r.key === body.idempotency_key
                );
                if (existing) return Response.json(view(existing[0]));
                const id = `run_${++count}`;
                // Keys read post:<post>:<arm>:<attempt>:<digest>; the attempt sets this run's spend.
                const key = String(body.idempotency_key);
                runs.set(id, {
                    n: Number(key.split(':')[3]),
                    polls: 0,
                    cancelled: false,
                    key,
                    workbench: body.workbench,
                });
                return Response.json(view(id), { status: 201 });
            }
            const id = parts[2]!;
            const run = runs.get(id);
            if (parts[1] === 'sessions')
                return Response.json({ id, model: 'openrouter/fable-5.1' });
            if (!run) return new Response('missing', { status: 404 });
            if (parts[3] === 'commands') {
                run.cancelled = true;
                return Response.json({ sequence: 1 }, { status: 202 });
            }
            if (parts[3] === 'events') {
                const after = Number(url.searchParams.get('after'));
                const all = events(id, run);
                const page = all.filter((e) => e.sequence > after).slice(0, 2);
                return Response.json({
                    events: page,
                    next: page.at(-1)?.sequence ?? after,
                });
            }
            if (parts[3] === 'changes')
                return run.cancelled
                    ? new Response('none', { status: 404 })
                    : new Response(`diff --git a/${id}.txt b/${id}.txt\n`);
            run.polls++;
            return Response.json(view(id));
        },
    });
    function status(run: FakeRun) {
        if (run.cancelled) return 'cancelled';
        if (options.needsInput && run.key.startsWith(options.needsInput))
            return run.polls >= 1 ? 'needs_input' : 'running';
        return ['queued', 'running', 'completed'][Math.min(run.polls, 2)];
    }
    function view(id: string) {
        const run = runs.get(id)!;
        const s = status(run);
        const done = ['completed', 'cancelled'].includes(s);
        return {
            id,
            session_id: `wbs_${id}`,
            status: s,
            workbench: {
                slug: String(run.workbench).split('/')[1],
                organization_slug: String(run.workbench).split('/')[0],
            },
            version: {
                id: crypto.randomUUID(),
                version: '0.2.3',
                digest: 'd'.repeat(64),
            },
            package_digest: 'e'.repeat(64),
            final_response: done ? 'Done, the game is ready to play.' : null,
            terminal_reason: s === 'cancelled' ? 'Cancelled by the organization' : null,
            usage: null,
            max_minutes: 20,
            created_at: '2026-10-21T10:00:00.000Z',
            started_at: '2026-10-21T10:00:00.000Z',
            completed_at: done ? '2026-10-21T10:05:00.000Z' : null,
        };
    }
    function events(id: string, run: FakeRun): RunEvent[] {
        const bench = String(runs.get(id)!.workbench).startsWith('pompeii/');
        return [
            { type: 'turn.started', data: {} },
            {
                type: 'tool.completed',
                data: {
                    id: 't1',
                    name: 'bash',
                    status: 'completed',
                    programs: bench ? ['tgcheck'] : ['ls'],
                    exit_code: 0,
                },
            },
            {
                type: 'usage.updated',
                data: {
                    kind: 'delta',
                    total_tokens: 30,
                    input_tokens: 20,
                    output_tokens: 10,
                    reasoning_tokens: 0,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    cost_usd: 0.25 * run.n,
                },
            },
            { type: 'turn.completed', data: { reason: 'stop' } },
            { type: 'run.completed', data: {} },
        ].map((e, i) => ({ ...e, run_id: id, sequence: i + 1, timestamp: '' }));
    }
    return {
        server,
        created,
        api: new RegistryApi(`http://127.0.0.1:${server.port}`, KEY),
    };
}

test('a post runs every attempt in the cloud, grades its patch, and resumes', async () => {
    const paths = workspace();
    const registry = fakeRegistry({ needsInput: 'post:runner-game:vanilla:2:' });
    const graded: string[] = [];
    const grade: Grade = async (_paths, _task, _owner, _work, project, evidence) => {
        graded.push(readFileSync(join(project, 'patch.txt'), 'utf8'));
        mkdirSync(evidence, { recursive: true });
        return {
            verdicts: [
                {
                    id: 'builds',
                    kind: 'gate',
                    title: 'Builds',
                    pass: true,
                    status: 'pass',
                },
            ],
        };
    };
    const reconstruct = async (_post: PostSpec, patch: string, project: string) => {
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, 'patch.txt'), patch);
    };
    const task = loadTask(paths.tasks, 'runner');
    try {
        const results = await runPost(
            paths,
            post(),
            task,
            { api: registry.api, grade, reconstruct, sleep: async () => {}, pollMs: 0 },
            2
        );
        expect(results.map((r) => [r.arm, r.attempt, r.status, r.run_status])).toEqual([
            ['bench', 1, 'passed', 'completed'],
            ['bench', 2, 'passed', 'completed'],
            ['vanilla', 1, 'passed', 'completed'],
            ['vanilla', 2, 'inconclusive', 'cancelled'],
        ]);
        // Every attempt starts from the pinned fixture with the task's prompt and time limit.
        expect(registry.created[0]).toEqual(
            expect.objectContaining({
                task: 'Build a three-lane runner.',
                workspace: {
                    repository: 'pompeii-labs/workbenchmarks-fixtures',
                    ref: COMMIT,
                },
                max_minutes: 20,
            })
        );
        expect(new Set(registry.created.map((c) => c.idempotency_key)).size).toBe(4);
        // The cancelled attempt kept no patch and was never graded.
        const cancelled = results.find((r) => r.run_status === 'cancelled')!.run_id;
        expect(graded).toHaveLength(3);
        expect(graded.some((patch) => patch.includes(`${cancelled}.txt`))).toBe(false);
        const bench = results.find((r) => r.arm === 'bench' && r.attempt === 1)!;
        expect(bench.workbench).toBe('pompeii/threejs-game');
        expect(bench.model).toBe('openrouter/fable-5.1');
        expect(bench.final_response).toBe('Done, the game is ready to play.');
        expect(bench.metrics.elapsed_ms).toBe(300_000);
        expect(bench.metrics.completed).toBe(true);
        expect(bench.behavior?.gate_runs).toBe(1);
        expect(bench.behavior?.unused_tools).toEqual(['tgplaytest']);
        const saved = attemptDirectory(paths, post(), post().arms[1]!, 1);
        expect(
            readFileSync(join(saved, 'events.ndjson'), 'utf8').trim().split('\n')
        ).toHaveLength(5);
        expect(existsSync(join(saved, 'changes.diff'))).toBe(true);

        // A rerun resumes from saved results without creating runs or grading again.
        const before = registry.created.length;
        await runPost(paths, post(), task, {
            api: registry.api,
            grade,
            reconstruct,
            sleep: async () => {},
        });
        expect(registry.created.length).toBe(before);
        expect(graded).toHaveLength(3);

        const data = buildPostData(
            post(),
            loadAttempts(join(paths.results, 'posts', 'runner-game')),
            new Date(0)
        );
        const [vanilla, withBench] = data.arms;
        expect(vanilla).toEqual(
            expect.objectContaining({
                id: 'vanilla',
                attempts: 2,
                works: 1,
                checked_own_work: 0,
                mean_gate_runs: null,
            })
        );
        expect(withBench).toEqual(
            expect.objectContaining({
                id: 'bench',
                works: 2,
                total_cost: 0.75,
                cost_per_working_result: 0.375,
                checked_own_work: 2,
                mean_gate_runs: 1,
                unused_tools: ['tgplaytest'],
                median_wall_ms: 300_000,
                workbench_version: '0.2.3',
            })
        );
        expect(data.attempts.map((a) => a.arm)).toEqual([
            'vanilla',
            'vanilla',
            'bench',
            'bench',
        ]);
    } finally {
        registry.server.stop(true);
    }
});

test('a refused run is an infrastructure error, counted but never scored', async () => {
    const paths = workspace();
    const registry = fakeRegistry({ failCreate: true });
    try {
        const results = await runPost(
            paths,
            post({ attempts: 1 }),
            loadTask(paths.tasks, 'runner'),
            {
                api: registry.api,
                grade: async () => ({ verdicts: [] }),
                sleep: async () => {},
            }
        );
        expect(results.every((r) => r.status === 'infra_error')).toBe(true);
        expect(results[0]!.infra_error).toContain('workbenches.dev 402');
        const data = buildPostData(post({ attempts: 1 }), results);
        expect(data.arms[0]).toEqual(
            expect.objectContaining({
                attempts: 0,
                infra_errors: 1,
                cost_per_working_result: null,
            })
        );
    } finally {
        registry.server.stop(true);
    }
});

test('the graded project is the fixture commit with the attempt patch applied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-fixture-'));
    roots.push(root);
    const source = join(root, 'origin', 'owner', 'fixtures.git');
    mkdirSync(source, { recursive: true });
    const git = (cwd: string, ...args: string[]) => {
        const r = Bun.spawnSync(['git', '-C', cwd, ...args]);
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        return r.stdout.toString().trim();
    };
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    writeFileSync(join(source, 'index.html'), '<h1>start</h1>\n');
    git(source, 'add', '-A');
    git(
        source,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '-m',
        'fixture'
    );
    const commit = git(source, 'rev-parse', 'HEAD');
    const patch = [
        'diff --git a/index.html b/index.html',
        '--- a/index.html',
        '+++ b/index.html',
        '@@ -1 +1 @@',
        '-<h1>start</h1>',
        '+<h1>runner</h1>',
        'diff --git a/game.js b/game.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/game.js',
        '@@ -0,0 +1 @@',
        '+export const lanes = 3;',
        '',
    ].join('\n');
    const project = join(root, 'work', 'project');
    await reconstructProject(
        post({ fixture: { repository: 'owner/fixtures', commit } }),
        patch,
        project,
        `file://${join(root, 'origin')}`
    );
    expect(readFileSync(join(project, 'index.html'), 'utf8')).toBe('<h1>runner</h1>\n');
    expect(readFileSync(join(project, 'game.js'), 'utf8')).toBe(
        'export const lanes = 3;\n'
    );
    // The baseline is the untouched fixture, so the grader sees what the agent changed.
    expect(git(project, 'show', 'baseline:index.html')).toBe('<h1>start</h1>');
    expect(git(project, 'diff', '--name-only', 'baseline')).toBe('index.html');
    expect(git(project, 'ls-files', '--others')).toBe('game.js');
});

test('the API client refuses anything but an organization key', () => {
    expect(() => new RegistryApi('http://x', 'sk-or-v1-abc')).toThrow(
        'workbenches.dev API key'
    );
    expect(() => RegistryApi.fromEnvironment({})).toThrow('WORKBENCHES_API_KEY');
});
