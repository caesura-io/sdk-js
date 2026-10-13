import { expect, it } from 'vitest';
import { copyProviderValue } from './copy.js';
import { auditSnapshot, snapshotObservation } from './contracts.js';
it('copies mutable native data without cloning opaque provider handles', () => {
  const image = new URL('https://example.test/image');
  const signal = new AbortController().signal;
  const file = new File(['payload'], 'file.txt');
  const input = {
    nested: [{ image }],
    signal,
    file,
    bytes: new Uint8Array([1, 2]),
    buffer: Buffer.from([3, 4]),
    date: new Date(0),
  };
  const output = copyProviderValue(input);
  expect(output.nested[0]!.image.href).toBe(image.href);
  output.nested[0]!.image.pathname = '/changed';
  output.bytes[0] = 9;
  output.buffer[0] = 9;
  output.date.setTime(5);
  expect(image.pathname).toBe('/image');
  expect(input.bytes[0]).toBe(1);
  expect(input.buffer[0]).toBe(3);
  expect(input.date.getTime()).toBe(0);
  expect(Buffer.isBuffer(output.buffer)).toBe(true);
  expect(output.signal).toBe(signal);
  expect(output.file).toBe(file);
});
it('snapshots URL metadata and audits URLs/binary content without losing values', () => {
  const url = new URL('https://example.test/file.pdf');
  const observation = snapshotObservation({ metadata: { url } });
  const audit = auditSnapshot({
    headers: { authorization: 'secret' },
    prompt: [
      {
        content: [
          { type: 'file', data: url },
          { type: 'image', image: new Uint8Array([1, 2]) },
        ],
      },
    ],
  }) as { prompt: { content: { data?: URL; image?: Uint8Array }[] }[] };
  expect(audit).not.toHaveProperty('headers');
  expect(audit.prompt[0]!.content[0]!.data?.href).toBe(url.href);
  expect(audit.prompt[0]!.content[1]!.image).toEqual(new Uint8Array([1, 2]));
  url.pathname = '/changed';
  expect(observation.metadata.url.pathname).toBe('/file.pdf');
  expect(audit.prompt[0]!.content[0]!.data?.pathname).toBe('/file.pdf');
});
