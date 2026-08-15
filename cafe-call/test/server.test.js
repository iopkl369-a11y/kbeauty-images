'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-call-server-'));
process.env.DATA_DIR = dir;
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.STAFF_PIN = '4821';
process.env.STORE_NAME = '테스트 카페';
process.env.NOTIFY_PROVIDER = 'console';

const config = require('../src/config');
const { server } = require('../server');

let base;
let cookie = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  // SSE 연결이 열려 있으면 close()가 끝나지 않으므로 먼저 끊는다.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body, useCookie = true) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(useCookie && cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML 응답 */
  }
  return { status: res.status, json, text, headers: res.headers };
}

test('로그인 없이는 직원 API에 접근할 수 없다', async () => {
  const res = await call('GET', '/api/state', undefined, false);
  assert.equal(res.status, 401);
});

test('틀린 PIN은 거부된다', async () => {
  const res = await call('POST', '/api/login', { pin: '0000' }, false);
  assert.equal(res.status, 401);
});

test('올바른 PIN으로 로그인하면 세션 쿠키를 받는다', async () => {
  const res = await call('POST', '/api/login', { pin: '4821' }, false);
  assert.equal(res.status, 200);

  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^sid=/);
  assert.match(setCookie, /HttpOnly/);
  cookie = setCookie.split(';')[0];

  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.storeName, '테스트 카페');
});

test('위조된 세션 쿠키는 통하지 않는다', async () => {
  const res = await fetch(base + '/api/state', {
    headers: { Cookie: 'sid=eyJyb2xlIjoic3RhZmYiLCJleHAiOjk5OTk5OTk5OTk5OTl9.fakesignature' },
  });
  assert.equal(res.status, 401);
});

test('손님 디스플레이는 올바른 키로만 열린다', async () => {
  const bad = await call('GET', '/api/c/wrong-key-here/state', undefined, false);
  assert.equal(bad.status, 403);

  const good = await call('GET', `/api/c/${config.customerKey}/state`, undefined, false);
  assert.equal(good.status, 200);
  assert.equal(good.json.mode, 'idle');
});

test('주문 → 손님 번호 입력 → 호출 → 픽업 전체 흐름', async () => {
  // 1. 직원이 주문을 만든다
  const created = await call('POST', '/api/orders', { memo: '아이스 아메리카노' });
  assert.equal(created.status, 201);
  const orderId = created.json.order.id;
  const ticket = created.json.order.ticket;

  // 2. 손님 디스플레이에 그 주문이 뜬다
  const display = await call('GET', `/api/c/${config.customerKey}/state`, undefined, false);
  assert.equal(display.json.mode, 'input');
  assert.equal(display.json.orderId, orderId);
  assert.equal(display.json.ticket, ticket);

  // 3. 잘못된 번호는 거부된다
  const bad = await call(
    'POST',
    `/api/c/${config.customerKey}/phone`,
    { orderId, phone: '010123' },
    false,
  );
  assert.equal(bad.status, 400);

  // 4. 올바른 번호를 입력하면 접수된다
  const ok = await call(
    'POST',
    `/api/c/${config.customerKey}/phone`,
    { orderId, phone: '010-1234-5678' },
    false,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ticket, ticket);

  // 5. 손님 화면은 다시 대기 상태로 돌아간다
  const idle = await call('GET', `/api/c/${config.customerKey}/state`, undefined, false);
  assert.equal(idle.json.mode, 'idle');

  // 6. 직원 화면에는 마스킹된 번호만 보인다
  const state = await call('GET', '/api/state');
  const order = state.json.active.find((o) => o.id === orderId);
  assert.equal(order.phoneMasked, '010-****-5678');
  assert.equal(order.phoneState, 'set');
  assert.ok(!state.text.includes('01012345678'), '원본 번호가 응답에 노출되면 안 된다');

  // 7. 완료 호출 → 알림 발송
  const ready = await call('POST', `/api/orders/${orderId}/ready`);
  assert.equal(ready.status, 200);
  assert.equal(ready.json.notify.ok, true);
  assert.equal(ready.json.notify.channel, 'console');

  // 8. 픽업하면 번호가 지워지고 목록에서 빠진다
  const picked = await call('POST', `/api/orders/${orderId}/pick`);
  assert.equal(picked.status, 200);

  const after = await call('GET', '/api/state');
  assert.ok(!after.json.active.some((o) => o.id === orderId));
  const done = after.json.done.find((o) => o.id === orderId);
  assert.equal(done.status, 'picked');
  assert.equal(done.phoneMasked, null);
});

test('이미 지나간 주문에 번호를 넣으려 하면 거절된다', async () => {
  const created = await call('POST', '/api/orders', {});
  const orderId = created.json.order.id;

  await call('POST', `/api/c/${config.customerKey}/skip`, { orderId }, false);

  const late = await call(
    'POST',
    `/api/c/${config.customerKey}/phone`,
    { orderId, phone: '01011112222' },
    false,
  );
  assert.equal(late.status, 409);
});

test('전화번호가 없는 주문도 호출은 되지만 알림은 실패로 표시된다', async () => {
  const created = await call('POST', '/api/orders', { requestPhone: false });
  const orderId = created.json.order.id;

  const ready = await call('POST', `/api/orders/${orderId}/ready`);
  assert.equal(ready.status, 200, '음료는 나왔으므로 호출 자체는 성공해야 한다');
  assert.equal(ready.json.notify.ok, false);

  const state = await call('GET', '/api/state');
  assert.equal(state.json.active.find((o) => o.id === orderId).status, 'ready');
});

test('직원이 번호를 대신 입력할 수 있다', async () => {
  const created = await call('POST', '/api/orders', { requestPhone: false });
  const orderId = created.json.order.id;

  const bad = await call('POST', `/api/orders/${orderId}/phone`, { phone: '123' });
  assert.equal(bad.status, 400);

  const ok = await call('POST', `/api/orders/${orderId}/phone`, { phone: '01087654321' });
  assert.equal(ok.status, 200);

  const state = await call('GET', '/api/state');
  assert.equal(state.json.active.find((o) => o.id === orderId).phoneMasked, '010-****-4321');
});

test('SSE 스트림이 첫 스냅샷을 곧바로 내려준다', async () => {
  const res = await fetch(base + `/api/c/${config.customerKey}/stream`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  // 프레임이 한 청크로 합쳐져 올 수도 있으므로 data: 줄이 나올 때까지 모은다.
  const reader = res.body.getReader();
  let buffer = '';
  while (!/^data: .+$/m.test(buffer)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += Buffer.from(value).toString('utf8');
  }
  await reader.cancel();

  assert.match(buffer, /retry: 3000/);
  const line = buffer.match(/^data: (.+)$/m)[1];
  assert.equal(JSON.parse(line).mode, 'idle');
});
