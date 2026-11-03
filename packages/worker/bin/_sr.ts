import { chromePage } from '../src/chrome.ts';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { loadAnswers } from '@apply-fleet/data';
const pdf = process.argv[2];
const p = await chromePage('smartrecruiters.com');
const find = `function F(id){var r=null;function w(root){[].forEach.call(root.querySelectorAll('*'),function(x){if(x.id===id&&/^(INPUT|TEXTAREA)$/.test(x.tagName))r=x;if(x.shadowRoot)w(x.shadowRoot)})}w(document);return r}`;
const b64 = readFileSync(pdf).toString('base64');
// upload done separately

const a = loadAnswers(resolvePath(import.meta.dirname, '../../../config/answers.yml')) as any;
const c = a.contact;
const vals: Record<string,string> = {'first-name-input':a.identity.first_name,'last-name-input':a.identity.last_name,'email-input':c.email,'confirm-email-input':c.email,'spl-form-element_10':c.city,'spl-form-element_5':String(c.phone).replace(/\D/g,''),'linkedin-input':c.linkedin,'website-input':c.github};
console.log(await p.evaluate(`(function(){${find};var V=${JSON.stringify(vals)};var o=[];Object.keys(V).forEach(function(id){var e=F(id);if(!e){o.push('MISS '+id);return}if(e.value!==V[id]){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,V[id]);['input','change','blur'].forEach(function(t){e.dispatchEvent(new Event(t,{bubbles:true,composed:true}))})}o.push(id+'='+e.value)});return o.join('\\n')})()`));
