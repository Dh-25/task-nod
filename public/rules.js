// Rule-based Arabic task extractor. Shared by the Netlify function (fallback) and the browser (offline fallback).
// Never invents owners or dates: anything not stated in the text stays empty.
const MONTHS = { يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12 };
const WDAYS = { الاحد: 0, الاثنين: 1, الثلاثاء: 2, الاربعاء: 3, الخميس: 4, الجمعه: 5, السبت: 6 };
const STOP = new Set(['ان', 'انه', 'انها', 'ذلك', 'هذا', 'هذه', 'الحضور', 'الجميع', 'من', 'في', 'الي', 'علي', 'بعد', 'قبل', 'كل', 'لم', 'ما']);
/* Simple Arabic rules used when the AI service is unavailable. Never invents owners or dates. */
export function localExtract(text, base) {
  const clean = text.replace(/[\u064B-\u0652\u0640]/g, ''), norm = clean.replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const b = new Date(base + 'T00:00:00Z'), add = (n) => new Date(b.getTime() + n * 864e5).toISOString().slice(0, 10);
  const CUE = /(سيقوم|ستقوم|سيرسل|سترسل|سيجهز|ستجهز|سيراجع|ستراجع|سيحدث|ستحدث|سيعد|ستعد|سينجز|ستنجز|سيكمل|ستكمل|سينهي|ستنهي|يتولي|تتولي|يجب|ينبغي|مطلوب|طلب[تا]? \S+ من|تجهيز|تحديث|مراجعه|ارسال|اعداد|يرسل|ترسل|يجهز|تجهز|يراجع|تراجع|يحدث|تحدث|ينهي|تنهي|يكمل|تكمل|متابعه)/;
  const OWN = [/طلب[تا]? \S+ من (\S+)/, /(?:يتولي|تتولي) (\S+)/, /علي ان [تي]\S* (\S+)/, /(?:قال|قالت|وعد|وعدت) (\S+)/, /^\s*علي (\S+)/, /(\S+) (?:سيقوم|ستقوم|سيرسل|سترسل|سيجهز|ستجهز|سيراجع|ستراجع|سيحدث|ستحدث|سيعد|ستعد|سينجز|ستنجز|سيكمل|ستكمل)/];
  const re = /[\n.؛;!؟?]+/, ns = norm.split(re), cs = clean.split(re), out = [], seen = new Set();
  ns.forEach((st, i) => {
    const o = (cs[i] || '').trim(); if (st.trim().length < 8 || !CUE.test(st)) return;
    let owner = '';
    if (!/لم يحدد|لم يتم تحديد|غير محدد/.test(st)) for (const r of OWN) {
      const m = st.match(r), g = m && (m[1] || m[2]); if (!g) continue;
      const w = g.replace(/[،,:]+$/, ''); if (STOP.has(w) || (w.startsWith('ال') && w !== 'الفريق') || w.length < 2) continue;
      owner = cs[i].substr(st.indexOf(g, m.index), w.length); break;
    }
    let d = '', dm;
    if ((dm = st.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) d = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
    else if ((dm = st.match(new RegExp('(\\d{1,2}) (' + Object.keys(MONTHS).join('|') + ')(?: (\\d{4}))?')))) { const y = dm[3] ? +dm[3] : b.getUTCFullYear(); let c = `${y}-${String(MONTHS[dm[2]]).padStart(2, '0')}-${dm[1].padStart(2, '0')}`; if (!dm[3] && c < base) c = `${y + 1}${c.slice(4)}`; d = c; }
    else if (/بعد غد/.test(st)) d = add(2); else if (/غدا/.test(st)) d = add(1);
    else if (/(?:خلال|بعد) اسبوعين/.test(st)) d = add(14);
    else if ((dm = st.match(/(?:خلال|بعد) (\d+) (?:ايام|يوم)/))) d = add(+dm[1]);
    else if (/(?:خلال|بعد) اسبوع|الاسبوع القادم/.test(st)) d = add(7);
    else if ((dm = st.match(new RegExp('(' + Object.keys(WDAYS).join('|') + ')')))) d = add(((WDAYS[dm[1]] - b.getUTCDay() + 7) % 7) || 7);
    const p = /عاجل|فورا|بسرعه|باسرع|اولويه عاليه|ضروري|مهم جدا/.test(st) ? 'h' : /لاحقا|عند الامكان|اولويه منخفضه/.test(st) ? 'l' : 'm';
    const t = o.split('،')[0].trim().slice(0, 140); if (!t || seen.has(t)) return; seen.add(t);
    out.push({ t, o: owner, d: d || 'غير محدد', p, k: 1 });
  });
  return out.slice(0, 30);
}
