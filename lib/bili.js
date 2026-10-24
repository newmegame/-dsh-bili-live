/**
 * Bilibili live protocol helpers: room entry, danmaku relay, QR sign-in and
 * danmaku sending. Standard library only.
 */
import { createHash } from 'node:crypto';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { openWebSocket } from './ws.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LIVE_REFERER = 'https://live.bilibili.com/';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export class BiliApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BiliApiError';
    this.code = code;
  }
}

function headers(extra = {}) {
  return {
    'user-agent': UA,
    referer: LIVE_REFERER,
    origin: 'https://live.bilibili.com',
    ...extra,
  };
}

function cookieHeader(auth) {
  if (!auth) return '';
  const parts = [];
  if (auth.sessdata) parts.push(`SESSDATA=${auth.sessdata}`);
  if (auth.biliJct) parts.push(`bili_jct=${auth.biliJct}`);
  if (auth.dedeUserId) parts.push(`DedeUserID=${auth.dedeUserId}`);
  if (auth.buvid3) parts.push(`buvid3=${auth.buvid3}`);
  return parts.join('; ');
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new BiliApiError(`接口返回了非 JSON 内容（HTTP ${res.status}）`, res.status);
  }
}

/**
 * fetch with a hard timeout. Bilibili endpoints occasionally accept a
 * connection and then stall; without this a single hung request would leave
 * the panel's action button disabled forever.
 */
async function request(url, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseSetCookies(headersObject) {
  let list = [];
  if (typeof headersObject.getSetCookie === 'function') {
    list = headersObject.getSetCookie();
  } else {
    const raw = headersObject.get('set-cookie');
    if (raw) list = [raw];
  }
  const jar = {};
  for (const line of list) {
    const first = String(line).split(';')[0] || '';
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

function pickAuthCookies(jar) {
  const out = {};
  if (jar.SESSDATA) out.sessdata = jar.SESSDATA;
  if (jar.bili_jct) out.biliJct = jar.bili_jct;
  if (jar.DedeUserID) out.dedeUserId = jar.DedeUserID;
  if (jar.buvid3) out.buvid3 = jar.buvid3;
  return out;
}

export class BiliLive {
  constructor({ onEvent } = {}) {
    this.onEvent = onEvent || (() => {});
    this.wbi = null;
    this.buvid3 = null;
    this.socket = null;
    this.roomId = 0;
    this.stopped = true;
    this.retry = 0;
    this.retryTimer = null;
    this.beatTimer = null;
    this.watchTimer = null;
    this.lastPacketAt = 0;
    this.roomInfo = null;
    this.connectedAt = 0;
    this.logs = [];
  }

  log(message, level = 'info') {
    const entry = { at: Date.now(), level, message };
    this.logs.push(entry);
    if (this.logs.length > 120) this.logs.shift();
    this.onEvent({ type: 'log', entry });
    if (level === 'error') console.warn(`[bili-live] ${message}`);
    else console.log(`[bili-live] ${message}`);
  }

  #emitState(patch = {}) {
    this.onEvent({ type: 'state', patch });
  }

  async #ensureFingerprint() {
    if (this.buvid3) return this.buvid3;
    const res = await request('https://api.bilibili.com/x/frontend/finger/spi', { headers: headers() });
    const json = await readJson(res);
    this.buvid3 = json?.data?.b_3 || '';
    return this.buvid3;
  }

  async #ensureWbi(force = false) {
    if (!force && this.wbi && Date.now() - this.wbi.at < 60 * 60 * 1000) return this.wbi;
    const buvid3 = await this.#ensureFingerprint();
    const res = await request('https://api.bilibili.com/x/web-interface/nav', {
      headers: headers({ cookie: `buvid3=${buvid3}` }),
    });
    const json = await readJson(res);
    const imgUrl = json?.data?.wbi_img?.img_url;
    const subUrl = json?.data?.wbi_img?.sub_url;
    if (!imgUrl || !subUrl) throw new BiliApiError('无法获取 B 站签名密钥（wbi_img 缺失）');
    const imgKey = String(imgUrl).split('/').pop().split('.')[0];
    const subKey = String(subUrl).split('/').pop().split('.')[0];
    const mixin = MIXIN_TAB.map((index) => (imgKey + subKey)[index] || '').join('').slice(0, 32);
    this.wbi = { imgKey, subKey, mixin, at: Date.now() };
    return this.wbi;
  }

  async #signedQuery(params) {
    const wbi = await this.#ensureWbi();
    const withTs = { ...params, wts: Math.round(Date.now() / 1000) };
    const query = Object.keys(withTs)
      .sort()
      .map(
        (key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(String(withTs[key]).replace(/[!'()*]/g, ''))}`,
      )
      .join('&');
    const wRid = createHash('md5').update(query + wbi.mixin).digest('hex');
    return `${query}&w_rid=${wRid}`;
  }

  async resolveRoom(roomId) {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const fingerprint = await this.#ensureFingerprint();
        const cookie = `buvid3=${fingerprint}`;
        const query = await this.#signedQuery({ id: roomId, type: 0, web_location: 444.8 });
        const res = await request(
          `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
          { headers: headers({ cookie }) },
        );
        const json = await readJson(res);
        if (json.code === 0 && json.data?.token) {
          const hosts = (json.data.host_list || []).filter((item) => item.host);
          if (hosts.length === 0) throw new BiliApiError('弹幕服务器列表为空');
          return { token: json.data.token, hosts };
        }
        if (attempt === 0 && (json.code === -352 || json.code === -403)) {
          await this.#ensureWbi(true);
          this.buvid3 = null;
          await this.#ensureFingerprint();
          continue;
        }
        throw new BiliApiError(`获取弹幕服务器失败：${json.message || json.msg || json.code}`, json.code);
      }
    } catch (error) {
      if (!(error instanceof BiliApiError)) throw error;
    }
    // Legacy room entry. Its token is accepted by the relay even when the WBI
    // entry endpoint is rate limited.
    const res = await request(
      `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
      { headers: headers() },
    );
    const json = await readJson(res);
    if (json.code !== 0) {
      throw new BiliApiError(`无法进入直播间 ${roomId}：${json.message || json.msg || json.code}`, json.code);
    }
    const hosts = (json.data.host_server_list || []).filter((item) => item.host);
    return { token: json.data.token, hosts, legacy: true };
  }

  async roomDetail(roomId) {
    try {
      const res = await request(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
        headers: headers(),
      });
      const json = await readJson(res);
      if (json.code !== 0) {
        this.lastRoomError = json.message || json.msg || `code ${json.code}`;
        return null;
      }
      return {
        roomId: Number(json.data.room_id) || roomId,
        shortId: Number(json.data.short_id) || 0,
        title: json.data.title,
        uname: json.data.uname,
        liveStatus: json.data.live_status,
        online: json.data.online,
        area: `${json.data.parent_area_name || ''} · ${json.data.area_name || ''}`,
      };
    } catch (error) {
      this.lastRoomError = error.message;
      return null;
    }
  }

  async start(roomId) {
    this.stop();
    this.stopped = false;
    this.retry = 0;
    const info = await this.roomDetail(roomId);
    if (!info) {
      const detail = this.lastRoomError ? `（${this.lastRoomError}）` : '';
      throw new BiliApiError(`未找到直播间 ${roomId}，请检查房间号${detail}`);
    }
    this.roomInfo = info;
    // A short id and the real room id are different values; the relay and the
    // send endpoint want the real one.
    this.roomId = info.roomId;
    this.#emitState({ connected: false, connecting: true, roomInfo: this.roomInfo, error: null });
    await this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.beatTimer);
    clearInterval(this.watchTimer);
    this.retryTimer = null;
    this.beatTimer = null;
    this.watchTimer = null;
    if (this.socket) {
      try {
        this.socket.terminate?.() ?? this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    if (this.roomId) this.#emitState({ connected: false, connecting: false });
  }

  async #connect() {
    const roomId = this.roomId;
    this.#emitState({ connected: false, connecting: true, error: null });
    try {
      const { token, hosts } = await this.resolveRoom(roomId);
      if (this.stopped || roomId !== this.roomId) return;
      const host = hosts[Math.floor(Math.random() * hosts.length)];
      const url = `wss://${host.host}:${host.wss_port}/sub`;
      this.log(`连接弹幕服务器 ${host.host}:${host.wss_port}`);
      let opened = false;
      const socket = openWebSocket(url, {
        onOpen: () => {
          opened = true;
          clearTimeout(connectTimer);
          this.retry = 0;
          this.connectedAt = Date.now();
          socket.send(
            encodePacket(7, {
              uid: 0,
              roomid: roomId,
              protover: 3,
              platform: 'web',
              type: 2,
              key: token,
              buvid: this.buvid3 || '',
            }),
          );
          this.#emitState({ connected: true, connecting: false, connectedAt: this.connectedAt });
          this.#startHeartbeat();
        },
        onMessage: (buffer) => {
          this.lastPacketAt = Date.now();
          this.#handlePacket(buffer, roomId);
        },
        onError: (error) => {
          this.log(`弹幕连接错误：${error?.message || error}`, 'error');
          if (!opened) this.#emitState({ connecting: false, connected: false, error: String(error?.message || error) });
        },
        onClose: () => {
          clearTimeout(connectTimer);
          clearInterval(this.beatTimer);
          clearInterval(this.watchTimer);
          if (!this.stopped && this.roomId === roomId) {
            this.#emitState({ connected: false, connecting: true });
            this.#scheduleReconnect();
          }
        },
      });
      const connectTimer = setTimeout(() => {
        if (socket.open) return;
        this.log('弹幕服务器连接超时，准备重连', 'warn');
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }, 15000);
      this.socket = socket;
      if (this.stopped) socket.close();
    } catch (error) {
      this.log(`进入直播间失败：${error?.message || error}`, 'error');
      this.#emitState({ connecting: false, connected: false, error: String(error?.message || error) });
      if (!this.stopped) this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retry += 1;
    const delay = Math.min(30000, 1500 * 2 ** Math.min(this.retry, 5));
    this.log(`将在 ${Math.round(delay / 1000)} 秒后重连（第 ${this.retry} 次）`);
    this.retryTimer = setTimeout(() => {
      if (!this.stopped) this.#connect();
    }, delay);
  }

  #startHeartbeat() {
    clearInterval(this.beatTimer);
    clearInterval(this.watchTimer);
    this.lastPacketAt = Date.now();
    this.beatTimer = setInterval(() => {
      if (this.socket?.open) this.socket.send(encodePacket(2, ''));
    }, 30000);
    // The relay answers every heartbeat, so a silent minute means the socket is
    // half-open. Reconnect instead of waiting for the OS to notice.
    this.watchTimer = setInterval(() => {
      if (Date.now() - this.lastPacketAt > 75000 && this.socket) {
        this.log('弹幕连接静默超时，重建连接', 'warn');
        try {
          this.socket.close();
        } catch {
          /* ignore */
        }
        this.socket = null;
        if (!this.stopped) this.#scheduleReconnect();
      }
    }, 15000);
  }

  #handlePacket(buffer, roomId) {
    let offset = 0;
    while (offset + 16 <= buffer.length) {
      const packetLength = buffer.readUInt32BE(offset);
      const headerLength = buffer.readUInt16BE(offset + 4);
      const version = buffer.readUInt16BE(offset + 6);
      const operation = buffer.readUInt32BE(offset + 8);
      if (packetLength < 16 || offset + packetLength > buffer.length) return;
      const body = buffer.subarray(offset + headerLength, offset + packetLength);
      offset += packetLength;
      if (version === 2 || version === 3) {
        try {
          const inflated = version === 2 ? inflateSync(body) : brotliDecompressSync(body);
          this.#handlePacket(inflated, roomId);
        } catch (error) {
          this.log(`弹幕解压失败：${error.message}`, 'warn');
        }
        continue;
      }
      if (operation === 8) {
        try {
          const reply = JSON.parse(body.toString('utf8'));
          if (reply.code !== 0) this.log(`弹幕服务器拒绝鉴权：${reply.code}`, 'error');
          else this.log('弹幕流鉴权成功');
        } catch {
          /* ignore */
        }
        continue;
      }
      if (operation === 3) {
        if (body.length >= 4) this.onEvent({ type: 'popularity', value: body.readUInt32BE(0) });
        continue;
      }
      if (operation !== 5) continue;
      try {
        const payload = JSON.parse(body.toString('utf8'));
        if (payload.cmd === 'DANMU_MSG' && Array.isArray(payload.info)) this.#handleDanmaku(payload.info);
      } catch {
        /* command payloads we do not consume */
      }
    }
  }

  #handleDanmaku(info) {
    const text = typeof info[1] === 'string' ? info[1] : '';
    const user = Array.isArray(info[2]) ? info[2] : [];
    const uid = Number(user[0] || 0);
    const uname = String(user[1] || '');
    if (!text || !uname) return;
    const medal = Array.isArray(info[3]) ? info[3] : [];
    this.onEvent({
      type: 'danmaku',
      data: {
        uid,
        user: uname,
        text,
        isAdmin: Boolean(user[2]),
        isVip: Boolean(user[3]),
        level: Number(Array.isArray(info[4]) ? info[4][0] : 0) || 0,
        medalLevel: Number(medal[0] || 0),
        medalName: String(medal[1] || ''),
        at: Date.now(),
      },
    });
  }

  async sendDanmaku(auth, roomId, msg) {
    if (!auth?.sessdata) throw new BiliApiError('还没有登录，无法发送弹幕');
    if (!auth?.biliJct) throw new BiliApiError('登录凭据缺少 bili_jct（csrf），请重新扫码登录');
    const text = String(msg || '').trim();
    if (!text) throw new BiliApiError('弹幕内容不能为空');
    if ([...text].length > 20) throw new BiliApiError('B 站弹幕最多 20 个字符');

    const params = {
      bubble: 0,
      msg: text,
      color: 16777215,
      mode: 1,
      fontsize: 25,
      rnd: Math.round(Date.now() / 1000),
      roomid: roomId,
      csrf: auth.biliJct,
      csrf_token: auth.biliJct,
    };
    let usedSignature = true;
    let json;
    try {
      const query = await this.#signedQuery(params);
      const res = await request('https://api.live.bilibili.com/msg/send', {
        method: 'POST',
        headers: headers({
          'content-type': 'application/x-www-form-urlencoded',
          cookie: cookieHeader(auth),
          referer: `https://live.bilibili.com/${roomId}`,
        }),
        body: query,
      });
      json = await readJson(res);
      if (json.code !== 0 && (json.code === -403 || json.code === -352)) {
        usedSignature = false;
        const res2 = await request('https://api.live.bilibili.com/msg/send', {
          method: 'POST',
          headers: headers({
            'content-type': 'application/x-www-form-urlencoded',
            cookie: cookieHeader(auth),
            referer: `https://live.bilibili.com/${roomId}`,
          }),
          body: new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString(),
        });
        json = await readJson(res2);
      }
    } catch (error) {
      throw error instanceof BiliApiError ? error : new BiliApiError(`发送失败：${error.message}`);
    }
    const message = json.message || json.msg || '';
    if (json.code !== 0) {
      throw new BiliApiError(`发送失败（${json.code}）${message ? `：${message}` : ''}`, json.code);
    }
    return { code: json.code, usedSignature, message: message || 'ok' };
  }

  async createQrLogin() {
    const res = await request(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
      { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } },
    );
    const json = await readJson(res);
    if (json.code !== 0 || !json.data?.url) {
      throw new BiliApiError(`生成登录二维码失败：${json.message || json.code}`, json.code);
    }
    return { url: json.data.url, qrcodeKey: json.data.qrcode_key };
  }

  async pollQrLogin(qrcodeKey) {
    const res = await request(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
        qrcodeKey,
      )}&source=main-fe-header`,
      { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } },
    );
    const json = await readJson(res);
    const jar = parseSetCookies(res.headers);
    const code = json?.data?.code ?? json.code;
    const status =
      code === 0 ? 'success' : code === 86090 ? 'scanned' : code === 86038 ? 'expired' : 'waiting';
    return {
      status,
      code,
      message: json?.data?.message || json.message || '',
      cookies: pickAuthCookies(jar),
      allCookies: jar,
    };
  }

  async fetchNav(auth) {
    const res = await request('https://api.bilibili.com/x/web-interface/nav', {
      headers: headers({ cookie: cookieHeader(auth) }),
    });
    const json = await readJson(res);
    if (json.code !== 0 || !json.data?.isLogin) return null;
    return { uname: json.data.uname, mid: json.data.mid, avatar: json.data.face };
  }
}

function encodePacket(operation, body) {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const buffer = Buffer.alloc(16 + payload.length);
  buffer.writeUInt32BE(16 + payload.length, 0);
  buffer.writeUInt16BE(16, 4);
  buffer.writeUInt16BE(1, 6);
  buffer.writeUInt32BE(operation, 8);
  buffer.writeUInt32BE(1, 12);
  payload.copy(buffer, 16);
  return buffer;
}
