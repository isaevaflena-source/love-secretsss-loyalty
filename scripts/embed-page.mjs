import fs from 'node:fs/promises';
const [htmlPath, workerPath, clientPath, iconSvgPath, icon192Path, icon512Path] = process.argv.slice(2);
const [html, source, client, iconSvg, icon192, icon512] = await Promise.all([fs.readFile(htmlPath, 'utf8'), fs.readFile(workerPath, 'utf8'), fs.readFile(clientPath, 'utf8'), fs.readFile(iconSvgPath, 'utf8'), fs.readFile(icon192Path), fs.readFile(icon512Path)]);
if (!source.includes('__PAGE_HTML__')) throw new Error('Page placeholder missing');
if (!html.includes('__CLIENT_JS__')) throw new Error('Client placeholder missing');
await fs.writeFile(workerPath, source.replace('__PAGE_HTML__', JSON.stringify(html.replace('__CLIENT_JS__', client))).replace('__ICON_SVG__', JSON.stringify(iconSvg)).replace('__ICON_192__', JSON.stringify(icon192.toString('base64'))).replace('__ICON_512__', JSON.stringify(icon512.toString('base64'))));
