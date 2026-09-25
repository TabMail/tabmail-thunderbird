import { describe, expect, it, vi } from 'vitest';
import { experimentFunctions } from './helpers/experimentFunctions.js';

const source = new URL('../agent/modules/onMoved.js', import.meta.url);

describe('stock message update wake consumer', () => {
  it('registers once and retries if Thunderbird rejects the first registration', () => {
    const addListener = vi.fn()
      .mockImplementationOnce(() => { throw new Error('synthetic registration failure'); });
    const globals = {
      _onMessageUpdatedHandler: null,
      log: vi.fn(),
      browser: { messages: { onUpdated: { addListener } } },
    };
    const { attachOnUpdatedListener } = experimentFunctions(source, ['attachOnUpdatedListener'], globals);

    attachOnUpdatedListener();
    attachOnUpdatedListener();
    attachOnUpdatedListener();
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(globals.log).toHaveBeenCalledWith(
      expect.stringContaining('Failed attaching messages.onUpdated listener'), 'warn',
    );
  });
});
