// The slice of the workbenches.dev runs API a post needs: start a run on a
// repository, follow it to its end, and read back its events and patch.

export type RunStatus =
    | 'queued'
    | 'provisioning'
    | 'starting'
    | 'running'
    | 'needs_input'
    | 'completing'
    | 'completed'
    | 'failed'
    | 'cancelled';

export const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export interface Run {
    id: string;
    session_id: string;
    status: RunStatus;
    workbench: { slug: string; organization_slug: string };
    version: { id: string; version: string; digest: string };
    package_digest: string;
    final_response: string | null;
    terminal_reason: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cost_usd: number | null;
    } | null;
    max_minutes: number;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
}

export interface RunSession {
    id: string;
    model: string;
    runner?: string;
}

export interface RunEvent {
    run_id: string;
    sequence: number;
    timestamp: string;
    type: string;
    runner?: string;
    data: Record<string, unknown>;
}

export interface CreateRun {
    workbench: string | { version_id: string };
    task: string;
    workspace: { repository: string; ref: string };
    idempotency_key: string;
    max_minutes: number;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
    }
}

export class RegistryApi {
    constructor(
        private readonly origin: string,
        private readonly key: string,
        private readonly fetcher: typeof fetch = fetch
    ) {
        if (!/^wb_[a-f0-9]{64}$/.test(key))
            throw new Error('WORKBENCHES_API_KEY must be a workbenches.dev API key');
    }

    static fromEnvironment(env = process.env): RegistryApi {
        const key = env.WORKBENCHES_API_KEY;
        if (!key) throw new Error('Set WORKBENCHES_API_KEY to an organization API key');
        return new RegistryApi(
            env.WORKBENCHES_API_URL ?? 'https://api.workbenches.dev',
            key
        );
    }

    /** Starts a run, or returns the one that already holds this idempotency key. */
    createRun(body: CreateRun): Promise<Run> {
        return this.json('POST', '/v1/runs', body);
    }

    run(id: string): Promise<Run> {
        return this.json('GET', `/v1/runs/${encodeURIComponent(id)}`);
    }

    session(id: string): Promise<RunSession> {
        return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}`);
    }

    /** Every event of a run, in sequence order. */
    async events(id: string): Promise<RunEvent[]> {
        const events: RunEvent[] = [];
        let after = 0;
        for (;;) {
            const page = await this.json<{ events: RunEvent[]; next: number | null }>(
                'GET',
                `/v1/runs/${encodeURIComponent(id)}/events?after=${after}&limit=500`
            );
            events.push(...page.events);
            if (!page.events.length || page.next === null || page.next <= after)
                return events;
            after = page.next;
        }
    }

    /** The patch a repository run made, or an empty string when it kept none. */
    async changes(id: string): Promise<string> {
        const response = await this.request(
            'GET',
            `/v1/runs/${encodeURIComponent(id)}/changes`
        );
        if (response.status === 404) return '';
        await this.ok(response);
        return response.text();
    }

    cancel(id: string, idempotencyKey: string): Promise<unknown> {
        return this.json('POST', `/v1/runs/${encodeURIComponent(id)}/commands`, {
            kind: 'cancel',
            payload: {},
            idempotency_key: idempotencyKey,
        });
    }

    private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
        const response = await this.request(method, path, body);
        await this.ok(response);
        return (await response.json()) as T;
    }

    private request(method: string, path: string, body?: unknown): Promise<Response> {
        return this.fetcher(new URL(path, this.origin), {
            method,
            headers: {
                authorization: `Bearer ${this.key}`,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }

    private async ok(response: Response): Promise<void> {
        if (response.ok) return;
        const text = await response.text().catch(() => '');
        throw new ApiError(
            response.status,
            `workbenches.dev ${response.status}: ${text.slice(0, 500)}`
        );
    }
}
