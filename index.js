/**
 * Host half of the Bilibili live assistant.
 *
 * Owns the danmaku relay connection, the QR sign-in session, the reply engine
 * and one small HTTP surface the panel talks to. The panel is the only client;
 * it reaches these routes on the same origin as the Harness Web GUI.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BiliApiError, BiliLive } from './lib/bili.js';

const require = createRequire(import.meta.url);

let qrcode = null;
try {
  qrcode = require('./vendor/qrcode-generator.cjs');
} catch {
  qrcode = null;
}

const MAX_RECENT = 60;
const STATE_DIR = join(process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'bili-live');
const STATE_FILE = join(STATE_DIR, 'state.json');

const DEFAULT_RULES = [
  { keyword: '你好', reply: '{user} 你好呀，欢迎来到直播间~' },
  { keyword: '来了', reply: '欢迎 {user} 来到直播间！' },
  { keyword: '关注', reply: '谢谢关注，常来玩呀~' },
];

const DEFAULT_SYSTEM_PROMPT =
  '你在替主播回复直播间弹幕。只输出一句不超过 20 个字的简体中文回复，语气自然、口语化，' +
  '像主播本人在聊天；不要使用引号、换行、颜文字或表情代码，不要提到自己是 AI 或机器人。';

const BUILTIN_STYLES = [
  { id: 'natural', name: '自然', builtin: true, prompt: '语气自然、口语化，像主播平时和观众聊天，不端着。' },
  { id: 'lively', name: '元气', builtin: true, prompt: '语气活泼有精神，短句为主，可以带感叹号，像个有活力的主播。' },
  { id: 'gentle', name: '温柔', builtin: true, prompt: '语气温柔耐心，像轻声聊天，不催促、不怼人。' },
  { id: 'cool', name: '高冷', builtin: true, prompt: '话少、简短、有点酷，不解释太多，不刻意卖萌。' },
  { id: 'funny', name: '整活', builtin: true, prompt: '爱接梗、会自嘲，带点幽默和夸张，但别油腻、别冒犯。' },
  { id: 'sweet', name: '甜妹', builtin: true, prompt: '语气甜、软，自然使用「呀」「啦」「嘛」这类语气词，不腻。' },
  { id: 'acg', name: '二次元', builtin: true, prompt: '二次元浓度稍高，可以用常见梗和「喵」「欸嘿」这类语气，别过度。' },
  { id: 'blunt', name: '直球', builtin: true, prompt: '直接回答、不绕弯，短句为主，偶尔轻吐槽。' },
];

function defaults() {
  return {
    roomId: 0,
    enabled: true,
    autoReply: true,
    aiEnabled: true,
    dryRun: true,
    cooldownMs: 12000,
    maxPerMinute: 5,
    perUserCooldownMs: 120000,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    rules: DEFAULT_RULES.map((rule) => ({ ...rule })),
    bannedWords: [],
    style: { activeId: 'natural', custom: [] },
    auth: null,
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function safeText(value, max) {
  return String(value ?? '').slice(0, max);
}

function sanitizeReply(raw) {
  let text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'“”‘’「」『』《》]+/, '').replace(/["'“”‘’「」『』《》]+$/, '');
  text = text.replace(/^(回复|回答|答|说)[：:]\s*/, '');
  return [...text].slice(0, 20).join('');
}

function renderTemplate(template, entry) {
  return String(template)
    .replaceAll('{user}', entry.user)
    .replaceAll('{text}', entry.text);
}

/** Returns the first configured word contained in `text`, or null. */
function findBanned(text, words) {
  const source = String(text || '').toLowerCase();
  for (const word of words || []) {
    const needle = String(word || '').trim().toLowerCase();
    if (needle && source.includes(needle)) return String(word).trim();
  }
  return null;
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A style is one active entry plus the user's own entries. Built-in entries are
 * code-owned, so only `activeId` and `custom` are persisted.
 */
function normalizeStyle(next, fallback) {
  const source = next && typeof next === 'object' ? next : {};
  const previous = fallback && typeof fallback === 'object' ? fallback : {};
  const rawCustom = Array.isArray(source.custom) ? source.custom : Array.isArray(previous.custom) ? previous.custom : [];
  const custom = [];
  const seen = new Set();
  for (const item of rawCustom.slice(0, 30)) {
    const name = safeText(item?.name, 20).trim();
    const prompt = safeText(item?.prompt, 300).trim();
    if (!name || !prompt) continue;
    const id = safeText(item?.id, 60).trim() || `custom-${makeId()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    custom.push({ id, name, prompt });
  }
  const validIds = new Set([...BUILTIN_STYLES.map((style) => style.id), ...custom.map((item) => item.id)]);
  let activeId = safeText(source.activeId ?? previous.activeId ?? 'natural', 60);
  if (!validIds.has(activeId)) activeId = 'natural';
  return { activeId, custom };
}

export const inject = ['webServer', 'tools'];

export function apply(ctx) {
  const webServer = ctx.webServer;
  const settings = defaults();
  const status = {
    connected: false,
    connecting: false,
    error: null,
    popularity: 0,
    connectedAt: 0,
    roomInfo: null,
  };
  const recent = [];
  const replied = [];
  const seen = new Map();
  const perUser = new Map();
  const minuteWindow = [];
  const listeners = new Set();
  const logs = [];
  const stats = { received: 0, generated: 0, sent: 0, dry: 0, failed: 0, skipped: 0, blocked: 0 };
  let lastSentAt = 0;
  let pendingEcho = null;
  let queue = [];
  let pumping = false;
  let broadcastTimer = null;
  let saveTimer = null;
  let loginTimer = null;
  let loginExpiryTimer = null;
  let loginGeneration = 0;
  let login = { status: 'idle', qr: null, startedAt: 0, message: '' };
  let llmInfo = { available: false, provider: null, model: null, error: null };
  let llmResolved = false;

  const bili = new BiliLive({
    onEvent: (event) => {
      if (event.type === 'state') {
        Object.assign(status, event.patch);
        if (event.patch.connected) status.error = null;
        scheduleBroadcast();
        return;
      }
      if (event.type === 'popularity') {
        status.popularity = event.value;
        scheduleBroadcast();
        return;
      }
      if (event.type === 'log') {
        pushLog(event.entry.message, event.entry.level);
        return;
      }
      if (event.type === 'danmaku') {
        onDanmaku(event.data);
      }
    },
  });

  function pushLog(message, level = 'info') {
    logs.push({ at: Date.now(), level, message: safeText(message, 500) });
    if (logs.length > 80) logs.shift();
    scheduleBroadcast();
  }

  const ready = (async () => {
    try {
      const raw = await readFile(STATE_FILE, 'utf8');
      const stored = JSON.parse(raw);
      Object.assign(settings, stored);
      settings.rules = Array.isArray(settings.rules) && settings.rules.length > 0 ? settings.rules : defaults().rules;
      settings.systemPrompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      settings.style = normalizeStyle(settings.style, defaults().style);
      if (settings.auth && !settings.auth.sessdata) settings.auth = null;
    } catch (error) {
      if (error && error.code !== 'ENOENT') pushLog(`读取本地配置失败：${error.message}`, 'warn');
    }
  })();

  async function writeStateNow() {
    try {
      await mkdir(dirname(STATE_FILE), { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      pushLog(`保存本地配置失败：${error.message}`, 'error');
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void writeStateNow();
    }, 200);
  }

  function scheduleBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcast();
    }, 200);
  }

  function broadcast() {
    if (listeners.size === 0) return;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of listeners) {
      try {
        res.write(payload);
      } catch {
        listeners.delete(res);
      }
    }
  }

  function snapshot() {
    const auth = settings.auth;
    return {
      // A server-generated timestamp lets the panel drop any snapshot that was
      // produced before one it has already applied (SSE vs. POST vs. poll).
      sentAt: Date.now(),
      status: {
        connected: status.connected,
        connecting: status.connecting,
        error: status.error,
        popularity: status.popularity,
        connectedAt: status.connectedAt,
        roomInfo: status.roomInfo,
        roomId: settings.roomId,
      },
      settings: {
        roomId: settings.roomId,
        enabled: settings.enabled,
        autoReply: settings.autoReply,
        aiEnabled: settings.aiEnabled,
        dryRun: settings.dryRun,
        cooldownMs: settings.cooldownMs,
        maxPerMinute: settings.maxPerMinute,
        perUserCooldownMs: settings.perUserCooldownMs,
        systemPrompt: settings.systemPrompt,
        rules: settings.rules,
        bannedWords: settings.bannedWords,
        style: settings.style,
      },
      stylePresets: BUILTIN_STYLES,
      login: auth?.sessdata
        ? {
            configured: true,
            uname: auth.uname || '',
            uid: auth.uid || 0,
            savedAt: auth.savedAt || 0,
            error: status.error && /登录|未登录|csrf/i.test(status.error) ? status.error : null,
          }
        : { configured: false },
      loginFlow: login,
      llm: llmInfo,
      stats: { ...stats },
      recent: recent.slice(-40),
      replies: replied.slice(-30),
      logs: logs.slice(-25),
      storagePath: STATE_FILE,
    };
  }

  function onDanmaku(data) {
    stats.received += 1;
    if (pendingEcho && data.text === pendingEcho.text && Date.now() - pendingEcho.at < 15000) {
      pendingEcho = null;
      pushLog('弹幕回显确认：已出现在直播间弹幕流中');
    }
    const entry = {
      id: makeId(),
      uid: data.uid,
      user: data.user,
      text: data.text,
      at: data.at,
      isAdmin: data.isAdmin,
      medalLevel: data.medalLevel,
      reply: null,
    };
    recent.push(entry);
    if (recent.length > MAX_RECENT) recent.shift();
    if (seen.size > 500) seen.clear();
    const blockedBy = findBanned(entry.text, settings.bannedWords);
    if (blockedBy) {
      entry.blocked = blockedBy;
      stats.blocked += 1;
      scheduleBroadcast();
      return;
    }
    scheduleBroadcast();
    if (settings.enabled && settings.autoReply) {
      if (queue.length > 30) queue.shift();
      queue.push(entry);
      void pump();
    }
  }

  function limitReason(entry) {
    const now = Date.now();
    if (settings.auth?.uid && entry.uid === Number(settings.auth.uid)) return '自己的弹幕';
    if (entry.text.startsWith('/')) return '命令式弹幕';
    const key = `${entry.uid}:${entry.text}`;
    const duplicateAt = seen.get(key);
    seen.set(key, now);
    if (duplicateAt && now - duplicateAt < 60000) return '重复内容';
    if (now - lastSentAt < settings.cooldownMs) return '全局冷却中';
    const userAt = perUser.get(entry.uid) || 0;
    if (now - userAt < settings.perUserCooldownMs) return '该用户冷却中';
    while (minuteWindow.length > 0 && now - minuteWindow[0] > 60000) minuteWindow.shift();
    if (minuteWindow.length >= settings.maxPerMinute) return '每分钟上限';
    return null;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const entry = queue.shift();
        await handleReply(entry);
      }
    } finally {
      pumping = false;
    }
  }

  async function handleReply(entry) {
    if (!settings.enabled || !settings.autoReply) return;
    if (!status.connected || !bili.roomId) return;
    if (!entry.reply) {
      const reason = limitReason(entry);
      if (reason) {
        stats.skipped += 1;
        return;
      }
    }
    let text = null;
    const rule = settings.rules.find(
      (item) => item.keyword && entry.text.toLowerCase().includes(String(item.keyword).toLowerCase()),
    );
    if (rule) {
      text = sanitizeReply(renderTemplate(rule.reply, entry));
    } else if (settings.aiEnabled) {
      text = await aiReply(entry);
    }
    if (!text) return;
    let bannedHit = findBanned(text, settings.bannedWords);
    if (bannedHit && !rule && settings.aiEnabled) {
      // One retry that names the forbidden words is usually enough; a rule
      // template is fixed, so retrying it would produce the same text.
      text = await aiReply(entry, settings.bannedWords);
      bannedHit = text ? findBanned(text, settings.bannedWords) : null;
    }
    if (!text) return;
    stats.generated += 1;
    const reply = { text, status: 'pending', at: Date.now(), rule: rule?.keyword || null };
    entry.reply = reply;
    replied.push(entry);
    if (replied.length > 30) replied.shift();
    if (bannedHit) {
      reply.status = 'blocked';
      reply.error = `命中违禁词「${bannedHit}」`;
      stats.blocked += 1;
      pushLog(`回复被违禁词拦截 ${entry.user}：${text}`, 'warn');
      scheduleBroadcast();
      return;
    }
    pushLog(`${settings.dryRun ? '预演回复' : '回复'} ${entry.user}：${text}`);
    scheduleBroadcast();

    if (settings.dryRun) {
      reply.status = 'dry';
      stats.dry += 1;
      // Rate windows advance in rehearsal too, so switching to live sending
      // does not start from a burst of queued replies.
      lastSentAt = Date.now();
      minuteWindow.push(lastSentAt);
      perUser.set(entry.uid, lastSentAt);
      scheduleBroadcast();
      return;
    }
    try {
      if (!status.connected || !bili.roomId) {
        reply.status = 'failed';
        reply.error = '已断开直播间，未发送';
        stats.failed += 1;
        scheduleBroadcast();
        return;
      }
      await bili.sendDanmaku(settings.auth, bili.roomId || settings.roomId, text);
      pendingEcho = { text, at: Date.now() };
      reply.status = 'sent';
      stats.sent += 1;
      lastSentAt = Date.now();
      minuteWindow.push(lastSentAt);
      perUser.set(entry.uid, lastSentAt);
    } catch (error) {
      reply.status = 'failed';
      reply.error = safeText(error.message, 300);
      stats.failed += 1;
      pushLog(`回复失败：${reply.error}`, 'error');
    }
    scheduleBroadcast();
  }

  async function resolveLlm() {
    if (llmResolved) return llmInfo;
    llmResolved = true;
    const llm = ctx.get('llm');
    if (!llm) {
      llmInfo = { available: false, provider: null, model: null, error: '当前配置没有挂载 llm 服务' };
      return llmInfo;
    }
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      let provider = selection?.provider || null;
      let model = selection?.model || null;
      if (!provider) provider = llm.listProviders?.()[0]?.id || null;
      if (provider && !model) {
        const models = await llm.listModels(provider);
        model = models?.[0]?.id || null;
      }
      llmInfo = { available: Boolean(provider && model), provider, model, error: provider && model ? null : '没有可用的模型' };
    } catch (error) {
      llmInfo = { available: false, provider: null, model: null, error: safeText(error.message, 300) };
    }
    scheduleBroadcast();
    return llmInfo;
  }

  function activeStyle() {
    const style = settings.style || { activeId: 'natural', custom: [] };
    return (
      [...BUILTIN_STYLES, ...(style.custom || [])].find((item) => item.id === style.activeId) ||
      BUILTIN_STYLES[0]
    );
  }

  async function aiReply(entry, avoid = null) {
    const info = await resolveLlm();
    if (!info.available) return null;
    const llm = ctx.get('llm');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const prompt = `直播间：${status.roomInfo?.title || settings.roomId}\n弹幕（${entry.user}）：${entry.text}`;
      const style = activeStyle();
      const styleLine = style
        ? `\n当前回复风格为「${style.name}」，优先于上面的语气要求，请严格按这个风格说话：${style.prompt}`
        : '';
      const avoidLine = Array.isArray(avoid) && avoid.length > 0 ? `\n回复中绝对不要出现这些词：${avoid.join('、')}` : '';
      const stream = llm.stream({
        provider: info.provider,
        model: info.model,
        system: `${settings.systemPrompt || DEFAULT_SYSTEM_PROMPT}${styleLine}${avoidLine}`,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 80,
        temperature: 0.9,
        signal: controller.signal,
      });
      let out = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') out += chunk.text;
        if (chunk.type === 'finish') break;
      }
      return sanitizeReply(out) || null;
    } catch (error) {
      pushLog(`AI 回复失败：${error.message}`, 'warn');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function startLogin() {
    if (!qrcode) throw new BiliApiError('二维码组件没有加载，无法生成登录二维码');
    stopLoginPolling();
    const generation = ++loginGeneration;
    pushLog('正在生成登录二维码…');
    const { url, qrcodeKey } = await bili.createQrLogin();
    if (generation !== loginGeneration) return;
    const qr = renderQr(url);
    login = { status: 'waiting', qr, startedAt: Date.now(), message: '请用哔哩哔哩手机客户端扫码' };
    pushLog('二维码已生成，等待扫码');
    scheduleBroadcast();
    loginTimer = setInterval(() => {
      void pollLogin(qrcodeKey, generation);
    }, 2000);
    loginExpiryTimer = setTimeout(() => {
      if (generation !== loginGeneration) return;
      if (login.status === 'waiting' || login.status === 'scanned') {
        login = { status: 'expired', qr: null, startedAt: login.startedAt, message: '二维码已过期，请重新获取' };
        stopLoginPolling();
        pushLog('登录二维码已过期', 'warn');
        scheduleBroadcast();
      }
    }, 180000);
  }

  async function pollLogin(qrcodeKey, generation) {
    try {
      const result = await bili.pollQrLogin(qrcodeKey);
      if (generation !== loginGeneration) return;
      if (result.status === 'waiting') return;
      if (result.status === 'scanned') {
        if (login.status !== 'scanned') {
          login = { ...login, status: 'scanned', message: '已扫码，请在手机上确认登录' };
          pushLog('已扫码，等待手机确认');
          scheduleBroadcast();
        }
        return;
      }
      if (result.status === 'expired') {
        stopLoginPolling();
        login = { ...login, status: 'expired', qr: null, message: '二维码已过期，请重新获取' };
        pushLog('登录二维码已过期', 'warn');
        scheduleBroadcast();
        return;
      }
      if (result.status === 'success') {
        stopLoginPolling();
        const cookies = result.cookies || {};
        if (!cookies.sessdata) {
          login = { ...login, status: 'error', message: '登录成功但没有拿到 SESSDATA，请重试' };
          pushLog('登录成功但没有拿到 SESSDATA', 'error');
          scheduleBroadcast();
          return;
        }
        const auth = {
          sessdata: cookies.sessdata,
          biliJct: cookies.biliJct,
          dedeUserId: cookies.dedeUserId,
          buvid3: cookies.buvid3 || bili.buvid3 || '',
          savedAt: Date.now(),
        };
        try {
          const nav = await bili.fetchNav(auth);
          if (nav) {
            auth.uname = nav.uname;
            auth.uid = nav.mid;
          }
        } catch {
          /* the cookie itself is what matters */
        }
        settings.auth = auth;
        save();
        login = { status: 'success', qr: null, startedAt: login.startedAt, message: `已登录：${auth.uname || auth.dedeUserId || ''}` };
        pushLog(`扫码登录成功：${auth.uname || auth.dedeUserId}`);
        scheduleBroadcast();
      }
    } catch (error) {
      pushLog(`轮询登录状态失败：${error.message}`, 'warn');
    }
  }

  function stopLoginPolling() {
    loginGeneration += 1;
    clearInterval(loginTimer);
    loginTimer = null;
    clearTimeout(loginExpiryTimer);
    loginExpiryTimer = null;
  }

  function renderQr(text) {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const rows = [];
    for (let row = 0; row < count; row += 1) {
      let line = '';
      for (let column = 0; column < count; column += 1) line += qr.isDark(row, column) ? '1' : '0';
      rows.push(line);
    }
    return { count, rows };
  }

  function send(res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new BiliApiError('请求体过大');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new BiliApiError('请求体不是合法 JSON');
    }
  }

  async function route(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/bili-live';
    const method = req.method || 'GET';

    let allowedOrigin = null;
    try {
      allowedOrigin = webServer.getOrigin();
    } catch {
      allowedOrigin = null;
    }
    const origin = req.headers.origin;
    if (origin && allowedOrigin && origin !== allowedOrigin) {
      send(res, 403, { error: 'origin not allowed' });
      return;
    }
    if (method !== 'GET' && req.headers['x-bili-live'] !== '1') {
      send(res, 403, { error: 'missing x-bili-live header' });
      return;
    }
    await ready;

    try {
      if (method === 'GET' && path === '/bili-live/state') {
        send(res, 200, snapshot());
        return;
      }

      if (method === 'GET' && path === '/bili-live/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        listeners.add(res);
        req.on('close', () => listeners.delete(res));
        return;
      }

      if (method === 'POST' && path === '/bili-live/settings') {
        const body = await readBody(req);
        const next = body.settings || body;
        if (next.roomId !== undefined) {
          // Editing the room field only persists it; connecting stays an
          // explicit action so a half-typed number cannot kill a live session.
          settings.roomId = clampNumber(next.roomId, 0, 4294967295, settings.roomId);
        }
        if (next.enabled !== undefined) settings.enabled = Boolean(next.enabled);
        if (next.autoReply !== undefined) settings.autoReply = Boolean(next.autoReply);
        if (next.aiEnabled !== undefined) settings.aiEnabled = Boolean(next.aiEnabled);
        if (next.dryRun !== undefined) settings.dryRun = Boolean(next.dryRun);
        if (next.cooldownMs !== undefined) settings.cooldownMs = clampNumber(next.cooldownMs, 1000, 120000, settings.cooldownMs);
        if (next.maxPerMinute !== undefined) settings.maxPerMinute = clampNumber(next.maxPerMinute, 1, 60, settings.maxPerMinute);
        if (next.perUserCooldownMs !== undefined) {
          settings.perUserCooldownMs = clampNumber(next.perUserCooldownMs, 0, 3600000, settings.perUserCooldownMs);
        }
        if (next.systemPrompt !== undefined) settings.systemPrompt = safeText(next.systemPrompt, 2000) || DEFAULT_SYSTEM_PROMPT;
        if (Array.isArray(next.bannedWords)) {
          const seen = new Set();
          settings.bannedWords = [];
          for (const word of next.bannedWords.slice(0, 300)) {
            const clean = safeText(word, 30).trim();
            if (!clean || seen.has(clean.toLowerCase())) continue;
            seen.add(clean.toLowerCase());
            settings.bannedWords.push(clean);
          }
        }
        if (next.style !== undefined) settings.style = normalizeStyle(next.style, settings.style);
        if (Array.isArray(next.rules)) {
          settings.rules = next.rules.slice(0, 50).map((rule) => ({
            keyword: safeText(rule?.keyword, 40),
            reply: safeText(rule?.reply, 120),
          }));
        }
        save();
        broadcast();
        send(res, 200, snapshot());
        return;
      }

      if (method === 'POST' && path === '/bili-live/connect') {
        const body = await readBody(req);
        const rawRoom = Number(body.roomId ?? settings.roomId);
        if (!Number.isFinite(rawRoom) || rawRoom < 1) {
          send(res, 400, { error: '请先填写直播间房间号' });
          return;
        }
        const roomId = clampNumber(rawRoom, 1, 4294967295, 0);
        queue.length = 0;
        try {
          await bili.start(roomId);
        } catch (error) {
          send(res, 400, { error: error.message });
          return;
        }
        // `start` resolves the real room id (a short id is a different value),
        // and that is what the send endpoint must use.
        settings.roomId = bili.roomId;
        save();
        pushLog(`连接直播间 ${bili.roomId}${status.roomInfo?.title ? `（${status.roomInfo.title}）` : ''}`);
        send(res, 200, snapshot());
        return;
      }

      if (method === 'POST' && path === '/bili-live/disconnect') {
        queue.length = 0;
        pendingEcho = null;
        bili.stop();
        pushLog('已断开直播间');
        send(res, 200, snapshot());
        return;
      }

      if (method === 'POST' && path === '/bili-live/login/start') {
        await startLogin();
        send(res, 200, snapshot());
        return;
      }

      if (method === 'POST' && path === '/bili-live/login/cancel') {
        stopLoginPolling();
        login = { status: 'idle', qr: null, startedAt: 0, message: '' };
        scheduleBroadcast();
        send(res, 200, snapshot());
        return;
      }

      if (method === 'POST' && path === '/bili-live/login/cookie') {
        const body = await readBody(req);
        const sessdata = String(body.sessdata || '').trim();
        const biliJct = String(body.biliJct || '').trim();
        const dedeUserId = String(body.dedeUserId || '').trim();
        if (!sessdata) {
          send(res, 400, { error: '请填写 SESSDATA' });
          return;
        }
        const auth = {
          sessdata,
          biliJct,
          dedeUserId,
          buvid3: bili.buvid3 || '',
          savedAt: Date.now(),
        };
        try {
          const nav = await bili.fetchNav(auth);
          if (!nav) {
            send(res, 400, { error: 'Cookie 无效或登录态已过期，请重新复制' });
            return;
          }
          auth.uname = nav.uname;
          auth.uid = nav.mid;
          settings.auth = auth;
          save();
          login = { status: 'success', qr: null, startedAt: 0, message: `已登录：${nav.uname}` };
          pushLog(`手动 Cookie 登录成功：${nav.uname}`);
          broadcast();
          send(res, 200, snapshot());
        } catch (error) {
          send(res, 400, { error: `验证 Cookie 失败：${error.message}` });
        }
        return;
      }

      if (method === 'POST' && path === '/bili-live/logout') {
        stopLoginPolling();
        login = { status: 'idle', qr: null, startedAt: 0, message: '' };
        pendingEcho = null;
        settings.auth = null;
        // Write through immediately: a debounced save could lose the logout if
        // the app restarts in the next 200ms.
        await writeStateNow();
        pushLog('已退出 B 站登录');
        broadcast();
        send(res, 200, snapshot());
        return;
      }

      if (method === 'POST' && path === '/bili-live/send') {
        const body = await readBody(req);
        const text = sanitizeReply(body.text);
        if (!text) {
          send(res, 400, { error: '弹幕内容为空' });
          return;
        }
        const bannedHit = findBanned(text, settings.bannedWords);
        if (bannedHit) {
          send(res, 400, { error: `弹幕包含违禁词「${bannedHit}」，已拦截` });
          return;
        }
        if (!settings.roomId) {
          send(res, 400, { error: '还没有连接直播间' });
          return;
        }
        if (!status.connected || !bili.roomId) {
          send(res, 400, { error: '弹幕连接尚未就绪，请先连接直播间' });
          return;
        }
        try {
          await bili.sendDanmaku(settings.auth, bili.roomId, text);
          pendingEcho = { text, at: Date.now() };
          lastSentAt = Date.now();
          minuteWindow.push(lastSentAt);
          pushLog(`手动发送到 ${status.roomInfo?.title || `房间 ${bili.roomId}`}：${text}`);
          send(res, 200, { ok: true, text, roomId: bili.roomId, roomTitle: status.roomInfo?.title || '' });
        } catch (error) {
          send(res, 400, { error: error.message });
        }
        return;
      }

      if (method === 'POST' && path === '/bili-live/reply-now') {
        const body = await readBody(req);
        const entry = recent.find((item) => item.id === body.id);
        if (!entry?.reply?.text) {
          send(res, 404, { error: '这条弹幕还没有生成回复' });
          return;
        }
        const replyHit = findBanned(entry.reply.text, settings.bannedWords);
        if (replyHit) {
          entry.reply.status = 'blocked';
          entry.reply.error = `命中违禁词「${replyHit}」`;
          stats.blocked += 1;
          scheduleBroadcast();
          send(res, 400, { error: `回复包含违禁词「${replyHit}」，已拦截` });
          return;
        }
        try {
          await bili.sendDanmaku(settings.auth, bili.roomId || settings.roomId, entry.reply.text);
          entry.reply.status = 'sent';
          entry.reply.error = null;
          stats.sent += 1;
          lastSentAt = Date.now();
          minuteWindow.push(lastSentAt);
          perUser.set(entry.uid, lastSentAt);
          scheduleBroadcast();
          send(res, 200, snapshot());
        } catch (error) {
          entry.reply.status = 'failed';
          entry.reply.error = error.message;
          scheduleBroadcast();
          send(res, 400, { error: error.message });
        }
        return;
      }

      if (method === 'POST' && path === '/bili-live/clear') {
        recent.length = 0;
        replied.length = 0;
        send(res, 200, snapshot());
        return;
      }

      send(res, 404, { error: 'not found' });
    } catch (error) {
      send(res, 500, { error: safeText(error?.message || error, 500) });
    }
  }

  ctx.effect(() => {
    const disposeRoute = webServer.register({ kind: 'prefix', path: '/bili-live', handler: route });
    const keepAlive = setInterval(() => {
      for (const res of listeners) {
        try {
          res.write(': ping\n\n');
        } catch {
          listeners.delete(res);
        }
      }
    }, 15000);
    return () => {
      clearInterval(keepAlive);
      disposeRoute();
      stopLoginPolling();
      bili.stop();
      for (const res of listeners) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      listeners.clear();
    };
  });

  // The panel is the primary surface, but these tools let an agent read and
  // drive the assistant without opening a browser.
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_live_status',
      description:
        '读取 B 站直播助手的状态：是否已连接直播间、当前房间信息、登录账号、自动回复开关和最近的弹幕。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回最近多少条弹幕，默认 10，最多 40' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(args, value) {
          return [{ type: 'text', text: String(value) }];
        },
      },
      async execute(args) {
        await ready;
        const limit = Math.min(40, Math.max(1, Number(args?.limit) || 10));
        return JSON.stringify(
          {
            ...snapshot(),
            recent: recent.slice(-limit),
            replies: replied.slice(-limit),
          },
          null,
          2,
        );
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_live_send',
      description:
        '以当前登录的 B 站账号，向已连接的直播间直接发送一条弹幕（最多 20 字）。发送前会检查登录状态、连接状态和违禁词。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '弹幕内容，最多 20 个字符' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(args, value) {
          return [{ type: 'text', text: String(value) }];
        },
      },
      async execute(args) {
        await ready;
        const text = sanitizeReply(args?.text);
        if (!text) throw new Error('弹幕内容为空');
        if (!settings.auth?.sessdata) throw new Error('还没有登录 B 站账号，请先在面板里扫码登录');
        if (!status.connected || !bili.roomId) throw new Error('还没有连接到直播间，请先在面板里连接');
        const bannedHit = findBanned(text, settings.bannedWords);
        if (bannedHit) throw new Error(`弹幕包含违禁词「${bannedHit}」，已拦截`);
        if (Date.now() - lastSentAt < 3000) throw new Error('刚刚已经发过一条弹幕，请等几秒再试');
        await bili.sendDanmaku(settings.auth, bili.roomId, text);
        lastSentAt = Date.now();
        minuteWindow.push(lastSentAt);
        pendingEcho = { text, at: lastSentAt };
        pushLog(`助手发送到 ${status.roomInfo?.title || `房间 ${bili.roomId}`}：${text}`);
        return JSON.stringify({
          ok: true,
          roomId: bili.roomId,
          roomTitle: status.roomInfo?.title || '',
          text,
        });
      },
    }),
  );
}
