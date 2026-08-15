'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** .env 파일을 읽어 process.env 에 채운다 (이미 설정된 값은 덮어쓰지 않음). */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(v).toLowerCase());
};
const int = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

/**
 * 손님 디스플레이 주소에 쓰는 비밀키. 한 번 만들어 파일에 저장해두고 계속 쓴다.
 * (직원 화면은 PIN 로그인, 손님 디스플레이는 이 키가 박힌 주소로 접속)
 */
function persistentKey(name) {
  const envValue = process.env[name.toUpperCase()];
  if (envValue) return envValue;
  const file = path.join(dataDir, `${name}.key`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const key = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

const config = {
  port: int(process.env.PORT, 3000),
  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'cafe-call.db'),

  storeName: process.env.STORE_NAME || '우리 카페',
  staffPin: process.env.STAFF_PIN || '1234',
  sessionSecret: process.env.SESSION_SECRET || persistentKey('session-secret'),
  customerKey: persistentKey('customer'),

  /** 영업일 경계 시각. 새벽 4시 기준으로 대기번호가 1번부터 다시 시작한다. */
  dayRolloverHour: int(process.env.DAY_ROLLOVER_HOUR, 4),
  timezoneOffsetMinutes: int(process.env.TZ_OFFSET_MINUTES, 540), // KST = UTC+9

  /** 전화번호 자동 삭제까지의 시간(분). 픽업 완료 시에는 즉시 삭제한다. */
  purgeAfterMinutes: int(process.env.PURGE_AFTER_MINUTES, 120),

  notify: {
    provider: process.env.NOTIFY_PROVIDER || 'console', // console | solapi
    mode: process.env.NOTIFY_MODE || 'alimtalk', // alimtalk | sms
    smsFallback: bool(process.env.SMS_FALLBACK, true),
    senderPhone: (process.env.SENDER_PHONE || '').replace(/\D/g, ''),
    solapi: {
      apiKey: process.env.SOLAPI_API_KEY || '',
      apiSecret: process.env.SOLAPI_API_SECRET || '',
      pfId: process.env.SOLAPI_PF_ID || '',
      templateId: process.env.SOLAPI_TEMPLATE_ID || '',
    },
    /** 알림톡 템플릿에 등록한 변수명. 템플릿을 다르게 등록했다면 여기만 바꾸면 된다. */
    varStore: process.env.TEMPLATE_VAR_STORE || '#{매장명}',
    varTicket: process.env.TEMPLATE_VAR_TICKET || '#{대기번호}',
  },
};

/** 문자 대체 발송 및 콘솔 모드에서 쓰는 본문. */
config.buildMessageText = (ticket) =>
  `[${config.storeName}] ${ticket}번 주문하신 음료 나왔습니다. 카운터에서 찾아가 주세요.`;

module.exports = config;
