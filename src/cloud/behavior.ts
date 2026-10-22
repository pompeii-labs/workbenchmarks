// The behavior columns, read from a run's normalized events. They need the
// engine's scrubbed shell `programs` and `exit_code` on tool events; an older
// engine leaves them unavailable rather than guessed from the model's titles.
import type { RunEvent } from './api.ts';
import type { BehaviorSpec } from './post.ts';

export interface Behavior {
    /** False when no shell call carried `programs`, so nothing below can be read. */
    available: boolean;
    shell_calls: number;
    turns: number;
    /** Every program the agent ran, in first-seen order. */
    programs: string[];
    /** It ran something that builds, serves, tests, or fetches the result. */
    checked_own_work: boolean;
    /** Calls to the arm's own gate, and how many of them exited zero when known. */
    gate_runs: number;
    gate_passes: number | null;
    /** Shipped tools the agent never called. */
    unused_tools: string[];
}

export function readBehavior(
    events: RunEvent[],
    spec: BehaviorSpec | undefined,
    verificationPrograms: string[]
): Behavior {
    const programs: string[] = [];
    let available = false,
        shellCalls = 0,
        turns = 0,
        gateRuns = 0,
        gatePasses = 0,
        gateExitKnown = true;
    const gates = new Set(spec?.gatePrograms ?? []);
    for (const event of events) {
        if (event.type === 'turn.completed') turns++;
        if (event.type !== 'tool.completed') continue;
        const ran = event.data.programs;
        if (!Array.isArray(ran)) continue;
        available = true;
        shellCalls++;
        const names = ran.filter((p): p is string => typeof p === 'string');
        for (const name of names) if (!programs.includes(name)) programs.push(name);
        if (names.some((name) => gates.has(name))) {
            gateRuns++;
            const exit = event.data.exit_code;
            if (typeof exit !== 'number') gateExitKnown = false;
            else if (exit === 0 && event.data.status === 'completed') gatePasses++;
        }
    }
    const verification = new Set(verificationPrograms);
    return {
        available,
        shell_calls: shellCalls,
        turns,
        programs,
        checked_own_work: programs.some(
            (p) => verification.has(p) || verification.has(script(p)) || gates.has(p)
        ),
        gate_runs: gateRuns,
        gate_passes: gateRuns && gateExitKnown ? gatePasses : gateRuns ? null : 0,
        unused_tools: (spec?.tools ?? []).filter((tool) => !programs.includes(tool)),
    };
}

/** The script a package manager runs: `bun run check` and `pnpm check` are both `check`. */
function script(program: string): string {
    return /^(?:npm|bun|pnpm|yarn)(?: run)? (\S+)$/.exec(program)?.[1] ?? program;
}
