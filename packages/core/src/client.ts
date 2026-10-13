import { sdkHeaders, sdkIdentity } from './provenance.js';
import type {
  AnalysisContext,
  AnalysisTransport,
  CreationContext,
  SdkIdentity,
} from './contracts.js';
import type { CaesuraAnalysis } from './types.js';

/** A message in the backend's existing AnalysisRequest shape. */
export interface AnalyzeMessage {
  /** Analysis-prompt role: user for either participant, assistant for prior analyses. */
  speakerRole: 'assistant' | 'user';
  speakerName?: string;
  /** Stable participant identity: customer 1, agent 0; prior analysis -1. */
  speakerIndex?: number;
  text: string;
}

/** Request body matching the (extended) /api/analyze route. */
export interface AnalyzeRequestBody {
  conversationId?: string;
  sessionId?: string;
  callType?: string;
  /** Guidance recipient, set by the engine to the configured agent speaker name. */
  currentUser?: string;
  messages: AnalyzeMessage[];
  /** Saves only the last submitted utterance and its analysis, not a transcript archive. */
  persist?: boolean;
  calculateSimilarities?: boolean;
  similarityThreshold?: number;
}

export interface CreateConversationOptions {
  name?: string;
  calendarId?: string;
  eventId?: string;
}

export interface AnalyzeResult {
  isSame?: boolean;
  analysis: CaesuraAnalysis;
  creditUsage?: number;
  /** Transport-specific usage and response metadata, preserved without reshaping. */
  usage?: unknown;
  requestId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export class CaesuraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {
    if (!apiKey)
      throw new Error('CaesuraO: HTTP transport requires an API key.');
  }

  /** Calls the analyze endpoint. Returns the analysis and optional credit usage. */
  async analyze(
    body: AnalyzeRequestBody,
    opts?: { includeCreditUsage?: boolean; sdk?: SdkIdentity },
    externalSignal?: AbortSignal,
  ): Promise<AnalyzeResult> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.trimmedBase()}/api/analyze`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...sdkHeaders(opts?.sdk ?? sdkIdentity('http')),
          ...(opts?.includeCreditUsage
            ? { 'x-include-credit-usage': 'true' }
            : {}),
        },
        body: JSON.stringify(body),
        signal: externalSignal
          ? AbortSignal.any([ctrl.signal, externalSignal])
          : ctrl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`CaesuraO analyze ${res.status}: ${text}`);
      }
      const mediaType =
        res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ??
        '';
      let analysis: CaesuraAnalysis;
      if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
        analysis = (await res.json()) as CaesuraAnalysis;
      } else if (mediaType.startsWith('text/')) {
        analysis = await res.text();
      } else {
        const text = await res.text();
        try {
          analysis = JSON.parse(text) as CaesuraAnalysis;
        } catch {
          analysis = text;
        }
      }
      const flag =
        analysis && typeof analysis === 'object' && !Array.isArray(analysis)
          ? (analysis.isSame ?? analysis.is_same)
          : undefined;
      const raw = res.headers.get('x-credit-usage');
      const creditUsage = raw != null ? Number(raw) : undefined;
      return {
        analysis,
        requestId: res.headers.get('x-request-id') ?? undefined,
        metadata: { status: res.status },
        isSame: typeof flag === 'boolean' ? flag : undefined,
        creditUsage:
          creditUsage != null && Number.isFinite(creditUsage)
            ? creditUsage
            : undefined,
      };
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    }
  }

  /** Create once and reuse the backend ID. Explicit failures propagate. */
  async createConversation(
    options: CreateConversationOptions = {},
    externalSignal?: AbortSignal,
    sdk: SdkIdentity = sdkIdentity('http'),
  ): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.trimmedBase()}/api/conversation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...sdkHeaders(sdk),
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          name: options.name,
          calendarId: options.calendarId,
          eventId: options.eventId,
        }),
        signal: externalSignal
          ? AbortSignal.any([ctrl.signal, externalSignal])
          : ctrl.signal,
      });
      if (!res.ok)
        throw new Error(
          `CaesuraO create conversation ${res.status}: ${await res.text()}`,
        );
      const body: unknown = await res.json();
      if (
        body &&
        typeof body === 'object' &&
        'id' in body &&
        typeof body.id === 'string' &&
        body.id.trim() &&
        (!('success' in body) || body.success !== false)
      )
        return body.id;
      throw new Error(
        'CaesuraO create conversation: response must contain a nonempty string id.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private trimmedBase(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }
}

/** Default application-independent HTTP implementation. */
export class HttpAnalysisTransport implements AnalysisTransport {
  constructor(public readonly client: CaesuraClient) {}
  analyze(
    body: AnalyzeRequestBody,
    context: AnalysisContext,
  ): Promise<AnalyzeResult> {
    return this.client.analyze(
      body,
      { includeCreditUsage: context.includeCreditUsage, sdk: context.sdk },
      context.signal,
    );
  }
  createConversation(
    options: CreateConversationOptions,
    context: CreationContext,
  ): Promise<string> {
    return this.client.createConversation(options, context.signal, context.sdk);
  }
}
