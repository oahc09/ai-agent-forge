import { createHash } from 'node:crypto';

export class ResearchBoundaryError extends Error {}
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ResearchBoundaryError(message);
}
export function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected plain record');
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Expected plain record');
  ensure(Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined), 'Unknown or accessor field');
  ensure(keys.every(key => Object.hasOwn(value, key)), 'Missing required field');
}
export function text(value: unknown, max = 256): asserts value is string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'Invalid text');
}
export function id(value: unknown): asserts value is string {
  text(value, 128); ensure(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value), 'Invalid identifier');
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'Invalid bounded integer');
}
export function sha(value: unknown, length: 40 | 64): asserts value is string {
  ensure(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value), 'Invalid pinned digest');
}
export function array(value: unknown, min = 0, max = 1000): asserts value is unknown[] {
  ensure(Array.isArray(value) && value.length >= min && value.length <= max && Object.getPrototypeOf(value) === Array.prototype, 'Invalid bounded array');
  ensure(Reflect.ownKeys(value).length === value.length + 1 && Array.from({length: value.length}, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).every(item => item && 'value' in item), 'Sparse or accessor array');
}
export function unique(values: readonly string[]): void { ensure(new Set(values).size === values.length, 'Duplicate values'); }
export function repo(value: unknown): asserts value is string {
  text(value); ensure(/^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && !value.endsWith('.git'), 'Noncanonical repository URL');
}
/** Lexical metadata check only. This does not provide filesystem or symlink isolation. */
export function path(value: unknown): asserts value is string {
  text(value, 512);
  ensure(value.split('/').every(segment => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(segment)), 'Noncanonical relative path');
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
export function snapshot<T>(value: T): T { return freeze(structuredClone(value)); }
export function digest(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item !== null && typeof item === 'object') return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(item);
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
