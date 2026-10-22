// Runs a post: every arm's attempts as workbenches.dev cloud runs on the same
// fixture commit, then each attempt's patch applied to that commit locally and
// graded by the task's own gates, exactly like a local trial.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Paths, quote } from '../core/runtime.ts';
import { prompt, type TaskSpec, type Verdict } from '../core/spec.ts';
import { json, must } from '../execution/container.ts';
import { tally } from '../grading/grading.ts';
import { emptyMetrics, type Metrics, parseEvents } from '../results/metrics.ts';
import { type RegistryApi, type Run, TERMINAL } from './api.ts';
import { type Behavior, readBehavior } from './behavior.ts';
import { DEFAULT_VERIFICATION_PROGRAMS, type PostArm, type PostSpec } from './post.ts';

export interface PostAttempt {
    version: 1;
    post: string;
    task: string;
    arm: string;
    attempt: number;
    run_id: string | null;
    session_id: string | null;
    workbench: string | null;
    workbench_version: string | null;
    package_digest: string | null;
    model: string | null;
    run_status: Run['status'] | null;
    terminal_reason: string | null;
    final_response: string | null;
    started_at: string | null;
    completed_at: string | null;
    metrics: Metrics;
    behavior: Behavior | null;
    verdicts: Verdict[];
    gates: { passed: number; total: number };
    criteria: { passed: number; total: number };
    practice: { passed: number; total: number };
    works: boolean;
    status: 'passed' | 'failed' | 'inconclusive' | 'infra_error';
    infra_error?: string;
}

export type Grade = (
    paths: Paths,
    task: TaskSpec,
    owner: string,
    work: string,
    project: string,
    evidence: string
) => Promise<{ verdicts: Verdict[]; metrics?: Metrics }>;

export interface PostDependencies {
    api: Pick<
        RegistryApi,
        'createRun' | 'run' | 'session' | 'events' | 'changes' | 'cancel'
    >;
    grade: Grade;
    /** Builds the graded project: the fixture commit with the attempt's patch applied. */
    reconstruct?: (post: PostSpec, patch: string, project: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
    pollMs?: number;
}

export function postDirectory(paths: Paths, post: PostSpec): string {
    return join(paths.results, 'posts', post.id);
}

export function attemptDirectory(
    paths: Paths,
    post: PostSpec,
    arm: PostArm,
    n: number
) {
    return join(postDirectory(paths, post), 'attempts', `${arm.id}__${n}`);
}

/**
 * The run's idempotency key. A rerun of the same post resumes the same runs;
 * changing an arm's Workbench, the fixture, or the prompt starts new ones.
 */
export function attemptKey(post: PostSpec, arm: PostArm, n: number, text: string) {
    const digest = createHash('sha256')
        .update(JSON.stringify([post.id, arm.id, n, arm.workbench, post.fixture, text]))
        .digest('hex')
        .slice(0, 32);
    return `post:${post.id}:${arm.id}:${n}:${digest}`;
}

export async function runPost(
    paths: Paths,
    post: PostSpec,
    task: TaskSpec,
    deps: PostDependencies,
    parallel = 3
): Promise<PostAttempt[]> {
    if (task.id !== post.task)
        throw new Error(`Post ${post.id} runs task ${post.task}`);
    const text = prompt(paths.tasks, task.id);
    const directory = postDirectory(paths, post);
    mkdirSync(directory, { recursive: true });
    json(join(directory, 'post.json'), post);
    writeFileSync(join(directory, 'prompt.md'), text);

    const queue = post.arms.flatMap((arm) =>
        Array.from({ length: post.attempts }, (_, i) => ({ arm, n: i + 1 }))
    );
    const results: PostAttempt[] = [];
    // Cloud runs wait in parallel; grading shares this host's Docker, one at a time.
    let grading = Promise.resolve();
    const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
        const next = grading.then(work);
        grading = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    };
    const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
            results.push(
                await runAttempt(
                    paths,
                    post,
                    task,
                    item.arm,
                    item.n,
                    text,
                    deps,
                    exclusive
                )
            );
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
    return results.sort((a, b) => a.arm.localeCompare(b.arm) || a.attempt - b.attempt);
}

async function runAttempt(
    paths: Paths,
    post: PostSpec,
    task: TaskSpec,
    arm: PostArm,
    n: number,
    text: string,
    deps: PostDependencies,
    exclusive: <T>(work: () => Promise<T>) => Promise<T>
): Promise<PostAttempt> {
    const out = attemptDirectory(paths, post, arm, n);
    const saved = join(out, 'result.json');
    if (existsSync(saved))
        return JSON.parse(readFileSync(saved, 'utf8')) as PostAttempt;
    mkdirSync(out, { recursive: true });
    const log = (message: string) =>
        deps.log?.(`${post.id} / ${arm.id} / ${n}: ${message}`);
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const pollMs = deps.pollMs ?? 15_000;

    let run: Run | undefined,
        model: string | null = null,
        metrics = emptyMetrics(),
        behavior: Behavior | null = null,
        verdicts: Verdict[] = [],
        infraError: string | undefined;
    try {
        const key = attemptKey(post, arm, n, text);
        run = await deps.api.createRun({
            workbench: arm.workbench,
            task: text,
            workspace: {
                repository: post.fixture.repository,
                ref: post.fixture.commit,
            },
            idempotency_key: key,
            max_minutes: Math.ceil(task.timeoutMinutes ?? 30),
        });
        log(`run ${run.id} ${run.status}`);
        json(join(out, 'run-created.json'), run);
        const deadline = Date.now() + (run.max_minutes + 20) * 60_000;
        let cancelled = false;
        while (!TERMINAL.includes(run.status)) {
            if (Date.now() > deadline) throw new Error(`Run ${run.id} never ended`);
            if (run.status === 'needs_input' && !cancelled) {
                // Nobody answers a benchmark run; waiting for input is a failed attempt.
                log('asked for input; cancelling');
                await deps.api.cancel(run.id, `${key}:cancel`);
                cancelled = true;
            }
            await sleep(pollMs);
            run = await deps.api.run(run.id);
        }
        log(
            `run ${run.status}${run.terminal_reason ? `: ${run.terminal_reason}` : ''}`
        );
        json(join(out, 'run.json'), run);
        model = (await deps.api.session(run.session_id)).model;

        const events = await deps.api.events(run.id);
        const eventsPath = join(out, 'events.ndjson');
        writeFileSync(
            eventsPath,
            `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
        );
        const started = run.started_at ? Date.parse(run.started_at) : NaN;
        const ended = run.completed_at ? Date.parse(run.completed_at) : NaN;
        metrics = {
            ...parseEvents(eventsPath, 'workbench'),
            elapsed_ms:
                Number.isFinite(started) && Number.isFinite(ended)
                    ? ended - started
                    : 0,
            timed_out: /time limit|max_minutes|deadline|timed out/i.test(
                run.terminal_reason ?? ''
            ),
            exit_code: null,
        };
        behavior = readBehavior(
            events,
            arm.behavior,
            post.verificationPrograms ?? DEFAULT_VERIFICATION_PROGRAMS
        );

        const patch = await deps.api.changes(run.id);
        writeFileSync(join(out, 'changes.diff'), patch);
        if (run.status === 'completed' || patch) {
            const owner = `post-${post.id}-${arm.id}-${n}`;
            const work = join(paths.work, `${owner}-${crypto.randomUUID()}`);
            const project = join(work, 'project');
            await exclusive(async () => {
                log('grading');
                await (deps.reconstruct ?? reconstructProject)(post, patch, project);
                const graded = await deps.grade(
                    paths,
                    task,
                    owner,
                    work,
                    project,
                    join(out, 'grading')
                );
                verdicts = graded.verdicts;
            });
        }
    } catch (error) {
        infraError = String(error);
        log(`infrastructure error: ${infraError}`);
    }
    const counted = tally(verdicts);
    const result: PostAttempt = {
        version: 1,
        post: post.id,
        task: task.id,
        arm: arm.id,
        attempt: n,
        run_id: run?.id ?? null,
        session_id: run?.session_id ?? null,
        workbench: run
            ? `${run.workbench.organization_slug}/${run.workbench.slug}`
            : null,
        workbench_version: run?.version.version ?? null,
        package_digest: run?.package_digest ?? null,
        model,
        run_status: run?.status ?? null,
        terminal_reason: run?.terminal_reason ?? null,
        final_response: run?.final_response ?? null,
        started_at: run?.started_at ?? null,
        completed_at: run?.completed_at ?? null,
        metrics,
        behavior,
        verdicts,
        ...counted,
        ...(infraError
            ? { infra_error: infraError, works: false, status: 'infra_error' as const }
            : {}),
    };
    json(saved, result);
    log(`${result.status}${result.works ? ', works' : ''}`);
    return result;
}

/** The fixture commit as a fresh repository tagged `baseline`, with the attempt's patch applied. */
export async function reconstructProject(
    post: PostSpec,
    patch: string,
    project: string,
    origin = 'https://github.com'
) {
    mkdirSync(project, { recursive: true });
    const url = `${origin}/${post.fixture.repository}.git`;
    await must(
        `git init -q ${quote(project)} && git -C ${quote(project)} fetch -q --depth 1 ${quote(url)} ${quote(post.fixture.commit)} && git -C ${quote(project)} checkout -q FETCH_HEAD && rm -rf ${quote(join(project, '.git'))}`
    );
    await must(
        `git -C ${quote(project)} init -q -b main && git -C ${quote(project)} add -A && git -C ${quote(project)} -c user.name=developer -c user.email=dev@example.com commit -q --allow-empty -m 'Current project' && git -C ${quote(project)} tag baseline`
    );
    if (!patch.trim()) return;
    const file = join(project, '..', 'changes.diff');
    writeFileSync(file, patch);
    await must(`git -C ${quote(project)} apply --whitespace=nowarn ${quote(file)}`);
}
