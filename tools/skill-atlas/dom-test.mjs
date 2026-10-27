// No Chrome, windows, browser profiles or network. DOM interaction checks only.
// Dependency: npm install --prefix /tmp/skill-atlas-dom-test linkedom
import {parseHTML} from '/tmp/skill-atlas-dom-test/node_modules/linkedom/esm/index.js';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const root=new URL('./',import.meta.url);
const {window,document}=parseHTML(await fs.readFile(new URL('index.html',root),'utf8'));
const store=new Map();
const dialog=document.querySelector('dialog');dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'))};
// linkedom models markup, not native browser form validation or select state.
Object.defineProperty(window.HTMLSelectElement.prototype,'value',{get(){return this._value??this.querySelector('option[selected]')?.getAttribute('value')??this.querySelector('option[selected]')?.textContent??this.querySelector('option')?.getAttribute('value')??this.querySelector('option')?.textContent},set(v){this._value=String(v)},configurable:true});
document.querySelector('#extras').checked=true;
window.HTMLInputElement.prototype.setCustomValidity=function(s){this.validationMessage=s};
const context=vm.createContext({document,console,Event:window.Event,Set,Map,Blob,URL,setTimeout,clearTimeout,navigator:{clipboard:{writeText:async()=>{}}},localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},fetch:async p=>{try{const value=await fs.readFile(new URL(p,root),'utf8');return {ok:true,json:async()=>JSON.parse(value),text:async()=>value}}catch{return {ok:false}}}});
vm.runInContext(await fs.readFile(new URL('strategy.js',root),'utf8'),context);
vm.runInContext(await fs.readFile(new URL('compare.js',root),'utf8'),context);
vm.runInContext(await fs.readFile(new URL('workspace.js',root),'utf8'),context);
await vm.runInContext(await fs.readFile(new URL('app.js',root),'utf8'),context);
const page={
 open:async()=>{},
 wait:async selector=>{if(!document.querySelector(selector))throw Error('Missing '+selector)},
 eval:async fn=>vm.runInContext(typeof fn==='function'?`(${fn.toString()})()`:fn,context),
 click:async selector=>{const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector);el.click()},
 fill:async(selector,value)=>{const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new window.Event('input',{bubbles:true}))}
};
// Adapt browser source URL assertion: linkedom returns the literal href, which is already absolute.
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
await new AsyncFunction('page',await fs.readFile(new URL('browser-test.js',root),'utf8'))(page);
await new AsyncFunction('page',await fs.readFile(new URL('compare-test.js',root),'utf8'))(page);
await new AsyncFunction('page',await fs.readFile(new URL('workspace-test.js',root),'utf8'))(page);
console.log('DOM-only checks; layout and real browser behavior are not certified.');
