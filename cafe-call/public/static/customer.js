'use strict';
/* 손님 전용 입력 디스플레이. 터치 숫자패드와 USB 숫자키패드 입력을 모두 받는다. */

const KEY = location.pathname.split('/')[2];
const MAX_DIGITS = 11;
const MIN_DIGITS = 10;
const DONE_SCREEN_MS = 3500;

const $ = (sel) => document.querySelector(sel);
const el = {
  offline: $('#offline'),
  storeName: $('#store-name'),
  ticketBadge: $('#ticket-badge'),
  ticketNum: $('#ticket-num'),
  viewIdle: $('#view-idle'),
  viewInput: $('#view-input'),
  viewDone: $('#view-done'),
  number: $('#number'),
  confirm: $('#confirm'),
  skip: $('#skip'),
  pad: $('#pad'),
  doneTicket: $('#done-ticket'),
};

let state = { mode: 'idle', orderId: null, ticket: null, storeName: '' };
let digits = '';
let doneUntil = 0;
let doneTimer = null;
let sending = false;

// ---------------------------------------------------------------- 렌더링

function renderNumber() {
  el.number.textContent = '';
  const groups = [3, 4, 4];
  let idx = 0;
  groups.forEach((len, groupIndex) => {
    if (groupIndex > 0) {
      const dash = document.createElement('span');
      dash.className = 'dash';
      dash.textContent = '-';
      el.number.append(dash);
    }
    for (let i = 0; i < len; i++, idx++) {
      const slot = document.createElement('span');
      const char = digits[idx];
      slot.className = char ? 'slot' : 'slot empty';
      slot.textContent = char || '·';
      el.number.append(slot);
    }
  });
  el.number.classList.toggle('filled', digits.length >= MIN_DIGITS);
  el.confirm.disabled = digits.length < MIN_DIGITS || sending;
}

function show(view) {
  el.viewIdle.classList.toggle('hidden', view !== 'idle');
  el.viewInput.classList.toggle('hidden', view !== 'input');
  el.viewDone.classList.toggle('hidden', view !== 'done');
}

function render() {
  el.storeName.textContent = state.storeName || '';

  if (Date.now() < doneUntil) {
    el.ticketBadge.classList.add('hidden');
    show('done');
    return;
  }

  if (state.mode === 'input') {
    el.ticketNum.textContent = state.ticket ?? '0';
    el.ticketBadge.classList.remove('hidden');
    show('input');
    renderNumber();
  } else {
    el.ticketBadge.classList.add('hidden');
    show('idle');
  }
}

function showDone(ticket) {
  el.doneTicket.textContent = ticket ?? '';
  doneUntil = Date.now() + DONE_SCREEN_MS;
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => {
    doneUntil = 0;
    render();
  }, DONE_SCREEN_MS);
  render();
}

function buzz(ms = 12) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// ---------------------------------------------------------------- 입력 처리

function press(key) {
  if (state.mode !== 'input' || Date.now() < doneUntil) return;

  if (key === 'back') {
    digits = digits.slice(0, -1);
    buzz();
  } else if (key === 'clear') {
    digits = '';
    buzz();
  } else if (key === 'confirm') {
    submit();
    return;
  } else if (/^\d$/.test(key)) {
    if (digits.length >= MAX_DIGITS) return;
    digits += key;
    buzz();
  } else {
    return;
  }
  renderNumber();
}

function rejectInput() {
  el.number.classList.add('shake');
  setTimeout(() => el.number.classList.remove('shake'), 450);
  buzz(120);
}

async function submit() {
  if (sending || digits.length < MIN_DIGITS) return;
  sending = true;
  renderNumber();
  try {
    const res = await fetch(`/api/c/${KEY}/phone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: state.orderId, phone: digits }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      rejectInput();
      // 주문이 바뀐 경우라면 서버 상태를 다시 받아 화면을 맞춘다.
      if (res.status === 409) await refresh();
      return;
    }
    const ticket = body.ticket ?? state.ticket;
    digits = '';
    showDone(ticket);
  } catch {
    rejectInput();
  } finally {
    sending = false;
    renderNumber();
  }
}

async function skip() {
  if (state.mode !== 'input' || sending) return;
  sending = true;
  try {
    await fetch(`/api/c/${KEY}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: state.orderId }),
    });
    digits = '';
  } catch {
    /* 실패해도 다음 상태 갱신으로 정리된다 */
  } finally {
    sending = false;
  }
}

el.pad.addEventListener('click', (e) => {
  const button = e.target.closest('[data-key]');
  if (button) press(button.dataset.key);
});

el.skip.addEventListener('click', skip);

// USB 숫자키패드(넘버키)로도 그대로 입력할 수 있게 한다.
window.addEventListener('keydown', (e) => {
  if (e.key >= '0' && e.key <= '9') press(e.key);
  else if (e.key === 'Backspace') press('back');
  else if (e.key === 'Enter') press('confirm');
  else if (e.key === 'Escape' || e.key === 'Delete') press('clear');
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- 서버 연결

function applyState(next) {
  const orderChanged = next.orderId !== state.orderId;
  state = next;
  // 다음 손님 차례가 되면 앞 손님이 누르던 숫자가 남아 있으면 안 된다.
  if (orderChanged) digits = '';
  render();
}

async function refresh() {
  try {
    const res = await fetch(`/api/c/${KEY}/state`);
    if (res.ok) applyState(await res.json());
  } catch {
    /* 스트림이 곧 재연결된다 */
  }
}

function connect() {
  const source = new EventSource(`/api/c/${KEY}/stream`);

  source.onopen = () => el.offline.classList.add('hidden');

  source.onmessage = (e) => {
    el.offline.classList.add('hidden');
    try {
      applyState(JSON.parse(e.data));
    } catch {
      /* 잘못된 프레임은 무시 */
    }
  };

  source.onerror = () => {
    el.offline.classList.remove('hidden');
    // EventSource 가 알아서 재연결하지만, 끊긴 동안의 변화를 놓치지 않도록 한 번 더 받아온다.
    setTimeout(refresh, 3000);
  };
}

/** 손님이 보는 화면이므로 자동으로 꺼지지 않게 잡아둔다. */
async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  try {
    await navigator.wakeLock.request('screen');
  } catch {
    /* 브라우저가 거부하면 그대로 둔다 */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
    refresh();
  }
});

render();
refresh();
connect();
keepAwake();
