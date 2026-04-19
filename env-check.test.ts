import { describe, test, expect } from 'bun:test';

test('check HOME env', () => {
  console.log('HOME in test:', process.env.HOME);
  console.log('cwd:', process.cwd());
  expect(process.env.HOME).toBeDefined();
});
