window.__ModuleLoader__.load({
  id: '@local/dsh-bili-live',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    const BASE = '/bili-live';

    async function api(path, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      let res;
      try {
        res = await fetch(BASE + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-bili-live': '1' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(err?.name === 'AbortError' ? '请求超时，请重试' : `无法连接直播助手：${err?.message || err}`);
      } finally {
        clearTimeout(timer);
      }
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok) throw new Error(json?.error || `请求失败（HTTP ${res.status}）`);
      return json;
    }

    const T = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    const inputStyle = {
      background: T.layer2,
      color: T.text,
      border: `1px solid ${T.border}`,
      borderRadius: 8,
      padding: '7px 10px',
      fontSize: 13,
      fontFamily: 'inherit',
      outline: 'none',
      boxSizing: 'border-box',
    };

    function Btn({ children, onClick, kind = 'default', disabled = false, title, style }) {
      const base = {
        border: `1px solid ${kind === 'primary' ? 'transparent' : T.border}`,
        background: kind === 'primary' ? T.brand : kind === 'ghost' ? 'transparent' : T.layer2,
        color: kind === 'primary' ? '#fff' : T.text,
        borderRadius: 8,
        padding: '7px 14px',
        fontSize: 13,
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
      };
      return h('button', { type: 'button', onClick, disabled, title, style: { ...base, ...style } }, children);
    }

    function Switch({ checked, onChange, label, hint }) {
      return h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' } },
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': checked,
            'aria-label': label,
            onClick: () => onChange(!checked),
            style: {
              width: 38,
              height: 22,
              borderRadius: 11,
              border: 'none',
              padding: 2,
              background: checked ? T.brand : T.idle,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: checked ? 'flex-end' : 'flex-start',
              alignItems: 'center',
              transition: 'background 120ms ease',
              flex: '0 0 auto',
            },
          },
          h('span', {
            style: {
              width: 18,
              height: 18,
              borderRadius: 9,
              background: '#fff',
              display: 'block',
              boxShadow: '0 1px 2px rgba(0,0,0,.25)',
            },
          }),
        ),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
          h('span', { style: { fontSize: 13, color: T.text } }, label),
          hint ? h('span', { style: { fontSize: 11, color: T.muted } }, hint) : null,
        ),
      );
    }

    function Editable({ value, onCommit, placeholder, style, multiline = false, rows = 3 }) {
      const [draft, setDraft] = useState(value ?? '');
      const focused = useRef(false);
      useEffect(() => {
        if (!focused.current) setDraft(value ?? '');
      }, [value]);
      const commit = () => {
        focused.current = false;
        if ((value ?? '') !== draft) onCommit(draft);
      };
      const common = {
        value: draft,
        onChange: (event) => setDraft(event.target.value),
        onFocus: () => {
          focused.current = true;
        },
        onBlur: commit,
        placeholder,
        style: { ...inputStyle, ...style },
      };
      if (multiline) {
        return h('textarea', { ...common, rows, onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur(); } } });
      }
      return h('input', { ...common, onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); } });
    }

    function Card({ title, description, right, children }) {
      return h(
        'section',
        {
          style: {
            background: T.layer1,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            padding: '16px 18px',
            marginBottom: 14,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 } },
          h('h2', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: T.text } }, title),
          description ? h('span', { style: { fontSize: 12, color: T.muted } }, description) : null,
          h('span', { style: { marginLeft: 'auto' } }, right || null),
        ),
        children,
      );
    }

    function Dot({ tone = 'idle' }) {
      const color = tone === 'ok' ? T.success : tone === 'warn' ? T.warn : tone === 'error' ? T.error : T.idle;
      return h('span', {
        style: { width: 7, height: 7, borderRadius: 4, background: color, display: 'inline-block', flex: '0 0 auto' },
      });
    }

    function Qr({ qr }) {
      const quiet = 4;
      const size = qr.count + quiet * 2;
      const rects = [];
      for (let row = 0; row < qr.count; row += 1) {
        const line = qr.rows[row];
        for (let col = 0; col < qr.count; col += 1) {
          if (line[col] === '1') {
            rects.push(h('rect', { key: `${row}-${col}`, x: col + quiet, y: row + quiet, width: 1, height: 1, fill: '#111' }));
          }
        }
      }
      const scale = Math.max(4, Math.floor(300 / size));
      const pixels = size * scale;
      return h(
        'div',
        { style: { background: '#fff', borderRadius: 10, padding: 10, display: 'inline-block', lineHeight: 0 } },
        h('svg', { width: pixels, height: pixels, viewBox: `0 0 ${size} ${size}`, shapeRendering: 'crispEdges' }, rects),
      );
    }

    function fmtTime(ts) {
      if (!ts) return '';
      const date = new Date(ts);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    }

    function SidebarIcon({ size = 18, active = false }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4 6.2A3.2 3.2 0 0 1 7.2 3h9.6A3.2 3.2 0 0 1 20 6.2v7.9a3.2 3.2 0 0 1-3.2 3.2H9.4L5 21v-3.9A3 3 0 0 1 4 15Z',
          fill: active ? T.brand : 'currentColor',
          opacity: active ? 1 : 0.85,
        }),
        h('circle', { cx: 9, cy: 10, r: 1.25, fill: 'var(--dsw-alias-bg-base)' }),
        h('circle', { cx: 12, cy: 10, r: 1.25, fill: 'var(--dsw-alias-bg-base)' }),
        h('circle', { cx: 15, cy: 10, r: 1.25, fill: 'var(--dsw-alias-bg-base)' }),
      );
    }

    function ReplyChip({ reply, onResend }) {
      if (!reply) return null;
      const tone =
        reply.status === 'sent' ? { color: T.success, text: '已发送' } :
        reply.status === 'dry' ? { color: T.warn, text: '预演' } :
        reply.status === 'blocked' ? { color: T.error, text: '拦截' } :
        reply.status === 'failed' ? { color: T.error, text: '失败' } :
        { color: T.muted, text: '生成中' };
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 11, color: tone.color, border: `1px solid ${tone.color}`, borderRadius: 5, padding: '0 5px', lineHeight: '17px' } }, tone.text),
        h('span', { style: { fontSize: 12, color: T.text } }, reply.text || ''),
        reply.error ? h('span', { style: { fontSize: 11, color: T.error } }, reply.error) : null,
        reply.status === 'dry'
          ? h(Btn, { kind: 'ghost', style: { fontSize: 11, padding: '1px 8px' }, onClick: () => onResend(reply.text) }, '补发')
          : null,
      );
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [roomInput, setRoomInput] = useState(() => {
        try {
          return localStorage.getItem('bili-live:room') || '';
        } catch {
          return '';
        }
      });
      const [testText, setTestText] = useState('直播助手已上线，有问题直接弹幕问～');
      const [busy, setBusy] = useState(false);
      const [showPrompt, setShowPrompt] = useState(false);
      const [showStyleForm, setShowStyleForm] = useState(false);
      const [styleName, setStyleName] = useState('');
      const [stylePrompt, setStylePrompt] = useState('');
      const [localQr, setLocalQr] = useState(null);
      const [loginBusy, setLoginBusy] = useState(false);
      const [disconnecting, setDisconnecting] = useState(false);
      const [loggingOut, setLoggingOut] = useState(false);
      const [showCookie, setShowCookie] = useState(false);
      const [cookieSess, setCookieSess] = useState('');
      const [cookieJct, setCookieJct] = useState('');
      const [cookieUid, setCookieUid] = useState('');
      const alive = useRef(true);
      const lastSentAt = useRef(0);
      const roomFocused = useRef(false);

      // Every snapshot carries a server timestamp. Apply only the newest one, so
      // an older SSE frame or a slow /state poll can never overwrite the QR the
      // login POST just returned.
      const apply = (snapshot) => {
        if (!snapshot) return;
        const at = Number(snapshot.sentAt) || Date.now();
        if (at < lastSentAt.current) return;
        lastSentAt.current = at;
        setState(snapshot);
      };

      useEffect(() => {
        alive.current = true;
        let source = null;
        let poll = null;
        api('/state')
          .then((snapshot) => {
            if (!alive.current) return;
            apply(snapshot);
            if (!roomFocused.current && snapshot?.settings?.roomId) {
              setRoomInput(String(snapshot.settings.roomId));
            }
          })
          .catch((err) => setError(err.message));
        try {
          source = new EventSource(BASE + '/events');
          source.onmessage = (event) => {
            try {
              apply(JSON.parse(event.data));
              setError('');
            } catch {
              /* ignore malformed frame */
            }
          };
          source.onerror = () => {
            /* EventSource retries by itself; the poll below covers a dead stream */
          };
        } catch {
          source = null;
        }
        // Always reconcile with the host on a timer. SSE gives instant updates,
        // but a silently dead stream must not freeze the whole panel.
        poll = setInterval(() => {
          api('/state')
            .then((snapshot) => alive.current && apply(snapshot))
            .catch(() => {});
        }, 5000);
        return () => {
          alive.current = false;
          if (source) source.close();
          clearInterval(poll);
        };
      }, []);

      // A local QR survives unrelated snapshot churn; only a terminal login
      // state clears it.
      useEffect(() => {
        if (!state) return;
        if (state.login?.configured || state.loginFlow?.status === 'expired') setLocalQr(null);
      }, [state?.sentAt]);

      // While a QR is pending, poll the login state every 2s as a fallback. A
      // stale SSE stream must not leave "waiting" on screen after the phone
      // has already confirmed.
      useEffect(() => {
        const status = state?.loginFlow?.status;
        if (status !== 'waiting' && status !== 'scanned') return undefined;
        const timer = setInterval(() => {
          api('/state')
            .then((snapshot) => apply(snapshot))
            .catch(() => {});
        }, 2000);
        return () => clearInterval(timer);
      }, [state?.loginFlow?.status]);

      // Keep the field in step with the saved room, but never while the user is
      // editing it.
      useEffect(() => {
        if (roomFocused.current) return;
        const saved = state?.settings?.roomId;
        if (saved) setRoomInput(String(saved));
      }, [state?.settings?.roomId]);

      const rememberRoom = (value) => {
        try {
          localStorage.setItem('bili-live:room', String(value));
        } catch {
          /* storage may be unavailable in a hardened browser */
        }
      };

      const connectRoom = () => {
        const value = Number(roomInput);
        if (!value) return undefined;
        rememberRoom(value);
        return run(() => api('/connect', { roomId: value }), '正在进入直播间');
      };

      const disconnectRoom = async () => {
        setDisconnecting(true);
        setError('');
        setState((current) =>
          current ? { ...current, status: { ...current.status, connected: false, connecting: false } } : current,
        );
        try {
          const snapshot = await api('/disconnect');
          apply(snapshot);
          setNotice('已断开直播间');
        } catch (err) {
          setError(err.message);
          api('/state').then((snapshot) => apply(snapshot)).catch(() => {});
        } finally {
          setDisconnecting(false);
        }
      };

      const logoutAccount = async () => {
        setLoggingOut(true);
        setError('');
        setState((current) =>
          current
            ? {
                ...current,
                login: { configured: false },
                loginFlow: { status: 'idle', qr: null, startedAt: 0, message: '' },
              }
            : current,
        );
        try {
          const snapshot = await api('/logout');
          apply(snapshot);
          setNotice('已退出登录');
        } catch (err) {
          setError(err.message);
          api('/state').then((snapshot) => apply(snapshot)).catch(() => {});
        } finally {
          setLoggingOut(false);
        }
      };

      const run = async (action, successText) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const snapshot = await action();
          if (snapshot && snapshot.status) apply(snapshot);
          if (successText) setNotice(successText);
          return true;
        } catch (err) {
          setError(err.message);
          return false;
        } finally {
          setBusy(false);
        }
      };

      const startLogin = async () => {
        setLoginBusy(true);
        setError('');
        setNotice('');
        try {
          const snapshot = await api('/login/start');
          apply(snapshot);
          if (snapshot?.loginFlow?.qr) {
            setLocalQr(snapshot.loginFlow.qr);
            setNotice('二维码已生成，请用哔哩哔哩手机客户端扫码');
          }
        } catch (err) {
          setError(err.message);
        } finally {
          setLoginBusy(false);
        }
      };

      const cancelLogin = async () => {
        setLocalQr(null);
        await run(() => api('/login/cancel'), '已取消');
      };

      const saveCookieLogin = async () => {
        const ok = await run(
          () =>
            api('/login/cookie', {
              sessdata: cookieSess.trim(),
              biliJct: cookieJct.trim(),
              dedeUserId: cookieUid.trim(),
            }),
          '登录成功',
        );
        if (ok) {
          setCookieSess('');
          setCookieJct('');
          setCookieUid('');
          setShowCookie(false);
        }
      };

      const patch = (settings, successText) => run(() => api('/settings', { settings }), successText);

      if (!state) {
        return h(
          'div',
          { style: { padding: 40, color: T.muted, fontSize: 13 } },
          error ? `直播助手没有响应：${error}` : '正在读取直播助手状态…',
        );
      }

      const { status, settings, login, loginFlow, llm, stats, recent, replies = [], logs, storagePath, stylePresets = [] } = state;
      const roomInfo = status.roomInfo;
      const online = roomInfo?.liveStatus === 1;
      const showQr = loginFlow.status === 'waiting' || loginFlow.status === 'scanned' || Boolean(localQr);
      const qrData = loginFlow.qr || localQr;
      const statusTone = status.connected ? 'ok' : status.connecting ? 'warn' : status.error ? 'error' : 'idle';
      const statusText = status.connected
        ? '弹幕已连接'
        : status.connecting
          ? '正在连接…'
          : status.error
            ? '连接异常'
            : '未连接';

      const setRules = (rules) => patch({ rules });

      const style = settings.style || { activeId: 'natural', custom: [] };
      const allStyles = [...stylePresets, ...(style.custom || [])];
      const currentStyle = allStyles.find((item) => item.id === style.activeId) || allStyles[0] || { name: '自然', prompt: '' };

      const selectStyle = (id) => patch({ style: { ...style, activeId: id } });

      const removeStyle = (id) => {
        const custom = (style.custom || []).filter((item) => item.id !== id);
        patch({ style: { activeId: style.activeId === id ? 'natural' : style.activeId, custom } });
      };

      const addStyle = () => {
        const name = styleName.trim();
        const prompt = stylePrompt.trim();
        if (!name || !prompt) return;
        const id = `custom-${Date.now().toString(36)}`;
        const custom = [...(style.custom || []), { id, name, prompt }];
        patch({ style: { activeId: id, custom } });
        setStyleName('');
        setStylePrompt('');
        setShowStyleForm(false);
      };

      return h(
        'div',
        { style: { height: '100%', overflow: 'auto', background: T.bg, color: T.text } },
        h(
          'div',
          { style: { maxWidth: 940, margin: '0 auto', padding: '26px 24px 72px' } },

          // heading
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 } },
            h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 650 } }, 'B站直播助手'),
            h(
              'span',
              {
                style: {
                  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.muted,
                  border: `1px solid ${T.border}`, borderRadius: 999, padding: '3px 10px',
                },
              },
              h(Dot, { tone: statusTone }),
              statusText,
            ),
            settings.dryRun
              ? h('span', { style: { fontSize: 12, color: T.warn, border: `1px solid ${T.warn}`, borderRadius: 999, padding: '3px 10px' } }, '预演模式')
              : null,
          ),
          h(
            'p',
            { style: { margin: '0 0 18px', fontSize: 12.5, color: T.muted, lineHeight: 1.7 } },
            '连接你的直播间，按关键词规则或 AI 生成回复，扫码登录后以你的账号发弹幕。自动回复属于平台风控敏感行为，建议先跑预演、确认话术再关闭预演。',
          ),

          error ? h('div', { style: { background: T.layer1, border: `1px solid ${T.error}`, color: T.error, borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 12 } }, error) : null,
          notice ? h('div', { style: { background: T.layer1, border: `1px solid ${T.success}`, color: T.success, borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 12 } }, notice) : null,

          // room
          h(
            Card,
            { title: '直播间', description: roomInfo ? `${roomInfo.uname || ''} · ${roomInfo.title || ''}` : '填写房间号后连接弹幕流' },
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                value: roomInput,
                onChange: (event) => setRoomInput(event.target.value.replace(/[^\d]/g, '')),
                onFocus: () => {
                  roomFocused.current = true;
                },
                onBlur: () => {
                  roomFocused.current = false;
                  rememberRoom(Number(roomInput) || 0);
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') connectRoom();
                },
                placeholder: '直播间房间号，例如 21987615',
                style: { ...inputStyle, width: 220 },
              }),
              h(Btn, {
                kind: 'primary',
                disabled: busy || !roomInput,
                onClick: connectRoom,
              }, status.connected || status.connecting ? '重新连接' : '连接直播间'),
              settings.roomId
                ? h(Btn, { disabled: disconnecting, onClick: disconnectRoom }, disconnecting ? '断开中…' : '断开直播间')
                : null,
              roomInfo
                ? h('span', { style: { fontSize: 12, color: T.muted } }, `${roomInfo.area || ''} · ${online ? '直播中' : '未开播'} · 房间 ${roomInfo.roomId} · 人气 ${Number(status.popularity || 0).toLocaleString()}`)
                : null,
            ),
            status.connected && !roomInfo
              ? h('div', { style: { marginTop: 8, fontSize: 12, color: T.warn } }, `已连上房间 ${status.roomId} 的弹幕流，但没有查到房间信息，这个房间号可能不存在。`)
              : null,
            status.error
              ? h('div', { style: { marginTop: 8, fontSize: 12, color: T.error } }, status.error)
              : null,
          ),

          // account
          h(
            Card,
            { title: 'B站账号', description: login.configured ? '已登录，可以发送弹幕' : '扫码或填写 Cookie 后可以发送弹幕' },
            login.configured
              ? h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 13, color: T.text } }, `已登录：${login.uname || `UID ${login.uid || ''}`}`),
                  h(Btn, { disabled: loggingOut, onClick: logoutAccount }, loggingOut ? '退出中…' : '退出登录'),
                )
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
                  showQr
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' } },
                        qrData ? h(Qr, { qr: qrData }) : null,
                        h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                          h('span', { style: { fontSize: 13, color: T.text } }, loginFlow.message || '请用哔哩哔哩手机客户端扫码'),
                          h('span', { style: { fontSize: 12, color: T.muted } }, '登录成功后凭据只保存在本机，不会上传。'),
                          h(Btn, { disabled: busy, onClick: cancelLogin }, '取消'),
                        ),
                      )
                    : h(
                        'div',
                        { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                        h(Btn, { kind: 'primary', disabled: busy || loginBusy, onClick: startLogin }, loginBusy ? '正在生成…' : '扫码登录'),
                        loginFlow.status === 'expired'
                          ? h('span', { style: { fontSize: 12, color: T.warn } }, loginFlow.message || '二维码已过期')
                          : null,
                        loginFlow.status === 'error'
                          ? h('span', { style: { fontSize: 12, color: T.error } }, loginFlow.message || '登录失败')
                          : null,
                      ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setShowCookie((value) => !value),
                      style: {
                        alignSelf: 'flex-start',
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        color: T.muted,
                        fontSize: 12,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        textDecoration: 'underline',
                        textUnderlineOffset: 3,
                      },
                    },
                    showCookie ? '收起手动登录' : '扫码不方便？手动填 Cookie',
                  ),
                  showCookie
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 540 } },
                        h(
                          'span',
                          { style: { fontSize: 11, color: T.muted, lineHeight: 1.7 } },
                          '在浏览器打开 live.bilibili.com 并登录，按 F12 → Application → Cookies → bilibili.com，复制 SESSDATA、bili_jct、DedeUserID 三个值。Cookie 等同于登录态，别发给别人。',
                        ),
                        h('input', {
                          value: cookieSess,
                          onChange: (event) => setCookieSess(event.target.value),
                          placeholder: 'SESSDATA',
                          style: { ...inputStyle, width: '100%' },
                        }),
                        h('input', {
                          value: cookieJct,
                          onChange: (event) => setCookieJct(event.target.value),
                          placeholder: 'bili_jct',
                          style: { ...inputStyle, width: '100%' },
                        }),
                        h('input', {
                          value: cookieUid,
                          onChange: (event) => setCookieUid(event.target.value),
                          placeholder: 'DedeUserID（可选）',
                          style: { ...inputStyle, width: '100%' },
                        }),
                        h(
                          Btn,
                          { kind: 'primary', disabled: busy || !cookieSess.trim(), onClick: saveCookieLogin },
                          '用 Cookie 登录',
                        ),
                      )
                    : null,
                ),
          ),

          // reply settings
          h(
            Card,
            {
              title: '自动回复',
              description: `冷却 ${Math.round(settings.cooldownMs / 1000)} 秒 · 每分钟最多 ${settings.maxPerMinute} 条 · 同一用户 ${Math.round(settings.perUserCooldownMs / 1000)} 秒`,
            },
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12, marginBottom: 14 } },
              h(Switch, {
                checked: settings.enabled,
                label: '总开关',
                hint: '关闭后只监听，不生成回复',
                onChange: (value) => patch({ enabled: value }),
              }),
              h(Switch, {
                checked: settings.autoReply,
                label: '自动回复',
                hint: '命中规则或 AI 才回复',
                onChange: (value) => patch({ autoReply: value }),
              }),
              h(Switch, {
                checked: settings.dryRun,
                label: '预演模式',
                hint: '只记录回复内容，不真正发送',
                onChange: (value) => patch({ dryRun: value }),
              }),
              h(Switch, {
                checked: settings.aiEnabled,
                label: 'AI 生成',
                hint: llm.available ? `命中不了规则时用 ${llm.provider}/${llm.model}` : llm.error || '模型不可用，只走规则',
                onChange: (value) => patch({ aiEnabled: value }),
              }),
            ),

            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 } },
              h(
                'label',
                { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: T.muted } },
                '全局冷却（秒）',
                h(Editable, {
                  value: String(Math.round(settings.cooldownMs / 1000)),
                  onCommit: (value) => patch({ cooldownMs: Number(value) * 1000 }),
                  style: { width: '100%' },
                }),
              ),
              h(
                'label',
                { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: T.muted } },
                '每分钟上限',
                h(Editable, {
                  value: String(settings.maxPerMinute),
                  onCommit: (value) => patch({ maxPerMinute: Number(value) }),
                  style: { width: '100%' },
                }),
              ),
              h(
                'label',
                { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: T.muted } },
                '同一用户冷却（秒）',
                h(Editable, {
                  value: String(Math.round(settings.perUserCooldownMs / 1000)),
                  onCommit: (value) => patch({ perUserCooldownMs: Number(value) * 1000 }),
                  style: { width: '100%' },
                }),
              ),
            ),

            h('div', { style: { fontSize: 12, color: T.muted, marginBottom: 6 } }, '关键词规则（按顺序匹配，命中即用；{user} 会替换成昵称）'),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 } },
              (settings.rules || []).map((rule, index) =>
                h(
                  'div',
                  { key: index, style: { display: 'grid', gridTemplateColumns: '130px 1fr 30px', gap: 6 } },
                  h(Editable, {
                    value: rule.keyword,
                    placeholder: '关键词',
                    onCommit: (value) => {
                      const next = settings.rules.map((item, i) => (i === index ? { ...item, keyword: value } : item));
                      setRules(next);
                    },
                  }),
                  h(Editable, {
                    value: rule.reply,
                    placeholder: '回复内容',
                    onCommit: (value) => {
                      const next = settings.rules.map((item, i) => (i === index ? { ...item, reply: value } : item));
                      setRules(next);
                    },
                  }),
                  h(Btn, {
                    kind: 'ghost',
                    title: '删除这条规则',
                    style: { padding: '6px 0' },
                    onClick: () => setRules(settings.rules.filter((_, i) => i !== index)),
                  }, '×'),
                ),
              ),
              h(Btn, {
                style: { alignSelf: 'flex-start' },
                onClick: () => setRules([...(settings.rules || []), { keyword: '', reply: '' }]),
              }, '+ 添加规则'),
            ),

            h(
              'button',
              {
                type: 'button',
                onClick: () => setShowPrompt((value) => !value),
                style: { background: 'none', border: 'none', color: T.muted, fontSize: 12, cursor: 'pointer', padding: 0, marginTop: 4, fontFamily: 'inherit' },
              },
              `${showPrompt ? '收起' : '展开'} AI 回复提示词`,
            ),
            showPrompt
              ? h(Editable, {
                  value: settings.systemPrompt,
                  multiline: true,
                  rows: 4,
                  onCommit: (value) => patch({ systemPrompt: value }),
                  style: { width: '100%', marginTop: 8, resize: 'vertical', lineHeight: 1.6 },
                })
              : null,
          ),

          // reply style
          h(
            Card,
            {
              title: '回复风格',
              description: `当前「${currentStyle.name}」 · 只影响 AI 生成的回复，关键词规则话术不变`,
            },
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
              allStyles.map((item) => {
                const active = item.id === style.activeId;
                return h(
                  'div',
                  { key: item.id, style: { display: 'flex', alignItems: 'center' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      title: item.prompt,
                      onClick: () => selectStyle(item.id),
                      style: {
                        padding: '7px 12px',
                        borderRadius: 8,
                        border: `1px solid ${active ? T.brand : T.border}`,
                        background: active ? T.layer2 : 'transparent',
                        color: active ? T.brand : T.text,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 13,
                        fontWeight: active ? 600 : 400,
                      },
                    },
                    item.name,
                  ),
                  item.builtin
                    ? null
                    : h(
                        'button',
                        {
                          type: 'button',
                          title: '删除这个词条',
                          onClick: () => removeStyle(item.id),
                          style: {
                            background: 'none', border: 'none', color: T.muted, cursor: 'pointer',
                            fontSize: 14, lineHeight: 1, padding: '0 4px', fontFamily: 'inherit',
                          },
                        },
                        '×',
                      ),
                );
              }),
              h(Btn, { onClick: () => setShowStyleForm((value) => !value) }, showStyleForm ? '取消添加' : '+ 添加词条'),
            ),
            h('div', { style: { marginTop: 8, fontSize: 12, color: T.muted } }, currentStyle.prompt),
            showStyleForm
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, maxWidth: 560 } },
                  h('input', {
                    value: styleName,
                    onChange: (event) => setStyleName(event.target.value.slice(0, 20)),
                    placeholder: '词条名称，例如：猫娘',
                    style: { ...inputStyle, width: '100%' },
                  }),
                  h('textarea', {
                    value: stylePrompt,
                    onChange: (event) => setStylePrompt(event.target.value.slice(0, 300)),
                    rows: 3,
                    placeholder: '风格描述，例如：每句话结尾加一个「喵」，语气软一点，但别影响信息量',
                    style: { ...inputStyle, width: '100%', resize: 'vertical', lineHeight: 1.6 },
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8 } },
                    h(Btn, { kind: 'primary', disabled: !styleName.trim() || !stylePrompt.trim(), onClick: addStyle }, '保存并启用'),
                  ),
                )
              : null,
          ),

          // banned words
          h(
            Card,
            {
              title: '违禁词',
              description: `${(settings.bannedWords || []).length} 个 · 弹幕命中不回复；生成的回复或手动发送命中会被拦截`,
            },
            h(Editable, {
              value: (settings.bannedWords || []).join('\n'),
              multiline: true,
              rows: 4,
              placeholder: '每行一个词，也可用逗号分隔，例如：\n加群\n代练\n外挂',
              onCommit: (value) =>
                patch({
                  bannedWords: value
                    .split(/[\n,，、]/)
                    .map((word) => word.trim())
                    .filter(Boolean),
                }),
              style: { width: '100%', resize: 'vertical', lineHeight: 1.7 },
            }),
            h(
              'span',
              { style: { display: 'block', marginTop: 6, fontSize: 11, color: T.muted } },
              '保存后立即生效，按不区分大小写的包含匹配。弹幕被拦截时仍会显示在列表里，只是不生成回复。',
            ),
          ),

          // test send
          h(
            Card,
            {
              title: '手动发一条',
              description: status.connected && roomInfo
                ? `发送到：${roomInfo.title || '直播间'}（房间 ${roomInfo.roomId}）`
                : '先连接直播间，弹幕才会发到正确的房间',
            },
            h(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('input', {
                value: testText,
                onChange: (event) => setTestText(event.target.value.slice(0, 20)),
                placeholder: '最多 20 个字',
                style: { ...inputStyle, flex: '1 1 320px' },
              }),
              h(Btn, {
                kind: 'primary',
                disabled: busy || !testText || !login.configured || !status.connected,
                onClick: () =>
                  run(
                    () => api('/send', { text: testText }),
                    roomInfo ? `已发送到 ${roomInfo.title || `房间 ${roomInfo.roomId}`}` : '已发送',
                  ),
              }, '发送'),
            ),
          ),

          // reply log
          h(
            Card,
            {
              title: '回复记录',
              description: `最近 ${replies.length} 条生成结果${settings.dryRun ? ' · 当前为预演，不会真正发送' : ''}`,
            },
            replies.length === 0
              ? h('div', { style: { fontSize: 12.5, color: T.muted, padding: '10px 0' } }, '还没有生成过回复。连接直播间后，命中规则或 AI 生成的内容会出现在这里。')
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflow: 'auto' } },
                  replies.slice().reverse().map((entry) =>
                    h(
                      'div',
                      { key: entry.id, style: { padding: '7px 0', borderBottom: `1px solid ${T.border}` } },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                        h('span', { style: { fontSize: 11, color: T.muted, fontVariantNumeric: 'tabular-nums' } }, fmtTime(entry.at)),
                        h('span', { style: { fontSize: 12, color: T.brand, flex: '0 0 auto' } }, entry.user),
                        h('span', { style: { fontSize: 12, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.text),
                      ),
                      h(ReplyChip, { reply: entry.reply, onResend: (text) => run(() => api('/send', { text }), '已发送') }),
                    ),
                  ),
                ),
          ),

          // danmaku
          h(
            Card,
            {
              title: '实时弹幕',
              description: `${recent.length} 条 · 收到 ${stats.received} / 生成 ${stats.generated} / 已发 ${stats.sent} / 预演 ${stats.dry} / 失败 ${stats.failed} / 拦截 ${stats.blocked || 0}`,
              right: h(Btn, { kind: 'ghost', onClick: () => run(() => api('/clear')) }, '清空'),
            },
            recent.length === 0
              ? h('div', { style: { fontSize: 12.5, color: T.muted, padding: '18px 0' } }, status.connected ? '已连接，等待弹幕…' : '连接直播间后这里会实时显示弹幕和回复。')
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 420, overflow: 'auto' } },
                  recent.slice().reverse().map((entry) =>
                    h(
                      'div',
                      { key: entry.id, style: { padding: '7px 0', borderBottom: `1px solid ${T.border}` } },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                        h('span', { style: { fontSize: 11, color: T.muted, fontVariantNumeric: 'tabular-nums' } }, fmtTime(entry.at)),
                        h('span', { style: { fontSize: 12.5, color: T.brand, flex: '0 0 auto' } }, entry.user),
                        entry.isAdmin ? h('span', { style: { fontSize: 10, color: T.warn } }, '房管') : null,
                        entry.blocked
                          ? h(
                              'span',
                              {
                                style: {
                                  fontSize: 10, color: T.error, border: `1px solid ${T.error}`,
                                  borderRadius: 4, padding: '0 4px', lineHeight: '15px', flex: '0 0 auto',
                                },
                                title: `命中违禁词「${entry.blocked}」，已跳过`,
                              },
                              '违禁词',
                            )
                          : null,
                        h('span', { style: { fontSize: 13, color: T.text, wordBreak: 'break-word' } }, entry.text),
                        entry.reply && entry.reply.status === 'dry'
                          ? h(Btn, {
                              kind: 'ghost',
                              style: { marginLeft: 'auto', fontSize: 11, padding: '1px 8px' },
                              onClick: () => run(() => api('/reply-now', { id: entry.id }), '已补发'),
                            }, '补发')
                          : null,
                      ),
                      h(ReplyChip, { reply: entry.reply, onResend: (text) => run(() => api('/send', { text }), '已发送') }),
                    ),
                  ),
                ),
          ),

          // logs
          h(
            Card,
            { title: '运行日志' },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 180, overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5 } },
              logs.length === 0
                ? h('span', { style: { color: T.muted } }, '暂无日志')
                : logs.slice().reverse().map((item, index) =>
                    h(
                      'div',
                      { key: index, style: { color: item.level === 'error' ? T.error : item.level === 'warn' ? T.warn : T.muted } },
                      `${fmtTime(item.at)}  ${item.message}`,
                    ),
                  ),
            ),
          ),

          h(
            'p',
            { style: { fontSize: 11, color: T.muted, lineHeight: 1.7, marginTop: 8 } },
            `登录凭据与设置保存在本机：${storagePath}。自动回复通过 B 站网页接口发送弹幕，属于非官方用法，存在账号被限流或限制发言的风险，请自行控制频率。`,
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'bili-live', order: 20, label: 'B站直播助手' },
            SidebarIcon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'bili-live' }, Panel),
        );
      },
    };
  },
});
