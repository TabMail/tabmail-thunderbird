
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { experiment } from './helpers/nativeLifecycleHarness.js';
function fixture() {
  let seq=0;
  const intervals=new Map(), timeouts=new Map(), sockets=[];
  const h=experiment('agent/experiments/tmDeviceSync/tmDeviceSync.sys.mjs','tmDeviceSync',{moduleOverrides:{
    setInterval:(cb,ms)=>{const id=++seq;intervals.set(id,{cb,ms});return id;},clearInterval:id=>intervals.delete(id),
    setTimeout:(cb,ms)=>{const id=++seq;timeouts.set(id,{cb,ms});return id;},clearTimeout:id=>timeouts.delete(id),
  }});
  class Socket { static OPEN=1; constructor(){this.readyState=0;this.sent=[];sockets.push(this);} open(){this.readyState=1;this.onopen();} close(){this.readyState=3;this.onclose?.();} send(data){this.sent.push(data);} }
  h.Services.appShell={createWindowlessBrowser:()=>({document:{defaultView:{WebSocket:Socket}},close(){}})};
  h.Services.io.newURI=raw=>{const u=new URL(raw);return {scheme:u.protocol.slice(0,-1),host:u.hostname,filePath:u.pathname,userPass:u.username};};
  return {...h,intervals,timeouts,sockets};
}
describe('Device Sync exposed lifecycle',()=>{
  it('wakes through exposed persistent event and delivers one peer payload after suspend',async()=>{
    const h=fixture();
    try {
      const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
      const registration=manifest.experiment_apis.tmDeviceSync;
      const schema=JSON.parse(readFileSync(new URL('../'+registration.schema,import.meta.url),'utf8'));
      const exposed=registration.parent.paths.some(p=>p.length===1 && p[0]===schema[0].namespace) ? h.api : undefined;
      expect(exposed).toBeDefined();
      const durable=[];
      const awake=async event=>{if(event.type==='message') durable.push(JSON.parse(event.data).payload);};
      exposed.onEvent.addListener(awake);
      exposed.connect('wss://sync.tabmail.ai/ws?token=synthetic');h.sockets[0].open();
      h.sockets[0].onmessage({data:JSON.stringify({type:'peer_payload',payload:'before-suspend'})});
      await Promise.resolve();expect(durable).toEqual(['before-suspend']);
      exposed.onEvent.close();
      const metadata=exposed.onEvent.testPersistentRegistration();
      expect(metadata).not.toBeNull();
      const queue=[];let wakes=0;
      const primed=metadata.prime({async:event=>new Promise(resolve=>{wakes++;queue.push({event,resolve});})});
      h.sockets[0].onmessage({data:'{"type":"pong"}'});
      expect(wakes).toBe(0);
      h.sockets[0].onmessage({data:JSON.stringify({type:'peer_payload',payload:'after-suspend'})});
      expect(wakes).toBe(1);expect(durable).toEqual(['before-suspend']);
      primed.convert({async:awake});
      for (const pending of queue) pending.resolve(awake(pending.event));
      await Promise.resolve();
      expect(durable).toEqual(['before-suspend','after-suspend']);expect(h.sockets).toHaveLength(1);
      primed.unregister();
      h.sockets[0].onmessage({data:JSON.stringify({type:'peer_payload',payload:'after-unregister'})});
      await Promise.resolve();expect(durable).toEqual(['before-suspend','after-suspend']);
    } finally {h.instance.onShutdown();}
  });
  it('repeated open and teardown release all timer resources as well as stopping traffic',()=>{
    const h=fixture(); const resourceCounts=[]; let activeHeartbeats=0;
    try {
      for(let cycle=0;cycle<12;cycle++) {
        h.api.connect('wss://sync.tabmail.ai/ws?token=synthetic'); const socket=h.sockets.at(-1); socket.open();
        for(const t of [...h.intervals.values()]) if(t.ms===30000)t.cb();
        expect(socket.sent).toEqual(['{"type":"ping"}']);activeHeartbeats++;
        if(cycle%3===0)socket.close();
        if(cycle%3===2)h.instance.onShutdown();else h.api.disconnect();
        const wire=socket.sent.length;
        for(const t of [...h.intervals.values()]) t.cb();
        expect(socket.sent).toHaveLength(wire);expect(socket.readyState).toBe(3);
        resourceCounts.push(h.intervals.size+h.timeouts.size);
      }
      expect(activeHeartbeats).toBe(12);
      expect(resourceCounts).toEqual(Array(12).fill(0));
    } finally {h.instance.onShutdown();}
  });
});
