// A post is one editorial comparison: one task, several arms, a few attempts
// each, run in the cloud. It lives in posts/<id>/post.json; the task, its
// prompt, and its gates stay in tasks/ like every other task.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identifier } from '../core/spec.ts';

/** What the behavior columns look for in an arm's shell calls. */
export interface BehaviorSpec {
    /** Programs that are the arm's own quality gate, such as `tgcheck`. */
    gatePrograms?: string[];
    /** The command-line tools the arm's Workbench ships, to find the ones never called. */
    tools?: string[];
}

export interface PostArm {
    id: string;
    /** The column heading, usually the model: `Opus 5.5`. */
    label: string;
    /** The second line: `Vanilla`, `+ pompeii/threejs-game`. */
    setup: string;
    /** `organization/name` for its latest version, or one exact version. */
    workbench: string | { version_id: string };
    behavior?: BehaviorSpec;
}

export interface PostSpec {
    version: 1;
    id: string;
    title: string;
    task: string;
    attempts: number;
    /** The public repository and commit every attempt starts from. */
    fixture: { repository: string; commit: string };
    arms: PostArm[];
    /** Programs that count as the agent checking its own result before finishing. */
    verificationPrograms?: string[];
}

export const DEFAULT_VERIFICATION_PROGRAMS = [
    'npm run build',
    'npm test',
    'npm run test',
    'npm run dev',
    'npm run preview',
    'bun test',
    'bun run build',
    'bun run dev',
    'pnpm build',
    'pnpm test',
    'yarn build',
    'yarn test',
    'vite',
    'serve',
    'http-server',
    'playwright',
    'curl',
    'wget',
];

export function loadPost(postsDir: string, id: string): PostSpec {
    identifier(id, 'post');
    const file = join(postsDir, id, 'post.json');
    if (!existsSync(file)) throw new Error(`no post.json in ${join(postsDir, id)}`);
    const post = validatePost(JSON.parse(readFileSync(file, 'utf8')));
    if (post.id !== id) throw new Error(`${file} declares id ${post.id}`);
    return post;
}

export function validatePost(value: unknown): PostSpec {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('post.json must be an object');
    const p = value as PostSpec;
    only(
        p,
        [
            'version',
            'id',
            'title',
            'task',
            'attempts',
            'fixture',
            'arms',
            'verificationPrograms',
        ],
        'post'
    );
    if (p.version !== 1) throw new Error('post.json version must be 1');
    identifier(p.id, 'post.id');
    identifier(p.task, 'post.task');
    text(p.title, 'post.title');
    if (!Number.isInteger(p.attempts) || p.attempts < 1 || p.attempts > 10)
        throw new Error('post.attempts must be a whole number from 1 to 10');
    if (!p.fixture || typeof p.fixture !== 'object')
        throw new Error('post.fixture must name a repository and commit');
    only(p.fixture, ['repository', 'commit'], 'post.fixture');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.fixture.repository))
        throw new Error('post.fixture.repository must be owner/name');
    if (!/^[a-f0-9]{40}$/.test(p.fixture.commit))
        throw new Error('post.fixture.commit must be a full commit SHA');
    if (!Array.isArray(p.arms) || p.arms.length < 2 || p.arms.length > 6)
        throw new Error('post.arms must hold 2 to 6 arms');
    const ids = new Set<string>();
    for (const arm of p.arms) {
        if (!arm || typeof arm !== 'object') throw new Error('Invalid arm');
        only(arm, ['id', 'label', 'setup', 'workbench', 'behavior'], 'arm');
        identifier(arm.id, 'arm.id');
        if (ids.has(arm.id)) throw new Error(`Duplicate arm id: ${arm.id}`);
        ids.add(arm.id);
        text(arm.label, 'arm.label');
        text(arm.setup, 'arm.setup');
        const w = arm.workbench;
        const named =
            typeof w === 'string' &&
            /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(w);
        const pinned =
            typeof w === 'object' &&
            w !== null &&
            Object.keys(w).length === 1 &&
            /^[0-9a-f-]{36}$/.test(w.version_id);
        if (!named && !pinned)
            throw new Error(
                `arm ${arm.id}: workbench must be organization/name or { version_id }`
            );
        if (arm.behavior !== undefined) {
            only(arm.behavior, ['gatePrograms', 'tools'], 'arm.behavior');
            programs(arm.behavior.gatePrograms, 'arm.behavior.gatePrograms');
            programs(arm.behavior.tools, 'arm.behavior.tools');
        }
    }
    programs(p.verificationPrograms, 'post.verificationPrograms');
    return p;
}

function only(value: object, keys: string[], label: string) {
    for (const key of Object.keys(value))
        if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

function text(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200)
        throw new Error(`${label}: expected short nonempty text`);
}

function programs(value: unknown, label: string) {
    if (value === undefined) return;
    if (
        !Array.isArray(value) ||
        value.some((v) => typeof v !== 'string' || !/^[A-Za-z0-9._+ -]{1,64}$/.test(v))
    )
        throw new Error(`${label} must list program names`);
}
