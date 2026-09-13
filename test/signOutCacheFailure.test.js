/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({store:{},local:{},failRead:false,clear:vi.fn()}));
vi.mock('../agent/modules/idbStorage.js',()=>({
 get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in h.store).map(k=>[k,h.store[k]])),
 getAllKeys:async()=>{if(h.failRead)throw new Error('synthetic read transaction failure');return Object.keys(h.store);},
 set:async obj=>Object.assign(h.store,obj),remove:async keys=>{for(const k of keys)delete h.store[k];},
 clear:async()=>{h.clear();h.store={};},
}));
vi.mock('../agent/modules/config.js',()=>({SETTINGS:{},getBackendUrl:async()=> 'https://invalid.example'}));
vi.mock('../agent/modules/utils.js',()=>({log:vi.fn(),resolveUniqueMessageKey:async()=>({status:'absent',weIds:[],folder:null}),getUniqueMessageKey:async()=> 'acc:/INBOX:synthetic@example.test'}));
vi.mock('../agent/modules/tagDefs.js',()=>({triggerSortRefresh:vi.fn(),maxPriorityAction:vi.fn()}));
vi.mock('../agent/modules/deviceSync.js',()=>({cleanupDeviceSync:vi.fn()}));
let auth;
beforeEach(async()=>{
 vi.resetModules();h.clear.mockClear();h.failRead=false;
 h.local={'user_prompts:user_action.md':'Synthetic private prompt'};
 h.store={'action:acc:/INBOX:synthetic@example.test':'reply','action:userprompt:acc:/INBOX:synthetic@example.test':'Synthetic private prompt'};
 globalThis.browser={storage:{local:{get:async key=>({[key]:h.local[key]}),set:async obj=>Object.assign(h.local,obj),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete h.local[k];}},onChanged:{addListener:vi.fn()}}};
 auth=await import('../agent/modules/supabaseAuth.js');
});
afterEach(async()=>{const owner=await import('../agent/modules/actionCache.js');owner.cleanupActionCache?.();});
it.each([false,true])('wipes cached user prompts at sign-out even if the preliminary key read fails=%s',async fail=>{
 h.failRead=fail;
 expect(await auth.signOut()).toBe(true);
 expect(h.local['user_prompts:user_action.md']).toBeUndefined();
 expect(h.store).toEqual({});expect(h.clear).toHaveBeenCalledOnce();
});
