import type { CaesuraAnalysis } from './types.js';

/** A message in the backend's existing AnalysisRequest shape. */
export interface AnalyzeMessage {
  speakerRole: 'assistant' | 'user';
  speakerName?: string;
  text: string;
}

/** Request body matching the (extended) /api/analyze route. */
export interface AnalyzeRequestBody {
  conversationId?: string;
  sessionId?: string;
  callType?: string;
  messages: AnalyzeMessage[];
  persist?: boolean;
  calculateSimilarities?: boolean;
  similarityThreshold?: number;
}

export interface AnalyzeResult {
  analysis: CaesuraAnalysis;
  creditUsage?: number;
}

export class CaesuraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  /** Calls the analyze endpoint. Returns the analysis and optional credit usage. */
  async analyze(
    body: AnalyzeRequestBody,
    opts?: { includeCreditUsage?: boolean },
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
          ...(opts?.includeCreditUsage ? { 'x-include-credit-usage': 'true' } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Caesura analyze ${res.status}: ${text}`);
      }
      const analysis = (await res.json()) as CaesuraAnalysis;
      const raw = res.headers.get('x-credit-usage');
      const creditUsage = raw != null ? Number(raw) : undefined;
      return {
        analysis,
        creditUsage: creditUsage != null && Number.isFinite(creditUsage) ? creditUsage : undefined,
      };
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    }
  }

  private trimmedBase(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }
}
