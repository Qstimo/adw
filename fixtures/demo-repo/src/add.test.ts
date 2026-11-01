import { expect, it } from 'vitest';
import { add } from './add.js';
it('adds two numbers (FAIL_UNIT=1 forces a known red result)', () => {
 expect(add(2, 3)).toBe(process.env.FAIL_UNIT === '1' ? 6 : 5);
});
