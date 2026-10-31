/**
 * Song requests from danmaku: search Netease CloudMusic, then hand the track to
 * the installed desktop client through its registered `orpheus://` protocol
 * (falling back to the web player when the client is not installed).
 *
 * Only two values ever leave this module: the search text goes into a query
 * string, and a numeric song id goes into a URL passed to the shell. Nothing a
 * viewer types is ever concatenated into a command line.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CLIENT_CANDIDATES = [
  'C:\\Program Files\\NetEase\\CloudMusic\\cloudmusic.exe',
  'C:\\Program Files (x86)\\NetEase\\CloudMusic\\cloudmusic.exe',
  'C:\\Program Files\\Netease\\CloudMusic\\cloudmusic.exe',
  'C:\\Program Files (x86)\\Netease\\CloudMusic\\cloudmusic.exe',
];

export class SongError extends Error {}

/** Absolute path of the installed Netease client, or null. */
export function findClient() {
  for (const path of CLIENT_CANDIDATES) {
    try {
      if (existsSync(path)) return path;
    } catch {
      /* an unreadable candidate is simply not the client */
    }
  }
  return null;
}

async function fetchJson(url, init = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'user-agent': UA,
        referer: 'https://music.163.com/',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new SongError(`网易云接口返回 HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new SongError('网易云接口返回内容无法解析');
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw new SongError('网易云接口请求超时');
    throw error instanceof SongError ? error : new SongError(`访问网易云失败：${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}

function toSong(item) {
  return {
    id: Number(item?.id) || 0,
    name: String(item?.name || '').trim(),
    artists: (Array.isArray(item?.artists) ? item.artists : [])
      .map((artist) => String(artist?.name || '').trim())
      .filter(Boolean),
    album: String(item?.album?.name || '').trim(),
    duration: Number(item?.duration) || 0,
    // `status: -1` marks tracks that are pulled; `fee` 4 means the client
    // needs a subscription, which is still worth trying.
    playable: Number(item?.status) !== -1,
  };
}

/**
 * Search Netease CloudMusic. Returns playable tracks first, then the rest, so
 * a viewer naming a pulled album still gets a usable match when one exists.
 */
export async function searchSongs(keyword, limit = 5) {
  const query = String(keyword || '').trim();
  if (!query) throw new SongError('没有歌名可以搜索');
  const count = Math.min(20, Math.max(1, Number(limit) || 5));
  const url =
    'https://music.163.com/api/search/get?s=' +
    encodeURIComponent(query) +
    `&type=1&limit=${count * 2}&offset=0`;
  const body = await fetchJson(url);
  const raw = Array.isArray(body?.result?.songs) ? body.result.songs : [];
  if (raw.length === 0) return [];
  const songs = raw.map(toSong).filter((song) => song.id > 0 && song.name);
  const lower = query.toLowerCase();
  const score = (song) => {
    const name = song.name.toLowerCase();
    if (name === lower) return 0;
    if (name.includes(lower) || lower.includes(name)) return 1;
    return 2;
  };
  songs.sort((left, right) => {
    const playable = Number(right.playable) - Number(left.playable);
    if (playable !== 0) return playable;
    return score(left) - score(right);
  });
  return songs.slice(0, count);
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function openExternal(url) {
  return new Promise((resolve, reject) => {
    const [command, args] =
      process.platform === 'win32'
        ? ['cmd.exe', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    execFile(command, args, { windowsHide: true, timeout: 8000 }, (error) => {
      if (error) reject(new SongError(`打开播放器失败：${error.message}`));
      else resolve();
    });
  });
}

/**
 * Hand a track to the Netease client. `orpheus://song/<id>` plays the track in
 * an already running client and launches the client when it is not running;
 * `cloudmusic.exe --webcmd=` is what that protocol handler itself runs, and
 * works even when the protocol association is broken. Each attempt is tried in
 * turn so a locked-down shell (where `cmd /c start` refuses) still ends up
 * playing something.
 */
export async function playSong(song) {
  const id = Number(song?.id);
  if (!Number.isFinite(id) || id <= 0) throw new SongError('歌曲 id 无效');
  const client = findClient();
  const protocol = `orpheus://song/${id}`;
  const web = `https://music.163.com/#/song?id=${id}`;
  const attempts = [];
  if (client) {
    attempts.push(
      { mode: 'client', via: '客户端命令行', run: () => spawnDetached(client, [`--webcmd=${protocol}`]) },
      { mode: 'client', via: '协议唤起', run: () => openExternal(protocol) },
      { mode: 'client', via: '资源管理器', run: () => spawnDetached('explorer.exe', [protocol]) },
    );
  }
  attempts.push({ mode: 'web', via: '网页播放', run: () => openExternal(web) });
  const errors = [];
  for (const attempt of attempts) {
    try {
      await attempt.run();
      return {
        mode: attempt.mode,
        via: attempt.via,
        client: attempt.mode === 'client' ? client : null,
        url: attempt.mode === 'client' ? protocol : web,
      };
    } catch (error) {
      errors.push(`${attempt.via}: ${error.message}`);
    }
  }
  throw new SongError(`无法打开播放器：${errors.join('；')}`);
}
