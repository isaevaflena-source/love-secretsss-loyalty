const page = __PAGE_HTML__;
const iconSvg = __ICON_SVG__;
const icon192 = __ICON_192__;
const icon512 = __ICON_512__;
const manifest = { name: 'Love secretsss · Карта лояльности', short_name: 'Love secretsss', description: 'Баллы, уровни и новости клуба Love secretsss', start_url: '/', scope: '/', display: 'standalone', background_color: '#fffafa', theme_color: '#5a102a', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] };
const serviceWorker = `const CACHE='love-secretsss-v2';self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/','/icon-192.png','/icon-512.png'])).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>caches.match('/')))});`;

function cookie(request, key) {
  return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(key + '='))?.slice(key.length + 1) || '';
}
async function signature(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(signed)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function role(request, env) {
  const value = cookie(request, 'loyalty_session');
  const [kind, expires, nonce, mac] = value.split('.');
  if (!['owner', 'cashier'].includes(kind) || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^\d{13}$/.test(expires || '') || Number(expires) < Date.now() || !env.SESSION_SECRET || !mac) return null;
  const expected = await signature(`${kind}.${expires}.${nonce}`, env.SESSION_SECRET);
  return safeEqual(mac, expected) ? kind : null;
}
async function clientPhone(request, env) {
  const value = cookie(request, 'loyalty_client');
  const [digits, expires, nonce, mac] = value.split('.');
  if (!/^7\d{10}$/.test(digits || '') || !/^\d{13}$/.test(expires || '') || Number(expires) < Date.now() || !/^[a-f0-9]{32}$/.test(nonce || '') || !env.SESSION_SECRET || !mac) return null;
  const expected = await signature(`client.${digits}.${expires}.${nonce}`, env.SESSION_SECRET);
  return safeEqual(mac, expected) ? `+${digits}` : null;
}
async function loginRoute(request, env) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply({ error: 'Запрос с другой страницы отклонён.' }, 403);
  let body;
  try { body = await request.json(); } catch { return reply({ error: 'Некорректный запрос.' }, 400); }
  const username = String(body.username || '').trim().toLowerCase();
  const kind = username === 'кассир' ? 'cashier' : ['фатима', 'fdibirova06@gmail.com'].includes(username) ? 'owner' : null;
  const expectedPassword = kind === 'owner' ? env.OWNER_PASSWORD : env.CASHIER_PASSWORD;
  if (!kind || !expectedPassword || !env.SESSION_SECRET || !safeEqual(String(body.password || ''), expectedPassword)) return reply({ error: 'Неверное имя или пароль.' }, 401);
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
  const value = `${kind}.${expires}.${nonce}`;
  const mac = await signature(value, env.SESSION_SECRET);
  const response = reply({ role: kind });
  response.headers.set('Set-Cookie', `loyalty_session=${value}.${mac}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`);
  response.headers.append('Set-Cookie', 'loyalty_client=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
  return response;
}

function reply(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
async function bridge(env, action, payload) {
  if (!env.BRIDGE_URL || !env.BRIDGE_SECRET) throw new Error('Связь с реестром не настроена.');
  const response = await fetch(env.BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.BRIDGE_SECRET, action, payload }), redirect: 'follow' });
  if (!response.ok) throw new Error('Google Таблица временно недоступна.');
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Не удалось выполнить операцию с таблицей.');
  return data;
}
function phone(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return d.length === 11 && d[0] === '7' ? '+' + d : null;
}
async function read(env) {
  const data = await bridge(env, 'read');
  if (!Array.isArray(data.values)) throw new Error('Не удалось прочитать реестр операций.');
  return data.values.filter(r => r[1] && r[8]).map(r => ({
    date: String(r[0] || ''), phone: String(r[1]), type: String(r[2] || ''),
    purchase: Number(r[3] || 0), accrued: Number(r[4] || 0), redeemed: Number(r[5] || 0),
    balanceAfter: Number(r[6] || 0), staff: String(r[7] || ''), id: String(r[8]), name: String(r[9] || '')
  }));
}
function stats(rows) {
  const balances = Object.create(null);
  let purchases = 0, accrued = 0, redeemed = 0, sales = 0;
  for (const r of rows) {
    if (r.type === 'Начисление') { purchases++; sales += r.purchase; }
    accrued += r.accrued; redeemed += r.redeemed;
    balances[r.phone] = (balances[r.phone] || 0) + r.accrued - r.redeemed;
  }
  return { purchases, customers: Object.keys(balances).length, accrued, redeemed, balance: accrued - redeemed, sales, balances };
}
function tierFor(total) {
  if (total >= 30000) return { key: 'empress', name: 'Императрица', rate: 0.15, next: null };
  if (total >= 15000) return { key: 'queen', name: 'Королева', rate: 0.15, next: 30000 };
  if (total >= 5000) return { key: 'princess', name: 'Принцесса', rate: 0.10, next: 15000 };
  return { key: 'lady', name: 'Леди', rate: 0.07, next: 5000 };
}
function profile(rows, client) {
  const own = rows.filter(r => r.phone === client);
  const spent = own.reduce((sum, r) => sum + (r.type === 'Начисление' ? r.purchase : 0), 0);
  const fullName = own.find(r => r.name)?.name || '';
  return { name: fullName.split(' ')[1] || fullName.split(' ')[0] || '', spent, balance: stats(own).balance, tier: tierFor(spent) };
}
async function notifications(env) {
  const data = await bridge(env, 'notifications_read');
  if (!Array.isArray(data.values)) throw new Error('Не удалось прочитать уведомления.');
  return data.values.map(r => ({ id: String(r[0] || ''), date: String(r[1] || ''), target: String(r[2] || ''), category: String(r[3] || ''), title: String(r[4] || ''), body: String(r[5] || '') })).filter(r => r.id && r.title);
}
function nowMoscow() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const v = x => p.find(i => i.type === x)?.value || '00';
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')}`;
}
function operationTime(date) {
  const value = String(date || '').trim().replace(' ', 'T');
  const parsed = Date.parse(value + '+03:00');
  return Number.isFinite(parsed) ? parsed : 0;
}
function fullName(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  const parts = normalized.split(' ');
  return normalized.length <= 120 && parts.length >= 2 && parts.every(part => /^[\p{L}][\p{L}'’-]{1,}$/u.test(part)) ? normalized : null;
}
async function dataRoute(request, env, access) {
  if (access !== 'owner') return reply({ error: 'Только для владельца.' }, 403);
  try { const operations = await read(env); return reply({ operations, stats: stats(operations) }); }
  catch (e) { return reply({ error: e.message }, 502); }
}
async function customerRoute(request, env, access) {
  if (!access) return reply({ error: 'Войдите в систему.' }, 401);
  const client = phone(new URL(request.url).searchParams.get('phone'));
  if (!client) return reply({ error: 'Введите корректный номер телефона.' }, 400);
  try {
    const operations = (await read(env)).filter(r => r.phone === client);
    return reply({ operations, stats: stats(operations) });
  } catch (e) { return reply({ error: e.message }, 502); }
}
async function clientLoginRoute(request, env) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply({ error: 'Запрос с другой страницы отклонён.' }, 403);
  let body;
  try { body = await request.json(); } catch { return reply({ error: 'Некорректный запрос.' }, 400); }
  const client = phone(body.phone);
  if (!client) return reply({ error: 'Введите корректный номер телефона.' }, 400);
  try {
    const all = await read(env);
    if (!all.some(r => r.phone === client)) return reply({ error: 'Номер пока не найден в программе лояльности.' }, 401);
    const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
    const digits = client.slice(1);
    const mac = await signature(`client.${digits}.${expires}.${nonce}`, env.SESSION_SECRET);
    const response = reply({ role: 'client', profile: profile(all, client) });
    response.headers.append('Set-Cookie', `loyalty_client=${digits}.${expires}.${nonce}.${mac}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
    response.headers.append('Set-Cookie', 'loyalty_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    return response;
  } catch (e) { return reply({ error: e.message }, 502); }
}
async function clientDataRoute(request, env, client) {
  if (!client) return reply({ error: 'Войдите по номеру телефона.' }, 401);
  try {
    const all = await read(env);
    if (!all.some(r => r.phone === client)) return reply({ error: 'Клиент не найден.' }, 404);
    const own = profile(all, client);
    const messages = (await notifications(env)).filter(n => n.target === 'all' || n.target === own.tier.key).reverse().slice(0, 30);
    return reply({ profile: own, notifications: messages });
  } catch (e) { return reply({ error: e.message }, 502); }
}
async function notificationRoute(request, env, access) {
  if (access !== 'owner') return reply({ error: 'Только для владельца.' }, 403);
  if (request.method === 'GET') {
    try { return reply({ notifications: (await notifications(env)).reverse() }); }
    catch (e) { return reply({ error: e.message }, 502); }
  }
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply({ error: 'Запрос с другой страницы отклонён.' }, 403);
  let body;
  try { body = await request.json(); } catch { return reply({ error: 'Некорректный запрос.' }, 400); }
  const target = String(body.target || '');
  const category = String(body.category || '');
  const title = String(body.title || '').trim();
  const message = String(body.body || '').trim();
  if (!['all', 'lady', 'princess', 'queen', 'empress'].includes(target) || !['arrivals', 'news', 'gift'].includes(category) || !title || title.length > 80 || !message || message.length > 500) return reply({ error: 'Проверьте категорию, уровень, заголовок и текст уведомления.' }, 400);
  try {
    const result = await bridge(env, 'notifications_append', { id: crypto.randomUUID(), target, category, title, body: message });
    return reply({ notification: result.notification });
  } catch (e) { return reply({ error: e.message }, 502); }
}
async function writeRoute(request, env, access) {
  if (!access) return reply({ error: 'Войдите в систему.' }, 401);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply({ error: 'Запрос с другой страницы отклонён.' }, 403);
  let body;
  try { body = await request.json(); } catch { return reply({ error: 'Некорректный запрос.' }, 400); }
  const client = phone(body.phone);
  if (!client) return reply({ error: 'Введите телефон в формате +7 (999) 123-45-67.' }, 400);
  if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id)) return reply({ error: 'Некорректный ID операции.' }, 400);
  const type = body.type === 'accrue' ? 'Начисление' : body.type === 'redeem' ? 'Списание' : null;
  if (!type) return reply({ error: 'Выберите тип операции.' }, 400);
  let operations;
  try { operations = await read(env); } catch (e) { return reply({ error: e.message }, 502); }
  const old = operations.find(r => r.id === body.id);
  if (old) return reply({ operation: old, duplicate: true });
  const current = stats(operations).balances[client] || 0;
  const knownName = operations.find(r => r.phone === client && r.name)?.name;
  const name = knownName || fullName(body.name);
  if (!name) return reply({ error: 'Для нового клиента укажите фамилию и имя (при наличии — отчество).' }, 400);
  let purchase = 0, accrued = 0, redeemed = 0;
  if (type === 'Начисление') {
    const input = String(body.amount || '').replace(/\s/g, '');
    if (!/^\d{1,9}([.,]\d{1,2})?$/.test(input)) return reply({ error: 'Введите корректную сумму покупки в рублях.' }, 400);
    purchase = Number(input.replace(',', '.'));
    if (purchase <= 0 || purchase > 100000000) return reply({ error: 'Введите сумму покупки от 0,01 до 100 000 000 ₽.' }, 400);
    const priorSpend = operations.filter(r => r.phone === client && r.type === 'Начисление').reduce((sum, r) => sum + r.purchase, 0);
    accrued = Math.floor(purchase * tierFor(priorSpend + purchase).rate + 1e-9);
    if (!accrued) return reply({ error: 'С этой суммы начислится 0 баллов. Увеличьте сумму покупки.' }, 400);
  } else {
    redeemed = Number(body.points);
    if (!Number.isSafeInteger(redeemed) || redeemed < 1) return reply({ error: 'Введите целое число баллов.' }, 400);
    if (redeemed > current) return reply({ error: `Недостаточно баллов. На счёте ${current}.` }, 409);
    const latestAccrual = Math.max(0, ...operations.filter(r => r.phone === client && r.type === 'Начисление').map(r => operationTime(r.date)));
    const unlockAt = latestAccrual + 24 * 60 * 60 * 1000;
    if (latestAccrual && Date.now() < unlockAt) return reply({ error: 'Списать баллы можно через 24 часа после последнего начисления.', unlockAt: new Date(unlockAt).toISOString() }, 409);
  }
  try {
    const result = await bridge(env, 'append', { id: body.id, phone: client, name, type: body.type, amount: body.amount, points: body.points, staff: access === 'owner' ? 'Фатима' : 'Кассир' });
    return reply({ operation: result.operation, duplicate: !!result.duplicate });
  } catch (e) { return reply({ error: e.message + ' Проверьте реестр перед повтором.', uncertain: true }, 502); }
}
export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' } });
    if (request.method === 'GET' && url.pathname === '/sw.js') return new Response(serviceWorker, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    if (request.method === 'GET' && url.pathname === '/icon.svg') return new Response(iconSvg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
    if (request.method === 'GET' && ['/icon-192.png', '/icon-512.png'].includes(url.pathname)) {
      const bytes = Uint8Array.from(atob(url.pathname === '/icon-192.png' ? icon192 : icon512), x => x.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }
    if (url.pathname === '/api/login' && request.method === 'POST') return loginRoute(request, env);
    if (url.pathname === '/api/client-login' && request.method === 'POST') return clientLoginRoute(request, env);
    const access = await role(request, env);
    const client = await clientPhone(request, env);
    if (url.pathname === '/api/session' && request.method === 'GET') return reply({ role: access || (client ? 'client' : null), phone: access ? null : client });
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) return reply({ error: 'Запрос с другой страницы отклонён.' }, 403);
      const response = reply({ ok: true });
      response.headers.set('Set-Cookie', 'loyalty_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
      response.headers.append('Set-Cookie', 'loyalty_client=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
      return response;
    }
    if (url.pathname === '/api/client-data' && request.method === 'GET') return clientDataRoute(request, env, client);
    if (url.pathname === '/api/notifications' && ['GET', 'POST'].includes(request.method)) return notificationRoute(request, env, access);
    if (url.pathname === '/api/data' && request.method === 'GET') return dataRoute(request, env, access);
    if (url.pathname === '/api/customer' && request.method === 'GET') return customerRoute(request, env, access);
    if (url.pathname === '/api/operation' && request.method === 'POST') return writeRoute(request, env, access);
    if (url.pathname !== '/' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
  }
};
