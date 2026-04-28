import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, unwrap } from './result.js';

describe('Result', () => {
  it('ok() creates a successful result', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it('err() creates a failed result', () => {
    const result = err(new Error('oops'));
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('oops');
  });

  it('isOk() narrows to Ok', () => {
    expect(isOk(ok('hello'))).toBe(true);
    expect(isOk(err('nope'))).toBe(false);
  });

  it('isErr() narrows to Err', () => {
    expect(isErr(err('fail'))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
  });

  it('unwrap() returns value on success', () => {
    expect(unwrap(ok('value'))).toBe('value');
  });

  it('unwrap() throws on failure', () => {
    expect(() => unwrap(err(new Error('boom')))).toThrow('boom');
  });
});
