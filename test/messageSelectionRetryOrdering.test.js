import { afterEach, expect, it, vi } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';
import { experimentFunctions } from './helpers/experimentFunctions.js';
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), getUniqueMessageKey: vi.fn(async id => `synthetic:${id}`) }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../agent/modules/folderResolver.js', () => ({ resolveWeFolderFromXulUri: vi.fn() }));
import { CHAT_SETTINGS } from '../chat/modules/chatConfig.js';
import { initMessageSelectionListener, cleanupMessageSelectionListener, handleMessageSelectionRequest } from '../chat/modules/messageSelection.js';
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
afterEach(() => { cleanupMessageSelectionListener(); delete globalThis.browser; });
it.each(['mailMessageTab', 'contentTab'])('a queued bootstrap retry must not erase live mail selection on %s', async mode => {
 const w=makeWindow();
 const x=experiment('chat/experiments/messageSelection/messageSelection.sys.mjs', 'messageSelection', {windows:[w.win]});
 x.instance.extension.messageManager.convert=hdr=>({id:hdr.messageKey});
 const listeners=new Set(), timers=[], history=[], ctx={selectedMessageIds:[]};
 let firstRequest=true;
 globalThis.browser={messageSelection:x.api,runtime:{
  onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
  sendMessage:vi.fn(async message=>{
   if(message.command==='get-current-selection') {
    if(firstRequest) {firstRequest=false;return undefined;}
    return handleMessageSelectionRequest(message);
   }
   history.push(message.selectedMessageIds);
   for(const fn of listeners) fn(message);
  })
 }};
 const chat=experimentFunctions(new URL('../chat/chat.js',import.meta.url),
  ['initMessageSelectionTracking','updateSelectionFromMessage','cleanupMessageSelectionListener'],
  {CHAT_SETTINGS,browser,ctx,currentSelectionCount:0,messageSelectionListener:null,log:vi.fn(),setTimeout:fn=>timers.push(fn)});
 const autocompleteState={matches:[]};
 const mention=experimentFunctions(new URL('../chat/modules/mentionAutocomplete.js',import.meta.url),['updateMatches'],
  {ctx,autocompleteState,emailCache:[],templateCache:[],log:vi.fn(),getEmailById:async id=>({subject:id,from:'sender@example.test'})});
 try {
  await initMessageSelectionListener();
  await chat.initMessageSelectionTracking();
  expect(timers).toHaveLength(1);
  w.hdr.messageKey=2;w.tree.dispatch('select');await settle();
  expect(ctx.selectedMessageIds).toEqual(['synthetic:2']);
  const tabmail=w.win.document.getElementById('tabmail');
  tabmail.currentTabInfo={mode:{name:mode}};tabmail.currentAbout3Pane=null;
  w.tabContainer.dispatch('TabSelect');await settle();
  expect(ctx.selectedMessageIds).toEqual(['synthetic:2']);
  expect(JSON.parse(await x.api.getSelectedMessages())).toEqual([]);
  timers.shift()();await settle();
  await mention.updateMatches('');
  expect(ctx.selectedMessageIds).toEqual(['synthetic:2']);
  expect(autocompleteState.matches.map(m=>m.label)).toEqual(['synthetic:2']);
  expect(history).toEqual([['synthetic:2']]);
  expect(browser.runtime.sendMessage.mock.calls.filter(([message]) => message.command === 'get-current-selection')).toHaveLength(1);
 } finally {chat.cleanupMessageSelectionListener();cleanupMessageSelectionListener();x.instance.onShutdown(false);}
});
