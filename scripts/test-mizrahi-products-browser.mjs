// Entirely synthetic local DOM fixture; never connects to a bank.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { readMizrahiProducts } from '../src/scrapers/mizrahi-products.ts';
import f from '../src/scrapers/fixtures/mizrahi-products.ts';
const browser=await puppeteer.launch({executablePath:process.env.CHROMIUM_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
 const page=await browser.newPage();
 await page.setContent('<a href="#mortgage">הלוואות ומשכנתאות</a><a id="mainMenu" href="/OnlineApp/hs/legacy/root-main-hs-myDeposits">פיקדונות וחסכונות</a><iframe></iframe>');
 const mortgage=`<div class="sky-mash-header">Synthetic header</div><div class="sky-maslolim"><table><thead><tr>${f.mortgage.headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${f.mortgage.rows.map(r=>`<tr role="button">${r.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
 const deposits=`<div class="sky-my-deposits"><li class="active">הכל (2)</li><table hidden><tr><th>צברת עד כה</th></tr></table><ul>${f.deposits.records.map(r=>`<li class="deposit-cube">${Object.entries(r.fields).map(([k,v])=>`<div class="sky-deposit-details"><div>${k}</div><div>${v}</div></div>`).join('')}</li>`).join('')}</ul></div>`;
 await page.evaluate(({mortgage,deposits})=>document.querySelectorAll('a').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();document.querySelector('iframe').srcdoc=a.id?deposits:mortgage;})),{mortgage,deposits});
 const result=await readMizrahiProducts(page);
 assert.equal(result.mortgage?.tracks.length,6);assert.equal(result.deposits?.records.length,2);
 assert.equal(result.deposits.records[0].valuation,12356.78);assert.equal(result.mortgage.accountBinding,null);
 await page.$eval('iframe',e=>e.style.visibility='hidden');
 const hidden=await readMizrahiProducts(page);
 assert.equal(hidden.mortgage,null);assert.equal(hidden.deposits,null);
 await page.$eval('iframe',e=>e.style.visibility='visible');
 await page.evaluate(html=>{const hidden=document.createElement('iframe');hidden.style.visibility='hidden';hidden.srcdoc=html;document.body.append(hidden);},mortgage+deposits);
 const mixed=await readMizrahiProducts(page);
 assert.equal(mixed.mortgage?.tracks.length,6);assert.equal(mixed.deposits?.records.length,2);
 await page.$eval('iframe',e=>{const wrapper=document.createElement('div');wrapper.style.display='none';e.before(wrapper);wrapper.append(e);});
 const ancestorHidden=await readMizrahiProducts(page);
 assert.equal(ancestorHidden.mortgage,null);assert.equal(ancestorHidden.deposits,null);
 console.log('PASS hidden frame/ancestor unavailable; visible frame selected beside conflicting hidden source');
 console.log('PASS synthetic browser: content-selected iframe, six tracks, two visible cards, hidden template ignored, precise valuation, no account binding');
} finally {await browser.close();}
