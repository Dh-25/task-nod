import { localExtract } from '/rules.js';

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const now = () => Date.now();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); return v; } catch { return null; } };
const JH = { 'Content-Type': 'application/json' };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PL = { h: ['عالية', 'hi'], m: ['متوسطة', 'md'], l: ['منخفضة', 'lo'] };
const ST = ['معلقة', 'قيد التنفيذ', 'مكتملة'];
const bd = (p) => `<span class="b ${(PL[p] || PL.m)[1]}">${(PL[p] || PL.m)[0]}</span>`;
let toastT;
function toast(x) { const t = $('#t'); t.textContent = x; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200); }

/* ================= workspace + data (localStorage first, Netlify Blobs sync) ================= */
let WS = new URLSearchParams(location.search).get('w') || ls('tn_ws');
if (!WS || !/^[a-z0-9]{16,64}$/.test(WS)) { const a = new Uint8Array(12); crypto.getRandomValues(a); WS = [...a].map((b) => b.toString(36).padStart(2, '0')).join(''); }
ls('tn_ws', WS);
if (location.search.includes('w=')) history.replaceState(null, '', location.pathname + location.hash);
let D; try { D = JSON.parse(ls('tn_doc_' + WS) || 'null'); } catch { D = null; }
D = D && Array.isArray(D.tasks) ? { tasks: D.tasks, meetings: D.meetings || [], log: D.log || [] } : { tasks: [], meetings: [], log: [] };
const mList = (a = [], b = []) => { const m = new Map(), cut = now() - 30 * 864e5; for (const x of [...a, ...b]) { if (!x || !x.id) continue; const o = m.get(x.id); if (!o || (x.u || 0) >= (o.u || 0)) m.set(x.id, x); } return [...m.values()].filter((x) => !(x.x && (x.u || 0) < cut)).sort((p, q) => (p.id < q.id ? -1 : 1)); };
const mDoc = (a = {}, b = {}) => ({ tasks: mList(a.tasks, b.tasks), meetings: mList(a.meetings, b.meetings), log: mList(a.log, b.log) });
const live = (a) => a.filter((x) => !x.x);
const T = () => live(D.tasks), MT = () => live(D.meetings).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.c || 0) - (a.c || 0)), LG = () => live(D.log).sort((a, b) => (b.u || 0) - (a.u || 0));
const isOver = (t) => t.s !== 2 && t.d && t.d < today();
function put(kind, o) { o.u = now(); const a = D[kind], i = a.findIndex((x) => x.id === o.id); i >= 0 ? (a[i] = o) : a.push(o); persist(); }
function del(kind, id) { const a = D[kind], i = a.findIndex((x) => x.id === id); if (i >= 0) a[i] = { id, x: 1, u: now() }; persist(); }
function persist() { ls('tn_doc_' + WS, JSON.stringify(D)); schedulePush(); }
let H = { ok: false, ai_key: false, stt: false, email: false, storage: '' }, sync = 'local', pushT;
function setSync(s) { sync = s; const p = $('#sync'); if (!p) return; p.className = 'pill ' + (s === 'ok' ? 'ok' : 'wn'); p.textContent = s === 'ok' ? 'محفوظ على السحابة ✓' : s === 'pending' ? 'جارٍ الحفظ…' : 'محفوظ على جهازك'; }
async function pull() {
  try {
    const r = await fetch('/api/ws?id=' + WS); if (!r.ok) throw 0; const j = await r.json(), before = JSON.stringify(D);
    D = mDoc(D, j.doc || {}); const after = JSON.stringify(D); ls('tn_doc_' + WS, after);
    setSync('ok'); if (after !== JSON.stringify(mDoc(j.doc || {}, {}))) schedulePush(); return after !== before;
  } catch { setSync('local'); return false; }
}
function schedulePush() { clearTimeout(pushT); setSync('pending'); pushT = setTimeout(push, 1200); }
async function push() {
  try {
    const r = await fetch('/api/ws?id=' + WS, { method: 'PUT', headers: JH, body: JSON.stringify({ doc: D }) }); if (!r.ok) throw 0;
    const j = await r.json(); D = mDoc(D, j.doc); ls('tn_doc_' + WS, JSON.stringify(D)); setSync('ok');
  } catch { setSync('local'); }
}

/* ================= state ================= */
const NAV = [['dash', 'لوحة العمل'], ['create', 'اجتماع جديد'], ['tasks', 'المهام'], ['cal', 'التقويم'], ['ask', 'اسأل Task Node'], ['stats', 'التحليلات'], ['log', 'سجل الاجتماعات'], ['settings', 'الإعدادات']];
const TITLES = Object.fromEntries([...NAV, ['review', 'مراجعة المقترحات']]);
let CR = { mode: 'txt', title: '', date: today(), att: '', text: '', files: [] };
let RV = null, FORM = null, FIL = '', LOGOPEN = '', LOGEDIT = '', ASK = [], calM = new Date(), REC = { on: false, blob: null, url: '' }, FORCE_LIVE = false, BUSY = '';
let stream, mr, chunks = [], useWhisper = false, sr = null;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ================= email ================= */
const mailBody = (t) => `مرحبًا ${t.o || ''}،\n\nتذكير بمهمة مسندة إليك:\n• المهمة: ${t.t}\n• موعد التسليم: ${t.d || 'غير محدد'}\n• الأولوية: ${(PL[t.p] || PL.m)[0]}\n• الحالة: ${ST[t.s || 0]}\n\nأُرسلت عبر Task Node — من الاجتماع إلى الإنجاز.`;
function openMailto(to, subject, body) { const a = document.createElement('a'); a.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; document.body.appendChild(a); a.click(); a.remove(); }
async function mailTask(id) {
  const t = T().find((x) => x.id === id); if (!t) return;
  if (!t.e || !EMAIL_RE.test(t.e)) { toast('أضف بريد المسؤول الصحيح أولًا من «تعديل»'); return; }
  const subject = ('تذكير بمهمة: ' + t.t).slice(0, 150);
  if (H.email) {
    try {
      const r = await fetch('/api/email', { method: 'POST', headers: JH, body: JSON.stringify({ to: t.e, name: t.o, title: t.t, deadline: t.d, priority: t.p, status: t.s }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { toast('تم إرسال الإشعار إلى ' + t.e); return; }
      if (r.status === 429 && !j.fallback) { toast(j.error || 'تجاوزت الحد المسموح'); return; }
    } catch { /* fall back below */ }
    toast('تعذر الإرسال المباشر، فتحنا رسالة بريد جاهزة'); openMailto(t.e, subject, mailBody(t)); return;
  }
  toast('خدمة البريد غير مفعّلة، فتحنا رسالة بريد جاهزة'); openMailto(t.e, subject, mailBody(t));
}

/* ================= voice ================= */
function liveStart() {
  if (!SR) return false;
  sr = new SR(); sr.lang = 'ar-SA'; sr.continuous = true; sr.interimResults = true;
  const base = CR.text ? CR.text.replace(/\s+$/, '') + ' ' : ''; let fin = '';
  sr.onresult = (e) => { let interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) fin += r[0].transcript + ' '; else interim += r[0].transcript; } CR.text = base + fin + interim; const ta = $('#txt'); if (ta) ta.value = CR.text; };
  sr.onerror = (e) => { if (e.error === 'not-allowed') toast('تم رفض إذن الميكروفون'); };
  sr.onend = () => { if (REC.on && sr) { try { sr.start(); } catch { /* already started */ } } };
  try { sr.start(); return true; } catch { return false; }
}
function liveStop() { const s = sr; sr = null; try { s && s.stop(); } catch { /* ignore */ } }
async function recStart() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('المتصفح لا يدعم التسجيل الصوتي'); return; }
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast(e.name === 'NotAllowedError' ? 'تم رفض إذن الميكروفون. فعّله من إعدادات المتصفح ثم أعد المحاولة.' : e.name === 'NotFoundError' ? 'لم يتم العثور على ميكروفون.' : 'خطأ في الميكروفون: ' + e.message); return; }
  chunks = []; mr = new MediaRecorder(stream);
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); REC.blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' }); if (REC.url) URL.revokeObjectURL(REC.url); REC.url = URL.createObjectURL(REC.blob); REC.on = false; liveStop(); render(); if (useWhisper) transcribeRecording(); };
  useWhisper = H.stt && !FORCE_LIVE; mr.start(); REC.on = true;
  if (!useWhisper && !liveStart()) toast('تفريغ المتصفح غير مدعوم هنا (جرّب Chrome أو Edge)؛ سيُحفظ الصوت فقط.');
  render();
}
function recStop() { if (mr && mr.state !== 'inactive') mr.stop(); }
function recDelete() { if (REC.url) URL.revokeObjectURL(REC.url); REC = { on: false, blob: null, url: '' }; render(); }
async function transcribeBlob(blob, name) {
  const fd = new FormData(); fd.append('file', blob, name); BUSY = 'جارٍ تحويل الصوت إلى نص…'; render();
  try {
    const r = await fetch('/api/transcribe', { method: 'POST', body: fd }), j = await r.json().catch(() => ({}));
    if (!r.ok) { if (j.fallback === 'webspeech') { FORCE_LIVE = true; } throw new Error(j.error || 'تعذر تحويل الصوت'); }
    return j.text || '';
  } finally { BUSY = ''; }
}
async function transcribeRecording() {
  try { const t = await transcribeBlob(REC.blob, 'recording.webm'); if (!t) { toast('لم يُكتشف كلام في التسجيل'); render(); return; } CR.text = (CR.text ? CR.text + '\n\n' : '') + t; CR.mode = 'txt'; render(); toast('تم تحويل التسجيل إلى نص. راجعه ثم استخرج المهام'); }
  catch (e) { render(); toast(e.message + (FORCE_LIVE ? ' — أعد التسجيل وسيُستخدم تفريغ المتصفح.' : '')); }
}

/* ================= files ================= */
async function pdfText(f) {
  if (!window.pdfjsLib) {
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload = ok; s.onerror = () => no(new Error('تعذر تحميل قارئ PDF (يحتاج اتصالًا بالإنترنت)')); document.head.appendChild(s); });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const pdf = await window.pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise; let t = '';
  for (let i = 1; i <= pdf.numPages; i++) t += (await (await pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + '\n';
  return t;
}
async function addFiles(list) {
  for (const f of list) {
    const ext = (f.name.split('.').pop() || '').toLowerCase(), o = { id: uid(), name: f.name, status: 'جارٍ القراءة…', text: '', bad: false };
    const isAudio = (f.type || '').startsWith('audio/') || ['mp3', 'wav', 'm4a', 'ogg', 'webm'].includes(ext);
    CR.files.push(o);
    if (f.size > 5.5 * 1024 * 1024) { o.status = 'الحجم أكبر من 5MB (حد Netlify)'; o.bad = true; render(); continue; }
    if (!['txt', 'pdf', 'docx'].includes(ext) && !isAudio) { o.status = 'نوع غير مدعوم (المدعوم: TXT وPDF وDOCX ومقاطع صوتية mp3/wav/m4a)'; o.bad = true; render(); continue; }
    render();
    try {
      if (ext === 'txt') o.text = await f.text();
      else if (ext === 'pdf') o.text = await pdfText(f);
      else if (ext === 'docx') { const fd = new FormData(); fd.append('file', f, f.name); const r = await fetch('/api/extract', { method: 'POST', body: fd }), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'فشل قراءة الملف'); o.text = j.text; }
      else { if (!H.stt) throw new Error('تحويل الملفات الصوتية يحتاج GROQ_API_KEY. استخدم «تسجيل مباشر» (يعمل بدون مفتاح في Chrome/Edge) أو الصق النص.'); o.text = await transcribeBlob(f, f.name); }
      o.status = o.text.trim() ? `جاهز (${o.text.trim().length} حرف)` : 'لم يُعثر على نص في الملف'; o.bad = !o.text.trim();
    } catch (e) { o.status = e.message || 'فشلت المعالجة'; o.bad = true; }
    render();
  }
}

/* ================= analysis ================= */
const norm = (a) => a.map((x) => ({ id: uid(), t: x.t, o: x.o || '', e: '', d: /^\d{4}-\d\d-\d\d$/.test(x.d || '') ? x.d : '', p: x.p || 'm', k: 1 }));
async function analyze() {
  const src = [CR.text, ...CR.files.filter((f) => f.text).map((f) => f.text)].join('\n\n').trim();
  if (src.length < 15) { toast('أدخل محضرًا لا يقل عن 15 حرفًا (نصًا أو ملفًا أو تسجيلًا)'); return; }
  BUSY = 'جارٍ استخراج المهام…'; render(); let res;
  try {
    const r = await fetch('/api/analyze', { method: 'POST', headers: JH, body: JSON.stringify({ text: src.slice(0, 12000), date: CR.date }) }), j = await r.json().catch(() => ({}));
    if (r.status === 429) { BUSY = ''; render(); toast(j.error); return; }
    if (!r.ok) throw 0; res = j;
  } catch { res = { tasks: localExtract(src.slice(0, 12000), CR.date || today()), mode: 'rules', note: 'تعذر الوصول للخادم، فاستُخدم تحليل مبسّط داخل المتصفح وليس الذكاء الاصطناعي؛ راجع كل مهمة بعناية.' }; }
  const title = CR.title.trim() || 'اجتماع جديد', att = CR.att.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
  let m = live(D.meetings).find((x) => x.title === title && x.date === CR.date && x.minutes === src);
  if (!m) { m = { id: uid(), title, date: CR.date || today(), att, minutes: src, c: now() }; put('meetings', m); }
  RV = { mid: m.id, title, tasks: norm(res.tasks || []), mode: res.mode, note: res.note }; BUSY = ''; location.hash = 'review'; render();
  if (!RV.tasks.length) toast('لم يتم العثور على مهام واضحة؛ يمكنك إضافة مهمة يدوية');
}
function rvAdd() {
  const sel = RV.tasks.filter((x) => x.k); let added = 0, skipped = 0;
  for (const x of sel) {
    const t = x.t.trim(); if (!t) continue;
    if (x.e && !EMAIL_RE.test(x.e)) { toast(`بريد غير صالح للمهمة «${t}»`); return; }
    if (T().some((y) => y.t === t && y.o === x.o.trim() && y.d === x.d && y.m === RV.mid)) { skipped++; continue; }
    put('tasks', { id: uid(), t, o: x.o.trim(), e: x.e.trim(), d: x.d || '', p: x.p, s: 0, m: RV.mid, c: now() });
    put('log', { id: uid(), title: t, owner: x.o.trim(), decision: 'approved', meeting: RV.title, day: today() }); added++;
  }
  if (!added && !skipped) { toast('لا توجد مهام محددة'); return; }
  RV = null; CR = { mode: 'txt', title: '', date: today(), att: '', text: '', files: [] }; location.hash = 'tasks'; render();
  toast(`تمت إضافة ${added} مهام${skipped ? ` (تخطّي ${skipped} مكررة)` : ''}`);
}
function rvSkip() {
  const sel = RV.tasks.filter((x) => x.k); if (!sel.length) { toast('لا توجد مهام محددة'); return; }
  sel.forEach((x) => put('log', { id: uid(), title: x.t, owner: x.o, decision: 'rejected', meeting: RV.title, day: today() }));
  RV.tasks = RV.tasks.filter((x) => !x.k); render(); toast('تم تجاهل المهام المحددة وتسجيلها كمرفوضة');
}

/* ================= views ================= */
const fmtD = (d) => d || 'بلا موعد';
function taskTile(x) {
  return `<div class="tc task-tile"><b>${esc(x.t)}</b><div><span class="mu">${esc(x.o || 'غير محدد')}${x.e ? ' · ' + esc(x.e) : ''}</span>${bd(x.p)}</div><div><span class="mu ${isOver(x) ? 'ov' : ''}">${isOver(x) ? 'متأخرة · ' : ''}${esc(fmtD(x.d))}</span></div>
  <div class="task-controls"><select data-c="tstat" data-id="${x.id}" aria-label="الحالة">${ST.map((s, i) => `<option value="${i}" ${x.s === i ? 'selected' : ''}>${s}</option>`).join('')}</select><button class="task-ghost" data-a="tedit" data-id="${x.id}">تعديل</button><button class="task-ghost" data-a="tmail" data-id="${x.id}" title="إرسال تذكير للمسؤول">✉ تذكير</button><button class="task-delete" data-a="tdel" data-id="${x.id}">حذف</button></div></div>`;
}
function taskForm() {
  const f = FORM, isNew = !f.id;
  return `<div class="card" id="tform" style="margin-bottom:18px"><h2>${isNew ? 'إضافة مهمة جديدة' : 'تعديل المهمة'}</h2>
  <label>عنوان المهمة *</label><input data-in="tf" data-k="t" value="${esc(f.t)}" placeholder="مثال: إرسال تقرير المبيعات">
  <div class="fgrid"><div><label>المسؤول</label><input data-in="tf" data-k="o" value="${esc(f.o)}" placeholder="اسم المسؤول"></div><div><label>بريد المسؤول</label><input type="email" data-in="tf" data-k="e" value="${esc(f.e)}" placeholder="name@company.com"></div><div><label>الموعد النهائي</label><input type="date" data-in="tf" data-k="d" value="${esc(f.d)}"></div></div>
  <div class="fgrid"><div><label>الحالة</label><select data-in="tf" data-k="s">${ST.map((s, i) => `<option value="${i}" ${+f.s === i ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div><label>الأولوية</label><select data-in="tf" data-k="p">${Object.entries(PL).map(([k, v]) => `<option value="${k}" ${f.p === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></div></div>
  <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap"><button class="btn" data-a="tsave">${isNew ? 'إضافة المهمة' : 'حفظ التعديل'}</button>${isNew ? '' : '<button class="btn gh" data-a="tmailnow">حفظ وإرسال تذكير</button>'}<button class="btn line" data-a="tcancel">إلغاء</button></div></div>`;
}
const VIEWS = {
  dash() {
    const t = T(), open = t.filter((x) => x.s !== 2), done = t.length - open.length, over = open.filter(isOver).length, pct = t.length ? Math.round((done / t.length) * 100) : 0;
    const next = open.filter((x) => x.d).sort((a, b) => a.d.localeCompare(b.d)).slice(0, 5);
    return `<h1>لوحة العمل</h1><p class="sub">من الاجتماع إلى الإنجاز — كل مهامك في مكان واحد.</p>
    <div class="hero"><div><h2>حوّل محضر اجتماعك إلى مهام</h2><p>الصق النص أو ارفع ملفًا أو سجّل صوتك، أو أضف مهمة يدويًا.</p></div><div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="#create">اجتماع جديد</a><button class="btn gh" data-a="newtask">مهمة جديدة</button></div></div>
    <div class="g4">${[['مهام مفتوحة', open.length], ['مهام مكتملة', done], ['مهام متأخرة', over], ['نسبة الإنجاز', pct + '%']].map((x) => `<div class="card st"><span>${x[0]}</span><div class="n">${x[1]}</div></div>`).join('')}</div>
    <div class="g2"><div class="card"><h2>مهام تستحق قريبًا</h2>${next.map((x) => `<a class="row" href="#tasks" style="text-decoration:none;color:inherit"><b>${esc(x.t)}</b><span class="mu ${isOver(x) ? 'ov' : ''}">${esc(x.o || 'غير محدد')} · ${esc(x.d)}</span></a>`).join('') || '<p class="mu">لا توجد مهام بمواعيد بعد.</p>'}</div>
    <div class="card"><h2>آخر الاجتماعات</h2>${MT().slice(0, 5).map((m) => `<a class="row" href="#log" style="text-decoration:none;color:inherit"><b>${esc(m.title)}</b><span class="mu">${esc(m.date)}</span></a>`).join('') || '<p class="mu">لا توجد اجتماعات محفوظة. تُحفظ تلقائيًا عند تحليل محضر.</p>'}</div></div>`;
  },
  create() {
    const m = CR.mode, ready = !!H.stt;
    const tabs = [['txt', 'نص'], ['voice', 'صوت'], ['file', 'ملفات']].map(([k, n]) => `<button class="${m === k ? 'on' : ''}" data-a="cmode" data-m="${k}">${n}</button>`).join('');
    let panel = '';
    if (m === 'txt') panel = `<label>محضر الاجتماع</label><textarea id="txt" data-in="cr" data-k="text" style="min-height:240px" placeholder="الصق تفريغ الاجتماع هنا…">${esc(CR.text)}</textarea>`;
    else if (m === 'voice') panel = `<div class="note">${ready && !FORCE_LIVE ? 'سيُحوَّل التسجيل إلى نص بواسطة Whisper (Groq) عند الإيقاف.' : 'سيُستخدم التفريغ الفوري من المتصفح (يعمل في Chrome وEdge) وتظهر الكلمات أثناء الحديث.'}</div>
      <div class="rec">${REC.on ? '<button class="btn" data-a="recstop">⏹ إيقاف التسجيل</button><span class="dotrec"></span><span class="mu">جارٍ التسجيل…</span>' : '<button class="btn" data-a="recstart">🎙 ' + (REC.blob ? 'تسجيل جديد' : 'ابدأ التسجيل') + '</button>'}${REC.blob && !REC.on ? '<button class="btn gh" data-a="recredo">إعادة التسجيل</button><button class="btn line" data-a="recdel">حذف التسجيل</button>' : ''}</div>
      ${REC.url && !REC.on ? `<audio controls src="${REC.url}" style="width:100%;margin-top:14px"></audio><div style="margin-top:10px">${ready && !FORCE_LIVE ? '<button class="btn gh sm" data-a="trec">تحويل التسجيل إلى نص</button>' : ''}</div>` : ''}
      <label>النص المفرَّغ (يمكنك تعديله)</label><textarea id="txt" data-in="cr" data-k="text" placeholder="سيظهر النص هنا…">${esc(CR.text)}</textarea>`;
    else panel = `<label class="dz" for="fi"><b>اسحب الملفات أو اضغط للاختيار</b><span class="mu">TXT · PDF · DOCX · ملفات صوتية (mp3/wav/m4a) حتى 5MB</span></label><input id="fi" type="file" multiple style="display:none" accept=".txt,.pdf,.docx,.mp3,.wav,.m4a,.ogg,.webm,audio/*" data-c="files">
      ${CR.files.map((f) => `<div class="fl"><span>📄 ${esc(f.name)}</span><span class="mu ${f.bad ? 'ov' : ''}">${esc(f.status)}</span><button class="task-delete" data-a="fdel" data-id="${f.id}">حذف</button></div>`).join('')}
      <label>نص إضافي (اختياري)</label><textarea id="txt" data-in="cr" data-k="text" style="min-height:90px">${esc(CR.text)}</textarea>`;
    return `<h1>اجتماع جديد</h1><p class="sub">أدخل المحضر بأي طريقة، وسيُستخرج منه المهام والمسؤولون والمواعيد لتراجعها قبل الإضافة.</p>
    <div class="card"><div class="fgrid"><div><label>عنوان الاجتماع</label><input data-in="cr" data-k="title" value="${esc(CR.title)}" placeholder="مثال: اجتماع الفريق الأسبوعي"></div><div><label>التاريخ</label><input type="date" data-in="cr" data-k="date" value="${esc(CR.date)}"></div><div><label>المشاركون (افصل بفاصلة)</label><input data-in="cr" data-k="att" value="${esc(CR.att)}" placeholder="أحمد، سارة"></div></div>
    <div class="tabs" style="margin-top:20px">${tabs}</div>${panel}
    <div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;align-items:center"><button class="btn" data-a="analyze" ${BUSY ? 'disabled' : ''}>${BUSY || 'استخراج المهام'}</button><button class="btn line" data-a="newtask">إضافة مهمة يدوية بدون تحليل</button>${RV ? '<a class="btn gh" href="#review">العودة للمراجعة</a>' : ''}</div></div>`;
  },
  review() {
    const sel = RV.tasks.filter((x) => x.k).length;
    return `<h1>مراجعة المهام المقترحة</h1><p class="sub">${esc(RV.title)} — عدّل ما يلزم، ثم أضف المحدد إلى قائمة المهام. لا يُحفظ شيء قبل ذلك.</p>
    <div class="note ${RV.mode === 'rules' ? 'wn' : ''}">${esc(RV.note || '')}</div>${RV.tasks.length ? '' : '<div class="note">لم يتم العثور على مهام واضحة. يمكنك إضافة مهمة يدوية.</div>'}
    ${RV.tasks.map((x, i) => `<div class="sug ${x.k ? '' : 'off'}"><div class="sug-h"><input class="chk" type="checkbox" data-c="rvk" data-i="${i}" ${x.k ? 'checked' : ''} aria-label="تحديد"><input type="text" data-in="rv" data-i="${i}" data-k="t" value="${esc(x.t)}" placeholder="عنوان المهمة"><button class="task-delete" data-a="rvdel" data-i="${i}">حذف</button></div>
    <div class="fgrid"><div><label>المسؤول (فارغ إن لم يُذكر)</label><input data-in="rv" data-i="${i}" data-k="o" value="${esc(x.o)}"></div><div><label>بريد المسؤول (اختياري)</label><input type="email" data-in="rv" data-i="${i}" data-k="e" value="${esc(x.e)}"></div><div><label>الموعد النهائي</label><input type="date" data-in="rv" data-i="${i}" data-k="d" value="${esc(x.d)}"></div></div>
    <div class="fgrid"><div><label>الأولوية</label><select data-in="rv" data-i="${i}" data-k="p">${Object.entries(PL).map(([k, v]) => `<option value="${k}" ${x.p === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></div></div></div>`).join('')}
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" data-a="rvadd">إضافة المحدد إلى المهام (${sel})</button><button class="btn gh" data-a="rvblank">+ مهمة يدوية</button><button class="btn line" data-a="rvskip">تجاهل المحدد</button><a class="btn line" href="#create">رجوع للمحضر</a></div>`;
  },
  tasks() {
    const q = FIL.trim(), all = T().filter((x) => !q || (x.t + ' ' + x.o + ' ' + x.e).includes(q));
    return `<h1>المهام</h1><p class="sub">أضف وعدّل واحذف وغيّر الحالة مباشرة، وأرسل تذكيرًا للمسؤول.</p>
    <div class="srch"><button class="btn" data-a="newtask">+ إضافة مهمة</button><input data-in="fil" placeholder="بحث في المهام…" value="${esc(FIL)}"></div>${FORM ? taskForm() : ''}
    ${T().length ? '' : '<div class="note">لا توجد مهام بعد. أضف مهمة يدويًا أو ابدأ من «اجتماع جديد».</div>'}
    <div class="g3">${ST.map((l, s) => `<div class="col"><h2>${l} <span class="mu">(${all.filter((x) => x.s === s).length})</span></h2>${all.filter((x) => x.s === s).sort((a, b) => (a.d || '9').localeCompare(b.d || '9')).map(taskTile).join('')}</div>`).join('')}</div>`;
  },
  cal() {
    const y = calM.getFullYear(), mo = calM.getMonth(), start = new Date(y, mo, 1).getDay(), days = new Date(y, mo + 1, 0).getDate(), pad = (n) => String(n).padStart(2, '0'), td = today(), it = {};
    const add = (k, v) => { (it[k] = it[k] || []).push(v); };
    T().forEach((t) => t.d && add(t.d, { k: t.s === 2 ? 'et' : 'ep', t: t.t, a: 'tasks' })); MT().forEach((m) => add(m.date, { k: 'em', t: m.title, a: 'log', id: m.id }));
    let cells = ''; for (let i = 0; i < start; i++) cells += '<div class="cd off"></div>';
    for (let d = 1; d <= days; d++) { const key = `${y}-${pad(mo + 1)}-${pad(d)}`, l = it[key] || []; cells += `<div class="cd${key === td ? ' td' : ''}"><span class="dn">${d}</span>${l.slice(0, 3).map((e) => `<button class="ev ${e.k}" data-a="calgo" data-go="${e.a}" data-id="${e.id || ''}">${esc(e.t)}</button>`).join('')}${l.length > 3 ? `<span class="mu">+${l.length - 3}</span>` : ''}</div>`; }
    return `<h1>التقويم</h1><p class="sub">مواعيد الاجتماعات وتسليم المهام في مكان واحد.</p><div class="cal-head"><button class="btn gh" data-a="calnav" data-n="-1" aria-label="الشهر السابق">‹</button><b>${calM.toLocaleDateString('ar', { month: 'long', year: 'numeric' })}</b><button class="btn gh" data-a="calnav" data-n="1" aria-label="الشهر التالي">›</button><button class="btn gh" data-a="caltoday">اليوم</button></div>
    <div class="cal">${['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'].map((x) => `<div class="cw">${x}</div>`).join('')}${cells}</div><p class="mu" style="margin-top:12px"><span class="lgd em"></span> اجتماع <span class="lgd ep"></span> مهمة مفتوحة <span class="lgd et"></span> مهمة مكتملة</p>`;
  },
  ask() {
    return `<h1>اسأل Task Node</h1><p class="sub">إجابات من بياناتك الفعلية (مساعد بقواعد محددة، وليس نموذجًا لغويًا).</p>
    <div class="chips">${['ما المهام المتأخرة؟', 'لخّص آخر اجتماع', 'ما نسبة الإنجاز؟', 'ما المهام المعلقة؟'].map((q) => `<button data-a="askq" data-q="${esc(q)}">${q}</button>`).join('')}</div>
    <div class="card"><div class="chat" id="ch">${ASK.length ? '' : '<p class="mu" style="padding:10px">اسأل عن: المهام المتأخرة، آخر اجتماع، نسبة الإنجاز، أو «من المسؤول عن …».</p>'}${ASK.map((m) => `<div class="m u">${esc(m[0])}</div><div class="m a">${m[1]}</div>`).join('')}</div>
    <div class="snd" style="margin-top:16px"><input id="q" placeholder="اكتب سؤالك…" data-enter="ask"><button class="btn" data-a="askq">إرسال</button></div></div>`;
  },
  stats() {
    const t = T(), done = t.filter((x) => x.s === 2).length, pct = t.length ? Math.round((done / t.length) * 100) : 0, over = t.filter(isOver).length, by = {};
    t.forEach((x) => { const k = x.o || 'غير محدد'; by[k] = by[k] || { n: 0, d: 0, o: 0 }; by[k].n++; if (x.s === 2) by[k].d++; else if (isOver(x)) by[k].o++; });
    return `<h1>التحليلات ومؤشرات الأداء</h1><p class="sub">مؤشرات مبنية على مهامك الفعلية.</p><div style="display:flex;justify-content:flex-end;margin-bottom:14px"><button class="btn gh" data-a="csv">تصدير المهام CSV</button></div>
    <div class="g4">${[['إجمالي المهام', t.length], ['نسبة الإنجاز', pct + '%'], ['مهام مكتملة', done], ['مهام متأخرة', over]].map((x) => `<div class="card st"><span>${x[0]}</span><div class="n">${x[1]}</div></div>`).join('')}</div>
    <div class="card"><h2>توزيع الحالات</h2>${ST.map((n, i) => { const c = t.filter((x) => x.s === i).length; return `<div class="row"><b>${n}</b><span>${c}</span></div><div class="bar"><i style="width:${t.length ? Math.round((c / t.length) * 100) : 0}%"></i></div>`; }).join('')}</div>
    <div class="card" style="margin-top:16px"><h2>أداء المسؤولين</h2>${Object.keys(by).length ? `<div style="overflow-x:auto"><table class="tb"><tr><th>المسؤول</th><th>مسندة</th><th>مكتملة</th><th>متأخرة</th><th>الإنجاز</th></tr>${Object.entries(by).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${v.d}</td><td>${v.o}</td><td>${Math.round((v.d / v.n) * 100)}%</td></tr>`).join('')}</table></div>` : '<p class="mu">لا توجد بيانات بعد.</p>'}</div>`;
  },
  log() {
    const dec = LG(), ap = dec.filter((x) => x.decision === 'approved').length, rj = dec.length - ap;
    const card = (m) => {
      const open = LOGOPEN === m.id, tk = T().filter((t) => t.m === m.id);
      const head = `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap"><div><b>${esc(m.title)}</b><div class="mu">${esc(m.date)} · ${(m.att || []).length} مشاركين · ${tk.length} مهام</div></div><button class="btn gh sm" data-a="logopen" data-id="${m.id}">${open ? 'إخفاء' : 'عرض التفاصيل'}</button></div>`;
      if (!open) return `<div class="card" style="margin-bottom:14px">${head}</div>`;
      if (LOGEDIT === m.id) return `<div class="card" style="margin-bottom:14px">${head}<label>العنوان</label><input id="mtT" value="${esc(m.title)}"><label>التاريخ</label><input id="mtD" type="date" value="${esc(m.date)}"><label>المحضر</label><textarea id="mtM" style="min-height:180px">${esc(m.minutes)}</textarea><div style="display:flex;gap:8px;margin-top:12px"><button class="btn" data-a="mtsave" data-id="${m.id}">حفظ</button><button class="btn line" data-a="mtcancel">إلغاء</button></div></div>`;
      return `<div class="card" style="margin-bottom:14px">${head}<hr style="border:0;border-top:1px solid var(--ln);margin:14px 0">${(m.att || []).length ? `<p>${m.att.map((a) => `<span class="b md" style="margin-inline-end:6px">${esc(a)}</span>`).join('')}</p>` : ''}<h3>المحضر</h3><p style="white-space:pre-wrap">${esc(m.minutes)}</p><h3>المهام المضافة من هذا الاجتماع</h3>${tk.length ? tk.map((t) => `<div class="row"><b>${esc(t.t)}</b><span class="mu">${esc(t.o || 'غير محدد')} · ${ST[t.s]}</span></div>`).join('') : '<p class="mu">لم تُضف مهام من هذا الاجتماع بعد.</p>'}<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="btn sm" data-a="mtre" data-id="${m.id}">إعادة استخراج المهام</button><button class="btn gh sm" data-a="mtedit" data-id="${m.id}">تعديل</button><button class="btn line sm" data-a="mtdel" data-id="${m.id}">حذف</button></div></div>`;
    };
    return `<h1>سجل الاجتماعات</h1><p class="sub">المحاضر المحفوظة والمهام المرتبطة بها وقراراتك عليها.</p>
    <div class="g3"><div class="card st"><span>قرارات بالإضافة</span><div class="n">${ap}</div></div><div class="card st"><span>مقترحات مرفوضة</span><div class="n">${rj}</div></div><div class="card st"><span>اجتماعات محفوظة</span><div class="n">${MT().length}</div></div></div>
    ${MT().length ? MT().map(card).join('') : '<div class="card"><p class="mu">لا توجد اجتماعات محفوظة بعد. تُحفظ تلقائيًا عند تحليل أي محضر.</p><a class="btn" href="#create">اجتماع جديد</a></div>'}`;
  },
  settings() {
    const link = `${location.origin}${location.pathname}?w=${WS}`;
    const row = (n, ok, extra) => `<div class="row"><b>${n}</b><span class="b ${ok ? 'lo' : 'md'}">${ok ? 'مفعّل' : 'غير مفعّل'}</span></div>${extra ? `<p class="mu" style="margin:4px 4px 0">${extra}</p>` : ''}`;
    return `<h1>الإعدادات</h1><p class="sub">مساحة عملك وحالة الخدمات.</p>
    <div class="card"><h2>مساحة العمل</h2><p class="mu">لكل متصفح مساحة عمل خاصة تُحفظ تلقائيًا على جهازك وعلى السحابة. شارك الرابط التالي مع فريقك ليعملوا على نفس المهام (أي شخص لديه الرابط يستطيع التعديل).</p><div class="lnk" id="wl">${esc(link)}</div>
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap"><button class="btn" data-a="copylink">نسخ رابط المشاركة</button><button class="btn gh" data-a="export">تصدير نسخة JSON</button><label class="btn gh" style="margin:0;cursor:pointer">استيراد نسخة<input type="file" accept=".json,application/json" style="display:none" data-c="import"></label><button class="btn line" data-a="wipe">مسح كل البيانات</button></div></div>
    <div class="card" style="margin-top:16px"><h2>حالة الخدمات</h2>${row('التخزين السحابي', H.ok && !String(H.storage).startsWith('error'), H.ok ? '' : 'تعذر الاتصال بالخادم؛ بياناتك محفوظة على جهازك.')}${row('الذكاء الاصطناعي (Groq)', H.ai_key, H.ai_key ? '<button class="btn gh sm" data-a="aitest">اختبار الآن</button>' : 'غير مضبوط GROQ_API_KEY: يعمل المحلل المبسّط بالقواعد.')}${row('تحويل الصوت (Whisper)', H.stt, H.stt ? '' : 'بدونه يُستخدم تفريغ المتصفح المباشر.')}${row('إرسال البريد (Resend)', H.email, H.email ? '' : 'بدونه يفتح زر «تذكير» رسالة بريد جاهزة (mailto).')}</div>
    <div class="card" style="margin-top:16px"><h2>المظهر</h2><button class="btn gh" data-a="theme">تبديل الوضع الداكن/الفاتح</button></div>`;
  },
};

/* ================= shell + render ================= */
const curView = () => { const v = location.hash.slice(1) || 'dash'; return VIEWS[v] && (v !== 'review' || RV) ? v : 'dash'; };
function render() {
  const v = curView(), nav = RV ? [...NAV.slice(0, 2), ['review', `مراجعة المقترحات (${RV.tasks.length})`], ...NAV.slice(2)] : NAV;
  $('#root').innerHTML = `<div class="app"><aside><div class="logo brand"><img class="brand-logo" src="tasknode-logo.png" alt="Task Node — من الاجتماع إلى الإنجاز"></div>${nav.map(([k, n]) => `<a href="#${k}" class="${k === v ? 'on' : ''}">${n}</a>`).join('')}<div class="ft">من الاجتماع إلى الإنجاز</div></aside>
  <main><div class="top"><span class="crumb">Task Node / ${TITLES[v]}</span><span class="pill" id="sync"></span><button class="th" data-a="theme" title="تبديل المظهر" aria-label="تبديل المظهر">◐</button></div><div class="pg">${VIEWS[v]()}</div></main></div>`;
  setSync(sync);
}
const editing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');

/* ================= actions ================= */
const A = {
  theme() { const d = document.documentElement, dark = getComputedStyle(d).colorScheme === 'dark', n = dark ? 'light' : 'dark'; d.dataset.theme = n; ls('tn_theme', n); },
  newtask() { FORM = { t: '', o: '', e: '', d: '', s: 0, p: 'm' }; if (location.hash !== '#tasks') location.hash = 'tasks'; else render(); setTimeout(() => $('#tform')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50); },
  tedit(el) { const t = T().find((x) => x.id === el.dataset.id); if (!t) return; FORM = { ...t }; render(); $('#tform')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
  tcancel() { FORM = null; render(); },
  tsave(el, e, quiet) {
    const f = FORM, t = String(f.t || '').trim(); if (!t) { toast('عنوان المهمة مطلوب'); return null; }
    if (f.e && !EMAIL_RE.test(f.e.trim())) { toast('البريد الإلكتروني غير صالح'); return null; }
    if (f.d && !/^\d{4}-\d\d-\d\d$/.test(f.d)) { toast('الموعد غير صالح'); return null; }
    const o = { ...f, id: f.id || uid(), t, o: String(f.o || '').trim(), e: String(f.e || '').trim(), s: +f.s || 0, c: f.c || now() }; put('tasks', o); FORM = null; render(); if (!quiet) toast(f.id ? 'تم حفظ التعديل' : 'تمت إضافة المهمة'); return o;
  },
  tmailnow(el, e) { const o = A.tsave(null, null, true); if (o) mailTask(o.id); },
  tdel(el) { const t = T().find((x) => x.id === el.dataset.id); if (t && confirm(`حذف المهمة «${t.t}»؟`)) { del('tasks', t.id); render(); toast('تم حذف المهمة'); } },
  tmail(el) { mailTask(el.dataset.id); },
  cmode(el) { CR.mode = el.dataset.m; render(); },
  recstart: recStart, recstop: recStop, recdel: recDelete, recredo() { recDelete(); recStart(); }, trec: transcribeRecording,
  fdel(el) { CR.files = CR.files.filter((f) => f.id !== el.dataset.id); render(); },
  analyze,
  rvadd: rvAdd, rvskip: rvSkip,
  rvblank() { RV.tasks.push({ id: uid(), t: '', o: '', e: '', d: '', p: 'm', k: 1 }); render(); },
  rvdel(el) { RV.tasks.splice(+el.dataset.i, 1); render(); },
  calnav(el) { calM = new Date(calM.getFullYear(), calM.getMonth() + +el.dataset.n, 1); render(); },
  caltoday() { calM = new Date(); render(); },
  calgo(el) { if (el.dataset.go === 'log') { LOGOPEN = el.dataset.id; location.hash = 'log'; } else location.hash = 'tasks'; },
  askq(el) { const q = el.dataset.q || $('#q')?.value || ''; ask(q); },
  csv() {
    const t = T(); if (!t.length) { toast('لا توجد مهام للتصدير'); return; }
    const q = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const rows = [['العنوان', 'المسؤول', 'البريد', 'الموعد', 'الأولوية', 'الحالة'], ...t.map((x) => [x.t, x.o, x.e, x.d, (PL[x.p] || PL.m)[0], ST[x.s]])];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })); a.download = 'tasknode-tasks.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  },
  logopen(el) { LOGOPEN = LOGOPEN === el.dataset.id ? '' : el.dataset.id; LOGEDIT = ''; render(); },
  mtedit(el) { LOGEDIT = el.dataset.id; render(); }, mtcancel() { LOGEDIT = ''; render(); },
  mtsave(el) { const m = D.meetings.find((x) => x.id === el.dataset.id); if (!m) return; put('meetings', { ...m, title: $('#mtT').value.trim() || m.title, date: $('#mtD').value || m.date, minutes: $('#mtM').value }); LOGEDIT = ''; render(); toast('تم حفظ التعديلات'); },
  mtdel(el) { if (confirm('حذف الاجتماع من السجل؟ المهام المضافة لا تُحذف.')) { del('meetings', el.dataset.id); LOGOPEN = ''; render(); toast('تم حذف الاجتماع'); } },
  mtre(el) { const m = live(D.meetings).find((x) => x.id === el.dataset.id); if (!m) return; CR = { mode: 'txt', title: m.title, date: m.date, att: (m.att || []).join('، '), text: m.minutes, files: [] }; location.hash = 'create'; setTimeout(analyze, 50); },
  async copylink() { const l = $('#wl').textContent; try { await navigator.clipboard.writeText(l); toast('تم نسخ الرابط'); } catch { const r = document.createRange(); r.selectNodeContents($('#wl')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('حدد الرابط وانسخه يدويًا'); } },
  export() { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(D, null, 1)], { type: 'application/json' })); a.download = 'tasknode-backup.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500); },
  wipe() { if (!confirm('سيُحذف كل شيء في مساحة العمل هذه (المهام والاجتماعات). متأكد؟')) return; ['tasks', 'meetings', 'log'].forEach((k) => D[k].forEach((x) => { if (!x.x) { const i = D[k].indexOf(x); D[k][i] = { id: x.id, x: 1, u: now() }; } })); persist(); render(); toast('تم مسح البيانات'); },
  async aitest() { try { const r = await fetch('/api/health/ai'), j = await r.json(); toast('الذكاء الاصطناعي: ' + (j.ai_test || '—')); } catch { toast('تعذر الاتصال بالخادم'); } },
};
function ask(q) {
  q = String(q || '').trim(); if (!q) return; const n = q.replace(/[إأآ]/g, 'ا'), t = T(), open = t.filter((x) => x.s !== 2), over = open.filter(isOver);
  const li = (a) => (a.length ? '<ul>' + a.map((x) => `<li>${esc(x.t)} — ${esc(x.o || 'غير محدد')}${x.d ? ' · ' + esc(x.d) : ''}</li>`).join('') + '</ul>' : ''); let a;
  if (/متاخر|تاخر/.test(n)) a = over.length ? `<b>لديك ${over.length} مهام متأخرة:</b>` + li(over) : 'لا توجد مهام متأخرة حاليًا.';
  else if (/لخص|اخر اجتماع|الاجتماع الاخير/.test(n)) { const m = MT()[0]; a = m ? `<b>${esc(m.title)}</b> (${esc(m.date)})<br>${esc((m.minutes || '').slice(0, 320))}${m.minutes.length > 320 ? '…' : ''}` : 'لا توجد اجتماعات محفوظة بعد.'; }
  else if (/الانجاز|نسبه/.test(n)) { const d = t.length - open.length; a = t.length ? `نسبة الإنجاز ${Math.round((d / t.length) * 100)}% (${d} من ${t.length} مهمة).` : 'لا توجد مهام بعد.'; }
  else if (/معلق|قيد الانتظار/.test(n)) { const p = t.filter((x) => x.s === 0); a = p.length ? `<b>${p.length} مهام معلقة:</b>` + li(p) : 'لا توجد مهام معلقة.'; }
  else if (/مسؤول/.test(n)) { const m = q.match(/عن\s+(.+?)\s*[؟?]*$/), k = m ? m[1].trim() : '', hit = k ? t.filter((x) => x.t.includes(k)) : []; a = hit.length ? li(hit) : 'لم أجد مهامًا تحتوي «' + esc(k || '—') + '».'; }
  else a = 'أستطيع الإجابة عن: المهام المتأخرة، آخر اجتماع، نسبة الإنجاز، المهام المعلقة، و«من المسؤول عن …».';
  ASK.push([q, a]); render(); const ch = $('#ch'); if (ch && ch.lastChild) ch.lastChild.scrollIntoView({ block: 'end' });
}
const CHG = {
  tstat(el) { const t = T().find((x) => x.id === el.dataset.id); if (t) { put('tasks', { ...t, s: +el.value }); render(); toast('تم تحديث الحالة'); } },
  rvk(el) { RV.tasks[+el.dataset.i].k = el.checked ? 1 : 0; render(); },
  files(el) { const l = [...el.files]; el.value = ''; if (l.length) addFiles(l); },
  import(el) { const f = el.files[0]; el.value = ''; if (!f) return; f.text().then((s) => { try { const j = JSON.parse(s); D = mDoc(D, { tasks: j.tasks || [], meetings: j.meetings || [], log: j.log || [] }); persist(); render(); toast('تم استيراد النسخة'); } catch { toast('ملف غير صالح'); } }); },
};
const INP = {
  cr(el) { CR[el.dataset.k] = el.value; }, tf(el) { FORM[el.dataset.k] = el.value; }, rv(el) { RV.tasks[+el.dataset.i][el.dataset.k] = el.value; },
  fil(el) { FIL = el.value; clearTimeout(INP._t); INP._t = setTimeout(() => { const pos = el.selectionStart; render(); const n = $('[data-in=fil]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 250); },
};
document.addEventListener('click', (e) => { const el = e.target.closest('[data-a]'); if (el && A[el.dataset.a]) A[el.dataset.a](el, e); });
document.addEventListener('change', (e) => { const el = e.target.closest('[data-c]'); if (el && CHG[el.dataset.c]) CHG[el.dataset.c](el, e); });
document.addEventListener('input', (e) => { const el = e.target.closest('[data-in]'); if (el && INP[el.dataset.in]) INP[el.dataset.in](el, e); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset?.enter === 'ask') { e.preventDefault(); ask(e.target.value); } });
addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length && curView() === 'create') { e.preventDefault(); CR.mode = 'file'; render(); addFiles([...e.dataTransfer.files]); } });

/* ================= motion (animation only) ================= */
(() => {
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) return; let last = null, t;
  const countUp = () => $$('main .st .n').forEach((el) => { const m = el.textContent.trim().match(/^(\d+)(\D*)$/); if (!m || !+m[1]) return; const n = +m[1], suf = m[2], t0 = performance.now(); (function f(now) { const k = Math.min(1, (now - t0) / 800); el.textContent = Math.round(n * (1 - Math.pow(1 - k, 3))) + suf; if (k < 1) requestAnimationFrame(f); else el.textContent = m[1] + suf; })(t0); });
  new MutationObserver(() => { const h = location.hash; if (h === last) return; last = h; document.body.classList.add('vt'); clearTimeout(t); t = setTimeout(() => document.body.classList.remove('vt'), 1100); countUp(); }).observe($('#root'), { childList: true });
})();

/* ================= boot ================= */
render();
fetch('/api/health').then((r) => r.json()).then((j) => { H = { ...H, ...j }; if (curView() === 'settings' || curView() === 'create') render(); }).catch(() => {});
pull().then((ch) => { if (ch && !editing()) render(); });
setInterval(() => { if (!document.hidden && sync === 'ok') pull().then((ch) => { if (ch && !editing()) render(); }); }, 25000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pull().then((ch) => { if (ch && !editing()) render(); }); });
addEventListener('beforeunload', () => { if (sync === 'pending') { try { navigator.sendBeacon('/api/ws?id=' + WS, new Blob([JSON.stringify({ doc: D })], { type: 'application/json' })); } catch { /* ignore */ } } });
