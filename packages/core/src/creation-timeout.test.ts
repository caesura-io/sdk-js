import { expect, it, vi } from 'vitest';
import { createCaesuraEngine } from './engine.js';

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Creation stalled')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const failurePolicy of ['continue', 'throw'] as const) {
  it(`accepts a fractional creation timeout under ${failurePolicy}`, async () => {
    const createConversation = vi.fn(async () => 'conversation');
    const engine = createCaesuraEngine({
      timeoutMs: 10.5,
      failurePolicy,
      transport: { analyze: vi.fn(), createConversation },
    });
    try {
      expect(await engine.createConversation()).toBe('conversation');
      expect(createConversation).toHaveBeenCalledTimes(1);
    } finally {
      await engine.shutdown();
    }
  });

  it.each(['dependency', 'caller'] as const)(
    `preserves %s timeout policy with fractional milliseconds under ${failurePolicy}`,
    async (source) => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onError = vi.fn();
      const engine = createCaesuraEngine({
        timeoutMs: source === 'dependency' ? 10.5 : 1000.5,
        failurePolicy,
        onError,
        transport: {
          analyze: vi.fn(),
          createConversation: async () => {
            await blocked;
            return 'late-conversation';
          },
        },
      });
      try {
        const work = bounded(
          engine.createConversation(
            {},
            source === 'caller' ? { deadline: Date.now() + 10.5 } : {},
          ),
        );
        if (source === 'dependency' && failurePolicy === 'continue')
          await expect(work).resolves.toBeUndefined();
        else await expect(work).rejects.toMatchObject({ kind: 'timeout' });
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'timeout' }),
        );
      } finally {
        release();
        await engine.shutdown();
      }
    },
  );
}
