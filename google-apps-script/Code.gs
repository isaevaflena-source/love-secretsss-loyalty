const SPREADSHEET_ID = 'PASTE_SPREADSHEET_ID_HERE';
const BRIDGE_SECRET = 'SET_A_LONG_RANDOM_SECRET_HERE';
const TAB_NAME = 'Операции';
const NOTIFICATION_TAB = 'Уведомления';

function json(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return json({ ok: false, error: 'Method not allowed' });
}
function rows(sheet) {
  const last = sheet.getLastRow();
  return last < 2 ? [] : sheet.getRange(2, 1, last - 1, 10).getValues()
    .filter(row => row[1] && row[8])
    .map(row => [normalDate(row[0]), normalPhone(row[1]) || String(row[1]), ...row.slice(2)]);
}
function normalDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value, 'Europe/Moscow', 'yyyy-MM-dd HH:mm:ss');
  const text = String(value || '');
  if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:?\d\d)$/.test(text)) {
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, 'Europe/Moscow', 'yyyy-MM-dd HH:mm:ss');
  }
  return text;
}
function normalPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '7' + digits;
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  return digits.length === 11 && digits[0] === '7' ? '+' + digits : null;
}
function validName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  const parts = name.split(' ');
  return name.length <= 120 && parts.length >= 2 && parts.every(part => /^[\p{L}][\p{L}'’-]{1,}$/u.test(part)) ? name : null;
}
function operationMs(value) {
  const parsed = Date.parse(String(value || '').trim().replace(' ', 'T') + '+03:00');
  return Number.isFinite(parsed) ? parsed : 0;
}
function pointAvailability(clientRows) {
  const now = Date.now();
  let total = 0, matured = 0, redeemed = 0;
  for (const row of clientRows) {
    if (row[2] === 'Начисление') {
      const points = Number(row[4] || 0);
      total += points;
      if (operationMs(row[0]) + 86400000 <= now) matured += points;
    } else if (row[2] === 'Списание') redeemed += Number(row[5] || 0);
  }
  const balance = Math.max(0, total - redeemed);
  return { balance, available: Math.max(0, Math.min(balance, matured - redeemed)) };
}
function notificationSheet(book) {
  let sheet = book.getSheetByName(NOTIFICATION_TAB);
  if (!sheet) {
    sheet = book.insertSheet(NOTIFICATION_TAB);
    sheet.appendRow(['ID', 'Дата и время', 'Уровень', 'Категория', 'Заголовок', 'Текст']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
function notificationRows(book) {
  const sheet = notificationSheet(book);
  const last = sheet.getLastRow();
  return last < 2 ? [] : sheet.getRange(2, 1, last - 1, 6).getValues().filter(row => row[0] && row[4]);
}
function appendNotification(book, payload) {
  const id = String(payload.id || '');
  const target = String(payload.target || '');
  const category = String(payload.category || '');
  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  if (!/^[a-f0-9-]{36}$/.test(id) || !['all', 'lady', 'princess', 'queen', 'empress'].includes(target) || !['arrivals', 'news', 'gift'].includes(category) || !title || title.length > 80 || !body || body.length > 500) return { ok: false, error: 'Некорректное уведомление.' };
  const sheet = notificationSheet(book);
  const existing = notificationRows(book).find(row => row[0] === id);
  if (existing) return { ok: true, duplicate: true, notification: toNotification(existing) };
  const row = [id, Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd HH:mm:ss'), target, category, title, body];
  sheet.appendRow(row);
  SpreadsheetApp.flush();
  return { ok: true, notification: toNotification(row) };
}
function toNotification(row) {
  return { id: String(row[0]), date: String(row[1]), target: String(row[2]), category: String(row[3]), title: String(row[4]), body: String(row[5]) };
}
function append(sheet, payload) {
  const all = rows(sheet);
  const id = String(payload.id || '');
  if (!/^[a-f0-9-]{36}$/.test(id)) return { ok: false, error: 'Некорректный ID операции.' };
  const duplicate = all.find(row => row[8] === id);
  if (duplicate) return { ok: true, duplicate: true, operation: toOperation(duplicate) };
  const phone = normalPhone(payload.phone);
  if (!phone) return { ok: false, error: 'Некорректный телефон.' };
  const clientRows = all.filter(row => String(row[1]) === phone);
  const priorName = clientRows.find(row => row[9])?.[9];
  const name = priorName || validName(payload.name);
  if (!name) return { ok: false, error: 'Для нового клиента укажите фамилию и имя.' };
  const balance = clientRows.reduce((sum, row) => sum + Number(row[4] || 0) - Number(row[5] || 0), 0);
  let purchase = 0, accrued = 0, redeemed = 0, type;
  if (payload.type === 'accrue') {
    type = 'Начисление';
    const input = String(payload.amount || '').replace(/\s/g, '');
    if (!/^\d{1,9}([.,]\d{1,2})?$/.test(input)) return { ok: false, error: 'Введите корректную сумму покупки.' };
    purchase = Number(input.replace(',', '.'));
    if (purchase <= 0 || purchase > 100000000) return { ok: false, error: 'Некорректная сумма покупки.' };
    accrued = Math.floor(purchase * .10 + 1e-9);
    if (!accrued) return { ok: false, error: 'С этой суммы начислится 0 баллов. Увеличьте сумму покупки.' };
  } else if (payload.type === 'redeem') {
    type = 'Списание';
    redeemed = Number(payload.points);
    if (!Number.isSafeInteger(redeemed) || redeemed < 1) return { ok: false, error: 'Введите целое число баллов.' };
    const availability = pointAvailability(clientRows);
    if (redeemed > availability.balance) return { ok: false, error: 'Недостаточно баллов. На счёте ' + availability.balance + '.' };
    if (redeemed > availability.available) return { ok: false, error: 'Доступно к списанию ' + availability.available + ' баллов. Новые баллы станут доступны через 24 часа после начисления.' };
  } else return { ok: false, error: 'Некорректный тип операции.' };
  const date = Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd HH:mm:ss');
  const after = balance + accrued - redeemed;
  const staff = String(payload.staff || 'Кассир').slice(0, 80);
  const row = [date, phone, type, purchase, accrued, redeemed, after, staff, id, name];
  sheet.appendRow(row);
  sheet.getRange(sheet.getLastRow(), 2).setNumberFormat('@').setRichTextValue(SpreadsheetApp.newRichTextValue().setText(phone).build());
  SpreadsheetApp.flush();
  return { ok: true, operation: toOperation(row) };
}
function toOperation(row) {
  return { date: String(row[0] || ''), phone: String(row[1] || ''), type: String(row[2] || ''), purchase: Number(row[3] || 0), accrued: Number(row[4] || 0), redeemed: Number(row[5] || 0), balanceAfter: Number(row[6] || 0), staff: String(row[7] || ''), id: String(row[8] || ''), name: String(row[9] || '') };
}
function doPost(e) {
  let lock;
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.secret !== BRIDGE_SECRET) return json({ ok: false, error: 'Access denied' });
    const book = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = book.getSheetByName(TAB_NAME);
    if (!sheet) return json({ ok: false, error: 'Реестр не найден.' });
    if (body.action === 'read') return json({ ok: true, values: rows(sheet) });
    if (body.action === 'notifications_read') return json({ ok: true, values: notificationRows(book) });
    if (!['append', 'notifications_append'].includes(body.action)) return json({ ok: false, error: 'Unknown action' });
    lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return json({ ok: false, error: 'Система занята. Повторите через несколько секунд.' });
    return json(body.action === 'append' ? append(sheet, body.payload || {}) : appendNotification(book, body.payload || {}));
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) });
  } finally {
    if (lock) lock.releaseLock();
  }
}
