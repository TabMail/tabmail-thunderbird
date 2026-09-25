import { expect, it, vi } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';
import { experimentFunctions } from './helpers/experimentFunctions.js';
vi.mock('../agent/modules/utils.js',()=>({log:vi.fn(),getUniqueMessageKey:vi.fn(async id=>`synthetic-account:/Inbox:synthetic-${id}@example.test`)}));
vi.mock('../agent/modules/config.js',()=>({SETTINGS:{debugLogging:false}}));
vi.mock('../agent/modules/folderResolver.js',()=>({resolveWeFolderFromXulUri:vi.fn()}));
import { CHAT_SETTINGS } from '../chat/modules/chatConfig.js';
import { initMessageSelectionListener,cleanupMessageSelectionListener,handleMessageSelectionRequest } from '../chat/modules/messageSelection.js';
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r))};
it('Chat and its selected-email mention follow the mail view after a wake during an unfinished tab load',async()=>{
 const first=makeWindow(),second=makeWindow();
 delete first.win.gDBView;first.cw.gDBView=first.view;
 second.hdr.messageKey=2;second.cw.gDBView=null;second.doc.readyState='loading';
 const getElement=second.doc.getElementById;
 second.doc.getElementById=id=>second.doc.readyState==='complete'?getElement(id):null;
 const tabmail=first.win.document.getElementById('tabmail');
 const firstTab=tabmail.tabInfo[0];firstTab.mode={name:'mail3PaneTab'};tabmail.currentTabInfo=firstTab;
 const pending=new Map();
 const nativeBrowser={contentWindow:second.cw,get contentDocument(){return second.doc},
  addEventListener(name,fn,capture){pending.set(fn,{name,capture})},
  removeEventListener(name,fn,capture){if(pending.get(fn)?.name===name&&pending.get(fn)?.capture===capture)pending.delete(fn)},
  load(){for(const [fn,{name,capture}]of [...pending])if(name==='load'&&capture===true)fn({target:second.doc})}
 };
 const secondTab={mode:{name:'mail3PaneTab'},chromeBrowser:nativeBrowser};tabmail.tabInfo.push(secondTab);
 const x=experiment('chat/experiments/messageSelection/messageSelection.sys.mjs','messageSelection',{windows:[first.win]});
 x.instance.extension.messageManager.convert=h=>({id:h.messageKey});
 const listeners=new Set(),ctx={selectedMessageIds:[]};
 globalThis.browser={messages:{get:async id=>({headerMessageId:`synthetic-${id}@example.test`,folder:{accountId:'synthetic-account',path:'/Inbox'}})},messageSelection:x.api,runtime:{
  onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
  sendMessage:async message=>{if(message.command==='get-current-selection')return handleMessageSelectionRequest(message);for(const fn of listeners)fn(message)}
 }};
 const chat=experimentFunctions(new URL('../chat/chat.js',import.meta.url),['initMessageSelectionTracking','cleanupMessageSelectionListener','updateSelectionFromMessage'],{
  CHAT_SETTINGS,browser,ctx,currentSelectionCount:0,messageSelectionListener:null,log:vi.fn(),setTimeout
 });
 const state={matches:[]};const mention=experimentFunctions(new URL('../chat/modules/mentionAutocomplete.js',import.meta.url),['updateMatches'],{
  ctx,autocompleteState:state,emailCache:[],templateCache:[],log:vi.fn(),getEmailById:async id=>({subject:id,from:'sender@example.test'})
 });
 try{
  await initMessageSelectionListener();await chat.initMessageSelectionTracking();expect(ctx.selectedMessageIds).toEqual(['synthetic-account:/Inbox:synthetic-1@example.test']);
  tabmail.currentTabInfo=secondTab;tabmail.currentAbout3Pane=second.cw;first.tabContainer.dispatch('TabSelect');expect(pending.size).toBe(1);
  browser.messageSelection.onSelectionChanged.close();
  browser.messageSelection=x.instance.getAPI(x.context).messageSelection;await initMessageSelectionListener();
  second.doc.readyState='complete';second.cw.gDBView=second.view;nativeBrowser.load();
  expect(JSON.parse(await browser.messageSelection.getSelectedMessages()).map(m=>m.weMsgId)).toEqual([2]);
  second.hdr.messageKey=3;second.tree.dispatch('select');await settle();await mention.updateMatches('');
  const observed={ids:[...ctx.selectedMessageIds],mentions:state.matches.map(m=>m.label)};
  // Positive repair control: changing away and back reattaches the real tree;
  // an additional selection is delivered through native -> background -> Chat.
  tabmail.currentTabInfo=firstTab;tabmail.currentAbout3Pane=first.cw;first.tabContainer.dispatch('TabSelect');
  tabmail.currentTabInfo=secondTab;tabmail.currentAbout3Pane=second.cw;first.tabContainer.dispatch('TabSelect');
  second.hdr.messageKey=4;second.tree.dispatch('select');await settle();await mention.updateMatches('');
  await vi.waitFor(()=>expect(ctx.selectedMessageIds).toEqual(['synthetic-account:/Inbox:synthetic-4@example.test']));
  await mention.updateMatches('');expect(state.matches.map(m=>m.label)).toEqual(['synthetic-account:/Inbox:synthetic-4@example.test']);
  expect(observed).toEqual({ids:['synthetic-account:/Inbox:synthetic-3@example.test'],mentions:['synthetic-account:/Inbox:synthetic-3@example.test']});
 }finally{chat.cleanupMessageSelectionListener();cleanupMessageSelectionListener();x.instance.onShutdown(false);delete globalThis.browser}
});
