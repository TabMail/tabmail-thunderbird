import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

function startAgent(overrides = {}) {
  const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let script = source;
  const enqueueProcessMessage = vi.fn(async () => ({ ok: true }));
  const signalChatTyping = vi.fn();
  const globals = {
    console: { log() {}, error() {}, warn() {} }, Date, performance,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    window: {}, navigator: {},
  };
  for (const entry of ast.body.filter(node => node.type === 'ImportDeclaration').reverse()) {
    for (const specifier of entry.specifiers) {
      const name = specifier.local.name;
      globals[name] = name === 'SETTINGS' ? {} : name === 'idb' ? {} : () => Promise.resolve({});
    }
    script = script.slice(0, entry.start)
      + script.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ')
      + script.slice(entry.end);
  }
  globals.enqueueProcessMessage = enqueueProcessMessage;
  globals.signalChatTyping = signalChatTyping;
  globals.isInboxFolder = () => true;
  const events = new Map();
  function event(path) {
    if (!events.has(path)) {
      const listeners = new Set();
      events.set(path, {
        listeners,
        addListener: callback => listeners.add(callback),
        removeListener: callback => listeners.delete(callback),
        hasListener: callback => listeners.has(callback),
        emit: (...args) => Promise.all([...listeners].map(callback => callback(...args))),
      });
    }
    return events.get(path);
  }
  const fallback = () => Promise.resolve({});
  function api(path = 'browser') {
    return new Proxy(fallback, {
      get(_target, key) {
        if (key === 'then') return undefined;
        const next = `${path}.${String(key)}`;
        if (String(key).startsWith('on')) return event(next);
        if (key === 'getManifest') return () => ({ version: 'synthetic' });
        return api(next);
      },
    });
  }
  globals.browser = api();
  Object.assign(globals, overrides);
  vm.runInNewContext(script, globals, { filename: 'agent/background.js' });
  return { event, enqueueProcessMessage, signalChatTyping };
}


const h=vi.hoisted(()=>({store:{},native:new Map()}));
vi.mock('../agent/modules/idbStorage.js',()=>({get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in h.store).map(k=>[k,h.store[k]])),set:async values=>Object.assign(h.store,values),remove:async()=>{},clear:async()=>{},getAllKeys:async()=>Object.keys(h.store)}));
vi.mock('../agent/modules/utils.js',()=>({getUniqueMessageKey:async m=>`${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`,resolveUniqueMessageKey:async()=>({status:'resolved',weIds:[1],folder:{id:'inbox',accountId:'acc',path:'/INBOX',specialUse:['inbox']}}),log(){}}));
vi.mock('../agent/modules/config.js',()=>({SETTINGS:{}}));
vi.mock('../agent/modules/tagDefs.js',()=>({triggerSortRefresh(){}}));
it('canceled suspend preserves a live classification through durable commit and native projection',async()=>{
 vi.resetModules();h.store={};h.native=new Map();
 const folder={id:'inbox',accountId:'acc',path:'/INBOX',specialUse:['inbox']};
 const header={id:1,headerMessageId:'synthetic@example.test',folder};
 const key='acc:/INBOX:synthetic@example.test';
 const previousBrowser=globalThis.browser;
 globalThis.browser={messages:{query:async()=>({messages:[header]}),get:async()=>header},tmHdr:{setAction:async(id,action)=>h.native.set(id,action)},tmMessageHeaderChip:{refreshAll:async()=>{}},tmMultiMessageChip:{refreshAll:async()=>{}},folders:{query:async()=>[folder]},accounts:{list:async()=>[]}};
 try {
 const owner=await import('../agent/modules/actionCache.js');
 expect(await owner.setAction(header,'none')).toBe(key);
 expect(h.store[`action:${key}`]).toBe('none');
 const token=owner.beginAutomaticWork(key);
 const app=startAgent({cleanupActionCache:owner.cleanupActionCache});
 await app.event('browser.runtime.onSuspend').emit();
 await app.event('browser.runtime.onSuspendCanceled').emit();
 expect(await owner.setAction(header,'reply',{token})).toBe(key);
 expect(h.store[`action:${key}`]).toBe('reply');
 expect(h.native.get(1)).toBe('reply');
 owner.cleanupActionCache();
 } finally {
  if(previousBrowser===undefined) delete globalThis.browser;
  else globalThis.browser=previousBrowser;
 }
});
