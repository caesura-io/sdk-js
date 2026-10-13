/* global Response, AbortController, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function bounded(work) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fallback fixture stalled')),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export const fallbackCases = [
  'old-backend',
  'customer-save',
  'analysis-failure',
  'reply-save',
  'creation-failure',
  'strict-save',
  'strict-reply',
  'strict-creation',
  'cancel',
  'deadline',
  'required-hook',
  'required-audit',
  'provider-failure',
  'counter-timeout',
  'append-timeout',
  'creation-timeout',
  'analysis-timeout',
  'strict-counter-timeout',
  'strict-append-timeout',
  'strict-creation-timeout',
  'creation-cancel',
  'creation-deadline',
  'required-hook-timeout',
  'reply-timeout',
  'strict-reply-timeout',
  'late-completion',
  'graceful-shutdown',
];
export async function checkFailurePolicy({
  api,
  mode,
  stream,
  scenario,
  createClient,
}) {
  if (
    ['late-completion', 'graceful-shutdown'].includes(scenario) &&
    mode !== 'async'
  )
    return;
  const lifecycle = ['late-completion', 'graceful-shutdown'].includes(scenario);
  const oldFetch = globalThis.fetch;
  const requests = [],
    analyses = [],
    errors = [],
    events = [],
    completions = [],
    audits = [],
    transcripts = [];
  const analysisGate = gate(),
    analysisEntered = gate(),
    saveGate = gate(),
    saveEntered = gate(),
    completed = gate();
  const controller = new AbortController();
  let creationCalls = 0,
    backendWorks = false,
    delayedStorage = false;
  const strict = scenario.startsWith('strict');
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.endsWith('/conversation')) {
      creationCalls++;
      if (
        [
          'creation-timeout',
          'strict-creation-timeout',
          'creation-cancel',
          'creation-deadline',
        ].includes(scenario)
      ) {
        saveEntered.resolve();
        await saveGate.promise;
        return Response.json({ id: 'late-id' });
      }
      return scenario.includes('creation')
        ? Response.json({ message: 'offline' }, { status: 503 })
        : Response.json({ id: 'real-id' });
    }
    if (url.includes('/messages')) {
      saveEntered.resolve();
      if (scenario === 'cancel' || scenario === 'deadline')
        await saveGate.promise;
      if (
        !backendWorks &&
        !delayedStorage &&
        ((scenario.endsWith('counter-timeout') && url.includes('?')) ||
          (scenario.endsWith('append-timeout') && !url.includes('?')))
      ) {
        delayedStorage = true;
        await saveGate.promise;
      }
      if (!backendWorks && scenario === 'old-backend')
        return Response.json({ message: 'not found' }, { status: 404 });
      if (url.includes('?'))
        return Response.json({
          success: true,
          conversationId: 'real-id',
          nextMessageId: 1,
        });
      const body = JSON.parse(init.body);
      const agent = body.messages[0].role === 'assistant';
      if (!backendWorks && scenario.endsWith('reply-timeout') && agent) {
        analysisGate.resolve();
        await saveGate.promise;
      }
      if (
        !backendWorks &&
        (([
          'customer-save',
          'analysis-failure',
          'analysis-timeout',
          'strict-save',
        ].includes(scenario) &&
          !agent) ||
          (['reply-save', 'strict-reply'].includes(scenario) && agent))
      )
        return Response.json({ message: 'cannot save' }, { status: 503 });
      return Response.json({ success: true, ...body });
    }
    assert(url.endsWith('/analyze'));
    const body = JSON.parse(init.body);
    analyses.push(body);
    analysisEntered.resolve();
    if (mode === 'async' || scenario === 'analysis-timeout')
      await analysisGate.promise;
    return scenario === 'analysis-failure'
      ? Response.json({ message: 'analysis unavailable' }, { status: 503 })
      : Response.json('Advice', { headers: { 'x-credit-usage': '3' } });
  };
  const config = {
    mode,
    timeoutMs: scenario.endsWith('timeout') ? 25 : 8000,
    failurePolicy:
      strict || scenario === 'required-audit' ? 'throw' : 'continue',
    apiKey: 'mock',
    callType: 'chosen-preset',
    speakerNames: { customer: 'Visitor', agent: 'Support' },
    onError: (e) => errors.push(e),
    onEvent: (e) => events.push(e),
    onCompletion: (e) => {
      completions.push(e);
      if (e.status === 'completed') completed.resolve();
    },
    onProviderEvent: (e) => audits.push(e),
    inject: { skillPrompt: '', template: '{analysis}' },
    ...(lifecycle
      ? {
          persistMessages: async (batch) => {
            transcripts.push(batch);
          },
        }
      : {}),
    ...(['required-hook', 'required-hook-timeout'].includes(scenario)
      ? {
          persistMessages: async () => {
            if (scenario === 'required-hook-timeout') await saveGate.promise;
            else throw new Error('required app persistence failed');
          },
        }
      : {}),
    ...(scenario === 'required-audit'
      ? {
          persistProviderRequest: async () => {
            throw new Error('audit failed');
          },
        }
      : {}),
  };
  const client = createClient(
    config,
    requests,
    scenario === 'provider-failure',
  );
  let id;
  try {
    try {
      const creation = client.engine.createConversation(
        {},
        {
          signal: controller.signal,
          deadline: Date.now() + (scenario === 'creation-deadline' ? 25 : 2000),
        },
      );
      const settled = creation.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      if (scenario === 'creation-cancel') {
        await bounded(saveEntered.promise);
        controller.abort();
      }
      const result = await bounded(settled);
      if (
        [
          'creation-cancel',
          'creation-deadline',
          'strict-creation-timeout',
        ].includes(scenario)
      ) {
        assert.equal(
          result.error?.kind,
          scenario === 'creation-cancel' ? 'cancelled' : 'timeout',
        );
        assert.equal(requests.length, 0);
        assert.equal(errors.length, 1);
        assert.equal(
          events.filter((e) => e.type === 'conversation-created').length,
          0,
        );
        return;
      }
      if (result.error) throw result.error;
      id = result.value;
      if (scenario.includes('creation')) {
        assert.equal(id, undefined);
        assert.equal(errors.length, 1);
        assert.equal(
          events.filter((e) => e.type === 'conversation-created').length,
          0,
        );
      }
      if (lifecycle) id = undefined;
    } catch (error) {
      assert.equal(error.kind, 'transport');
      assert.equal(
        events.filter((e) => e.type === 'conversation-created').length,
        0,
      );
      assert.equal(errors.length, 1);
      if (strict) return;
    }
    const options = {
      ...(id ? { conversationId: id } : { stateless: true }),
      signal: controller.signal,
      turn: { id: 'first', origin: 'customer' },
      deadline: Date.now() + (scenario === 'deadline' ? 25 : 2000),
    };
    const finish = async (value) => {
      if (!stream) return value;
      if (api === 'ai') {
        const reader = value.stream.getReader();
        while (!(await reader.read()).done) {
          /* lazy consumption */
        }
      } else for await (const part of value) void part;
      return value;
    };
    const pending = Promise.resolve(client.call('hello', options, stream))
      .then((value) =>
        scenario === 'graceful-shutdown' && stream ? value : finish(value),
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    if (scenario === 'cancel') {
      await bounded(saveEntered.promise);
      controller.abort('stop');
    }
    // Background analysis remains blocked while generation completes.
    const outcome = await bounded(pending);
    if (
      [
        'strict-save',
        'required-audit',
        'cancel',
        'deadline',
        'strict-counter-timeout',
        'strict-append-timeout',
        'required-hook-timeout',
      ].includes(scenario)
    ) {
      assert.equal(
        outcome.error?.kind,
        scenario === 'cancel'
          ? 'cancelled'
          : scenario === 'deadline' || scenario.endsWith('timeout')
            ? 'timeout'
            : 'store',
      );
      assert.equal(requests.length, 0);
      return;
    }
    if (scenario === 'strict-reply' || scenario === 'strict-reply-timeout') {
      assert.equal(
        outcome.error?.kind,
        scenario.endsWith('timeout') ? 'timeout' : 'store',
      );
      assert.equal(requests.length, 1);
      return;
    }
    if (scenario === 'provider-failure') {
      assert.equal(outcome.error?.message, 'native provider failure');
      return;
    }
    assert.equal(outcome.error, undefined);
    assert.equal(requests.length, 1);
    assert.equal(
      JSON.stringify(requests[0]).includes('Advice'),
      mode === 'sync' &&
        !['analysis-failure', 'analysis-timeout', 'required-hook'].includes(
          scenario,
        ),
    );
    if (lifecycle) {
      await bounded(analysisEntered.promise);
      const shuttingDown = client.engine.shutdown({
        cancel: scenario === 'late-completion',
      });
      if (scenario === 'late-completion') {
        assert.deepEqual(
          (await bounded(shuttingDown)).map((c) => c.status),
          ['cancelled'],
        );
        analysisGate.resolve();
        await bounded(completed.promise);
        const late = await client.engine.flush();
        assert.equal(late.length, 1);
        assert.equal(late[0].status, 'completed');
        assert.equal(late[0].result.creditUsage, 3);
      } else {
        analysisGate.resolve();
        assert.deepEqual(
          (await bounded(shuttingDown)).map((c) => c.status),
          ['completed'],
        );
      }
      if (scenario === 'graceful-shutdown' && stream)
        await finish(outcome.value);
      assert.deepEqual(
        transcripts.flatMap((b) => b.messages.map((m) => m.role)),
        ['customer', 'agent'],
      );
      assert(
        transcripts.every((b) => b.correlation.conversationId === undefined),
      );
      assert.deepEqual(await client.engine.flush(), []);
      assert.equal(analyses[0].persist, false);
      return;
    }
    if (scenario !== 'analysis-timeout') analysisGate.resolve();
    saveGate.resolve();
    await bounded(client.engine.flush());
    if (scenario === 'analysis-timeout') {
      assert.equal(completions[0].error.kind, 'timeout');
      analysisGate.resolve();
    }
    if (scenario === 'required-hook') {
      assert.equal(analyses.length, 0);
      return;
    }
    assert.equal(analyses.length, 1);
    const fallback = [
      'old-backend',
      'customer-save',
      'analysis-failure',
      'creation-failure',
      'creation-timeout',
      'counter-timeout',
      'append-timeout',
      'analysis-timeout',
    ].includes(scenario);
    assert.equal(analyses[0].persist, !fallback);
    assert.equal(analyses[0].callType, 'chosen-preset');
    assert.equal(analyses[0].currentUser, 'Support');
    assert.equal(analyses[0].messages.at(-1).speakerName, 'Visitor');
    if (fallback)
      for (const key of ['conversationId', 'sessionId', 'transcriptMessageId'])
        assert.equal(key in analyses[0], false);
    assert.equal(
      completions[0].correlation.persistence,
      fallback ? 'disabled' : 'requested',
    );
    const audit = audits.find((e) => e.type === 'request');
    assert.equal(
      audit.correlation.persistence,
      fallback ? 'disabled' : 'requested',
    );
    assert.equal(audit.correlation.conversationId, id);
    assert.equal(
      errors.length,
      events.filter((e) => e.type === 'error').length,
    );
    assert(errors.length >= 1);
    assert.equal(creationCalls, 1);
    if (id && !['analysis-failure', 'analysis-timeout'].includes(scenario)) {
      backendWorks = true;
      await finish(
        await client.call(
          'next',
          { conversationId: id, turn: { id: 'next', origin: 'customer' } },
          stream,
        ),
      );
      await bounded(client.engine.flush());
      assert.equal(analyses.at(-1).persist, true);
      assert.equal(analyses.at(-1).conversationId, id);
      if (mode === 'async')
        assert(JSON.stringify(requests[1]).includes('Advice'));
      assert.equal(creationCalls, 1);
    }
  } finally {
    saveGate.resolve();
    analysisGate.resolve();
    await client.engine.shutdown();
    globalThis.fetch = oldFetch;
  }
}
