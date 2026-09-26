import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {parse} from 'acorn';
import {JSDOM} from 'jsdom';
const root=resolve(import.meta.dirname,'..');
function declaration(src,name){const n=parse(src,{ecmaVersion:'latest',sourceType:'module'}).body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);return src.slice(n.start,n.end);}
async function wakeWithSelection(navigate) {
 const repo=root; const timers=[], events=[], logs=[], store={};
 const dom=new JSDOM(readFileSync(resolve(repo,'welcome/welcome.html'),'utf8'),{url:'https://example.invalid/welcome/'});
 const url='moz-extension://synthetic/welcome/welcome.html';
 const registry=[{id:1,type:'normal',tabs:[{id:1,url:'about:3pane'}]},{id:3,type:'popup',tabs:[{id:10,url}]}];
 let pageListener; let failWelcomeWrite=true;
 const browser={
  storage:{local:{get:async defaults=>({...defaults,...store}),set:async fields=>{events.push(['storage.set',Object.keys(fields)]);if(failWelcomeWrite&&fields.tabmailWelcomeCompleted){failWelcomeWrite=false;throw Error('synthetic storage failure');}Object.assign(store,fields);}}},
  runtime:{getURL:()=>url,onMessage:{addListener:fn=>{pageListener=fn;}}},
  windows:{getAll:async (o={})=>registry.map(w=>o.populate?structuredClone(w):{id:w.id,type:w.type}),update:async (id,info)=>{events.push(['focus',id]);Object.assign(registry.find(w=>w.id===id),info);},create:async options=>{events.push(['create',options.url]);registry.push({id:4,type:'popup',tabs:[{id:20,url:options.url}]});}},
  tabs:{sendMessage:async (id,message)=>{events.push(['sendMessage',id,message.command]);return new Promise(resolve=>pageListener(message,{},resolve));}}
 };
 const ctx=vm.createContext({browser,document:dom.window.document,window:dom.window,console:{log:(...a)=>logs.push(a),warn:(...a)=>logs.push(a),error:(...a)=>logs.push(a)},fetch:async page=>({ok:true,text:async()=>readFileSync(resolve(repo,'welcome',page),'utf8')}),setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},SETTINGS:{},log(){},_welcomeWizardCheckInProgress:false,hasEmailAccounts:async()=>true,cleanupAccountCreatedListener(){},injectPaletteIntoDocument:async()=>{},generateProgressBubbles(){}});
 for(const file of ['welcome/welcomeConfig.js','welcome/modules/settings.js','welcome/modules/navigation.js','welcome/modules/pageLoader.js','welcome/modules/runtimeMessages.js']){
  vm.runInContext(readFileSync(resolve(repo,file),'utf8').replace(/^export /gm,''),ctx,{filename:resolve(repo,file)});
 }
 vm.runInContext(`let currentStep=0;
 const flattenedSteps=getFlattenedSteps(), totalSteps=getTotalSteps(), categories=getCategories();
 const getCurrentStep=()=>currentStep, setCurrentStep=n=>{currentStep=n};
 const settings=createSettings({flattenedSteps});
 const pageLoader=createPageLoader({getPageUrl,initializePageContent:async()=>{}});
 const navigation=createNavigation({totalSteps,getCategoryForStep,loadPage:pageLoader.loadPage,saveStepSettings:settings.saveStepSettings,finishWizard:async()=>{},getCurrentStep,setCurrentStep});`,ctx);
 const welcomeSrc=readFileSync(resolve(repo,'welcome/welcome.js'),'utf8');
 vm.runInContext(declaration(welcomeSrc,'init'),ctx);
 await vm.runInContext('init()',ctx);
 await vm.runInContext('navigation.goToStep(5)',ctx);
 // A real DOM selection, saved only by the real welcome settings module on Next.
 const select=dom.window.document.getElementById('default-calendar');
 select.innerHTML='<option value="synthetic-calendar-old">Old</option><option value="synthetic-calendar-new">New</option>';
 select.value='synthetic-calendar-new';
 const before={step:vm.runInContext('getCurrentStep()',ctx),selection:select.value,completion:store.tabmailWelcomeCompleted??false};
 let bg=readFileSync(resolve(repo,'agent/background.js'),'utf8');
 vm.runInContext(declaration(bg,'checkAndShowWelcomeWizard'),ctx);
 await vm.runInContext('checkAndShowWelcomeWizard()',ctx);
 const atReturn={step:vm.runInContext('getCurrentStep()',ctx),windows:registry.length};
 if (navigate) dom.window.document.getElementById('btn-next').click();
 for(let i=0;i<30;i++) await Promise.resolve();
 const afterNewerNext={step:vm.runInContext('getCurrentStep()',ctx),persistedCalendar:store.defaultCalendarId??null};
 for(const {fn} of timers) await fn();
 const after={step:vm.runInContext('getCurrentStep()',ctx),selection:dom.window.document.getElementById('default-calendar')?.value??null,persistedCalendar:store.defaultCalendarId??null,windows:registry.length};
 dom.window.close();
 return {before,atReturn,afterNewerNext,after,events};
}

it('preserves a retained wizard page and unsaved selection after a wake', async () => {
 const result=await wakeWithSelection(false);
 expect(result.before).toMatchObject({step:5,selection:'synthetic-calendar-new',completion:false});
 expect(result.after).toMatchObject({step:5,selection:'synthetic-calendar-new',persistedCalendar:null,windows:2});
});
it('does not override a newer Next action with an older wake reset', async () => {
 const result=await wakeWithSelection(true);
 expect(result.afterNewerNext).toEqual({step:6,persistedCalendar:'synthetic-calendar-new'});
 expect(result.after).toMatchObject({step:6,persistedCalendar:'synthetic-calendar-new',windows:2});
});
