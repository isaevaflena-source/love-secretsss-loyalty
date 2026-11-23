import fs from 'node:fs/promises';
const [htmlPath, workerPath] = process.argv.slice(2);
const [html, source] = await Promise.all([fs.readFile(htmlPath, 'utf8'), fs.readFile(workerPath, 'utf8')]);
if (!source.includes('__PAGE_HTML__')) throw new Error('Page placeholder missing');
await fs.writeFile(workerPath, source.replace('__PAGE_HTML__', JSON.stringify(html)));
