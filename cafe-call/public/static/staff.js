'use strict';
/* 직원용 화면. 주문 발급 → 호출 → 픽업까지를 한 화면에서 처리한다. */

const $ = (sel) => document.querySelector(sel);
const el = {
  storeName: $('#store-name'),
  tagDisplay: $('#tag-display'),
  tagNotify: $('#tag-notify'),
  newOrder: $('#new-order'),
  newOrderNoPhone: $('#new-order-nophone'),
  memo: $('#memo'),
  banner: $('#banner'),
  bannerText: $('#banner-text'),
  listPreparing: $('#list-preparing'),
  listReady: $('#list-ready'),
  emptyPreparing: $('#empty-preparing'),
  emptyReady: $('#empty-ready'),
  titlePreparing: $('#title-preparing'),
  titleReady: $('#title-ready'),
  settings: $('#settings'),
  customerUrl: $('#customer-url'),
  notifyInfo: $('#notify-info'),
};

let snapshot = null;
let busy = false;

// ---------------------------------------------------------------- 유틸

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = isError ? 'toast error' : 'toast';
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('로그인이 필요합니다.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || '요청에 실패했습니다.');
  return body;
}

/** 버튼 연타로 주문이 두 번 만들어지는 일이 없게 한 번에 하나씩만 처리한다. */
async function guard(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy = false;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const NOTIFY_LABEL = { alimtalk: '알림톡', sms: '문자', console: '모의발송' };

// ---------------------------------------------------------------- 카드

function phoneRow(order) {
  const row = element('div', 'meta');

  if (order.phoneState === 'pending') {
    row.append(element('span', 'tag tag-warn', '손님이 번호 입력 중'));
  } else if (order.phoneMasked) {
    row.append(element('span', 'phone', order.phoneMasked));
  } else if (order.phoneState === 'set') {
    row.append(element('span', 'phone none', '번호 삭제됨 (자동 삭제)'));
  } else {
    row.append(element('span', 'phone none', '번호 없음 · 직접 불러주세요'));
  }

  return row;
}

function notifyNote(order) {
  if (order.notifyStatus === 'sent') {
    const label = NOTIFY_LABEL[order.notifyChannel] || order.notifyChannel || '알림';
    return element('div', 'note', `${label} 발송 완료`);
  }
  if (order.notifyStatus === 'failed') {
    return element('div', 'note error', `발송 실패: ${order.notifyError || '알 수 없는 오류'}`);
  }
  return null;
}

function manualPhoneRow(order) {
  const row = element('div', 'manual');
  const input = element('input');
  input.type = 'tel';
  input.inputMode = 'numeric';
  input.maxLength = 13;
  input.placeholder = '직접 입력 (01012345678)';

  const save = element('button', 'btn', '등록');
  const submit = () =>
    guard(async () => {
      await api(`/api/orders/${order.id}/phone`, {
        method: 'POST',
        body: JSON.stringify({ phone: input.value }),
      });
      toast('번호를 등록했습니다.');
    });

  save.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  row.append(input, save);
  return row;
}

function buildCard(order) {
  const card = element('div', order.status === 'ready' ? 'card ready' : 'card');

  const ticket = element('div', 'ticket');
  ticket.append(element('span', 'n', String(order.ticket)), element('span', 'unit', '번'));
  card.append(ticket);

  const body = element('div', 'body');
  body.append(phoneRow(order));
  if (order.memo) body.append(element('div', 'memo', order.memo));

  const note = notifyNote(order);
  if (note) body.append(note);

  // 번호가 아직 없으면 직원이 대신 입력할 수 있게 해준다.
  if (order.phoneState !== 'set') body.append(manualPhoneRow(order));

  const actions = element('div', 'actions');

  if (order.status === 'preparing') {
    const call = element('button', 'btn btn-ok grow', '완료 호출');
    call.addEventListener('click', () =>
      guard(async () => {
        const result = await api(`/api/orders/${order.id}/ready`, { method: 'POST' });
        if (result.notify?.ok) {
          const label = NOTIFY_LABEL[result.notify.channel] || '알림';
          toast(`${order.ticket}번 ${label} 발송 완료`);
        } else {
          toast(`${order.ticket}번 호출 · ${result.notify?.error || '알림 미발송'}`, true);
        }
      }),
    );
    actions.append(call);

    if (order.phoneState === 'skipped') {
      const ask = element('button', 'btn', '손님화면에 요청');
      ask.addEventListener('click', () =>
        guard(async () => {
          await api(`/api/orders/${order.id}/request-phone`, { method: 'POST' });
          toast('손님 화면에 번호 입력을 띄웠습니다.');
        }),
      );
      actions.append(ask);
    }
  } else {
    const picked = element('button', 'btn btn-primary grow', '수령 완료');
    picked.addEventListener('click', () =>
      guard(async () => {
        await api(`/api/orders/${order.id}/pick`, { method: 'POST' });
      }),
    );
    actions.append(picked);

    if (order.hasPhone) {
      const again = element('button', 'btn', '다시 알림');
      again.addEventListener('click', () =>
        guard(async () => {
          const result = await api(`/api/orders/${order.id}/notify`, { method: 'POST' });
          if (result.ok) toast(`${order.ticket}번 재발송 완료`);
          else toast(result.notify?.error || '재발송 실패', true);
        }),
      );
      actions.append(again);
    }
  }

  const cancel = element('button', 'btn btn-danger', '취소');
  cancel.addEventListener('click', () =>
    guard(async () => {
      if (!window.confirm(`${order.ticket}번 주문을 취소할까요?`)) return;
      await api(`/api/orders/${order.id}/cancel`, { method: 'POST' });
    }),
  );
  actions.append(cancel);

  body.append(actions);
  card.append(body);
  return card;
}

// ---------------------------------------------------------------- 렌더링

function render(state) {
  snapshot = state;
  el.storeName.textContent = state.storeName;

  el.tagDisplay.textContent = state.customerDisplayConnected
    ? '손님화면 연결됨'
    : '손님화면 꺼짐';
  el.tagDisplay.className = state.customerDisplayConnected ? 'tag tag-ok' : 'tag tag-danger';

  const mode = NOTIFY_LABEL[state.notify.mode] || state.notify.mode;
  el.tagNotify.textContent = state.notify.live ? `${mode} 발송` : '모의발송 모드';
  el.tagNotify.className = state.notify.live ? 'tag tag-ok' : 'tag tag-warn';

  if (state.awaitingPhoneTicket) {
    el.bannerText.textContent = `${state.awaitingPhoneTicket}번 손님이 번호를 입력하고 있습니다`;
    el.banner.classList.remove('hidden');
  } else {
    el.banner.classList.add('hidden');
  }

  const preparing = state.active.filter((o) => o.status === 'preparing');
  const ready = state.active.filter((o) => o.status === 'ready');

  el.titlePreparing.textContent = `준비중 (${preparing.length})`;
  el.titleReady.textContent = `호출됨 · 픽업 대기 (${ready.length})`;

  el.listPreparing.replaceChildren(...preparing.map(buildCard));
  el.listReady.replaceChildren(...ready.map(buildCard));
  el.emptyPreparing.classList.toggle('hidden', preparing.length > 0);
  el.emptyReady.classList.toggle('hidden', ready.length > 0);

  el.customerUrl.textContent = location.origin + state.customerUrlPath;
  el.notifyInfo.textContent = state.notify.live
    ? `${state.notify.provider} · ${mode}${state.notify.smsFallback ? ' · 실패 시 문자 대체' : ''}`
    : '모의발송 (실제 문자가 나가지 않습니다)';
}

// ---------------------------------------------------------------- 이벤트

el.newOrder.addEventListener('click', () =>
  guard(async () => {
    const result = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ memo: el.memo.value.trim() || null, requestPhone: true }),
    });
    el.memo.value = '';
    toast(`${result.order.ticket}번 주문 · 손님 화면에서 번호 입력`);
  }),
);

el.newOrderNoPhone.addEventListener('click', () =>
  guard(async () => {
    const result = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ memo: el.memo.value.trim() || null, requestPhone: false }),
    });
    el.memo.value = '';
    toast(`${result.order.ticket}번 주문 (번호 없음)`);
  }),
);

$('#open-settings').addEventListener('click', () => el.settings.classList.remove('hidden'));
$('#close-settings').addEventListener('click', () => el.settings.classList.add('hidden'));
$('#open-customer').addEventListener('click', () => {
  if (snapshot) window.open(snapshot.customerUrlPath, '_blank', 'noopener');
});
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

async function refresh() {
  try {
    render(await api('/api/state'));
  } catch {
    /* 스트림이 곧 재연결된다 */
  }
}

function connect() {
  const source = new EventSource('/api/stream');
  source.onmessage = (e) => {
    try {
      render(JSON.parse(e.data));
    } catch {
      /* 잘못된 프레임은 무시 */
    }
  };
  source.onerror = () => setTimeout(refresh, 3000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

refresh();
connect();
