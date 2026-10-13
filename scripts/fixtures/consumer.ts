import { createCaesuraEngine, type CaesuraAnalysis } from '@caesura-io/core';
import { caesuraMiddleware } from '@caesura-io/ai-sdk';
import { wrapLanguageModel } from 'ai';
const values: CaesuraAnalysis[] = [
  null,
  false,
  0,
  'text',
  [],
  { 'next-step': 'ask' },
];
void values;
const engine = createCaesuraEngine({
  apiKey: 'test',
  send: { maxInputChars: 1 },
});
void engine.createConversation({ name: 'Example' });
// The installed AI SDK supplies its actual public middleware parameter type.
const middleware: Parameters<typeof wrapLanguageModel>[0]['middleware'] =
  caesuraMiddleware({ apiKey: 'test' });
void middleware;

// Public application transport and asynchronous detached store declarations.
import type {
  AnalysisTransport,
  CaesuraStore,
  ConversationState,
} from '@caesura-io/core';
const localTransport: AnalysisTransport = {
  async analyze(input, context) {
    context.signal.throwIfAborted();
    return {
      analysis: { evidence: input.messages.at(-1)?.text },
      usage: { tokens: 3 },
      requestId: context.analysisId,
    };
  },
};
const states = new Map<string, ConversationState>();
const asyncStore: CaesuraStore = {
  async get(id) {
    return structuredClone(
      states.get(id) ?? {
        recommendations: [],
        turn: 0,
        lastQueryTurn: 0,
        lastQueryMs: 0,
        inFlight: false,
        lastAccessMs: Date.now(),
      },
    );
  },
  async set(id, state) {
    states.set(id, structuredClone(state));
  },
  async clear(id) {
    states.delete(id);
  },
  async clearAll() {
    states.clear();
  },
};
void localTransport;
void asyncStore;

// Creation context has no fabricated conversation ID; transcript hooks are awaitable.
import type {
  CreationContext,
  TranscriptBatch,
  SdkIdentity,
} from '@caesura-io/core';
const localCreation = async (
  _: unknown,
  context: CreationContext,
): Promise<string> => {
  const sdk: SdkIdentity = context.sdk;
  return sdk.core.name;
};
const transcriptWrite = async (batch: TranscriptBatch): Promise<void> => {
  for (const message of batch.messages) {
    void message.id;
    void message.role;
  }
};
void localCreation;
void transcriptWrite;

// Live audit controls are separate from the persisted snapshot; one-arg hooks still work.
import type { ProviderAuditContext, OperationContext } from '@caesura-io/core';
const auditEngine = createCaesuraEngine({
  transport: localTransport,
  persistProviderRequest: async (event, context: ProviderAuditContext) => {
    const signal: AbortSignal = context.signal;
    const deadline: number | undefined = context.deadline;
    void event.parameters;
    void signal;
    void deadline;
  },
});
const operation: OperationContext = { signal: new AbortController().signal };
void auditEngine.prepareProvider(
  {
    type: 'request',
    api: 'chat',
    correlation: { conversationId: 'existing' },
    analysisIds: [],
    parameters: {},
  },
  operation,
);

// Explicit ID-free fallback keeps successful creation typed as a backend ID.
import type { CaesuraCallOptions, Correlation } from '@caesura-io/core';
const creation: Promise<string | undefined> = engine.createConversation();
const fallbackOptions: CaesuraCallOptions = { stateless: true };
const statelessScope = engine.createStatelessScope();
const outcome: Promise<'requested' | 'disabled' | undefined> =
  statelessScope.observeWithPersistence(undefined, [
    { speakerRole: 'user', text: 'hello' },
  ]);
const fallbackCorrelation: Correlation = { persistence: 'disabled' };
void creation;
void fallbackOptions;
void outcome;
void fallbackCorrelation;

const observation: Promise<void> = engine.observe('existing', []);
void observation;
