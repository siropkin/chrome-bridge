// Fixture server for the stress suite: static files + CORS JSON endpoints + a
// hand-rolled WebSocket echo (the repo has no deps, so no `ws` package).
// Usage: node server.mjs   (port 9334; BRIDGE_PORT-style env not supported —
// net.html hardcodes 9334 like the bridge hardcodes 9333.)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9334;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
  }
  if (req.url === '/api/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: 'slow' }));
    }, 800);
    return;
  }
  const rel = (req.url.replace(/^\/+/, '') || 'static.html').replace(/^fixtures\//, '');
  const file = path.join(FIXTURES, rel);
  if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) { res.writeHead(404, cors); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});

// --- minimal WebSocket echo (text frames only, client-masked, as browsers send)
server.on('upgrade', (req, socket) => {
  if (req.url !== '/echo') return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i % 4];
      buf = buf.subarray(off + 4 + len);
      if (opcode === 8) return socket.end(); // close
      if (opcode === 9) { socket.write(Buffer.from([0x8a, payload.length])); socket.write(payload); continue; } // ping → pong
      // ponytail: text frames only — binary/fragmented frames never come from these fixtures
      const text = 'echo:' + payload.toString('utf8');
      const head = text.length < 126
        ? Buffer.from([0x81, text.length])
        : Buffer.from([0x81, 126, (text.length >> 8) & 0xff, text.length & 0xff]);
      socket.write(Buffer.concat([head, Buffer.from(text)]));
    }
  });
});

server.listen(PORT, () => console.log('stress fixtures on http://localhost:' + PORT));
