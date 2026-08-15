'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-call-orders-'));
process.env.DATA_DIR = dir;
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.PURGE_AFTER_MINUTES = '60';

const orders = require('../src/orders');

test('전화번호 정규화', () => {
  assert.equal(orders.normalizePhone('010-1234-5678'), '01012345678');
  assert.equal(orders.normalizePhone('010 1234 5678'), '01012345678');
  assert.equal(orders.normalizePhone('+82 10-1234-5678'), '01012345678');
  assert.equal(orders.normalizePhone('01112345678'), '01112345678');
  assert.equal(orders.normalizePhone('0111234567'), '0111234567');

  assert.equal(orders.normalizePhone('021234567'), null, '유선번호는 거부');
  assert.equal(orders.normalizePhone('0101234'), null, '자릿수 부족');
  assert.equal(orders.normalizePhone('010123456789'), null, '자릿수 초과');
  assert.equal(orders.normalizePhone(''), null);
  assert.equal(orders.normalizePhone(null), null);
});

test('전화번호 마스킹은 뒷 4자리만 남긴다', () => {
  assert.equal(orders.maskPhone('01012345678'), '010-****-5678');
});

test('대기번호는 1번부터 순서대로 발급된다', () => {
  const a = orders.createOrder({ memo: '아메리카노' });
  const b = orders.createOrder({});
  assert.equal(a.ticket, 1);
  assert.equal(b.ticket, 2);
  assert.equal(a.status, 'preparing');
  assert.equal(a.phone_state, 'pending');
  assert.equal(a.memo, '아메리카노');
});

test('번호 없이 주문하면 손님 화면에 뜨지 않는다', () => {
  const order = orders.createOrder({ requestPhone: false });
  assert.equal(order.phone_state, 'skipped');
  assert.notEqual(orders.pendingPhoneOrder().id, order.id);
});

test('손님 화면은 먼저 들어온 주문부터 처리한다', () => {
  const pending = orders.pendingPhoneOrder();
  assert.equal(pending.ticket, 1, '가장 먼저 만들어진 주문이 먼저');
});

test('번호를 등록하면 다음 주문으로 넘어간다', () => {
  const first = orders.pendingPhoneOrder();

  assert.deepEqual(orders.setPhone(first.id, '010-000'), { ok: false, error: 'invalid_phone' });

  const result = orders.setPhone(first.id, '010-1234-5678');
  assert.equal(result.ok, true);
  assert.equal(result.order.phone, '01012345678');
  assert.equal(result.order.phone_masked, '010-****-5678');
  assert.equal(result.order.phone_state, 'set');

  assert.equal(orders.pendingPhoneOrder().ticket, 2, '다음 손님 차례로 넘어감');
});

test('손님이 건너뛰면 대기열에서 빠진다', () => {
  const second = orders.pendingPhoneOrder();
  orders.skipPhone(second.id);
  assert.equal(orders.pendingPhoneOrder(), null);

  orders.requestPhoneAgain(second.id);
  assert.equal(orders.pendingPhoneOrder().id, second.id, '직원이 다시 요청할 수 있다');
  orders.skipPhone(second.id);
});

test('호출과 픽업 처리', () => {
  const [first] = orders.listActive();
  assert.equal(orders.markReady(first.id).order.status, 'ready');

  const picked = orders.markPicked(first.id).order;
  assert.equal(picked.status, 'picked');
  assert.equal(picked.phone, null, '픽업하면 전화번호를 즉시 삭제한다');
  assert.equal(picked.phone_masked, null);
  assert.ok(picked.purged_at);

  assert.ok(!orders.listActive().some((o) => o.id === first.id));
  assert.ok(orders.listRecentDone().some((o) => o.id === first.id));
});

test('주문을 취소해도 전화번호가 남지 않는다', () => {
  const order = orders.createOrder({});
  orders.setPhone(order.id, '01099998888');
  const canceled = orders.cancelOrder(order.id).order;
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.phone, null);
});

test('오래된 전화번호는 자동으로 삭제된다', () => {
  const order = orders.createOrder({});
  orders.setPhone(order.id, '01055556666');

  assert.equal(orders.purgeExpiredPhones(Date.now()), 0, '아직 만료되지 않음');
  assert.ok(orders.getOrder(order.id).phone);

  const later = Date.now() + 61 * 60_000;
  assert.ok(orders.purgeExpiredPhones(later) >= 1);
  assert.equal(orders.getOrder(order.id).phone, null);
  assert.equal(orders.getOrder(order.id).phone_masked, null);
});

test('화면으로 내보내는 데이터에는 원본 번호가 없다', () => {
  const order = orders.createOrder({});
  orders.setPhone(order.id, '01012341234');
  const dto = orders.toPublic(orders.getOrder(order.id));

  assert.equal(dto.phoneMasked, '010-****-1234');
  assert.equal(dto.hasPhone, true);
  assert.ok(!('phone' in dto));
  assert.ok(!JSON.stringify(dto).includes('01012341234'));
});

test('영업일은 새벽 4시를 기준으로 나뉜다', () => {
  // 2026-08-15 02:00 KST -> 전날 영업일
  const lateNight = Date.parse('2026-08-14T17:00:00Z');
  // 2026-08-15 05:00 KST -> 당일 영업일
  const morning = Date.parse('2026-08-14T20:00:00Z');
  assert.equal(orders.bizDay(lateNight), '2026-08-14');
  assert.equal(orders.bizDay(morning), '2026-08-15');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
