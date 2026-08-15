'use strict';
const db = require('./db');
const config = require('./config');

const ACTIVE_STATUSES = ['preparing', 'ready'];

/**
 * 영업일 문자열(YYYY-MM-DD). 새벽 영업을 감안해 rollover 시각 이전은 전날로 친다.
 * 대기번호는 영업일마다 1번부터 다시 시작한다.
 */
function bizDay(now = Date.now()) {
  const shifted =
    now + config.timezoneOffsetMinutes * 60_000 - config.dayRolloverHour * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** 입력된 전화번호를 숫자만 남긴 국내 휴대폰 번호로 정규화한다. 형식이 틀리면 null. */
function normalizePhone(input) {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('82')) digits = '0' + digits.slice(2);
  if (!/^01[016789]\d{7,8}$/.test(digits)) return null;
  return digits;
}

/** 직원 화면에 보여줄 마스킹 번호. 뒷 4자리만 노출한다. */
function maskPhone(digits) {
  if (!digits) return null;
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

function nextTicket(day) {
  const row = db.prepare('SELECT MAX(ticket) AS max FROM orders WHERE biz_day = ?').get(day);
  const max = row && row.max ? Number(row.max) : 0;
  return max >= 999 ? 1 : max + 1;
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

/**
 * 새 주문을 만든다. requestPhone 이 true 면 손님 디스플레이에 번호 입력 화면이 뜬다.
 */
function createOrder({ memo = null, requestPhone = true } = {}) {
  const now = Date.now();
  const day = bizDay(now);

  // 동시에 두 명이 주문을 넣어 대기번호가 겹치면 다음 번호로 한 번 더 시도한다.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const info = db
        .prepare(
          `INSERT INTO orders (biz_day, ticket, memo, status, phone_state, created_at)
           VALUES (?, ?, ?, 'preparing', ?, ?)`,
        )
        .run(day, nextTicket(day), memo, requestPhone ? 'pending' : 'skipped', now);
      return getOrder(Number(info.lastInsertRowid));
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }
  throw new Error('대기번호를 발급하지 못했습니다.');
}

function listActive() {
  return db
    .prepare(
      `SELECT * FROM orders
        WHERE biz_day = ? AND status IN ('preparing', 'ready')
        ORDER BY created_at ASC`,
    )
    .all(bizDay());
}

function listRecentDone(limit = 20) {
  return db
    .prepare(
      `SELECT * FROM orders
        WHERE biz_day = ? AND status IN ('picked', 'canceled')
        ORDER BY COALESCE(picked_at, ready_at, created_at) DESC
        LIMIT ?`,
    )
    .all(bizDay(), limit);
}

/** 손님 디스플레이에 띄울 주문. 대기줄 순서대로 가장 먼저 들어온 것부터 처리한다. */
function pendingPhoneOrder() {
  return (
    db
      .prepare(
        `SELECT * FROM orders
          WHERE phone_state = 'pending' AND status IN ('preparing', 'ready')
          ORDER BY created_at ASC
          LIMIT 1`,
      )
      .get() || null
  );
}

function setPhone(id, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, error: 'invalid_phone' };
  const order = getOrder(id);
  if (!order) return { ok: false, error: 'not_found' };
  if (order.status === 'canceled') return { ok: false, error: 'canceled' };

  db.prepare(
    `UPDATE orders SET phone = ?, phone_masked = ?, phone_state = 'set', purged_at = NULL
      WHERE id = ?`,
  ).run(phone, maskPhone(phone), id);
  return { ok: true, order: getOrder(id) };
}

/** 손님이 번호 입력을 건너뛰었을 때. 이후로는 이름/번호로 직접 부른다. */
function skipPhone(id) {
  const order = getOrder(id);
  if (!order) return { ok: false, error: 'not_found' };
  db.prepare("UPDATE orders SET phone_state = 'skipped' WHERE id = ?").run(id);
  return { ok: true, order: getOrder(id) };
}

/** 직원이 다시 번호를 받고 싶을 때 손님 디스플레이를 그 주문으로 되돌린다. */
function requestPhoneAgain(id) {
  const order = getOrder(id);
  if (!order) return { ok: false, error: 'not_found' };
  if (order.status === 'canceled') return { ok: false, error: 'canceled' };
  db.prepare("UPDATE orders SET phone_state = 'pending' WHERE id = ?").run(id);
  return { ok: true, order: getOrder(id) };
}

function markReady(id) {
  const order = getOrder(id);
  if (!order) return { ok: false, error: 'not_found' };
  if (order.status === 'canceled') return { ok: false, error: 'canceled' };
  db.prepare("UPDATE orders SET status = 'ready', ready_at = ? WHERE id = ?").run(Date.now(), id);
  return { ok: true, order: getOrder(id) };
}

function markPicked(id) {
  const order = getOrder(id);
  if (!order) return { ok: false, error: 'not_found' };
  const now = Date.now();
  // 픽업이 끝나면 전화번호는 더 필요 없으므로 즉시 지운다.
  db.prepare(
    `UPDATE orders
        SET status = 'picked', picked_at = ?, phone = NULL, phone_masked = NULL, purged_at = ?
      WHERE id = ?`,
  ).run(now, now, id);
  return { ok: true, order: getOrder(id) };
}

function cancelOrder(id) {
  const order = getOrder(id);
  if (!order) return { ok: false, error: 'not_found' };
  const now = Date.now();
  db.prepare(
    `UPDATE orders
        SET status = 'canceled', phone = NULL, phone_masked = NULL, purged_at = ?
      WHERE id = ?`,
  ).run(now, id);
  return { ok: true, order: getOrder(id) };
}

function recordNotifyResult(id, result) {
  db.prepare(
    `UPDATE orders
        SET notify_status = ?, notify_channel = ?, notify_error = ?, notify_count = notify_count + 1
      WHERE id = ?`,
  ).run(result.ok ? 'sent' : 'failed', result.channel || null, result.error || null, id);
  return getOrder(id);
}

/**
 * 오래된 전화번호를 지운다. 알림 목적이 끝난 개인정보를 남겨두지 않기 위한 것으로,
 * 서버가 떠 있는 동안 주기적으로 호출된다.
 */
function purgeExpiredPhones(now = Date.now()) {
  const cutoff = now - config.purgeAfterMinutes * 60_000;
  const info = db
    .prepare(
      `UPDATE orders
          SET phone = NULL, phone_masked = NULL, purged_at = ?
        WHERE phone IS NOT NULL AND created_at < ?`,
    )
    .run(now, cutoff);
  return info.changes;
}

/** 화면으로 내보낼 때는 원본 전화번호를 절대 포함하지 않는다. */
function toPublic(order) {
  if (!order) return null;
  return {
    id: order.id,
    ticket: order.ticket,
    memo: order.memo,
    status: order.status,
    phoneMasked: order.phone_masked,
    phoneState: order.phone_state,
    hasPhone: Boolean(order.phone),
    notifyStatus: order.notify_status,
    notifyChannel: order.notify_channel,
    notifyError: order.notify_error,
    notifyCount: order.notify_count,
    createdAt: order.created_at,
    readyAt: order.ready_at,
    pickedAt: order.picked_at,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  bizDay,
  normalizePhone,
  maskPhone,
  getOrder,
  createOrder,
  listActive,
  listRecentDone,
  pendingPhoneOrder,
  setPhone,
  skipPhone,
  requestPhoneAgain,
  markReady,
  markPicked,
  cancelOrder,
  recordNotifyResult,
  purgeExpiredPhones,
  toPublic,
};
