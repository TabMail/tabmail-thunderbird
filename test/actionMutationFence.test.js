import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'acorn';
const root=resolve(import.meta.dirname,'..');
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(resolve(dir,e.name)):/\.(js|mjs)$/.test(e.name)?[resolve(dir,e.name)]:[]);}
function walk(node,visit){if(!node||typeof node!=='object')return;visit(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(v=>walk(v,visit));else if(value&&typeof value==='object')walk(value,visit);}
describe('canonical action mutation fence',()=>{
 it('owns action key construction and full-cache wipes in one production module',()=>{
  const violations=[];
  for(const file of ['agent','chat','theme'].flatMap(dir=>files(resolve(root,dir)))){
   if(file.endsWith('/agent/modules/actionCache.js'))continue;
   walk(parse(readFileSync(file,'utf8'),{ecmaVersion:'latest',sourceType:'module'}),node=>{
    if(node.type==='Literal'&&typeof node.value==='string'&&node.value.startsWith('action:'))violations.push(file);
    if(node.type==='TemplateElement'&&node.value.raw.startsWith('action:'))violations.push(file);
    if(node.type==='CallExpression'&&node.callee?.object?.name==='idb'&&node.callee?.property?.name==='clear')violations.push(file);
   });
  }
  expect(violations).toEqual([]);
 });
});
