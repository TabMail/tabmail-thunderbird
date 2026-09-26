/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../agent/experiments/tmDeviceSync/tmDeviceSync.sys.mjs', import.meta.url), 'utf8');
let api, sockets, events, host;
beforeEach(() => {
  vi.useFakeTimers(); sockets = []; events = [];
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.send = vi.fn(); sockets.push(this); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  host = { document: { documentGlobal: { WebSocket: Socket } }, close: vi.fn() };
  const common = { ExtensionAPIPersistent: class {}, ExtensionError: Error, EventManager: class {} };
  const Api = runInNewContext('const ExtensionCommon = {};\n' + source + '\n tmDeviceSync;', {
    ChromeUtils: { importESModule: path => path.includes('Timer') ? { setTimeout, clearTimeout, setInterval, clearInterval } : { ExtensionCommon: common } },
    Services: { appShell: { createWindowlessBrowser: () => host }, io: { newURI: raw => { const u = new URL(raw); return { scheme: u.protocol.slice(0, -1), host: u.hostname, filePath: u.pathname, userPass: u.username }; } } },
  });
  api = new Api({});
  api.PERSISTENT_EVENTS.onEvent({ fire: { async: async event => { events.push(event); } } });
});
afterEach(() => { api.onShutdown(); vi.useRealTimers(); });
describe('parent Device Sync transport', () => {
  it('keeps one socket and handles heartbeat without waking the consumer', () => {
    api.connect('wss://sync.tabmail.ai/ws?token=synthetic');
    api.connect('wss://sync.tabmail.ai/ws?token=synthetic');
    expect(sockets).toHaveLength(1);
    sockets[0].open(); events.length = 0;
    vi.advanceTimersByTime(30000);
    expect(sockets[0].send).toHaveBeenCalledWith('{"type":"ping"}');
    sockets[0].onmessage({ data: '{"type":"pong"}' });
    expect(events).toEqual([]);
    sockets[0].onmessage({ data: '{"type":"request_state"}' });
    expect(events).toEqual([{ type: 'message', data: '{"type":"request_state"}' }]);
  });
  it('converts the primed listener without stacking consumers or sockets', () => {
    api.listeners.clear();
    const sleeping = vi.fn(async () => {});
    const awake = vi.fn(async () => {});
    const registration = api.PERSISTENT_EVENTS.onEvent({ fire: { async: sleeping } });
    api.connect('wss://sync.tabmail.ai/ws?token=synthetic'); sockets[0].open();
    sleeping.mockClear();
    registration.convert({ async: awake });
    api.connect('wss://sync.tabmail.ai/ws?token=synthetic');
    sockets[0].onmessage({ data: '{"type":"request_state"}' });
    expect(sockets).toHaveLength(1);
    expect(sleeping).not.toHaveBeenCalled();
    expect(awake).toHaveBeenCalledExactlyOnceWith({ type: 'message', data: '{"type":"request_state"}' });
    registration.unregister();
    sockets[0].onmessage({ data: '{"type":"request_state"}' });
    expect(awake).toHaveBeenCalledTimes(1);
    expect(api.listeners.size).toBe(0);
  });
  it('asks the background to reconnect and cancels retry on disconnect', () => {
    api.connect('wss://sync.tabmail.ai/ws?token=synthetic'); sockets[0].open(); sockets[0].close();
    events.length = 0; vi.advanceTimersByTime(5000);
    expect(events).toEqual([{ type: 'reconnect' }]);
    api.connect('wss://sync.tabmail.ai/ws?token=refreshed'); sockets[1].open(); sockets[1].close();
    api.disconnect(); events.length = 0; vi.advanceTimersByTime(300000);
    expect(events).toEqual([]); expect(host.close).toHaveBeenCalled();
  });
  it('keeps startup from bypassing a pending reconnect delay', () => {
    api.connect('wss://sync.tabmail.ai/ws?token=synthetic');
    sockets[0].open(); sockets[0].close();
    expect(api.state()).toBe('retrying');
    api.connect('wss://sync.tabmail.ai/ws?token=refreshed');
    expect(sockets).toHaveLength(1);
    events.length = 0;
    vi.advanceTimersByTime(4999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([{ type: 'reconnect' }]);
    expect(api.state()).toBe('closed');
  });
  it('caps failed handshakes without a final close wake restarting the loop', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      api.connect('wss://sync.tabmail.ai/ws?token=synthetic');
      sockets.at(-1).close();
      expect(api.state()).toBe('retrying');
      vi.advanceTimersByTime(Math.min(5000 * 2 ** attempt, 300000));
    }
    api.connect('wss://sync.tabmail.ai/ws?token=synthetic');
    events.length = 0;
    sockets.at(-1).close();
    vi.advanceTimersByTime(600000);
    expect(events).toEqual([]);
    expect(api.state()).toBe('closed');
    expect(sockets).toHaveLength(11);
    api.disconnect();
    expect(api.attempts).toBe(0);
  });
  it('cleans up on addon shutdown and refuses other destinations', () => {
    expect(() => api.connect('wss://example.invalid/ws')).toThrow('Invalid Device Sync endpoint');
    expect(sockets).toHaveLength(0);
    api.connect('wss://sync.tabmail.ai/ws?token=synthetic'); sockets[0].open();
    api.onShutdown(); events.length = 0; vi.advanceTimersByTime(300000);
    expect(sockets[0].readyState).toBe(3); expect(events).toEqual([]);
    expect(host.close).toHaveBeenCalledTimes(1);
  });
});
