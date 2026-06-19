import type { CaesuraEvent } from './types.js';

export interface DebugLoggerOptions {
  /**
   * Only log events of these types. If omitted, logs all events.
   */
  types?: CaesuraEvent['type'][];

  /**
   * Custom logger function or object. Defaults to console.log.
   * If a function is provided, calls that function with formatted output.
   * If an object with a `log` or `info` function is provided, calls that.
   */
  logger?:
    | ((message: string, meta?: any) => void)
    | { log: (message: string, meta?: any) => void }
    | { info: (message: string, meta?: any) => void };

  /**
   * If set, message texts/rendered blocks longer than this will be truncated in logs.
   */
  truncateText?: number;
}

export function createDebugLogger(options: DebugLoggerOptions = {}): (event: CaesuraEvent) => void {
  const types = options.types ? new Set(options.types) : null;
  const truncateText = options.truncateText;

  const logFn = (() => {
    const logger = options.logger;
    if (typeof logger === 'function') {
      return logger;
    }
    if (logger && typeof logger === 'object') {
      if ('log' in logger && typeof logger.log === 'function') {
        return (msg: string, meta?: any) => logger.log(msg, meta);
      }
      if ('info' in logger && typeof logger.info === 'function') {
        return (msg: string, meta?: any) => logger.info(msg, meta);
      }
    }
    return (msg: string, meta?: any) => {
      if (meta !== undefined) {
        console.log(msg, meta);
      } else {
        console.log(msg);
      }
    };
  })();

  // Helper to truncate text values if they exceed the limit
  const truncate = (val: string): string => {
    if (truncateText === undefined || val.length <= truncateText) {
      return val;
    }
    return val.slice(0, truncateText) + '... [truncated]';
  };

  const processPayload = (obj: any): any => {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(processPayload);
    }
    const out: any = {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (key === 'text' && typeof val === 'string') {
        out[key] = truncate(val);
      } else if (typeof val === 'object' && val !== null) {
        out[key] = processPayload(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  };

  return (event: CaesuraEvent) => {
    if (types && !types.has(event.type)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefix = `[caesura:${event.type}] [${timestamp}]`;

    switch (event.type) {
      case 'request': {
        const body = processPayload(event.body);
        logFn(
          `${prefix} Conversation: ${event.conversationId}, Turn: ${event.queryTurn}`,
          { body, includeCreditUsage: event.includeCreditUsage }
        );
        break;
      }
      case 'response': {
        const analysis = processPayload(event.analysis);
        logFn(
          `${prefix} Conversation: ${event.conversationId}, Turn: ${event.queryTurn}, Duration: ${event.durationMs}ms`,
          { analysis, creditUsage: event.creditUsage }
        );
        break;
      }
      case 'skipped': {
        logFn(
          `${prefix} Conversation: ${event.conversationId}, Turn: ${event.turn}, Reason: ${event.reason}`
        );
        break;
      }
      case 'buffered': {
        logFn(
          `${prefix} Conversation: ${event.conversationId}, Turn: ${event.queryTurn}, RecID: ${event.recommendationId}`
        );
        break;
      }
      case 'deduped': {
        logFn(
          `${prefix} Conversation: ${event.conversationId}, Turn: ${event.queryTurn} (Duplicate or empty recommendation)`
        );
        break;
      }
      case 'injected': {
        const text = truncate(event.text);
        logFn(
          `${prefix} Conversation: ${event.conversationId}, Turn: ${event.turn}, Count: ${event.count}, Placement: ${event.placement}`,
          { text }
        );
        break;
      }
      case 'error': {
        logFn(
          `${prefix} Conversation: ${event.conversationId} Error occurred`,
          { error: event.error }
        );
        break;
      }
    }
  };
}
