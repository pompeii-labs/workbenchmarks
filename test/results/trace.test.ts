import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    diagnosticTools,
    discoverWorkbenchExport,
    exportNativeTrace,
    selectNativeExport,
} from '../../src/results/trace.ts';

test('large native exports survive a CLI that exits before stdout pipes drain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-trace-export-test-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const oldPath = process.env.PATH;
    try {
        writeFileSync(
            join(bin, 'opencode'),
            '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({messages:[{parts:[{type:"tool",tool:"bash",state:{status:"completed",output:"x".repeat(2_000_000)}}]}]}));process.exit(0);\n',
            { mode: 0o700 }
        );
        process.env.PATH = `${bin}:${oldPath}`;
        const result = JSON.parse(
            await exportNativeTrace(dir, 'plain', 'ses_synthetic')
        );
        expect(result.tools[0].output.length).toBe(2_000_000);
        expect(result.tools[0].name).toBe('bash');
    } finally {
        process.env.PATH = oldPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

const temp: string[] = [];
function directory() {
    const dir = mkdtempSync(join(tmpdir(), 'workbenchmark-test-'));
    temp.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function nativeSession(home: string, name: string, id = 'ses_native_123') {
    const session = join(home, '.workbench', 'sessions', name);
    mkdirSync(join(session, 'native'), { recursive: true });
    writeFileSync(
        join(session, 'session.json'),
        JSON.stringify({ native_session_id: id })
    );
    writeFileSync(join(session, 'native', 'opencode.sqlite'), 'fixture');
}

test('selects exactly one complete workbench native session', () => {
    const home = directory();
    nativeSession(home, 'owned');
    expect(discoverWorkbenchExport(home)).toEqual({
        sessionId: 'ses_native_123',
        database: join(
            home,
            '.workbench',
            'sessions',
            'owned',
            'native',
            'opencode.sqlite'
        ),
    });
});

test('rejects missing, malformed, and ambiguous workbench session state', () => {
    const missing = directory();
    expect(() => discoverWorkbenchExport(missing)).toThrow(
        'Missing Workbench sessions'
    );

    const malformed = directory();
    const metadata = join(malformed, '.workbench', 'sessions', 'owned');
    mkdirSync(metadata, { recursive: true });
    writeFileSync(join(metadata, 'session.json'), '{');
    expect(() => discoverWorkbenchExport(malformed)).toThrow(
        'Malformed session metadata'
    );

    const ambiguous = directory();
    nativeSession(ambiguous, 'one', 'ses_one');
    nativeSession(ambiguous, 'two', 'ses_two');
    expect(() => discoverWorkbenchExport(ambiguous)).toThrow('exactly one');
});

test('plain trace selection requires a safe saved session id', () => {
    const home = directory();
    expect(selectNativeExport(home, 'plain', 'ses_plain-1')).toEqual({
        sessionId: 'ses_plain-1',
    });
    expect(() => selectNativeExport(home, 'plain')).toThrow('requires');
    expect(() => selectNativeExport(home, 'plain', 'bad id')).toThrow('Invalid');
    expect(() => selectNativeExport(home, 'plain', '--help')).toThrow('Invalid');
    expect(() => selectNativeExport(home, 'workbench', 'ses_plain')).toThrow(
        'must not'
    );
});

test('keeps only tool diagnostics and removes runner context and credentials', () => {
    const trace = diagnosticTools({
        info: { provider: { apiKey: 'sk-top-level' }, prompt: 'do not retain' },
        messages: [
            {
                info: { reasoning: 'do not retain', text: 'do not retain' },
                parts: [
                    { type: 'text', text: 'assistant text must not be retained' },
                    {
                        type: 'tool',
                        callID: 'call_1',
                        tool: 'bash',
                        state: {
                            status: 'error',
                            input: {
                                command:
                                    'API_KEY=abc123 curl -H "Authorization: Bearer token-value"',
                                prompt: 'hidden prompt',
                                reasoning: 'hidden chain',
                                attachments: [{ name: 'hidden' }],
                            },
                            output: {
                                api_key: 'lowercase-key',
                                token: 'object-token',
                                OPENROUTER_API_KEY: 'provider-key',
                                SERVICE_ANON_KEY: 'anon-key',
                                ACCESS_TOKEN: 'access-token',
                                text: 'sk-output-secret Bearer another-token Basic dXNlcjpwYXNz https://user:password@example.test/path',
                            },
                            error: 'OPENROUTER_API_KEY=value',
                        },
                    },
                ],
            },
        ],
    });
    expect(trace).toEqual({
        version: 1,
        kind: 'tool-diagnostics',
        tools: [
            {
                id: 'call_1',
                name: 'bash',
                status: 'error',
                input: {
                    command:
                        'API_KEY=[REDACTED] curl -H "Authorization: Bearer [REDACTED]"',
                },
                output: {
                    api_key: '[REDACTED]',
                    token: '[REDACTED]',
                    OPENROUTER_API_KEY: '[REDACTED]',
                    SERVICE_ANON_KEY: '[REDACTED]',
                    ACCESS_TOKEN: '[REDACTED]',
                    text: '[REDACTED] Bearer [REDACTED] Basic [REDACTED] https://user:[REDACTED]@example.test/path',
                },
                error: 'OPENROUTER_API_KEY=[REDACTED]',
            },
        ],
    });
    expect(JSON.stringify(trace)).not.toContain('assistant text');
    expect(JSON.stringify(trace)).not.toContain('hidden prompt');
    expect(JSON.stringify(trace)).not.toContain('hidden chain');
});

test('rejects malformed native exports', () => {
    expect(() => diagnosticTools({ messages: {} })).toThrow('no messages');
});
