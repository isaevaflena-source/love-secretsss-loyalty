const sheetUrl = 'https://docs.google.com/spreadsheets/d/1AxD2EY_KRoao1OoXSUDCWY6SU2es0pmSp9mXDf_NNQw/edit';
document.querySelectorAll('.sheet-link').forEach(a => { a.href = sheetUrl; });
const $ = id => document.getElementById(id);
const fmt = value => new Intl.NumberFormat('ru-RU').format(value || 0);
let operations = [];
let stats = { balances: {} };
let access = null;
let type = 'accrue';
let activePhone = '';
let pendingId = null;
let lookupTimer = null;
let deferredInstall = null;
let latestNotifications = [];

function phone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '7' + digits;
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  return digits.length === 11 && digits[0] === '7' ? '+' + digits : null;
}
function pretty(value) {
  const canonical = phone(value);
  return canonical ? '+7 (' + canonical.slice(2, 5) + ') ' + canonical.slice(5, 8) + '-' + canonical.slice(8, 10) + '-' + canonical.slice(10) : String(value || '');
}
function message(text, kind = '') {
  $('message').textContent = text;
  $('message').className = 'message ' + kind;
}
function operationTime(value) {
  const parsed = Date.parse(String(value || '').trim().replace(' ', 'T') + '+03:00');
  return Number.isFinite(parsed) ? parsed : 0;
}
function pointAvailability(client) {
  const now = Date.now();
  let matured = 0, redeemed = 0, nextUnlockAt = 0;
  for (const row of operations.filter(r => r.phone === client)) {
    if (row.type === 'Начисление') {
      const unlock = operationTime(row.date) + 86400000;
      if (unlock <= now) matured += row.accrued;
      else if (!nextUnlockAt || unlock < nextUnlockAt) nextUnlockAt = unlock;
    } else if (row.type === 'Списание') redeemed += row.redeemed;
  }
  const balance = currentBalance(client);
  const available = Math.max(0, Math.min(balance, matured - redeemed));
  return { available, pending: balance - available, nextUnlockAt };
}
function currentBalance(client) {
  return stats.balances?.[client] || 0;
}
function totalSpent(client) {
  return operations.filter(r => r.phone === client && r.type === 'Начисление').reduce((sum, r) => sum + r.purchase, 0);
}
function tierFor(total) {
  if (total >= 30000) return { key: 'empress', name: 'Императрица', rate: .10, next: 0, phrase: 'Ваше величие заслуживает особенного.' };
  if (total >= 15000) return { key: 'queen', name: 'Королева', rate: .10, next: 30000, phrase: 'Выбирайте себя каждый день.' };
  if (total >= 5000) return { key: 'princess', name: 'Принцесса', rate: .10, next: 15000, phrase: 'Ваша сказка только начинается.' };
  return { key: 'lady', name: 'Леди', rate: .10, next: 5000, phrase: 'Ваше очарование — уже повод для праздника.' };
}
function showPage(page) {
  if (access === 'cashier' && page !== 'cash') return;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === page));
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-page]').forEach(button => { button.onclick = () => showPage(button.dataset.page); });
document.querySelectorAll('[data-type]').forEach(button => {
  button.onclick = () => {
    type = button.dataset.type;
    document.querySelectorAll('[data-type]').forEach(item => item.classList.toggle('active', item === button));
    $('accrue-fields').hidden = type !== 'accrue';
    $('redeem-fields').hidden = type !== 'redeem';
    $('submit').textContent = type === 'accrue' ? 'Начислить баллы' : 'Списать баллы';
    message('');
    preview();
  };
});
function preview() {
  const amount = Number($('amount').value.replace(/\s/g, '').replace(',', '.'));
  const reached = tierFor(totalSpent(activePhone) + Math.max(0, amount));
  $('preview-points').textContent = fmt(amount > 0 ? Math.floor(amount * reached.rate + 1e-9) : 0) + ' баллов';
  $('preview-rate').textContent = `Начисление 10% · уровень после покупки: ${reached.name.toLowerCase()}. Новые баллы доступны через 24 часа.`;
  const balance = currentBalance(activePhone);
  const availability = pointAvailability(activePhone);
  const points = Number($('points').value || 0);
  $('preview-balance').textContent = activePhone ? fmt(Math.max(0, balance - points)) + ' баллов' : '—';
  $('redeem-lock').textContent = points > balance ? 'Нельзя списать больше текущего баланса.' : points > availability.available ? `Доступно сейчас: ${fmt(availability.available)}. Новые баллы откроются через 24 часа после начисления.` : availability.pending ? `Доступно сейчас: ${fmt(availability.available)}. В ожидании: ${fmt(availability.pending)}.` : `Доступно сейчас: ${fmt(availability.available)} баллов.`;
  $('submit').disabled = type === 'redeem' && !!activePhone && (points > availability.available || availability.available === 0);
}
$('amount').oninput = () => { pendingId = null; preview(); };
$('points').oninput = () => { pendingId = null; preview(); };
$('client-name-input').oninput = () => { pendingId = null; };
function renderClient() {
  activePhone = phone($('phone').value) || '';
  const known = operations.find(row => row.phone === activePhone && row.name)?.name || '';
  $('client-name-label').textContent = known || 'Баланс клиента';
  $('name-wrap').hidden = !activePhone || !!known;
  $('balance').textContent = activePhone ? fmt(currentBalance(activePhone)) : '—';
  const availability = pointAvailability(activePhone);
  $('balance-status').textContent = activePhone && known ? `Доступно к списанию: ${fmt(availability.available)} · ожидают 24 часа: ${fmt(availability.pending)}` : '';
  const tier = tierFor(totalSpent(activePhone));
  $('level-line').textContent = activePhone && known ? `${tier.name} · покупок на ${fmt(totalSpent(activePhone))} ₽` : '';
  const rows = operations.filter(row => row.phone === activePhone).reverse().slice(0, 8);
  $('client-count').textContent = rows.length + ' операций';
  const box = $('client-history');
  box.replaceChildren();
  if (!activePhone || !rows.length) {
    box.className = 'empty';
    box.textContent = activePhone ? 'Пока нет операций. Начните с первой покупки.' : 'Введите корректный номер телефона.';
    preview();
    return;
  }
  box.className = '';
  for (const row of rows) {
    const item = document.createElement('div'); item.className = 'history-item';
    const left = document.createElement('div');
    const label = document.createElement('b'); label.textContent = row.type;
    const date = document.createElement('small'); date.textContent = row.date;
    left.append(label, date);
    const value = document.createElement('strong');
    value.className = row.type === 'Списание' ? 'negative' : '';
    value.textContent = (row.type === 'Списание' ? '-' : '+') + fmt(row.type === 'Списание' ? row.redeemed : row.accrued);
    item.append(left, value); box.append(item);
  }
  preview();
}
async function lookup() {
  const client = phone($('phone').value);
  if (!client) { renderClient(); return; }
  $('phone').value = pretty(client);
  if (access === 'cashier') {
    try {
      const response = await fetch('/api/customer?phone=' + encodeURIComponent(client), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Не удалось найти клиента.');
      if (phone($('phone').value) !== client) return;
      operations = data.operations || [];
      stats = data.stats || { balances: {} };
      message('');
    } catch (error) { message(error.message, 'error'); return; }
  }
  renderClient();
}
$('find').onclick = lookup;
$('phone').onkeydown = event => { if (event.key === 'Enter') lookup(); };
$('phone').oninput = () => {
  pendingId = null;
  clearTimeout(lookupTimer);
  if (access === 'cashier') { operations = []; stats = { balances: {} }; }
  renderClient();
  if (phone($('phone').value)) lookupTimer = setTimeout(lookup, 400);
};
function periodRows() {
  const from = $('date-from').value, to = $('date-to').value;
  return operations.filter(row => { const day = row.date.slice(0, 10); return (!from || day >= from) && (!to || day <= to); });
}
function renderStats() {
  const rows = periodRows();
  const values = {
    purchases: rows.filter(row => row.type === 'Начисление').length,
    customers: new Set(rows.map(row => row.phone)).size,
    accrued: rows.reduce((sum, row) => sum + row.accrued, 0),
    redeemed: rows.reduce((sum, row) => sum + row.redeemed, 0),
    sales: rows.reduce((sum, row) => sum + row.purchase, 0),
    balance: stats.balance || 0
  };
  for (const [key, id] of [['purchases', 's-purchases'], ['customers', 's-customers'], ['accrued', 's-accrued'], ['redeemed', 's-redeemed'], ['balance', 's-balance']]) $(id).textContent = fmt(values[key]);
  $('s-sales').textContent = fmt(values.sales) + ' ₽';
  renderClients(rows);
}
function renderClients(rows) {
  const phones = [...new Set(rows.map(row => row.phone))];
  const body = $('client-rows'); body.replaceChildren();
  if (!phones.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 5; td.className = 'empty'; td.textContent = 'За выбранный период клиентов нет';
    tr.append(td); body.append(tr); return;
  }
  for (const client of phones.sort()) {
    const name = operations.find(row => row.phone === client && row.name)?.name || 'ФИО не указано';
    const tr = document.createElement('tr');
    [name, pretty(client), tierFor(totalSpent(client)).name, fmt(currentBalance(client)), String(rows.filter(row => row.phone === client).length)].forEach(value => {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    });
    body.append(tr);
  }
}
$('date-from').onchange = renderStats;
$('date-to').onchange = renderStats;
$('clear-dates').onclick = () => { $('date-from').value = ''; $('date-to').value = ''; renderStats(); };
function renderRows() {
  const query = $('filter').value.replace(/\D/g, '');
  const rows = operations.filter(row => !query || row.phone.replace(/\D/g, '').includes(query)).reverse().slice(0, 250);
  const body = $('rows'); body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 8; td.className = 'empty'; td.textContent = query ? 'Ничего не найдено' : 'Операций пока нет';
    tr.append(td); body.append(tr); return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    const cells = [row.date, pretty(row.phone), row.name || '—', row.type, row.purchase ? fmt(row.purchase) + ' ₽' : '—', (row.type === 'Списание' ? '-' : '+') + fmt(row.type === 'Списание' ? row.redeemed : row.accrued), fmt(row.balanceAfter), row.staff];
    cells.forEach((value, index) => {
      const td = document.createElement('td');
      if (index === 3) { const tag = document.createElement('span'); tag.className = 'tag' + (row.type === 'Списание' ? ' redeem' : ''); tag.textContent = value; td.append(tag); }
      else td.textContent = value;
      tr.append(td);
    });
    body.append(tr);
  }
}
$('filter').oninput = renderRows;
async function load() {
  if (access === 'owner') {
    try {
      const response = await fetch('/api/data', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Не удалось загрузить данные.');
      operations = data.operations || [];
      stats = data.stats || { balances: {} };
      renderStats(); renderRows(); renderClient(); await loadNotifications();
    } catch (error) { message(error.message, 'error'); }
  } else if (access === 'client') await loadClient();
  else if (phone($('phone').value)) await lookup();
  else renderClient();
}
function notificationItem(n, owner = false) {
  const item = document.createElement('div'); item.className = 'notification-item';
  const content = document.createElement('div');
  const date = document.createElement('small'); date.textContent = n.date + ' · ' + ({ arrivals: 'Новинки', news: 'Новости', gift: 'Подарок' }[n.category] || 'Новости');
  const title = document.createElement('h3'); title.textContent = n.title;
  const body = document.createElement('p'); body.textContent = n.body;
  content.append(date, title, body); item.append(content);
  if (owner) { const target = document.createElement('span'); target.className = 'notification-target'; target.textContent = ({ all: 'Всем', lady: 'Леди', princess: 'Принцессам', queen: 'Королевам', empress: 'Императрицам' }[n.target] || n.target); item.append(target); }
  return item;
}
function renderOwnerNotifications() {
  const box = $('owner-notice-list'); box.replaceChildren(); box.className = '';
  if (!latestNotifications.length) { box.className = 'empty'; box.textContent = 'Сообщений пока нет.'; return; }
  latestNotifications.forEach(n => box.append(notificationItem(n, true)));
}
function audienceCount(target) {
  const clients = [...new Set(operations.map(r => r.phone))];
  return target === 'all' ? clients.length : clients.filter(client => tierFor(totalSpent(client)).key === target).length;
}
function renderAudience() {
  const count = audienceCount($('notice-target').value);
  const word = count % 10 === 1 && count % 100 !== 11 ? 'клиент' : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'клиента' : 'клиентов';
  $('notice-audience').textContent = `Сейчас увидят: ${count} ${word}. Сообщение также появится у тех, кто позже достигнет выбранного уровня. Для приоритетного анонса отправьте новость Императрицам раньше общей публикации.`;
}
$('notice-target').onchange = renderAudience;
async function loadNotifications() {
  const response = await fetch('/api/notifications', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Не удалось загрузить уведомления.');
  latestNotifications = data.notifications || [];
  renderOwnerNotifications(); renderAudience();
}
$('notice-form').onsubmit = async event => {
  event.preventDefault();
  $('notice-message').textContent = '';
  const payload = { target: $('notice-target').value, category: $('notice-category').value, title: $('notice-title').value, body: $('notice-body').value };
  const button = $('notice-form').querySelector('button[type="submit"]'); button.disabled = true;
  try {
    const response = await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Не удалось опубликовать уведомление.');
    $('notice-title').value = ''; $('notice-body').value = '';
    await loadNotifications();
    $('notice-message').textContent = 'Опубликовано. Клиенты увидят сообщение в своём кабинете.';
    $('notice-message').className = 'message ok';
  } catch (error) { $('notice-message').textContent = error.message; $('notice-message').className = 'message error'; }
  finally { button.disabled = false; }
};
function renderWallet(data) {
  const p = data.profile, t = p.tier;
  $('card-name').textContent = p.name;
  $('card-tier').textContent = t.name;
  $('welcome-name').textContent = p.name ? `Для вас, ${p.name}` : 'Добро пожаловать';
  $('wallet-balance').replaceChildren(document.createTextNode(fmt(p.balance) + ' '));
  const unit = document.createElement('span'); unit.textContent = 'баллов'; $('wallet-balance').append(unit);
  $('wallet-rate').textContent = `${Math.round(t.rate * 100)}% от покупки возвращаются баллами. 1 балл = 1 ₽.`;
  $('wallet-available').textContent = `Доступно к списанию: ${fmt(p.available)} баллов.`;
  $('wallet-pending').textContent = p.pending ? `${fmt(p.pending)} баллов ожидают 24 часа после покупки${p.nextUnlockAt ? '. Ближайшее начисление откроется ' + new Date(p.nextUnlockAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) + ' МСК' : ''}.` : 'Все начисленные баллы доступны к списанию.';
  $('wallet-gift').textContent = t.key === 'empress' ? 'Ваше преимущество: гарантированный подарок от бренда каждый месяц и приоритетные новости о новинках.' : tierFor(p.spent).phrase;
  $('wallet-progress').textContent = `Общая сумма покупок: ${fmt(p.spent)} ₽`;
  const previous = t.key === 'lady' ? 0 : t.key === 'princess' ? 5000 : t.key === 'queen' ? 15000 : 30000;
  $('wallet-progress-bar').style.width = t.next ? Math.min(100, Math.max(0, (p.spent - previous) / (t.next - previous) * 100)) + '%' : '100%';
  $('wallet-next').textContent = t.next ? `До уровня «${tierFor(t.next).name}» осталось покупок на ${fmt(t.next - p.spent)} ₽.` : 'Вы на вершине клуба Love secretsss. Наслаждайтесь особенным вниманием.';
  const notices = $('wallet-notifications'); notices.replaceChildren(); notices.className = '';
  $('wallet-notice-count').textContent = (data.notifications || []).length + ' сообщений';
  if (!(data.notifications || []).length) { notices.className = 'empty'; notices.textContent = 'Новостей пока нет. Скоро здесь будет что-то прекрасное.'; }
  else data.notifications.forEach(n => notices.append(notificationItem(n)));
}
async function loadClient() {
  try {
    const response = await fetch('/api/client-data', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Не удалось открыть карту.');
    renderWallet(data);
  } catch (error) { $('wallet-notifications').textContent = error.message; }
}
$('submit').onclick = async () => {
  if (access === 'cashier') await lookup();
  else renderClient();
  if (!activePhone) { message('Введите корректный номер телефона.', 'error'); $('phone').focus(); return; }
  if (!$('name-wrap').hidden && !$('client-name-input').value.trim()) { message('Укажите ФИО нового клиента.', 'error'); $('client-name-input').focus(); return; }
  if (type === 'redeem' && Number($('points').value || 0) > currentBalance(activePhone)) { message('Нельзя списать больше текущего баланса.', 'error'); return; }
  if (type === 'redeem' && Number($('points').value || 0) > pointAvailability(activePhone).available) { message('Новые баллы можно потратить через 24 часа после начисления.', 'error'); return; }
  if (!pendingId) pendingId = crypto.randomUUID();
  const payload = { id: pendingId, phone: activePhone, name: $('client-name-input').value, type, amount: $('amount').value.replace(/\s/g, ''), points: $('points').value };
  const button = $('submit'); button.disabled = true; button.textContent = 'Сохраняем…'; message('');
  try {
    const response = await fetch('/api/operation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) { if (!data.uncertain) pendingId = null; throw Error(data.error || 'Операция не проведена'); }
    pendingId = null; $('amount').value = ''; $('points').value = ''; $('client-name-input').value = '';
    await load();
    message(data.duplicate ? 'Операция уже записана.' : 'Операция проведена. Баланс обновлён.', 'ok');
  } catch (error) { message(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = type === 'accrue' ? 'Начислить баллы' : 'Списать баллы'; preview(); }
};
function applyRole(roleName) {
  access = roleName;
  $('login-screen').hidden = !!access;
  $('staff-app').hidden = !access || access === 'client';
  $('client-app').hidden = access !== 'client';
  const cashier = access === 'cashier';
  document.querySelectorAll('[data-page="registry"], [data-page="analytics"], [data-page="notifications"], .sheet-link').forEach(node => { node.hidden = cashier; });
  $('role-label').textContent = cashier ? 'Кассир' : 'Фатима · Владелец';
  $('logout').hidden = !access || access === 'client';
  if (cashier) showPage('cash');
}
$('choose-client').onclick = () => { $('client-login-form').hidden = false; $('login-form').hidden = true; $('choose-client').classList.add('active'); $('choose-staff').classList.remove('active'); $('login-message').textContent = ''; };
$('choose-staff').onclick = () => { $('client-login-form').hidden = true; $('login-form').hidden = false; $('choose-staff').classList.add('active'); $('choose-client').classList.remove('active'); $('login-message').textContent = ''; };
$('client-login-form').onsubmit = async event => {
  event.preventDefault(); $('login-message').textContent = '';
  try {
    const response = await fetch('/api/client-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: $('client-login-phone').value }) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Не удалось открыть карту.');
    applyRole('client'); await loadClient();
  } catch (error) { $('login-message').textContent = error.message; }
};
$('login-form').onsubmit = async event => {
  event.preventDefault();
  $('login-message').textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('login-user').value, password: $('login-password').value }) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Не удалось войти.');
    $('login-password').value = '';
    applyRole(data.role);
    await load();
  } catch (error) { $('login-message').textContent = error.message; }
};
$('logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); applyRole(null); operations = []; stats = { balances: {} }; };
$('client-logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); applyRole(null); };
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; });
$('install-card').onclick = async () => {
  if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; }
  else $('install-help').textContent = /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'В Safari нажмите «Поделиться», затем «На экран Домой».' : 'В меню браузера выберите «Установить приложение» или «Добавить на главный экран».';
};
$('share-card').onclick = async () => {
  try { await navigator.clipboard.writeText(location.origin); $('install-help').textContent = 'Ссылка скопирована. Клиенту достаточно открыть её и ввести свой номер телефона.'; }
  catch { $('install-help').textContent = location.origin; }
};
async function start() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store' });
    const data = await response.json();
    applyRole(data.role);
    if (data.role) await load();
    if (new URL(location.href).searchParams.has('client')) $('client-login-phone').value = new URL(location.href).searchParams.get('client');
  } catch (error) { $('login-screen').hidden = false; $('login-message').textContent = 'Не удалось проверить доступ. Обновите страницу.'; }
}
start();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
setInterval(() => { if (access === 'cashier' || access === 'owner') { if (activePhone) { renderClient(); } } else if (access === 'client') loadClient(); }, 60000);
