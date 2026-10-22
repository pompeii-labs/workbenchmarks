// The data a post page renders: one summary per arm for the side by side
// table, and every attempt behind it so nothing is cherry-picked.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostAttempt } from './executor.ts';
import type { PostSpec } from './post.ts';

export interface ArmSummary {
    id: string;
    label: string;
    setup: string;
    workbench: string | null;
    workbench_version: string | null;
    model: string | null;
    attempts: number;
    works: number;
    infra_errors: number;
    /** Every attempt's model spend divided by the attempts that worked. */
    cost_per_working_result: number | null;
    total_cost: number | null;
    median_wall_ms: number | null;
    median_input_tokens: number | null;
    median_output_tokens: number | null;
    median_turns: number | null;
    median_tool_calls: number | null;
    checked_own_work: number | null;
    mean_gate_runs: number | null;
    /** The command-line tools the arm declared, so unused ones read as a share. */
    tools: string[];
    unused_tools: string[];
}

export interface PostData {
    version: 1;
    /** `prompt` is the exact request every attempt received. */
    post: { id: string; title: string; task: string; attempts: number; prompt: string };
    fixture: PostSpec['fixture'];
    generated_at: string;
    arms: ArmSummary[];
    attempts: PostAttempt[];
}

export function loadAttempts(directory: string): PostAttempt[] {
    const root = join(directory, 'attempts');
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .map((name) => join(root, name, 'result.json'))
        .filter((path) => existsSync(path))
        .map((path) => JSON.parse(readFileSync(path, 'utf8')) as PostAttempt);
}

export function buildPostData(
    post: PostSpec,
    attempts: PostAttempt[],
    { prompt = '', now = new Date() }: { prompt?: string; now?: Date } = {}
): PostData {
    return {
        version: 1,
        post: {
            id: post.id,
            title: post.title,
            task: post.task,
            attempts: post.attempts,
            prompt,
        },
        fixture: post.fixture,
        generated_at: now.toISOString(),
        arms: post.arms.map((arm) =>
            summarize(
                arm,
                attempts.filter((a) => a.arm === arm.id)
            )
        ),
        attempts: [...attempts].sort(
            (a, b) =>
                post.arms.findIndex((arm) => arm.id === a.arm) -
                    post.arms.findIndex((arm) => arm.id === b.arm) ||
                a.attempt - b.attempt
        ),
    };
}

function summarize(arm: PostSpec['arms'][number], attempts: PostAttempt[]): ArmSummary {
    // Infrastructure errors say nothing about the arm; they are counted, not scored.
    const scored = attempts.filter((a) => a.status !== 'infra_error');
    const works = scored.filter((a) => a.works).length;
    const costs = scored.map((a) => a.metrics.cost_usd);
    const total =
        costs.every((c) => c !== null) && costs.length
            ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
            : null;
    const behaviors = scored.map((a) => a.behavior).filter((b) => b?.available);
    const first = attempts.find((a) => a.workbench_version);
    return {
        id: arm.id,
        label: arm.label,
        setup: arm.setup,
        workbench: first?.workbench ?? null,
        workbench_version: first?.workbench_version ?? null,
        model: attempts.find((a) => a.model)?.model ?? null,
        attempts: scored.length,
        works,
        infra_errors: attempts.length - scored.length,
        cost_per_working_result: total !== null && works ? total / works : null,
        total_cost: total,
        median_wall_ms: median(scored.map((a) => a.metrics.elapsed_ms || null)),
        median_input_tokens: median(scored.map((a) => a.metrics.tokens.input)),
        median_output_tokens: median(scored.map((a) => a.metrics.tokens.output)),
        median_turns: median(scored.map((a) => a.behavior?.turns ?? null)),
        median_tool_calls: median(scored.map((a) => a.metrics.tool_calls)),
        checked_own_work: behaviors.length
            ? behaviors.filter((b) => b?.checked_own_work).length
            : null,
        mean_gate_runs:
            behaviors.length && arm.behavior?.gatePrograms?.length
                ? behaviors.reduce((sum, b) => sum + (b?.gate_runs ?? 0), 0) /
                  behaviors.length
                : null,
        tools: arm.behavior?.tools ?? [],
        unused_tools: (arm.behavior?.tools ?? []).filter((tool) =>
            behaviors.length
                ? behaviors.every((b) => b?.unused_tools.includes(tool))
                : false
        ),
    };
}

function median(values: (number | null)[]): number | null {
    const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (!known.length) return null;
    const middle = Math.floor(known.length / 2);
    return known.length % 2
        ? known[middle]!
        : (known[middle - 1]! + known[middle]!) / 2;
}
