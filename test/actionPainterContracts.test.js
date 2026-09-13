import { describe, expect, it, vi } from 'vitest';
import { experimentFunctions } from './helpers/experimentFunctions.js';
const source = name => new URL(`../theme/experiments/${name}/${name}.sys.mjs`, import.meta.url);
const readers = [
 ['tmMessageListTableView','_lookupActionForRow_MLTV','TM_ACTION_PROP_NAME_MLTV','_isInboxOrUnifiedInboxFolder_MLTV'],
 ['tmMessageListCardView','_lookupActionForCard_MLCV','TM_ACTION_PROP_NAME_MLCV','_isActionInbox'],
 ['tmMessageHeaderChip','_lookupActionForHdr_MHC','TM_ACTION_PROP_NAME_MHC','_isActionInbox'],
 ['tmMultiMessageChip','_lookupActionForHdr_MMC','TM_ACTION_PROP_NAME_MMC','_isActionInbox'],
 ['tagSort','_lookupAction','TM_ACTION_PROP_NAME','_isInboxOrUnifiedInboxFolder'],
];
for(const [name,lookup,prop,gate] of readers) describe(`${name} canonical reader`,()=>{
 const functions=experimentFunctions(source(name),[lookup,gate],{[prop]:'tm-action',Ci:{nsMsgFolderFlags:{Inbox:1,Virtual:2}}});
 const read=functions[lookup];
 const hdr=(action,flags=1)=>({folder:{flags},getStringProperty:key=>key==='tm-action'?action:'tm_reply'});
 it('reads every action including none, but never revives legacy keywords',()=>{
  for(const action of ['reply','none','archive','delete'])expect(read(hdr(action))).toBe(action);
  expect(read(hdr(''))).toBeNull();
 });
 it('ignores non-inbox native props and handles missing headers',()=>{
  expect(read(hdr('reply',0))).toBeNull();expect(read(null)).toBeNull();
  const unified=hdr('reply',2);unified.folder.prettyName='Unified Inbox';expect(read(unified)).toBe('reply');
 });
});
describe('card wrapper ownership',()=>{
 it('leaves the entire newer patch intact when an older instance shuts down',()=>{
  const owner=()=>{},newer=()=>{},pristine=()=>{},reset=vi.fn();
  class Card {};
  Card.prototype.fillRow=Object.assign(()=>{}, {__tmCardOwner:newer});
  Card.__tmOrigFillRow=pristine;Card.__tmOrigRowHeight=40;Card.ROW_HEIGHT=60;Card.__tmPatched=true;
  const {unpatchThreadCardPrototype}=experimentFunctions(source('tmMessageListCardView'),['unpatchThreadCardPrototype'],{_applyZeroFlickerEnhancements:owner,CARD_SENDER_CONFIG_MLCV:{logPrefix:''},LOG_PREFIX_MLCV:'',console:{log(){},error(){}}});
  const doc={defaultView:{customElements:{get:()=>Card}},getElementById:()=>({reset})};
  const wrapper=Card.prototype.fillRow;unpatchThreadCardPrototype(doc);
  expect(Card.prototype.fillRow).toBe(wrapper);expect(Card.ROW_HEIGHT).toBe(60);expect(Card.__tmPatched).toBe(true);expect(reset).not.toHaveBeenCalled();
  wrapper.__tmCardOwner=owner;unpatchThreadCardPrototype(doc);
  expect(Card.prototype.fillRow).toBe(pristine);expect(Card.ROW_HEIGHT).toBe(40);expect(reset).toHaveBeenCalledOnce();
 });
});
describe('sort scheduling',()=>{
 it('restarts the 30-second timer independently of painting',async()=>{
  vi.useFakeTimers();try{
   const applySort=vi.fn();const win={setTimeout,clearTimeout};
   const {scheduleDelayedSort}=experimentFunctions(source('tagSort'),['scheduleDelayedSort'],{applySort,DELAYED_SORT_MS:30000,getWinDelayedSortTimer:w=>w.timer,setWinDelayedSortTimer:(w,t)=>{w.timer=t;}});
   scheduleDelayedSort(win);await vi.advanceTimersByTimeAsync(20000);scheduleDelayedSort(win);
   await vi.advanceTimersByTimeAsync(29999);expect(applySort).not.toHaveBeenCalled();
   await vi.advanceTimersByTimeAsync(1);expect(applySort).toHaveBeenCalledExactlyOnceWith(win);
   scheduleDelayedSort(win,true);expect(applySort).toHaveBeenLastCalledWith(win,true);
  }finally{vi.useRealTimers();}
 });
 it('owns exactly one retry for an immediate request inside the debounce',async()=>{
  vi.useFakeTimers();vi.setSystemTime(50);try{
   const getWinSortTimestamp=vi.fn(()=>0);
   const win={setTimeout,clearTimeout,document:{getElementById:()=>({currentTabInfo:{mode:{name:'other'}}})}};
   const {applySort}=experimentFunctions(source('tagSort'),['applySort'],{Date,isTagSortEnabled:()=>true,getWinSortTimestamp,SORT_DEBOUNCE_MS:100});
   applySort(win,true);const timer=win.__tmTagSortImmediateRetry;applySort(win,true);
   expect(win.__tmTagSortImmediateRetry).toBe(timer);expect(vi.getTimerCount()).toBe(1);
   await vi.advanceTimersByTimeAsync(100);expect(getWinSortTimestamp).toHaveBeenCalledTimes(3);expect(win.__tmTagSortImmediateRetry).toBeNull();
  }finally{vi.useRealTimers();}
 });
});
