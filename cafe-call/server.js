'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./src/config');
const orders = require('./src/orders');
const events = require('./src/events');
const { notifyReady } = require('./src/notify');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024;

// ---------------------------------------------------------------- 세션 쿠키

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(data)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

const isStaff = (req) => verifySession(parseCookies(req).sid)?.role === 'staff';

/** 길이가 달라도 정보가 새지 않도록 해시를 비교한다. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------- 응답 헬퍼

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendFile(res, filename, status = 200) {
  const file = path.join(PUBLIC_DIR, filename);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('찾을 수 없습니다.');
    return;
  }
  res.writeHead(status, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('요청 본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('잘못된 JSON 형식입니다.'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 화면 스냅샷

function staffSnapshot() {
  const pending = orders.pendingPhoneOrder();
  return {
    storeName: config.storeName,
    customerUrlPath: `/c/${config.customerKey}`,
    notify: {
      provider: config.notify.provider,
      mode: config.notify.mode,
      smsFallback: config.notify.smsFallback,
      live: config.notify.provider !== 'console',
    },
    customerDisplayConnected: events.clientCount('customer') > 0,
    awaitingPhoneTicket: pending ? pending.ticket : null,
    active: orders.listActive().map(orders.toPublic),
    done: orders.listRecentDone().map(orders.toPublic),
  };
}

function customerSnapshot() {
  const pending = orders.pendingPhoneOrder();
  return {
    storeName: config.storeName,
    mode: pending ? 'input' : 'idle',
    orderId: pending ? pending.id : null,
    ticket: pending ? pending.ticket : null,
  };
}

function broadcastAll() {
  events.broadcast('staff', staffSnapshot());
  events.broadcast('customer', customerSnapshot());
}

// ---------------------------------------------------------------- 로그인 제한

const loginAttempts = new Map(); // ip -> { count, until }

function loginBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.until && entry.until > Date.now()) return true;
  if (entry.until && entry.until <= Date.now()) loginAttempts.delete(ip);
  return false;
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.until = Date.now() + 5 * 60_000;
    entry.count = 0;
  }
  loginAttempts.set(ip, entry);
}

// ---------------------------------------------------------------- 라우팅

async function handle(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // ---- 정적 리소스
  if (method === 'GET' && pathname.startsWith('/static/')) {
    // public/static/ 아래 그대로 매핑한다 (앞의 '/' 만 떼어낸다).
    return sendFile(res, pathname.slice(1));
  }

  // ---- 로그인
  if (method === 'GET' && pathname === '/login') return sendFile(res, 'login.html');

  if (method === 'POST' && pathname === '/api/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginBlocked(ip)) {
      return sendJson(res, 429, { error: '시도가 너무 많습니다. 5분 뒤에 다시 해주세요.' });
    }
    const body = await readBody(req);
    if (!body.pin || !safeEqual(body.pin, config.staffPin)) {
      recordLoginFailure(ip);
      return sendJson(res, 401, { error: 'PIN이 올바르지 않습니다.' });
    }
    loginAttempts.delete(ip);
    const token = signSession({ role: 'staff', exp: Date.now() + 30 * 24 * 3600_000 });
    // 리버스 프록시 뒤에서 HTTPS로 서비스되는 경우 쿠키에 Secure를 붙인다.
    const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    const secure = https ? ' Secure;' : '';
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${30 * 24 * 3600}`,
    });
  }

  if (method === 'POST' && pathname === '/api/logout') {
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
  }

  // ---- 손님 디스플레이 (PIN 없이 비밀 주소로 접속)
  const customerPage = pathname.match(/^\/c\/([\w-]+)\/?$/);
  if (method === 'GET' && customerPage) {
    if (!safeEqual(customerPage[1], config.customerKey)) return sendFile(res, 'login.html', 403);
    return sendFile(res, 'customer.html');
  }

  const customerApi = pathname.match(/^\/api\/c\/([\w-]+)\/(state|stream|phone|skip)$/);
  if (customerApi) {
    if (!safeEqual(customerApi[1], config.customerKey)) {
      return sendJson(res, 403, { error: '접근 권한이 없습니다.' });
    }
    const action = customerApi[2];

    if (method === 'GET' && action === 'state') return sendJson(res, 200, customerSnapshot());

    if (method === 'GET' && action === 'stream') {
      events.subscribe('customer', res);
      res.write(`data: ${JSON.stringify(customerSnapshot())}\n\n`);
      // 직원 화면의 '손님화면 연결됨' 표시를 즉시 맞춰준다.
      events.broadcast('staff', staffSnapshot());
      res.on('close', () => events.broadcast('staff', staffSnapshot()));
      return undefined;
    }

    if (method === 'POST' && action === 'phone') {
      const body = await readBody(req);
      const pending = orders.pendingPhoneOrder();
      // 손님이 입력하는 사이 직원이 주문을 취소했을 수도 있으므로 대상 주문을 확인한다.
      if (!pending || pending.id !== Number(body.orderId)) {
        broadcastAll();
        return sendJson(res, 409, { error: '주문 상태가 바뀌었습니다.' });
      }
      const result = orders.setPhone(pending.id, body.phone);
      if (!result.ok) {
        return sendJson(res, 400, {
          error:
            result.error === 'invalid_phone'
              ? '휴대폰 번호를 다시 확인해주세요.'
              : '주문 상태가 바뀌었습니다.',
        });
      }
      broadcastAll();
      return sendJson(res, 200, { ok: true, ticket: result.order.ticket });
    }

    if (method === 'POST' && action === 'skip') {
      const body = await readBody(req);
      const pending = orders.pendingPhoneOrder();
      if (pending && pending.id === Number(body.orderId)) orders.skipPhone(pending.id);
      broadcastAll();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 여기서부터는 직원 전용
  const wantsJson = pathname.startsWith('/api/');
  if (!isStaff(req)) {
    if (wantsJson) return sendJson(res, 401, { error: '로그인이 필요합니다.' });
    if (pathname === '/' || pathname === '/staff') {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
  }

  if (method === 'GET' && (pathname === '/' || pathname === '/staff')) {
    return sendFile(res, 'staff.html');
  }

  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, staffSnapshot());

  if (method === 'GET' && pathname === '/api/stream') {
    events.subscribe('staff', res);
    res.write(`data: ${JSON.stringify(staffSnapshot())}\n\n`);
    return undefined;
  }

  if (method === 'POST' && pathname === '/api/orders') {
    const body = await readBody(req);
    const order = orders.createOrder({
      memo: body.memo ? String(body.memo).slice(0, 60) : null,
      requestPhone: body.requestPhone !== false,
    });
    broadcastAll();
    return sendJson(res, 201, { ok: true, order: orders.toPublic(order) });
  }

  const orderAction = pathname.match(
    /^\/api\/orders\/(\d+)\/(ready|notify|pick|cancel|phone|request-phone)$/,
  );
  if (method === 'POST' && orderAction) {
    const id = Number(orderAction[1]);
    const action = orderAction[2];

    if (action === 'ready') {
      const result = orders.markReady(id);
      if (!result.ok) return sendJson(res, 404, { error: '주문을 찾을 수 없습니다.' });
      broadcastAll();

      // 음료는 이미 나왔으므로 발송 결과와 무관하게 호출 자체는 성공 처리한다.
      let notifyResult = { ok: false, channel: null, error: '등록된 전화번호가 없습니다.' };
      if (result.order.phone) {
        notifyResult = await notifyReady(result.order);
        orders.recordNotifyResult(id, notifyResult);
        broadcastAll();
      }
      return sendJson(res, 200, { ok: true, notify: notifyResult });
    }

    if (action === 'notify') {
      const order = orders.getOrder(id);
      if (!order) return sendJson(res, 404, { error: '주문을 찾을 수 없습니다.' });
      if (!order.phone) return sendJson(res, 400, { error: '등록된 전화번호가 없습니다.' });
      const notifyResult = await notifyReady(order);
      orders.recordNotifyResult(id, notifyResult);
      broadcastAll();
      return sendJson(res, 200, { ok: notifyResult.ok, notify: notifyResult });
    }

    if (action === 'pick' || action === 'cancel') {
      const result = action === 'pick' ? orders.markPicked(id) : orders.cancelOrder(id);
      if (!result.ok) return sendJson(res, 404, { error: '주문을 찾을 수 없습니다.' });
      broadcastAll();
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'phone') {
      const body = await readBody(req);
      const result = orders.setPhone(id, body.phone);
      if (!result.ok) {
        return sendJson(res, 400, { error: '휴대폰 번호를 다시 확인해주세요.' });
      }
      broadcastAll();
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'request-phone') {
      const result = orders.requestPhoneAgain(id);
      if (!result.ok) return sendJson(res, 404, { error: '주문을 찾을 수 없습니다.' });
      broadcastAll();
      return sendJson(res, 200, { ok: true });
    }
  }

  if (wantsJson) return sendJson(res, 404, { error: '없는 API입니다.' });
  return sendFile(res, 'staff.html', 404);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  Promise.resolve(handle(req, res, url)).catch((err) => {
    console.error('요청 처리 실패:', err);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했습니다.' });
    else res.end();
  });
});

if (require.main === module) {
  // 알림 목적이 끝난 전화번호를 주기적으로 지운다.
  const purgeTimer = setInterval(() => {
    const removed = orders.purgeExpiredPhones();
    if (removed > 0) console.log(`전화번호 ${removed}건을 자동 삭제했습니다.`);
  }, 5 * 60_000);
  purgeTimer.unref();

  server.listen(config.port, () => {
    console.log(`\n  ${config.storeName} 주문 호출 시스템`);
    console.log(`  ─────────────────────────────────────`);
    console.log(`  직원 화면      http://localhost:${config.port}/staff   (PIN: ${config.staffPin})`);
    console.log(`  손님 디스플레이 http://localhost:${config.port}/c/${config.customerKey}`);
    console.log(`  알림 발송      ${config.notify.provider} / ${config.notify.mode}`);
    if (config.notify.provider === 'console') {
      console.log(`  ※ 지금은 모의발송 모드입니다. 실제 문자는 나가지 않습니다.`);
    }
    console.log('');
  });
}

module.exports = { server, handle, signSession, verifySession };
