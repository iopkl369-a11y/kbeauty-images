'use strict';
const crypto = require('node:crypto');

const ENDPOINT = 'https://api.solapi.com/messages/v4/send';
const TIMEOUT_MS = 10_000;

/**
 * 솔라피 HMAC 인증 헤더.
 * signature = HMAC-SHA256(date + salt, apiSecret)
 */
function authHeader({ apiKey, apiSecret }, now = new Date()) {
  const date = now.toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

/** 주문 하나에 대한 발송 요청 본문을 만든다. */
function buildMessage({ to, ticket, config }) {
  const n = config.notify;
  const text = config.buildMessageText(ticket);

  if (n.mode === 'sms') {
    return { to, from: n.senderPhone, text };
  }

  return {
    to,
    from: n.senderPhone,
    // 알림톡이 실패했을 때 대체 발송되는 문자 본문으로도 쓰인다.
    text,
    kakaoOptions: {
      pfId: n.solapi.pfId,
      templateId: n.solapi.templateId,
      variables: {
        [n.varStore]: config.storeName,
        [n.varTicket]: String(ticket),
      },
      // 카톡 미사용자이거나 알림톡 발송이 실패하면 솔라피가 문자로 자동 대체한다.
      disableSms: !n.smsFallback,
    },
  };
}

/** 솔라피 응답의 type 값을 사람이 읽을 수 있는 채널명으로 바꾼다. */
function channelName(type) {
  if (!type) return 'unknown';
  if (['ATA', 'CTA', 'CTI'].includes(type)) return 'alimtalk';
  if (['SMS', 'LMS', 'MMS'].includes(type)) return 'sms';
  return String(type).toLowerCase();
}

function missingSettings(config) {
  const n = config.notify;
  const missing = [];
  if (!n.solapi.apiKey) missing.push('SOLAPI_API_KEY');
  if (!n.solapi.apiSecret) missing.push('SOLAPI_API_SECRET');
  if (!n.senderPhone) missing.push('SENDER_PHONE');
  if (n.mode === 'alimtalk') {
    if (!n.solapi.pfId) missing.push('SOLAPI_PF_ID');
    if (!n.solapi.templateId) missing.push('SOLAPI_TEMPLATE_ID');
  }
  return missing;
}

async function send({ to, ticket, config }) {
  const missing = missingSettings(config);
  if (missing.length) {
    return { ok: false, channel: null, error: `설정 누락: ${missing.join(', ')}` };
  }

  const body = JSON.stringify({ message: buildMessage({ to, ticket, config }) });

  let res;
  let payload;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(config.notify.solapi),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    payload = await res.json().catch(() => ({}));
  } catch (err) {
    return { ok: false, channel: null, error: `발송 요청 실패: ${err.message}` };
  }

  if (!res.ok) {
    const code = payload.errorCode || res.status;
    const message = payload.errorMessage || res.statusText;
    return { ok: false, channel: null, error: `${code} ${message}` };
  }

  const channel = channelName(payload.type);
  const statusCode = String(payload.statusCode || '');
  if (statusCode && !statusCode.startsWith('2')) {
    return {
      ok: false,
      channel,
      error: `${statusCode} ${payload.statusMessage || '발송 실패'}`,
    };
  }

  return { ok: true, channel, messageId: payload.messageId || null };
}

module.exports = { send, buildMessage, authHeader, channelName, missingSettings };
