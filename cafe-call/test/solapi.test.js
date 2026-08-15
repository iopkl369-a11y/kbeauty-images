'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-call-solapi-'));
process.env.DATA_DIR = dir;
process.env.DB_FILE = path.join(dir, 'test.db');

const solapi = require('../src/notify/solapi');

const config = {
  storeName: '와이프 카페',
  buildMessageText: (ticket) =>
    `[와이프 카페] ${ticket}번 주문하신 음료 나왔습니다. 카운터에서 찾아가 주세요.`,
  notify: {
    mode: 'alimtalk',
    smsFallback: true,
    senderPhone: '0212345678',
    solapi: {
      apiKey: 'KEY',
      apiSecret: 'SECRET',
      pfId: 'PF01',
      templateId: 'TPL01',
    },
    varStore: '#{매장명}',
    varTicket: '#{대기번호}',
  },
};

test('알림톡 발송 본문에 템플릿 변수가 채워진다', () => {
  const message = solapi.buildMessage({ to: '01012345678', ticket: 42, config });

  assert.equal(message.to, '01012345678');
  assert.equal(message.from, '0212345678');
  assert.equal(message.kakaoOptions.pfId, 'PF01');
  assert.equal(message.kakaoOptions.templateId, 'TPL01');
  assert.equal(message.kakaoOptions.variables['#{매장명}'], '와이프 카페');
  assert.equal(message.kakaoOptions.variables['#{대기번호}'], '42');
  assert.equal(message.kakaoOptions.disableSms, false, '문자 대체 발송이 켜져 있어야 한다');
  assert.match(message.text, /42번 주문하신 음료 나왔습니다/, '대체 문자 본문도 함께 보낸다');
});

test('문자 대체를 끄면 disableSms 가 켜진다', () => {
  const off = { ...config, notify: { ...config.notify, smsFallback: false } };
  const message = solapi.buildMessage({ to: '01012345678', ticket: 7, config: off });
  assert.equal(message.kakaoOptions.disableSms, true);
});

test('문자 모드에서는 카카오 옵션 없이 본문만 보낸다', () => {
  const smsConfig = { ...config, notify: { ...config.notify, mode: 'sms' } };
  const message = solapi.buildMessage({ to: '01012345678', ticket: 7, config: smsConfig });

  assert.equal(message.kakaoOptions, undefined);
  assert.match(message.text, /^\[와이프 카페\] 7번 주문하신 음료 나왔습니다/);
  // 광고성 문구가 없으므로 90바이트 SMS를 넘겨도 LMS로 자동 전환된다.
  assert.ok(message.text.length < 200);
});

test('HMAC 인증 헤더 형식', () => {
  const now = new Date('2026-08-15T01:02:03.000Z');
  const header = solapi.authHeader({ apiKey: 'KEY', apiSecret: 'SECRET' }, now);

  const matched = header.match(
    /^HMAC-SHA256 apiKey=KEY, date=(.+?), salt=([0-9a-f]{64}), signature=([0-9a-f]{64})$/,
  );
  assert.ok(matched, `형식이 맞지 않음: ${header}`);

  const [, date, salt, signature] = matched;
  assert.equal(date, '2026-08-15T01:02:03.000Z');

  const expected = crypto.createHmac('sha256', 'SECRET').update(date + salt).digest('hex');
  assert.equal(signature, expected);
});

test('설정이 빠졌으면 발송 전에 걸러낸다', async () => {
  const empty = {
    ...config,
    notify: {
      ...config.notify,
      senderPhone: '',
      solapi: { apiKey: '', apiSecret: '', pfId: '', templateId: 'TPL01' },
    },
  };
  assert.deepEqual(solapi.missingSettings(empty), [
    'SOLAPI_API_KEY',
    'SOLAPI_API_SECRET',
    'SENDER_PHONE',
    'SOLAPI_PF_ID',
  ]);

  // 설정이 없으면 네트워크 요청 없이 실패를 반환해야 한다.
  const result = await solapi.send({ to: '01012345678', ticket: 1, config: empty });
  assert.equal(result.ok, false);
  assert.match(result.error, /설정 누락/);

  assert.deepEqual(solapi.missingSettings(config), []);
});

test('응답의 발송 채널을 알아본다', () => {
  assert.equal(solapi.channelName('ATA'), 'alimtalk');
  assert.equal(solapi.channelName('SMS'), 'sms');
  assert.equal(solapi.channelName('LMS'), 'sms');
  assert.equal(solapi.channelName(undefined), 'unknown');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
