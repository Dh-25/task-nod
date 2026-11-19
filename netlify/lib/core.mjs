// Task Node — open backend (no accounts). Netlify Functions v2. Only dependency: @netlify/blobs.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { localExtract } from '../../public/rules.js';

const E = process.env;
const MAX_FILE = 5.5 * 1024 * 1024; // Netlify request cap is ~6MB
class Bad extends Error {}  // -> 400
class Svc extends Error {}  // -> 502
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WS_RE = /^[a-z0-9]{16,64}$/;

/* ---------- storage: Netlify Blobs (a local JSON file is used only when TN_DATA is set, for tests) ---------- */
let _st;
async function store() {
  if (_st) return _st;
  try {
    const { getStore } = await import('@netlify/blobs');
    const s = getStore({ name: 'tasknode', consistency: 'strong' });
    _st = { get: (k) => s.get(k, { type: 'json' }), set: (k, v) => s.setJSON(k, v) };
  } catch (e) {
    if (!E.TN_DATA) throw e;
    const rd = () => { try { return JSON.parse(fs.readFileSync(E.TN_DATA, 'utf8')); } catch { return {}; } };
    _st = { get: async (k) => rd()[k] ?? null, set: async (k, v) => { const d = rd(); d[k] = v; fs.writeFileSync(E.TN_DATA, JSON.stringify(d)); } };
  }
  return _st;
}
const L = async (k, d) => (await (await store()).get(k)) ?? d;
const S = async (k, v) => (await store()).set(k, v);

/* ---------- helpers ---------- */
const J = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const ipOf = (req) => req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
const riyadhToday = () => new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 10);
async function body(req, lim = 60000) { const t = await req.text(); if (t.length > lim) throw new Bad('الطلب كبير جدًا'); return t ? JSON.parse(t) : {}; }
/* Public site => every costly action is rate-limited per visitor (hashed IP) to protect the AI and email quotas. */
async function rate(req, bucket, max, ms = 36e5) {
  try {
    const k = `rl-${bucket}-${crypto.createHash('sha256').update(ipOf(req)).digest('hex').slice(0, 16)}`, n = Date.now();
    const a = ((await L(k, [])) || []).filter((x) => n - x < ms);
    if (a.length >= max) throw Object.assign(new Error(`تجاوزت الحد المسموح (${max} عمليات في الساعة). حاول لاحقًا.`), { status: 429 });
    a.push(n); await S(k, a);
  } catch (e) { if (e.status === 429) throw e; /* storage unavailable: never block the visitor */ }
}
async function file(req) {
  const fd = await req.formData(), f = fd.get('file');
  if (!f || typeof f.arrayBuffer !== 'function') throw new Bad('لم يصل أي ملف');
  if (f.size > MAX_FILE) throw new Bad('حجم الملف كبير (الحد 5MB على Netlify)');
  return { buf: Buffer.from(await f.arrayBuffer()), name: String(f.name || 'file'), type: String(f.type || '') };
}

/* ---------- workspace sync (per-browser workspace id; merge by item id + updated time) ---------- */
const mList = (a = [], b = []) => {
  const m = new Map(), cut = Date.now() - 30 * 864e5;
  for (const x of [...a, ...b]) { if (!x || typeof x !== 'object' || typeof x.id !== 'string' || x.id.length > 64) continue; const o = m.get(x.id); if (!o || (x.u || 0) >= (o.u || 0)) m.set(x.id, x); }
  return [...m.values()].filter((x) => !(x.x && (x.u || 0) < cut)).sort((p, q) => (p.id < q.id ? -1 : 1));
};
const mDoc = (a = {}, b = {}) => ({ tasks: mList(a.tasks, b.tasks), meetings: mList(a.meetings, b.meetings), log: mList(a.log, b.log) });

/* ---------- AI (Groq) + rule-based fallback ---------- */
async function groq(path, init, ms = 9000) {
  let r; try { r = await fetch('https://api.groq.com/openai/v1/' + path, { ...init, signal: AbortSignal.timeout(ms), headers: { Authorization: 'Bearer ' + E.GROQ_API_KEY, ...(init.headers || {}) } }); }
  catch { throw new Svc('تعذر الاتصال بخدمة Groq (انتهت المهلة أو لا يوجد اتصال)'); }
  if (!r.ok) throw new Svc('Groq ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}
const MODELS = () => [...new Set([E.GROQ_MODEL, 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'].filter(Boolean))];
async function groqJSON(system, user) {
  let last;
  for (const model of MODELS()) for (const jm of [true, false]) {
    try {
      const data = await groq('chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, temperature: 0, ...(jm ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
      const txt = data.choices?.[0]?.message?.content || '', m = txt.match(/\{[\s\S]*\}/);
      return JSON.parse(m ? m[0] : txt);
    } catch (e) {
      last = e; if (!(e instanceof Svc) && !(e instanceof SyntaxError)) throw e;
      if (/Groq 401|Groq 403|invalid_api_key|المهلة/i.test(e.message || '')) throw e;
    }
  }
  throw last || new Svc('تعذر الاتصال بالذكاء الاصطناعي');
}
const SYS = 'أنت محلل محاضر اجتماعات باللغة العربية. استخرج فقط المهام المذكورة صراحة ولا تخترع مهامًا أو أشخاصًا أو مواعيد. افهم التواريخ النسبية اعتمادًا على تاريخ الاجتماع المرفق، واحفظ الأسماء والعبارات كما وردت. إذا كانت المهمة لعدة مسؤولين أعد أسماءهم في owner مفصولة بفاصلة عربية. إذا لم يُذكر موعد اجعل deadline فارغًا. إذا لم يُذكر مسؤول اجعل owner فارغًا. أعد JSON فقط بالشكل {"tasks":[{"title":"...","owner":"...","deadline":"YYYY-MM-DD أو فارغ","priority":"h أو m أو l"}]}، الأولوية تقديرية بناءً على قرب الموعد، ولا تضع نصًا خارج JSON.';
async function analyze(text, date) {
  text = String(text).trim(); if (text.length < 15 || text.length > 12000) throw new Bad('أدخل محضرًا بين 15 و12000 حرف');
  const base = /^\d{4}-\d\d-\d\d/.test(date) ? date.slice(0, 10) : riyadhToday();
  const rules = (why) => ({ tasks: localExtract(text, base), mode: 'rules', note: why + ' استُخدم تحليل مبسّط بالقواعد وليس الذكاء الاصطناعي؛ راجع كل مهمة بعناية.' });
  if (!E.GROQ_API_KEY) return rules('مفتاح الذكاء الاصطناعي (GROQ_API_KEY) غير مضبوط.');
  try {
    const parsed = await groqJSON(SYS, `تاريخ الاجتماع: ${base}\nالمحضر:\n${text}`), out = [];
    for (const it of (parsed.tasks || []).slice(0, 30)) {
      const t = String(it.title || '').trim().slice(0, 240), o = String(it.owner || '').trim().slice(0, 160);
      let d = String(it.deadline || '').trim(); if (!(/^\d{4}-\d\d-\d\d$/.test(d) && !isNaN(new Date(d)))) d = '';
      if (t) out.push({ t, o, d: d || 'غير محدد', p: ['h', 'm', 'l'].includes(it.priority) ? it.priority : 'm', k: 1 });
    }
    return { tasks: out, mode: 'groq', note: 'تم التحليل بواسطة Groq AI. راجع الأسماء والمواعيد قبل الإضافة؛ النتائج قد تحتوي على أخطاء.' };
  } catch (e) {
    if (!(e instanceof Svc) && !(e instanceof SyntaxError)) throw e;
    return rules('تعذر الاتصال بالذكاء الاصطناعي (' + String(e.message).slice(0, 110) + ').');
  }
}
async function transcribe(buf, name, type) {
  const fd = new FormData(); fd.append('model', 'whisper-large-v3'); fd.append('language', 'ar'); fd.append('response_format', 'json'); fd.append('temperature', '0');
  fd.append('file', new Blob([buf], { type: type || 'application/octet-stream' }), String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'audio.webm');
  return String((await groq('audio/transcriptions', { method: 'POST', body: fd }, 9500)).text || '').trim();
}
function docxText(buf) { // dependency-free .docx reader (zip central directory + inflate)
  try {
    const e = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); if (e < 0) throw 0;
    const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16);
    for (let i = 0; i < n; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw 0;
      const m = buf.readUInt16LE(p + 10), cs = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
      if (buf.toString('utf8', p + 46, p + 46 + nl) === 'word/document.xml') {
        const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(ds, ds + cs);
        const xml = (m === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
        return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|apos);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[c])).trim();
      }
      p += 46 + nl + xl + cl;
    }
  } catch { /* falls through */ }
  throw new Bad('ملف DOCX غير صالح أو تالف');
}

/* ---------- email (Resend). Without RESEND_API_KEY the browser falls back to a ready mailto: message ---------- */
const mailReady = () => !!E.RESEND_API_KEY;
const PRI = { h: 'عالية', m: 'متوسطة', l: 'منخفضة' }, STA = ['معلقة', 'قيد التنفيذ', 'مكتملة'];
async function sendMail(d) {
  const to = String(d.to || '').trim(), title = String(d.title || '').trim().slice(0, 200), name = String(d.name || '').trim().slice(0, 100);
  if (!EMAIL_RE.test(to) || to.length > 160) throw new Bad('البريد الإلكتروني للمسؤول غير صالح');
  if (!title) throw new Bad('عنوان المهمة مطلوب');
  const dl = /^\d{4}-\d\d-\d\d$/.test(d.deadline || '') ? d.deadline : 'غير محدد';
  const text = `مرحبًا ${name || ''}،\n\nتذكير بمهمة مسندة إليك:\n• المهمة: ${title}\n• موعد التسليم: ${dl}\n• الأولوية: ${PRI[d.priority] || 'متوسطة'}\n• الحالة: ${STA[+d.status] || STA[0]}\n\nأُرسلت عبر Task Node — من الاجتماع إلى الإنجاز.`;
  let r; try { r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(9000), headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: E.EMAIL_FROM || 'Task Node <onboarding@resend.dev>', to: [to], subject: ('تذكير بمهمة: ' + title).slice(0, 150), text }) }); }
  catch { throw new Svc('تعذر الاتصال بمزود البريد'); }
  if (!r.ok) throw new Svc('فشل مزود البريد: ' + (await r.text()).slice(0, 200));
  return (await r.json()).id || '';
}

/* ---------- routes ---------- */
export async function handleApi(req) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ''), method = req.method;
  try {
    if (path === '/api/health' && method === 'GET') {
      let storage = 'ok'; try { await L('ping', 0); } catch (e) { storage = 'error: ' + String(e.message).slice(0, 100); }
      return J(200, { ok: storage === 'ok', storage, ai_key: !!E.GROQ_API_KEY, stt: !!E.GROQ_API_KEY, email: mailReady() });
    }
    if (path === '/api/health/ai' && method === 'GET') { // real Groq test, no secrets in the answer
      if (!E.GROQ_API_KEY) return J(200, { ai_test: 'GROQ_API_KEY غير مضبوط' });
      await rate(req, 'aitest', 6);
      try { const r = await groqJSON('أعد JSON فقط', 'أعد {"ok":true}'); return J(200, { ai_test: r && r.ok ? 'يعمل' : 'رد غير متوقع' }); } catch (e) { return J(200, { ai_test: 'فشل: ' + String(e.message).slice(0, 200) }); }
    }
    if (path === '/api/ws') {
      const id = url.searchParams.get('id') || ''; if (!WS_RE.test(id)) throw new Bad('معرّف مساحة العمل غير صالح');
      if (method === 'GET') { await rate(req, 'wsget', 600); return J(200, { doc: await L('ws-' + id, { tasks: [], meetings: [], log: [] }) }); }
      if (method === 'PUT' || method === 'POST') { // POST is used by navigator.sendBeacon when the tab closes
        await rate(req, 'wsput', 600); const d = await body(req, 1000000), inc = d.doc || {};
        for (const k of ['tasks', 'meetings', 'log']) if (inc[k] !== undefined && !Array.isArray(inc[k])) throw new Bad('بيانات غير صالحة');
        if ((inc.tasks || []).length > 3000 || (inc.meetings || []).length > 800 || (inc.log || []).length > 3000) throw new Bad('تجاوزت الحد الأقصى للعناصر');
        const merged = mDoc(await L('ws-' + id, {}), inc);
        if (JSON.stringify(merged).length > 900000) return J(413, { error: 'حجم البيانات كبير جدًا؛ احذف اجتماعات قديمة' });
        await S('ws-' + id, merged); return J(200, { doc: merged });
      }
    }
    if (path === '/api/analyze' && method === 'POST') { await rate(req, 'ai', 20); const d = await body(req); return J(200, await analyze(d.text, String(d.date || ''))); }
    if (path === '/api/extract' && method === 'POST') {
      await rate(req, 'ai', 20); const f = await file(req);
      if (!/\.docx$/i.test(f.name)) throw new Bad('نوع الملف غير مدعوم هنا'); return J(200, { text: docxText(f.buf) });
    }
    if (path === '/api/transcribe' && method === 'POST') {
      if (!E.GROQ_API_KEY) return J(503, { error: 'تحويل الصوت عبر Whisper غير مفعّل (GROQ_API_KEY غير مضبوط).', fallback: 'webspeech' });
      await rate(req, 'stt', 10); const f = await file(req); if (!f.buf.length) throw new Bad('التسجيل فارغ');
      try { return J(200, { text: await transcribe(f.buf, f.name, f.type) }); } catch (e) { if (e instanceof Svc) return J(503, { error: e.message.slice(0, 220), fallback: 'webspeech' }); throw e; }
    }
    if (path === '/api/email' && method === 'POST') {
      if (!mailReady()) return J(503, { error: 'خدمة البريد غير مفعّلة (RESEND_API_KEY غير مضبوط).', fallback: 'mailto' });
      await rate(req, 'mail', 10);
      const day = 'mail-day-' + riyadhToday(), n = (await L(day, 0)) || 0; if (n >= 300) return J(429, { error: 'تم بلوغ حد الإرسال اليومي للموقع. جرّب غدًا أو استخدم رسالة البريد الجاهزة.', fallback: 'mailto' });
      const d = await body(req); const id = await sendMail(d); await S(day, n + 1); return J(200, { ok: true, id });
    }
    return J(404, { error: 'المسار غير موجود' });
  } catch (e) {
    if (e.status) return J(e.status, { error: e.message });
    if (e instanceof Bad || e instanceof SyntaxError || e instanceof TypeError) return J(400, { error: (e instanceof SyntaxError ? 'بيانات غير صالحة' : e.message).slice(0, 240) });
    if (e instanceof Svc) return J(502, { error: e.message.slice(0, 240), fallback: 'mailto' });
    console.error('API error', e); return J(500, { error: 'حدث خطأ داخلي' });
  }
}
