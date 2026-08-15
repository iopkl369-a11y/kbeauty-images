'use strict';

/**
 * 아주 단순한 SSE 허브. 화면(직원/손님)이 여기에 붙어 있다가
 * 주문에 변화가 생기면 곧바로 다시 그린다.
 */
const channels = new Map(); // channel -> Set<res>

function subscribe(channel, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  if (!channels.has(channel)) channels.set(channel, new Set());
  const set = channels.get(channel);
  set.add(res);

  const heartbeat = setInterval(() => {
    // 프록시가 유휴 커넥션을 끊지 않도록 주기적으로 주석 프레임을 보낸다.
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 25_000);
  heartbeat.unref?.();

  function cleanup() {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) channels.delete(channel);
  }

  res.on('close', cleanup);
  res.on('error', cleanup);
  return cleanup;
}

function broadcast(channel, payload) {
  const set = channels.get(channel);
  if (!set || set.size === 0) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...set]) {
    try {
      res.write(frame);
    } catch {
      set.delete(res);
    }
  }
}

function clientCount(channel) {
  const set = channels.get(channel);
  return set ? set.size : 0;
}

module.exports = { subscribe, broadcast, clientCount };
