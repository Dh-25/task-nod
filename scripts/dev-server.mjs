// Local test server (NOT used on Netlify): serves public/ and routes /api/* to the same handler.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { handleApi } from '../netlify/lib/core.mjs';
const PORT = +process.env.PORT || 8888, ROOT = path.resolve('public');
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css' };
http.createServer(async (rq, rs) => {
  const url = new URL(rq.url, 'http://' + rq.headers.host);
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const req = new Request(url, { method: rq.method, headers: rq.headers, body: ['GET', 'HEAD'].includes(rq.method) ? undefined : Buffer.concat(chunks) });
    const r = await handleApi(req); const h = {}; r.headers.forEach((v, k) => (h[k] = v));
    rs.writeHead(r.status, h); return rs.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = url.pathname; if (p.endsWith('/')) p += 'index.html'; if (p === '/app') { rs.writeHead(301, { Location: '/app/' }); return rs.end(); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { rs.writeHead(404); return rs.end('not found'); }
  rs.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); rs.end(fs.readFileSync(f));
}).listen(PORT, () => console.log('dev server http://127.0.0.1:' + PORT));
