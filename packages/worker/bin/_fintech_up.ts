import { chromePage } from '../src/chrome.ts';
const [m, sel, p] = process.argv.slice(2);
const page = await chromePage(m);
await page.setInputFiles(sel, p);
console.log('uploaded', sel);
process.exit(0);
