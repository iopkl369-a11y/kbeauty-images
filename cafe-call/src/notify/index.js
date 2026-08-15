'use strict';
const config = require('../config');

const providers = {
  console: require('./console'),
  solapi: require('./solapi'),
};

function getProvider(name = config.notify.provider) {
  return providers[name] || providers.console;
}

/**
 * 주문 하나에 대해 완료 알림을 보낸다.
 * 반환값은 항상 { ok, channel, error } 형태이며 예외를 던지지 않는다.
 * 발송이 실패해도 음료는 이미 나와 있으므로 호출 자체가 막히면 안 된다.
 */
async function notifyReady(order) {
  if (!order.phone) {
    return { ok: false, channel: null, error: '등록된 전화번호가 없습니다.' };
  }
  try {
    return await getProvider().send({
      to: order.phone,
      ticket: order.ticket,
      config,
    });
  } catch (err) {
    return { ok: false, channel: null, error: err.message };
  }
}

module.exports = { notifyReady, getProvider };
