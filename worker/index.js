const CONNECTOR = 'connector_5f3c8c41a1e54ad7a76272c89e2554fa';
const SHEET = '1AxD2EY_KRoao1OoXSUDCWY6SU2es0pmSp9mXDf_NNQw';
const TAB = 495510526;
const page = __PAGE_HTML__;

function reply(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
function extract(result) {
  if (result?.status !== 'success') throw new Error(result?.message || 'Google Таблица недоступна. Подключите Google Drive и повторите.');
  if (result.result?.structuredContent) return result.result.structuredContent;
  const item = result.result?.content?.find(x => x.type === 'text');
  if (item?.text) return JSON.parse(item.text);
  throw new Error('Не удалось прочитать ответ Google Таблицы.');
}
function phone(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return d.length === 11 && d[0] === '7' ? '+' + d : null;
}
async function read(ctx) {
  const binding = ctx.props?.CONNECTORS;
  if (!binding?.invoke) throw new Error('Подключение Google Drive недоступно.');
  const data = extract(await binding.invoke(CONNECTOR, 'get_spreadsheet_range', {
    spreadsheet_id: SHEET, sheet_name: 'Операции', range: 'A2:I10000', value_render_option: 'UNFORMATTED_VALUE'
  }));
  if (!Array.isArray(data.values)) throw new Error('Не удалось прочитать реестр операций.');
  return data.values.filter(r => r[1] && r[8]).map(r => ({
    date: String(r[0] || ''), phone: String(r[1]), type: String(r[2] || ''),
    purchase: Number(r[3] || 0), accrued: Number(r[4] || 0), redeemed: Number(r[5] || 0),
    balanceAfter: Number(r[6] || 0), staff: String(r[7] || ''), id: String(r[8])
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
function nowMoscow() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const v = x => p.find(i => i.type === x)?.value || '00';
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')}`;
}
async function dataRoute(request, ctx) {
  if (!request.headers.get('oai-authenticated-user-id')) return reply({ error: 'Войдите в аккаунт.' }, 401);
  try { const operations = await read(ctx); return reply({ operations, stats: stats(operations) }); }
  catch (e) { return reply({ error: e.message }, 502); }
}
async function writeRoute(request, ctx) {
  if (!request.headers.get('oai-authenticated-user-id')) return reply({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply({ error: 'Запрос с другой страницы отклонён.' }, 403);
  let body;
  try { body = await request.json(); } catch { return reply({ error: 'Некорректный запрос.' }, 400); }
  const client = phone(body.phone);
  if (!client) return reply({ error: 'Введите телефон в формате +7 (999) 123-45-67.' }, 400);
  if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id)) return reply({ error: 'Некорректный ID операции.' }, 400);
  const type = body.type === 'accrue' ? 'Начисление' : body.type === 'redeem' ? 'Списание' : null;
  if (!type) return reply({ error: 'Выберите тип операции.' }, 400);
  let operations;
  try { operations = await read(ctx); } catch (e) { return reply({ error: e.message }, 502); }
  const old = operations.find(r => r.id === body.id);
  if (old) return reply({ operation: old, duplicate: true });
  const current = stats(operations).balances[client] || 0;
  let purchase = 0, accrued = 0, redeemed = 0;
  if (type === 'Начисление') {
    const input = String(body.amount || '').replace(/\s/g, '');
    if (!/^\d{1,9}([.,]\d{1,2})?$/.test(input)) return reply({ error: 'Введите корректную сумму покупки в рублях.' }, 400);
    purchase = Number(input.replace(',', '.'));
    if (purchase <= 0 || purchase > 100000000) return reply({ error: 'Введите сумму покупки от 0,01 до 100 000 000 ₽.' }, 400);
    accrued = Math.floor(purchase * .10 + 1e-9);
    if (!accrued) return reply({ error: 'С этой суммы начислится 0 баллов. Минимальная покупка — 10 ₽.' }, 400);
  } else {
    redeemed = Number(body.points);
    if (!Number.isSafeInteger(redeemed) || redeemed < 1) return reply({ error: 'Введите целое число баллов.' }, 400);
    if (redeemed > current) return reply({ error: `Недостаточно баллов. На счёте ${current}.` }, 409);
  }
  const operation = { date: nowMoscow(), phone: client, type, purchase, accrued, redeemed, balanceAfter: current + accrued - redeemed, staff: request.headers.get('oai-authenticated-user-email') || 'Сотрудник', id: body.id };
  const cell = value => ({ userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: value } });
  try {
    extract(await ctx.props.CONNECTORS.invoke(CONNECTOR, 'batch_update_spreadsheet', {
      spreadsheet_id: SHEET,
      requests: [{ appendCells: { sheetId: TAB, rows: [{ values: [operation.date, client, type, purchase, accrued, redeemed, operation.balanceAfter, operation.staff, operation.id].map(cell) }], fields: 'userEnteredValue' } }]
    }));
    return reply({ operation });
  } catch (e) { return reply({ error: e.message + ' Проверьте реестр перед повтором.', uncertain: true }, 502); }
}
export default {
  async fetch(request, env, ctx) {
    void env;
    const url = new URL(request.url);
    if (url.pathname === '/api/data' && request.method === 'GET') return dataRoute(request, ctx);
    if (url.pathname === '/api/operation' && request.method === 'POST') return writeRoute(request, ctx);
    if (url.pathname !== '/' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
  }
};
