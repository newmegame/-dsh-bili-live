/**
 * Minimal RFC 6455 WebSocket client over node:net / node:tls.
 *
 * The plugin runs inside the Harness host process, whose Node runtime may not
 * expose a global `WebSocket`. This implementation depends on nothing beyond
 * the standard library and only supports what the Bilibili danmaku relay needs:
 * text/binary frames, fragmentation, ping/pong and close.
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function frame(payload, opcode) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const masked = Buffer.alloc(4);
  for (let i = 0; i < 4; i += 1) masked[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < body.length; i += 1) body[i] ^= masked[i & 3];
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, masked, body]);
}

export function openWebSocket(rawUrl, handlers = {}) {
  const url = new URL(rawUrl);
  const secure = url.protocol === 'wss:';
  const host = url.hostname;
  const port = Number(url.port || (secure ? 443 : 80));
  const path = `${url.pathname || '/'}${url.search}`;
  const key = randomBytes(16).toString('base64');

  let socket;
  let buffer = Buffer.alloc(0);
  let handshakeDone = false;
  let closeEmitted = false;
  let fragments = [];
  let fragmentsOpcode = 0;
  let closedByUs = false;

  const api = {
    get open() {
      return handshakeDone && !closeEmitted;
    },
    send(data, opcode = OP_BINARY) {
      if (!handshakeDone || !socket || socket.destroyed) return false;
      socket.write(frame(data, opcode));
      return true;
    },
    close(code = 1000, reason = '') {
      closedByUs = true;
      if (!socket || socket.destroyed) return;
      try {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2);
        socket.write(frame(payload, OP_CLOSE));
      } catch {
        /* the socket is already gone */
      }
      setTimeout(() => {
        if (socket && !socket.destroyed) socket.destroy();
      }, 300);
    },
    terminate() {
      closedByUs = true;
      if (socket && !socket.destroyed) socket.destroy();
    },
  };

  function finishClose(code, reason) {
    if (closeEmitted) return;
    closeEmitted = true;
    try {
      handlers.onClose?.({ code, reason });
    } catch {
      /* a handler must never break transport teardown */
    }
  }

  function handleFrame(opcode, payload, fin) {
    if (opcode === OP_PING) {
      if (handshakeDone) socket.write(frame(payload, OP_PONG));
      return;
    }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      try {
        if (handshakeDone) socket.write(frame(payload, OP_CLOSE));
      } catch {
        /* ignore */
      }
      socket.end();
      finishClose(code, reason);
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      fragments = [payload];
      fragmentsOpcode = opcode;
    } else if (opcode === OP_CONTINUATION) {
      fragments.push(payload);
    } else {
      return;
    }
    if (!fin) return;
    const whole = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
    fragments = [];
    try {
      handlers.onMessage?.(whole, fragmentsOpcode === OP_TEXT ? 'text' : 'binary');
    } catch (error) {
      handlers.onError?.(error);
    }
  }

  function consume(chunk) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) {
          socket.destroy();
          return;
        }
        length = Number(big);
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      buffer = buffer.subarray(offset + length);
      handleFrame(opcode, payload, fin);
    }
  }

  function onData(chunk) {
    if (handshakeDone) {
      consume(chunk);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const head = buffer.subarray(0, end).toString('latin1');
    const rest = buffer.subarray(end + 4);
    buffer = Buffer.alloc(0);
    const statusLine = head.split('\r\n')[0] || '';
    if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
      socket.destroy();
      handlers.onError?.(new Error(`WebSocket handshake failed: ${statusLine}`));
      return;
    }
    handshakeDone = true;
    handlers.onOpen?.();
    if (rest.length > 0) consume(rest);
  }

  try {
    socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
  } catch (error) {
    handlers.onError?.(error);
    return api;
  }

  socket.setNoDelay?.(true);
  socket.on('error', (error) => {
    handlers.onError?.(error);
  });
  socket.on('close', () => {
    finishClose(closedByUs ? 1000 : 1006, closedByUs ? 'client closed' : 'socket closed');
  });
  socket.on('data', onData);

  const start = () => {
    const hostHeader = url.port ? `${host}:${url.port}` : host;
    socket.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36\r\n' +
        '\r\n',
    );
  };

  if (secure) {
    socket.once('secureConnect', start);
  } else {
    socket.once('connect', start);
  }

  return api;
}
