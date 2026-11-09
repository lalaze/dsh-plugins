import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { NativeSharing, type NativeHost } from '../src/chat/native-service.js';
import { createHandler } from '../src/http.js';
import { NativeSharingSettings } from '../src/client/settings/native-sharing.js';
import { fixture } from './fakes.js';

const input = (body: object) => new Request('http://dsh.test/api/remote-agents', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) });
async function rig(t: TestContext) {
  const x = await fixture(t), id = 'private-source-session', session = Session.create(SessionId(id));
  session.append('user/message', createUserMessage({content:[{type:'text',text:'Explicitly selected private history'}],source:{kind:'user'}}), {surfaceOp:'append'});
  session.append('request/header', {header:{config:{provider:'ordinary',model:'configured'}},reason:'initial'} as never);
  let sealed = 0, published = 0;
  const host: NativeHost = { available:()=>true, placement:async()=>'/srv/project', idle:async(_id,run)=>run(),
    snapshot:async()=>({protocol:'shared-native-v1',header:session.header,inheritedEventCount:0,project:'/srv/project',title:'Private plan',events:structuredClone([...session.snapshotEvents()]),files:[]}),
    validate:async()=>{}, import:async()=>{throw Error('not importing');}, activate:async()=>{throw Error('not activating');}, seal:async()=>{sealed++;} };
  const native = new NativeSharing(join(x.directory,'native-entry.json'),'instance-entry', {call:async(_host,r)=>{
    if(r.action==='list') return [];
    if(r.action==='create') {published++;return {id:r.id,version:1,digest:'published',owner:null};}
    throw Error('Unexpected registry action');
  }}, host);
  t.after(()=>native.close());
  const handler=createHandler(x.service,undefined,undefined,undefined,undefined,undefined,undefined,native);
  return {...x,id,native,handler,counts:()=>({sealed,published})};
}

test('installed native API really enables host opt-in and requires exact enrollment/recovery confirmation',async t=>{
  const x=await rig(t);
  assert.equal((await (await x.handler(input({action:'nativeSharing'}))).json()).enabled,false);
  assert.equal((await x.handler(input({action:'setNativeSharing',hostId:x.hostId,enabled:true}))).status,200);
  assert.equal(x.native.status().enabled,true);assert.deepEqual(x.counts(),{sealed:0,published:0});
  for(const confirmation of [{},{confirmed:true,confirmedSessionId:'different-session'}]) {
    assert.equal((await x.handler(input({action:'nativeShare',hostId:x.hostId,sessionId:x.id,...confirmation}))).status,400);
  }
  assert.deepEqual(x.counts(),{sealed:0,published:0});
  assert.equal((await x.handler(input({action:'nativeRecover',sessionId:x.id}))).status,400);
  assert.equal((await x.handler(input({action:'nativeShare',hostId:x.hostId,sessionId:x.id,confirmedSessionId:x.id,confirmed:true}))).status,200);
  assert.deepEqual(x.counts(),{sealed:1,published:1});
  assert.equal((await x.handler(input({action:'removeHost',hostId:x.hostId}))).status,409);
});

test('settings entry selects a host, displays current title/ID, and sends nothing when sharing confirmation is cancelled',async t=>{
  const x=await rig(t), dom=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:'http://dsh.test/'});
  const names=['window','document','navigator','HTMLElement','IS_REACT_ACT_ENVIRONMENT','fetch'] as const;
  const originals=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const name of names) Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:name==='IS_REACT_ACT_ENVIRONMENT'?true:name==='fetch'?async(_url: unknown,init: RequestInit)=>x.handler(new Request('http://dsh.test/api/remote-agents',init)):(dom.window as any)[name]});
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const name of names){const prior=originals.get(name);if(prior)Object.defineProperty(globalThis,name,prior);else delete (globalThis as any)[name];}});
  const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
  await act(async()=>{root.render(<NativeSharingSettings dashboard={await x.service.snapshot()} sessionId={x.id} sessionTitle="Private plan"/>);await settle();});
  const select=dom.window.document.querySelector('select')!;
  await act(async()=>{select.value=x.hostId;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();});
  const checkbox=dom.window.document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  await act(async()=>{checkbox.click();await settle();});
  assert.equal(x.native.status().enabled,true);
  assert.match(dom.window.document.body.textContent!,/Private plan/);assert.match(dom.window.document.body.textContent!,new RegExp(x.id));
  const button=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='Share and close current conversation')!;
  let prompt='';dom.window.confirm=(message?:string)=>{prompt=String(message);return false;};
  await act(async()=>{button.click();await settle();});assert.deepEqual(x.counts(),{sealed:0,published:0});
  assert.match(prompt,/Private plan/);assert.match(prompt,new RegExp(x.id));assert.match(prompt,/close the original/);
  dom.window.confirm=()=>true;
  await act(async()=>{button.click();await settle();});assert.deepEqual(x.counts(),{sealed:1,published:1});
});
