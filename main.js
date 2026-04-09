const { app, BrowserWindow, globalShortcut } = require('electron');
const http = require('http');
const { spawn, execFile } = require('child_process');

let win;
const LOCAL_PORT = 18899;

// Find yt-dlp path — check bundled location first, then system
function findYtdlp() {
  const fs = require('fs');
  const path = require('path');
  // Bundled with the app (in production)
  const bundled = path.join(process.resourcesPath || '', 'yt-dlp-bin');
  if (fs.existsSync(bundled)) return bundled;
  // Local dev
  const local = path.join(__dirname, 'yt-dlp-bin');
  if (fs.existsSync(local)) return local;
  // System paths
  const paths = ['/opt/anaconda3/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/opt/homebrew/bin/yt-dlp'];
  for (const p of paths) { if (fs.existsSync(p)) return p; }
  return 'yt-dlp';
}

const YTDLP = findYtdlp();

// ── Local proxy using yt-dlp ──
function startProxy() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, 'http://localhost');

    // GET /stream/:videoId — return direct audio URL (seekable)
    if (url.pathname.startsWith('/stream/')) {
      const videoId = url.pathname.split('/stream/')[1];
      if (!videoId) { res.writeHead(400); res.end('No ID'); return; }

      execFile(YTDLP, [
        '-f', 'bestaudio',
        '--get-url',
        '--no-warnings',
        '--no-check-certificates',
        'https://www.youtube.com/watch?v=' + videoId
      ], { timeout: 15000 }, (err, stdout) => {
        const streamUrl = stdout?.trim();
        if (err || !streamUrl) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: streamUrl }));
      });
      return;
    }

    // GET /info/:videoId — returns title, duration
    if (url.pathname.startsWith('/info/')) {
      const videoId = url.pathname.split('/info/')[1];
      if (!videoId) { res.writeHead(400); res.end('No ID'); return; }

      execFile(YTDLP, [
        '--dump-json',
        '--no-warnings',
        '--no-check-certificates',
        'https://www.youtube.com/watch?v=' + videoId
      ], { timeout: 15000 }, (err, stdout) => {
        if (err || !stdout) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to get info' }));
          return;
        }
        try {
          const data = JSON.parse(stdout);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            title: data.title,
            author: data.uploader || data.channel,
            duration: data.duration,
            videoId: data.id,
          }));
        } catch(e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Parse error' }));
        }
      });
      return;
    }

    // GET /video/:videoId — return direct video URL (seekable)
    if (url.pathname.startsWith('/video/')) {
      const videoId = url.pathname.split('/video/')[1];
      if (!videoId) { res.writeHead(400); res.end('No ID'); return; }

      execFile(YTDLP, [
        '-f', 'bestvideo[height<=480][ext=mp4]/bestvideo[height<=480]/best[height<=480]',
        '--get-url',
        '--no-warnings',
        '--no-check-certificates',
        'https://www.youtube.com/watch?v=' + videoId
      ], { timeout: 15000 }, (err, stdout) => {
        const videoUrl = stdout?.trim();
        if (err || !videoUrl) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: videoUrl }));
      });
      return;
    }

    // GET /lyrics?artist=X&title=Y — fetch lyrics from lyrics.ovh
    if (url.pathname === '/lyrics') {
      const artist = url.searchParams.get('artist') || '';
      const title = url.searchParams.get('title') || '';
      if (!artist && !title) { res.writeHead(400); res.end('Need artist and title'); return; }

      const https = require('https');
      const apiUrl = 'https://api.lyrics.ovh/v1/' + encodeURIComponent(artist) + '/' + encodeURIComponent(title);

      https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, apiRes => {
        let data = '';
        apiRes.on('data', d => data += d);
        apiRes.on('end', () => {
          try {
            const json = JSON.parse(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ lyrics: json.lyrics || null }));
          } catch(e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ lyrics: null }));
          }
        });
      }).on('error', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lyrics: null }));
      });
      return;
    }

    // GET /spotify/:playlistId — get tracks from a Spotify playlist
    if (url.pathname.startsWith('/spotify/')) {
      const playlistId = url.pathname.split('/spotify/')[1];
      if (!playlistId) { res.writeHead(400); res.end('No ID'); return; }

      const https = require('https');
      const embedUrl = 'https://open.spotify.com/embed/playlist/' + playlistId;

      https.get(embedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      }, embedRes => {
        let html = '';
        embedRes.on('data', d => html += d);
        embedRes.on('end', () => {
          try {
            const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/);
            if (!m) throw new Error('No data found');
            const data = JSON.parse(m[1]);
            const entity = data.props.pageProps.state.data.entity;
            const tracks = (entity.trackList || []).map(t => ({
              title: (t.title || '').replace(/\s*\(feat\..*?\)/gi, '').replace(/\s*\[feat\..*?\]/gi, '').trim(),
              artist: (t.subtitle || '').replace(/\u00a0/g, ' ').trim(),
              fullTitle: t.title || '',
            }));
            const playlistName = entity.name || entity.title || 'Spotify Playlist';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name: playlistName, tracks }));
          } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to parse playlist: ' + e.message }));
          }
        });
      }).on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('Port ' + LOCAL_PORT + ' in use, trying ' + (LOCAL_PORT + 1));
      server.listen(LOCAL_PORT + 1, '127.0.0.1');
    }
  });
  server.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log('BashBeats proxy on port ' + LOCAL_PORT + ' (using ' + YTDLP + ')');
  });
}

// ── Electron Window ──
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  win.loadFile('index.html');
  win.setMenuBarVisibility(false);

  globalShortcut.register('MediaPlayPause', () => {
    win.webContents.executeJavaScript('player.isPlaying() ? player.pause() : player.play()');
  });
  globalShortcut.register('MediaNextTrack', () => {
    win.webContents.executeJavaScript('playNext()');
  });
  globalShortcut.register('MediaPreviousTrack', () => {
    win.webContents.executeJavaScript('playPrev()');
  });
}

app.whenReady().then(() => {
  startProxy();
  createWindow();
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
