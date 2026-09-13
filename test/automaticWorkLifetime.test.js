/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { experimentFunctions } from './helpers/experimentFunctions.js';
it('retains only active automatic work and invalidates only matching keys',()=>{
 const tokens=new Map();
 const {beginAutomaticWork,finishAutomaticWork,_bump,_current}=experimentFunctions(new URL('../agent/modules/actionCache.js',import.meta.url),['beginAutomaticWork','finishAutomaticWork','_bump','_current'],{_workTokens:tokens,_epoch:0});
 const unrelated=beginAutomaticWork('other');
 for(let i=0;i<300;i++){
  const key=`message-${i}`;const first=beginAutomaticWork(key),second=beginAutomaticWork(key);
  _bump(key);expect(_current(key,first)).toBe(false);expect(_current(key,second)).toBe(false);
 }
 expect(tokens.size).toBe(1);expect(_current('other',unrelated)).toBe(true);
 finishAutomaticWork(unrelated);expect(tokens.size).toBe(0);
 const cachedRead=beginAutomaticWork('cached');finishAutomaticWork(cachedRead);
 expect(tokens.size).toBe(0);expect(_current('cached',cachedRead)).toBe(false);
 _bump('never-classified');expect(tokens.size).toBe(0);
});
