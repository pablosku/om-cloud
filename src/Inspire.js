// ===== Morning inspiration (Pablo 28.11): a daily mentor conversation in the top note of the board =====
// Chapter 1 is made at MORNING_AT by tick (inspTick), or when the board opens and it is still missing.
// Pablo answers in the note; every answer goes to Gemini with the whole day's conversation (inspSend).
// The conversation follows Pablo's 4-stage prompt (INSP_PROMPT); the model marks the stage with <<stage=N>>.
// Chapters 2-3 (good news, research) use Google Search grounding, and their links come only from the search
// results (groundingChunks), never from the model's own text, so no link is invented.
// Models: a separate list from the bot (which stays on Flash). Default = every Gemini model the key can use,
// strongest first (ListModels, cached 6 h); a model that fails is skipped for a while and the next one answers.
// Script Property INSP_MODELS (comma list) overrides the automatic list.
// Sheet tab insp_days: one row per day. Ratings (1-3 per chapter) are saved there and summed into the prompt.

const INSP_H = ['date', 'stage', 'src', 'verse', 'story', 'question', 'chat', 'ratings', 'model', 'updated'];
const INSP_RATE = { a: 'מדויק ומעמיק', b: 'טוב, אפשר להעמיק יותר', c: 'פחות רלוונטי עבורי' };
const INSP_MAX_MS = 150000; // stop trying more models after this (google.script.run allows 6 minutes)

const INSP_PROMPT = `אתה מנטור פילוסופי ומדעי מעמיק עבור מורה ליוגה, יוגה תרפיה ומטפל. פעל איתי בתדריך הבוקר במבנה מדורג ונקי ב-4 שלבים (ללא שליחת כל הפרקים בבת אחת, וללא הצפת שאלות במקביל):

### שלב א' (הודעת הבוקר הראשונה) – פרק 1: סוגיה פילוסופית ורוחנית להתבוננות
- התמקד בעיקר במקורות היוגה הקלאסית והלא-דואלית (היוגה סוטרות של פטנג'לי, בהגווד גיטה, אופנישדות, אשטוואקרה גיטה, יוגה ואסישטהה, מסורות הטנטרה או האתה יוגה), ובמינון נמוך יותר של שילוב גם בבודהיזם או בזן.
- הצג אמירה, משל או סיפור קצר מתוך הטקסט. רק מדי פעם (לא בכל יום, אלא רק כשיש הדהוד טבעי ומדויק) הוסף קו מקביל או הקשר קצר ממקורות יהודיים פנימיים.
- בסוף הסוגיה שאל **רק את השאלה הראשונה**: "איך אתה מבין את הסוגיה הזו?"
- אל תשאל עדיין איפה היא פוגשת אותי, אל תכתוב את הפרשנות המקובלת בהודעה זו, ואל תציג עדיין את פרקים 2 ו-3. המתן לתשובתי.

### שלב ב' (מיצוי הדיון הפילוסופי – בהודעות ההמשך)
- כאשר אענה על "איך אתה מבין את הסוגיה הזו?", אם הניסוח שלי קצר, תמציתי או משתמע לשתי פנים (במיוחד בשעות הבוקר המוקדמות), אל תניח מראש שהתכוונתי לרובד השטחי של המילים – שאל אותי 1–2 שאלות הבהרה ממוקדות כדי לברר את הכוונה העמוקה שלי לפני שאתה מבקר או מסיק מסקנות.
- לאחר שאבהיר, היה ביקורתי וחד כלפי הרעיונות שלי (אתגר הנחות יסוד, הצבע על נקודות עיוורון או קלישאות רוחניות מתוך כבוד והקשבה לכוונתי האמיתית), ולאחר מכן הצג את הפרשנות המסורתית והפילוסופית המקובלת.
- בסיום הדיון הפילוסופי, הצע לעבור לשאלה השנייה: "איפה הסוגיה הזו פוגשת אותך כרגע בחיים, בתרגול או בעבודה?"

### שלב ג' (היישום האישי והמעבר לפרקים הבאים)
- לאחר שאשתף איפה זה פוגש אותי ונדון בכך בקצרה (כולל שיקוף ביקורתי חד במידת הצורך), שאל אותי אם אני מוכן להמשיך לפרק 2 ולפרק 3.

### שלב ד' (כשאאשר להמשיך) – הצג יחד את שני הפרקים הבאים:
1. **פרק 2 - החלק הפרקטי והטכני (טקסט, מדע ותרגול):** בחר סוטרה או עיקרון מעשי מתוך מסורות היוגה והמדיטציה הקלאסיות בלבד (ללא חיבור ליהדות בפרק זה), חבר אותו למחקר מדעי עכשווי (מדעי המוח, נוירולוגיה, פיזיולוגיה של הנשימה, מערכת העצבים, פסיכולוגיה או עולם החי), והצע תרגול קונקרטי המשלב מדיטציה, פראנאימה (נשימה) או אסאנה (תנוחה) – הן לתרגול אישי והן ככלי להוראה וטיפול להפחתת סבל (כולל התאמות לתרגול בישיבה על כיסא כשנדרש).
2. **פרק 3 - חדשות טובות מהעולם:** הצג 3 עד 5 ידיעות חיוביות ומעוררות השראה מהעולם (מדע, טבע, חברה, בריאות, חדשנות מיטיבה). ללא חדשות כלליות או פוליטיות שליליות.
3. **כלל קישורים ומקורות:** כאשר מצורפים קישורים למחקרים, סיכומים נגישים או ידיעות, השתמש אך ורק במקורות מוכרים, מאומתים ובעלי מוניטין (כגון אוניברסיטאות, בתי חולים מובילים, כתבי עת מדעיים, מאגרי PubMed/NIH, ארגון הבריאות העולמי או מדורי מדע מוכרים) — לעולם לא בלוגים שיווקיים או אתרים מסחריים.
4. **סיום ומשוב:** בסיום הצג שאלון משוב קצר (באמצעות רכיב בחירה אינטראקטיבי אם קיים בממשק, או שאלה ממוקדת) על 3 הפרקים (פרק 1 - פילוסופיה, פרק 2 - פרקטיקה, פרק 3 - חדשות טובות) עם 3 רמות דירוג: "מדויק ומעמיק", "טוב, אפשר להעמיק יותר", "פחות רלוונטי עבורי".`;

const INSP_FORMAT = `

כללי הממשק (השיחה מוצגת בפתק בדף האישי שלי, בטלפון):
- כתוב בעברית, בפסקאות קצרות. מותר **הדגשה**, כותרת קצרה בשורה שמתחילה ב-### ורשימה בשורות שמתחילות ב-"- ". בלי טבלאות.
- אל תכתוב כתובות אינטרנט (URL) בטקסט. המקורות שמצאת בחיפוש מצורפים אוטומטית מתחת להודעה. אל תמציא מקורות או מחקרים; אם אינך בטוח, אמור זאת.
- הממשק מציג כפתורי דירוג לשאלון המשוב, אז אל תכתוב את השאלון בעצמך.
- בשורה האחרונה של כל תשובה כתוב רק את הסימון <<stage=N>>: 2 בזמן הדיון הפילוסופי (שלב ב'), 3 מרגע שעברנו לשאלה "איפה הסוגיה הזו פוגשת אותך" (שלב ג'), 4 בהודעה שבה אתה מציג את פרקים 2 ו-3 ומשם והלאה.`;

// ---------- board calls (google.script.run) ----------
function inspGet(k) {
  boardGuard_(k);
  const today = inspToday_();
  let d = inspRow_(today).r;
  if (!d) {
    const c = CacheService.getScriptCache();
    if (c.get('insp_gen')) return { wait: true, past: inspPast_(today) };
    d = inspMake_(today);
    if (!d) return { err: 'busy', past: inspPast_(today) };
  }
  return { day: inspObj_(d), past: inspPast_(today), tried: inspTried_(), models: inspModels_().slice(0, 8) };
}

// text = Pablo's answer ('' = ask again for an answer to the last message, after a failure)
function inspSend(text, k) {
  boardGuard_(k);
  const today = inspToday_(), f = inspRow_(today);
  if (!f.r) return { err: 'nochapter' };
  const d = inspObj_(f.r);
  text = String(text || '').trim().slice(0, 8000);
  if (text) { d.chat.push({ r: 'me', t: text, at: Date.now() }); inspSave_(f, d); }
  if (!d.chat.length || d.chat[d.chat.length - 1].r !== 'me') return { day: d };
  const contents = [{ role: 'user', parts: [{ text: 'בוקר טוב.' }] }, { role: 'model', parts: [{ text: inspCh1Text_(d) }] }];
  d.chat.forEach(m => {
    const role = m.r === 'me' ? 'user' : 'model', last = contents[contents.length - 1];
    if (last.role === role) last.parts[0].text += '\n\n' + m.t; else contents.push({ role, parts: [{ text: m.t }] });
  });
  const sys = INSP_PROMPT + INSP_FORMAT + inspRatingsNote_() + `\n\nאנחנו כרגע בשלב ${'אבגד'[Math.min(d.stage, 4) - 1]}'.`;
  // the search is on from stage 3, where chapters 2-3 (research, news) can come
  let a = inspCall_(sys, contents, { search: d.stage >= 3 });
  if (!a && d.stage >= 3) a = inspCall_(sys + '\n\nהחיפוש אינו זמין כרגע: אל תציין קישורים או שמות מחקרים שאינך בטוח בהם.', contents, {});
  if (!a) return { err: 'busy', day: d };
  const m = a.text.match(/<<\s*stage\s*=\s*(\d)\s*>>/i);
  const st = m ? Math.min(4, Math.max(d.stage, Number(m[1]))) : d.stage;
  const msg = { r: 'om', t: a.text.replace(/<<\s*stage\s*=\s*\d\s*>>/gi, '').trim(), m: a.model, at: Date.now() };
  if (a.src.length) msg.src = a.src;
  if (st === 4 && !d.chat.some(x => x.fb)) msg.fb = true; // the rating buttons go under this message
  d.chat.push(msg); d.stage = st; d.model = a.model;
  inspSave_(inspRow_(today), d);
  return { day: d, tried: inspTried_() };
}

function inspRate(ch, v, k) {
  boardGuard_(k);
  const f = inspRow_(inspToday_());
  if (!f.r || !INSP_RATE[v] || [1, 2, 3].indexOf(Number(ch)) < 0) return 'no';
  const d = inspObj_(f.r); d.ratings[ch] = v; inspSave_(f, d);
  return 'ok';
}

function inspDay(date, k) {
  boardGuard_(k);
  const r = inspRow_(String(date)).r;
  return r ? inspObj_(r) : null;
}

// ---------- the morning: tick() calls this every minute ----------
function inspTick() {
  const tz = userTz(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (Utilities.formatDate(new Date(), tz, 'HH:mm') < (prop('MORNING_AT') || '04:30')) return;
  if (prop('INSP_DONE') === today) return;
  if (inspRow_(today).r) { P.setProperty('INSP_DONE', today); return; }
  const t = JSON.parse(prop('INSP_TRY') || '{}'); // {day, n, at}: at most 4 tries, 20 minutes apart
  if (t.day === today && (t.n >= 4 || Date.now() - t.at < 20 * 60000)) return;
  P.setProperty('INSP_TRY', JSON.stringify({ day: today, n: t.day === today ? t.n + 1 : 1, at: Date.now() }));
  if (CacheService.getScriptCache().get('insp_gen')) return;
  if (inspMake_(today)) P.setProperty('INSP_DONE', today);
}

// ---------- chapter 1 ----------
function inspMake_(today) {
  const c = CacheService.getScriptCache();
  c.put('insp_gen', '1', 240);
  try {
    const recent = inspRecent_(30).map(d => d.src).filter(String);
    const sys = INSP_PROMPT + INSP_FORMAT + inspRatingsNote_() +
      (recent.length ? '\n\nמקורות מהימים האחרונים (בחר משהו אחר): ' + recent.join(' | ') : '') +
      '\n\nעכשיו כתוב רק את שלב א\' (פרק 1). ענה ב-JSON בלבד: {"src": "שם הטקסט ומיקום מדויק, למשל: אשטוואקרה גיטה 1:11", ' +
      '"verse": "האמירה עצמה בעברית, משפט או שניים", "story": "המשל, הסיפור או ההקשר, עד 120 מילים", "question": "איך אתה מבין את הסוגיה הזו?"}';
    const a = inspCall_(sys, [{ role: 'user', parts: [{ text: 'בוקר טוב. תדריך הבוקר של ' + today + '.' }] }], { json: true });
    if (!a) return null;
    let j; try { j = JSON.parse(a.text.replace(/^```(json)?|```$/g, '').trim()); } catch (e) { log('insp bad ch1', a.text.slice(0, 300)); return null; }
    if (!j || !j.verse) return null;
    const row = ["'" + today, 1, String(j.src || ''), String(j.verse), String(j.story || ''), String(j.question || 'איך אתה מבין את הסוגיה הזו?'), '[]', '{}', a.model, new Date()];
    if (inspRow_(today).r) return inspRow_(today).r; // made meanwhile by the other caller
    tab_('insp_days', INSP_H).appendRow(row);
    return row.map((x, i) => i === 0 ? today : x);
  } finally { c.remove('insp_gen'); }
}
function inspCh1Text_(d) { return [d.src, d.verse, d.story, d.question].filter(String).join('\n\n'); }

// ---------- Gemini ----------
// one call; tries the models strongest first. Returns {text, model, src: [{u, t}]} or null.
function inspCall_(sys, contents, opt) {
  const c = CacheService.getScriptCache(), t0 = Date.now(), tag = opt.search ? 's_' : '';
  const body = { system_instruction: { parts: [{ text: sys }] }, contents, generationConfig: { temperature: 0.9 } };
  if (opt.json) body.generationConfig.responseMimeType = 'application/json';
  if (opt.search) body.tools = [{ google_search: {} }];
  const tried = []; // what happened to each model, shown in the note's ⋯ menu (fix 28.11: Pablo asked why Flash answered)
  const done = (res) => { P.setProperty('INSP_TRIED', JSON.stringify({ at: Date.now(), list: tried.slice(0, 8) })); log('insp model choice', tried.map(x => x.m + ': ' + x.c + (x.r ? ' (' + x.r + ')' : '')).join(' | ')); return res; }; // logged every call (Pablo 28.11)
  // speed (Pablo 28.11 "it thinks a long time"): the model that answered last goes first for 6 hours,
  // so a conversation does not wait for the stronger ones to fail again on every message
  const good = c.get('insp_good_' + tag), order = inspModels_();
  if (good && order.indexOf(good) > 0) { order.splice(order.indexOf(good), 1); order.unshift(good); }
  for (const model of order) {
    if (Date.now() - t0 > INSP_MAX_MS) break;
    if (c.get('insp_bad_' + tag + model)) { tried.push({ m: model, c: 'skip' }); continue; }
    let r;
    try {
      r = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': prop('GEMINI_KEY') }, payload: JSON.stringify(body), muteHttpExceptions: true });
    } catch (e) { log('insp fetch', model, String(e)); tried.push({ m: model, c: 'net' }); continue; }
    const code = r.getResponseCode();
    tried.push({ m: model, c: code });
    if (code === 200) {
      try {
        const resp = JSON.parse(r.getContentText()), cand = resp.candidates[0];
        const text = ((cand.content || {}).parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
        if (!text) throw new Error('empty');
        const seen = {}, src = (((cand.groundingMetadata || {}).groundingChunks) || []).map(g => g.web).filter(w => w && w.uri)
          .filter(w => !seen[w.uri] && (seen[w.uri] = 1)).slice(0, 8).map(w => ({ u: w.uri, t: String(w.title || '') }));
        c.put('insp_good_' + tag, model, 21600);
        return done({ text, model: String(resp.modelVersion || model), src }); // modelVersion = the real model behind "-latest"
      } catch (e) { log('insp bad answer', model, r.getContentText().slice(0, 300)); c.put('insp_bad_' + tag + model, '1', 1800); continue; }
    }
    const txt = r.getContentText();
    const why = tried[tried.length - 1].r = inspWhy_(txt);
    // no free quota at all for this model ("limit: 0" / quotaValue 0) = like no access: 6 h; busy: 30 min
    c.put('insp_bad_' + tag + model, '1', code === 429 && !/limit:?\s*0\b/.test(txt + ' ' + why) || code >= 500 ? 1800 : 21600);
  }
  return done(null);
}

// models for the conversation, strongest first, then the bot's list as the last fallback
function inspModels_() {
  const fixed = prop('INSP_MODELS');
  if (fixed) return fixed.split(',').map(s => s.trim()).filter(String);
  const c = CacheService.getScriptCache(), hit = c.get('insp_models');
  if (hit) return JSON.parse(hit);
  let names = [];
  try {
    const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      { headers: { 'x-goog-api-key': prop('GEMINI_KEY') }, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) names = (JSON.parse(r.getContentText()).models || [])
      .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0).map(m => String(m.name).replace(/^models\//, ''));
    else log('insp models', r.getResponseCode());
  } catch (e) { log('insp models', String(e)); }
  const list = inspRank_(names).slice(0, 6).concat(models()).filter((x, i, a) => a.indexOf(x) === i);
  c.put('insp_models', JSON.stringify(list), 21600);
  return list;
}
// rank by generation (2.5, 3, ...) and tier (pro > flash > flash-lite); "-latest" aliases count as the newest generation
function inspRank_(names) {
  const bad = /(tts|image|embedding|live|audio|robotics|computer|native|aqa|learnlm|gemma|nano|thinking|exp-\d|vision)/;
  const ver = n => { const m = n.match(/^gemini-(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : 0; };
  const top = Math.max(0, ...names.map(ver));
  const score = n => {
    if (!/^gemini-/.test(n) || bad.test(n)) return null;
    const tier = /flash-lite/.test(n) ? 1 : /flash/.test(n) ? 2 : /pro|ultra/.test(n) ? 3 : 0;
    if (!tier) return null;
    const v = ver(n) || (/latest/.test(n) ? top : 0);
    return v * 10 + tier * 4 - (/preview|exp/.test(n) ? 1 : 0) - (/latest/.test(n) ? 0.5 : 0);
  };
  return names.map(n => [n, score(n)]).filter(x => x[1] !== null).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

// ---------- ratings into the prompt ----------
function inspRatingsNote_() {
  const days = inspRecent_(21).filter(d => Object.keys(d.ratings).length);
  if (!days.length) return '';
  const names = { 1: 'פרק 1 (פילוסופיה)', 2: 'פרק 2 (פרקטיקה)', 3: 'פרק 3 (חדשות טובות)' };
  const lines = [1, 2, 3].map(ch => {
    const n = { a: 0, b: 0, c: 0 }; days.forEach(d => { if (n[d.ratings[ch]] !== undefined) n[d.ratings[ch]]++; });
    return n.a + n.b + n.c ? `${names[ch]}: ${Object.keys(n).filter(x => n[x]).map(x => n[x] + '× "' + INSP_RATE[x] + '"').join(', ')}` : '';
  }).filter(String);
  const low = days.filter(d => d.ratings[1] === 'c').map(d => d.src).filter(String).slice(0, 5);
  return '\n\nהמשוב שלי מהשבועות האחרונים (כוונן את התוכן לפיו):\n' + lines.join('\n') +
    (low.length ? '\nפרק 1 היה פחות רלוונטי בימים עם המקורות: ' + low.join(' | ') : '');
}

// ---------- sheet ----------
// a short reason from a Gemini error: status, the message without its links, and the quota that ran out
function inspWhy_(txt) {
  try {
    const e = JSON.parse(txt).error || {};
    const q = (e.details || []).map(d => (d.violations || []).map(v => [v.quotaId || v.quotaMetric, v.quotaValue !== undefined ? 'limit ' + v.quotaValue : ''].filter(String).join(' ')).join('; ')).filter(String).join('; ');
    return [e.status, String(e.message || '').replace(/\s*(For more information|Please|To monitor)[\s\S]*$/, '').replace(/https?:\S+/g, '').trim().slice(0, 140), q].filter(String).join(' · ');
  } catch (x) { return String(txt).replace(/\s+/g, ' ').slice(0, 160); }
}
function inspTried_() { try { return JSON.parse(prop('INSP_TRIED') || 'null'); } catch (e) { return null; } }
function inspToday_() { return Utilities.formatDate(new Date(), userTz(), 'yyyy-MM-dd'); }
function inspRow_(date) {
  const t = tab_('insp_days', INSP_H), v = t.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) if (dstr_(v[i][0]) === date) return { t, row: i + 1, r: v[i] };
  return { t, row: 0, r: null };
}
function inspObj_(r) {
  const js = (s, d) => { try { return JSON.parse(s || '') || d; } catch (e) { return d; } };
  return { date: dstr_(r[0]), stage: Number(r[1]) || 1, src: String(r[2] || ''), verse: String(r[3] || ''), story: String(r[4] || ''),
    question: String(r[5] || ''), chat: js(r[6], []), ratings: js(r[7], {}), model: String(r[8] || '') };
}
function inspSave_(f, d) {
  f.t.getRange(f.row, 2).setValue(d.stage);
  f.t.getRange(f.row, 7, 1, 4).setValues([[JSON.stringify(d.chat), JSON.stringify(d.ratings), d.model, new Date()]]);
}
function inspRecent_(n) {
  const v = tab_('insp_days', INSP_H).getDataRange().getValues().slice(1).filter(r => r[0]);
  return v.slice(-n).map(inspObj_);
}
function inspPast_(today) {
  return inspRecent_(15).filter(d => d.date !== today).reverse().slice(0, 14).map(d => ({ date: d.date, src: d.src, verse: d.verse }));
}
