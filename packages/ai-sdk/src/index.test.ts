import { describe, it, expect } from 'vitest';
import * as caesura from './index.js';

describe('package surface', () => {
  it('exports the middleware factory', () => {
    expect(typeof caesura.caesuraMiddleware).toBe('function');
  });
});
