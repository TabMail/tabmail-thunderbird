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
});

describe('collapsed card boundaries',()=>{
const names=['_isActionInbox','_lookupActionForCard_MLCV','_aggregateActionForThread_MLCV','_paintCardForAction_MLCV','_paintChipOnCard_MLCV','_colorForAction_MLCV'];
const actions=['reply','none','archive','delete'];
const f=experimentFunctions(source('tmMessageListCardView'),names,{
 Ci:{nsMsgFolderFlags:{Inbox:1,Virtual:2}},TM_ACTION_PROP_NAME_MLCV:'tm-action',TM_ACTION_PRIORITY_MLCV:actions,
 TM_ACTION_CLASSES_MLCV:actions.map(a=>'tm-action-'+a),_ACTION_TO_KEYWORD_MLCV:Object.fromEntries(actions.map(a=>[a,'tm_'+a])),
 _ACTION_LABELS_MLCV:{reply:'Reply',none:'None',archive:'Archive',delete:'Delete'},CHIP_CLASS_MLCV:'tm-action-chip',
 MailServices_MLCV:{tags:{getColorForKey:()=> '#123456'}},
 context:{extension:{messageManager:{convert:hdr=>({id:hdr.id})}}},
});
const makeHdr=(id,flags,action)=>({id,folder:{flags},getStringProperty:p=>p==='tm-action'?action:''});
const makeRow=()=>{
 const classes=new Set(),style=new Map();
 const row={children:[],classList:{contains:c=>classes.has(c),add:c=>classes.add(c),remove:c=>classes.delete(c)},style:{getPropertyValue:k=>style.get(k)||'',setProperty:(k,v)=>style.set(k,v),removeProperty:k=>style.delete(k)},
 querySelector:s=>s==='.tm-action-chip'?row.children[0]||null:null,
 appendChild(c){c.parentNode=row;row.children.push(c);},removeChild(c){row.children=row.children.filter(x=>x!==c);}};
 return row;
};
const doc={createElement:()=>({attrs:{},dataset:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];}})};
it('recycled collapsed card outside inbox loses its prior chip and tint, while an inbox card still paints',()=>{
 const outside=makeHdr(1,0,''),inbox=makeHdr(2,1,'reply');
 const tree={view:{dbView:{isContainer:()=>true,isContainerOpen:()=>false,getThreadContainingIndex:()=>({numChildren:2,getChildHdrAt:i=>[outside,inbox][i]})}}};
 const row=makeRow();
 let aggregate=f._aggregateActionForThread_MLCV(tree,0,inbox);
 f._paintCardForAction_MLCV(row,aggregate.action,doc,aggregate.sourceHdr);
 expect(row.classList.contains('tm-action-reply')).toBe(true);expect(row.children[0]?.textContent).toBe('Reply');
 aggregate=f._aggregateActionForThread_MLCV(tree,0,outside);
 f._paintCardForAction_MLCV(row,aggregate.action,doc,aggregate.sourceHdr);
 expect(row.classList.contains('tm-action-reply')).toBe(false);expect(row.style.getPropertyValue('--tag-color')).toBe('');expect(row.children).toHaveLength(0);
 expect(inbox.getStringProperty('tm-action')).toBe('reply');
});

});
