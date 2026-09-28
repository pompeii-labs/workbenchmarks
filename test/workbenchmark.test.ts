import { expect, test } from 'bun:test';
import { parseArms, parseModels, positiveInteger } from '../workbenchmark.ts';

test('rejects invalid CLI selections rather than running zero attempts', () => {
    for (const n of ['0', '-1', 'NaN', '1.5', 'Infinity'])
        expect(() => positiveInteger(n, 'reps')).toThrow();
    expect(parseArms('plain,workbench')).toEqual(['plain', 'workbench']);
    expect(() => parseArms('plain,plain')).toThrow();
    expect(() => parseArms('other')).toThrow();
});
test('--models accepts distinct models and rejects models that collide on slug', () => {
    expect(parseModels('vendor/a,vendor/b')).toEqual(['vendor/a', 'vendor/b']);
    expect(() => parseModels('vendor/model,other/model')).toThrow();
});
