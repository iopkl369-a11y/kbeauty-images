'use strict';

/**
 * 실제로 발송하지 않고 터미널에만 찍는 개발용 발송기.
 * 알림톡 계약 전에도 시스템 전체를 그대로 돌려볼 수 있게 해준다.
 */
async function send({ to, ticket, config }) {
  const masked = to ? `${to.slice(0, 3)}-****-${to.slice(-4)}` : '(번호 없음)';
  console.log(`[알림 모의발송] ${masked} <- ${config.buildMessageText(ticket)}`);
  return { ok: true, channel: 'console', messageId: null };
}

module.exports = { send };
