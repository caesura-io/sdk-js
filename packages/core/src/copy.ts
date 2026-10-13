/**
 * Copy request containers and mutable data leaves without serializing native values.
 * Opaque handles (signals, streams, functions, immutable Blob/File values and custom
 * provider objects) retain identity; SDK transformations never mutate those handles.
 */
export function copyProviderValue<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) return seen.get(item);
    if (item instanceof URL) return new URL(item.href);
    if (item instanceof URLSearchParams) return new URLSearchParams(item);
    if (item instanceof Date) return new Date(item.getTime());
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(item))
      return Buffer.from(item);
    if (item instanceof ArrayBuffer) return item.slice(0);
    // Structured clone supports binary views, unlike URL and many native handles.
    if (ArrayBuffer.isView(item)) return structuredClone(item);
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      seen.set(item, result);
      for (const entry of item) result.push(copy(entry));
      return result;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype === Object.prototype || prototype === null) {
      const result = Object.create(prototype) as Record<string, unknown>;
      seen.set(item, result);
      for (const [key, entry] of Object.entries(item))
        Object.defineProperty(result, key, {
          value: copy(entry),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      return result;
    }
    return item;
  };
  return copy(value) as T;
}
