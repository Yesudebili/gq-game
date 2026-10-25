/* ============================================================
 * 《蜕变 · 高质量男性养成游戏》核心逻辑
 * 纯前端 + localStorage，无任何外部依赖
 * ============================================================ */
'use strict';

const SAVE_KEY = 'gqmx_save_v1';
let S = null;                 // 全局存档状态
let currentTab = 'status';
let pendingJournal = null;    // 待提交的日志回调

/* ---------------- 工具 ---------------- */
const $ = sel => document.querySelector(sel);
const p2 = n => String(n).padStart(2, '0');
function todayStr(d = new Date()) {
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}
function seasonDay() {
  const a = new Date(S.start + 'T00:00:00');
  const b = new Date(todayStr() + 'T00:00:00');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------------- 存档 ---------------- */
function freshState(name) {
  return {
    v: 1,
    name: name || '修行者',
    start: todayStr(),
    xp: 0, hp: 100, sp: 0,
    attrs: { mind: 0, value: 0, frame: 0, comm: 0, charm: 0, image: 0 },
    streak: 0, bestStreak: 0, redClean: 0,
    daily:   { date: todayStr(), done: {}, violation: false, recovery: false, bonus: false },
    weekly:  { idx: 0, done: {}, gym: 0, read: 0, bonus: false, xpGained: 0 },
    monthly: { idx: 0, done: {} },
    skills: {},      // id -> true
    trainer: {},     // sid -> { oi, correct }
    books: {},       // bid -> true
    ach: {},         // aid -> date
    journal: [],     // { date, tag, text }
    stats: { gym: 0 },
    history: {},       // 'YYYY-MM-DD' -> 当日完成每日任务数（热力图）
    attrHistory: {},   // 'YYYY-MM-DD' -> 六维属性快照（成长曲线）
    settings: { sound: true },
  };
}
function save() { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); }
function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) { const obj = JSON.parse(raw); if (obj && obj.v === 1) return migrate(obj); }
  } catch (e) { /* 存档损坏则重开 */ }
  return null;
}
/* 旧存档迁移：补齐 V1.1 新增字段 */
function migrate(s) {
  s.history = s.history || {};
  s.attrHistory = s.attrHistory || {};
  s.settings = s.settings || { sound: true };
  if (s.daily && s.daily.bonus === undefined) s.daily.bonus = false;
  if (s.weekly) {
    if (s.weekly.bonus === undefined) s.weekly.bonus = false;
    if (s.weekly.xpGained === undefined) s.weekly.xpGained = 0;
  }
  return s;
}

/* ---------------- 等级 / 头衔 / 赛季 ---------------- */
function xpNeed(l) { return 40 + 35 * (l - 1); }
function levelInfo() {
  let l = 1, rem = S.xp;
  while (rem >= xpNeed(l)) { rem -= xpNeed(l); l++; }
  return { lv: l, cur: rem, need: xpNeed(l) };
}
function titleOf(lv) {
  let t = LEVEL_TITLES[0][1];
  for (const [l, name] of LEVEL_TITLES) { if (lv >= l) t = name; }
  return t;
}
function currentPhase() {
  const d = seasonDay();
  return PHASES.find(p => d >= p.from && d <= p.to) || PHASES[PHASES.length - 1];
}
function hpState() {
  if (S.hp >= 80) return { name: '稳如泰山', cls: 'ok' };
  if (S.hp >= 50) return { name: '略有波动', cls: 'mid' };
  if (S.hp >= 30) return { name: '心浮气躁', cls: 'mid' };
  return { name: '迷失状态', cls: '' };
}

/* ---------------- 音效（Web Audio 合成，无外部资源） ---------------- */
let audioCtx = null;
function tone(freq, t0, dur, type, vol) {
  if (!S || !S.settings || !S.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    const t = audioCtx.currentTime + t0;
    g.gain.setValueAtTime(vol || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + dur);
  } catch (e) { /* 浏览器不支持时静默 */ }
}
const sfx = {
  quest() { tone(660, 0, .09); tone(880, .09, .14); },
  level() { tone(523, 0, .12); tone(659, .12, .12); tone(784, .24, .22); },
  ach()   { tone(587, 0, .1); tone(740, .1, .1); tone(880, .2, .1); tone(1175, .3, .28); },
  bad()   { tone(233, 0, .16, 'sawtooth', .07); tone(165, .14, .22, 'sawtooth', .07); },
};

/* ---------------- 核心数值操作 ---------------- */
function addXP(n) {
  const before = levelInfo().lv;
  S.xp = Math.max(0, S.xp + n);
  if (n > 0 && S.weekly) S.weekly.xpGained = (S.weekly.xpGained || 0) + n;
  const after = levelInfo().lv;
  if (after > before) {
    S.sp += (after - before);
    sfx.level();
    toast(`🎉 <b>升级！</b>Lv.${after}「${titleOf(after)}」 · 技能点 +${after - before}`, 'gold');
    if (after >= 10) unlockAch('ach_lv10');
    if (after >= 20) unlockAch('ach_lv20');
    if (after >= 30) unlockAch('ach_lv30');
  } else if (after < before) {
    // 取消打卡导致降级：同步回收未花费的技能点
    S.sp = Math.max(0, S.sp - (before - after));
  }
}
function addAttr(key, n) { S.attrs[key] = Math.max(0, S.attrs[key] + n); }
function changeHP(n) { S.hp = Math.max(0, Math.min(100, S.hp + n)); }

/* ---------------- 成就 ---------------- */
function unlockAch(id) {
  if (S.ach[id] || !ACH_MAP[id]) return;
  S.ach[id] = todayStr();
  sfx.ach();
  toast(`🏆 <b>成就解锁</b>「${ACH_MAP[id].name}」 +30XP`, 'gold');
  addXP(30);
}
function checkAch() {
  if (S.streak >= 7) unlockAch('ach_streak7');
  if (S.streak >= 30) unlockAch('ach_streak30');
  if (S.stats.gym >= 10) unlockAch('ach_gym10');
  if (S.stats.gym >= 30) unlockAch('ach_gym30');
  const bookCount = Object.keys(S.books).length;
  if (bookCount >= 1) unlockAch('ach_book1');
  if (['b1','b2','b3','b4','b5'].every(b => S.books[b])) unlockAch('ach_book5');
  if (bookCount >= 9) unlockAch('ach_book9');
  const correct = Object.values(S.trainer).filter(t => t.correct).length;
  if (correct >= 5) unlockAch('ach_trainer5');
  if (correct >= 15) unlockAch('ach_trainer15');
  if (correct >= 30) unlockAch('ach_trainer30');
  if (S.redClean >= 14) unlockAch('ach_clean14');
  if (S.journal.length >= 5) unlockAch('ach_journal5');
  const sk = Object.keys(S.skills).length;
  if (sk >= 5) unlockAch('ach_skill5');
  if (sk >= 15) unlockAch('ach_skill15');
  if (MONTHLY_BOSSES.every(b => S.monthly.done[b.id])) unlockAch('ach_boss_month');
}

/* ---------------- 跨天 / 跨周 / 跨月重置 ---------------- */
let pendingReport = null; // 待展示的每周战报
function ensureResets() {
  const t = todayStr();
  if (S.daily.date !== t) {
    const prev = S.daily;
    const cnt = Object.values(prev.done).filter(Boolean).length;
    // 记录历史：热力图 + 属性成长快照
    S.history[prev.date] = cnt;
    S.attrHistory[prev.date] = { ...S.attrs };
    if (cnt >= 3) { S.streak++; S.bestStreak = Math.max(S.bestStreak, S.streak); }
    else S.streak = 0;
    if (prev.violation) S.redClean = 0;
    else if (cnt >= 1) S.redClean++;
    if (!prev.violation) changeHP(8);      // 无违规的一天，心力恢复
    S.daily = { date: t, done: {}, violation: false, recovery: false, bonus: false };
  }
  const day = seasonDay();
  const wk = Math.floor((day - 1) / 7);
  if (S.weekly.idx !== wk) {
    const old = S.weekly;
    // 生成上周战报（仅在有实际修行数据时）
    if (old && old.idx >= 0 && (old.xpGained > 0 || Object.keys(old.done).length > 0)) {
      const doneCount = Object.keys(old.done).length;
      if (doneCount >= 4) unlockAch('ach_perfect7');
      pendingReport = { week: old.idx + 1, xp: old.xpGained || 0, quests: doneCount, gym: old.gym, read: old.read };
    }
    S.weekly = { idx: wk, done: {}, gym: 0, read: 0, bonus: false, xpGained: 0 };
  }
  const mo = Math.floor((day - 1) / 30);
  if (S.monthly.idx !== mo) S.monthly = { idx: mo, done: {} };
}

/* ---------------- 每周战报 ---------------- */
function showWeeklyReport() {
  if (!pendingReport) return;
  const r = pendingReport;
  pendingReport = null;
  let verdict;
  if (r.quests >= 4) verdict = '👑 完美的一周！你正在以肉眼可见的速度蜕变。';
  else if (r.quests >= 2) verdict = '💪 扎实的一周。保持这个节奏，复利会替你工作。';
  else if (r.xp > 0) verdict = '🌱 有些松懈的一周。没关系——后撤不是放弃，是为了更好的推进。';
  else verdict = '🍂 休整的一周。新的一周，从一个小任务重新出发。';
  openModal(`
    <h3>📰 第 ${r.week} 周 · 修行战报</h3>
    <div class="stat-row" style="justify-content:space-around;margin:16px 0">
      <div class="stat-box"><b>${r.xp}</b><span>获得经验</span></div>
      <div class="stat-box"><b>${r.quests}/4</b><span>周任务</span></div>
      <div class="stat-box"><b>${r.gym}</b><span>健身次数</span></div>
      <div class="stat-box"><b>${r.read}</b><span>阅读天数</span></div>
    </div>
    <p class="center">${verdict}</p>
    <div class="modal-btns"><button class="btn" data-action="close">进入新一周</button></div>`);
}

/* ---------------- 任务系统 ---------------- */
function checkDailyBonus() {
  if (S.daily.bonus) return;
  if (DAILY_QUESTS.every(q => S.daily.done[q.id])) {
    S.daily.bonus = true;
    sfx.ach();
    addXP(20);
    toast('🌟 <b>今日全勤！</b>六项修行全部完成 +20XP', 'gold');
  }
}
function checkWeeklyBonus() {
  if (S.weekly.bonus) return;
  if (WEEKLY_QUESTS.every(q => S.weekly.done[q.id])) {
    S.weekly.bonus = true;
    sfx.ach();
    addXP(100);
    toast('👑 <b>周任务满贯！</b>四项周挑战全部击破 +100XP', 'gold');
  }
}
function toggleDaily(qid) {
  const q = DAILY_QUESTS.find(x => x.id === qid);
  if (!q) return;
  if (S.daily.done[qid]) {
    S.daily.done[qid] = false;
    addXP(-q.xp); addAttr(q.attr, -q.n);
    if (qid === 'q_gym') { S.weekly.gym = Math.max(0, S.weekly.gym - 1); S.stats.gym = Math.max(0, S.stats.gym - 1); }
    if (qid === 'q_read') S.weekly.read = Math.max(0, S.weekly.read - 1);
    toast('已取消打卡（奖励已收回）');
  } else {
    S.daily.done[qid] = true;
    sfx.quest();
    addXP(q.xp); addAttr(q.attr, q.n);
    toast(`✅ <b>${q.name}</b> +${q.xp}XP · ${ATTR_MAP[q.attr].name}+${q.n}`);
    unlockAch('ach_first');
    if (qid === 'q_gym') { S.weekly.gym++; S.stats.gym++; }
    if (qid === 'q_read') S.weekly.read++;
    autoWeekly();
    checkDailyBonus();
    checkAch();
  }
  save(); render();
}

function autoWeekly() {
  if (S.weekly.gym >= 3 && !S.weekly.done.w_gym) completeWeekly('w_gym');
  if (S.weekly.read >= 4 && !S.weekly.done.w_read) completeWeekly('w_read');
}
function completeWeekly(id) {
  const q = WEEKLY_QUESTS.find(x => x.id === id);
  if (!q || S.weekly.done[id]) return;
  S.weekly.done[id] = true;
  addXP(q.xp); addAttr(q.attr, q.n);
  toast(`⚔️ <b>周任务完成</b>「${q.name}」 +${q.xp}XP`, 'gold');
  checkWeeklyBonus();
  checkAch();
}
function claimWeekly(id) {
  const q = WEEKLY_QUESTS.find(x => x.id === id);
  if (!q || S.weekly.done[id]) return;
  if (q.journal) {
    openJournalModal('复盘一次失败互动', '复盘', '只找自己的问题：当时发生了什么？我的哪个选择暴露了需求感/丢了框架？下次怎么做？', () => completeWeekly(id));
  } else {
    completeWeekly(id);
    save(); render();
  }
}
function claimBoss(id) {
  const b = MONTHLY_BOSSES.find(x => x.id === id);
  if (!b || S.monthly.done[id]) return;
  openJournalModal(`讨伐 ${b.name}`, 'BOSS战', '写下你的行动证据：你实际做了什么？结果如何？', () => {
    S.monthly.done[id] = true;
    addXP(b.xp); addAttr(b.attr, b.n); S.sp += 1;
    toast(`👹 <b>BOSS击破！</b>「${b.name}」 +${b.xp}XP · 技能点+1`, 'gold');
    unlockAch('ach_boss1');
    checkAch();
  });
}

/* ---------------- 日志 ---------------- */
function openJournalModal(title, tag, placeholder, onDone) {
  pendingJournal = { tag, onDone };
  openModal(`
    <h3>📝 ${esc(title)}</h3>
    <p class="muted small">${esc(tag)} · ${todayStr()}</p>
    <textarea id="journal-text" rows="6" placeholder="${esc(placeholder || '写下你的记录与反思……')}"></textarea>
    <div class="modal-btns">
      <button class="btn-ghost" data-action="close">取消</button>
      <button class="btn" data-action="submit-journal">提交</button>
    </div>`);
  setTimeout(() => { const t = $('#journal-text'); if (t) t.focus(); }, 50);
}
function submitJournal() {
  const ta = $('#journal-text');
  const text = ta ? ta.value.trim() : '';
  if (!text) { toast('写点什么再提交吧', 'bad'); return; }
  S.journal.unshift({ date: todayStr(), tag: pendingJournal.tag, text });
  const cb = pendingJournal.onDone;
  pendingJournal = null;
  closeModal();
  toast('📝 日志已记录');
  checkAch();
  if (cb) cb();
  save(); render();
}

/* ---------------- 红线 / 违规 ---------------- */
function openViolationModal() {
  const items = RED_LINES.map((r, i) =>
    `<label class="vio"><input type="checkbox" class="vio-check" value="${i}"><span>第${i + 1}条 · ${esc(r)}</span></label>`
  ).join('');
  openModal(`
    <h3>⚠️ 申报违规</h3>
    <p>诚实是这套系统的地基。勾选今天触碰的红线，HP -15，随后会生成一个「修正任务」帮你复盘回血。</p>
    ${items}
    <div class="modal-btns">
      <button class="btn-ghost" data-action="close">取消</button>
      <button class="btn-danger" data-action="submit-violation">诚实申报</button>
    </div>`);
}
function submitViolation() {
  const checked = document.querySelectorAll('.vio-check:checked');
  if (!checked.length) { toast('没有勾选任何红线', 'bad'); return; }
  if (S.daily.violation) { toast('今天已经申报过了', 'bad'); closeModal(); return; }
  S.daily.violation = true;
  S.daily.recovery = true;
  S.redClean = 0;
  sfx.bad();
  changeHP(-15);
  closeModal();
  toast('⚠️ 已记录违规，HP -15。完成「修正任务」复盘可恢复 HP +8', 'bad');
  save(); render();
}
function doRecovery() {
  openJournalModal('修正任务 · 复盘今日违规', '修正', '我触碰了哪条红线？当时的心理是什么？下次遇到同样的场景，我会怎么做？', () => {
    S.daily.recovery = false;
    changeHP(8);
    addXP(20);
    toast('💪 复盘完成，HP +8 · +20XP。把注意力拉回自己身上。', 'gold');
  });
}

/* ---------------- 训练场 ---------------- */
function answerScenario(sid, oi) {
  const sc = SCENARIOS.find(x => x.id === sid);
  if (!sc) return;
  if (S.trainer[sid]) return; // 已作答（答错需点"重新挑战"）
  const opt = sc.options[oi];
  S.trainer[sid] = { oi, correct: !!opt.good };
  if (opt.good) {
    sfx.quest();
    addXP(20); addAttr(sc.attr, 2);
    toast(`✅ <b>判断正确</b> +20XP · ${ATTR_MAP[sc.attr].name}+2`, 'gold');
  } else {
    sfx.bad();
    changeHP(-5);
    toast('❌ 这个选择会暴露需求感或丢失框架，HP -5。看看解析，再挑战一次。', 'bad');
  }
  checkAch(); save(); render();
}
function retryScenario(sid) {
  if (S.trainer[sid] && !S.trainer[sid].correct) delete S.trainer[sid];
  save(); render();
}

/* ---------------- 技能 ---------------- */
function skillState(sk) {
  const lv = levelInfo().lv;
  if (S.skills[sk.id]) return 'owned';
  if (lv < sk.lv) return 'locked';
  if (sk.req && !S.skills[sk.req]) return 'locked';
  if (S.sp < sk.cost) return 'locked';
  return 'avail';
}
function unlockSkill(id) {
  const sk = SKILLS.find(x => x.id === id);
  if (!sk || S.skills[id]) return;
  const lv = levelInfo().lv;
  if (lv < sk.lv) { toast(`需要达到 Lv.${sk.lv}`, 'bad'); return; }
  if (sk.req && !S.skills[sk.req]) {
    const req = SKILLS.find(x => x.id === sk.req);
    toast(`需要先解锁前置技能「${req ? req.name : sk.req}」`, 'bad'); return;
  }
  if (S.sp < sk.cost) { toast(`技能点不足（需要 ${sk.cost} 点）`, 'bad'); return; }
  S.sp -= sk.cost;
  S.skills[id] = true;
  addAttr(sk.branch, 5);
  toast(`🌟 <b>掌握技能</b>「${sk.name}」 ${ATTR_MAP[sk.branch].name}+5`, 'gold');
  checkAch(); save(); render();
}

/* ---------------- 图书馆 ---------------- */
function toggleBook(id) {
  const b = BOOKS.find(x => x.id === id);
  if (!b) return;
  if (S.books[id]) {
    delete S.books[id];
    addXP(-80); addAttr('value', -5);
    toast('已取消读完标记（奖励已收回）');
  } else {
    S.books[id] = true;
    addXP(80); addAttr('value', 5);
    toast(`📚 <b>读完</b>《${b.title}》 +80XP · 价值+5`, 'gold');
  }
  checkAch(); save(); render();
}

/* ============================================================
 *  渲 染
 * ============================================================ */
function bar(pct, cls) {
  return `<div class="bar"><i class="${cls || ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
}
function miniBar(pct, cls) {
  return `<div class="mini-bar"><i class="${cls}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
}

/* ---------- HUD ---------- */
function renderHUD() {
  const li = levelInfo();
  const hp = hpState();
  const day = seasonDay();
  $('#hud').innerHTML = `
    <div class="logo">蜕 变<small>高质量男性养成游戏</small></div>
    <div class="hud-items">
      <div class="hud-item">📅 Day <b>${day}</b>/90</div>
      <div class="hud-item" title="连续修行天数">🔥 <b>${S.streak}</b></div>
      <div class="hud-item" title="HP 心力值：${hp.name}">❤️ ${miniBar(S.hp, 'hp-fill ' + hp.cls)}</div>
      <div class="hud-item" title="经验 ${li.cur}/${li.need}">
        <span class="lv-badge">Lv.${li.lv}</span><span class="p-title">${titleOf(li.lv)}</span>
        ${miniBar(li.cur / li.need * 100, 'xp-fill')}
      </div>
      <div class="hud-item"><span class="sp-pill">🔷 技能点 ${S.sp}</span></div>
    </div>`;
}

/* ---------- 角色页 ---------- */
function radarSVG() {
  const keys = ['mind', 'value', 'frame', 'comm', 'charm', 'image'];
  const vals = keys.map(k => S.attrs[k]);
  const max = Math.max(30, ...vals);
  const cx = 140, cy = 118, R = 82;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + i * Math.PI / 3;
    const r = R * (v / max);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const ring = f => keys.map((_, i) => {
    const a = -Math.PI / 2 + i * Math.PI / 3;
    return (cx + R * f * Math.cos(a)).toFixed(1) + ',' + (cy + R * f * Math.sin(a)).toFixed(1);
  }).join(' ');
  const poly = keys.map((_, i) => pt(i, vals[i]).map(n => n.toFixed(1)).join(',')).join(' ');
  const axes = keys.map((_, i) => {
    const [x, y] = pt(i, max);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#272d3d" stroke-width="1"/>`;
  }).join('');
  const labels = keys.map((k, i) => {
    const a = -Math.PI / 2 + i * Math.PI / 3;
    const x = cx + (R + 20) * Math.cos(a), y = cy + (R + 20) * Math.sin(a);
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="#939aab" font-size="11" text-anchor="middle">${ATTR_MAP[k].icon}${ATTR_MAP[k].name}</text>`;
  }).join('');
  return `<svg width="280" height="236" viewBox="0 0 280 236">
    <polygon points="${ring(1)}" fill="none" stroke="#272d3d"/>
    <polygon points="${ring(0.66)}" fill="none" stroke="#222636"/>
    <polygon points="${ring(0.33)}" fill="none" stroke="#1d212e"/>
    ${axes}
    <polygon points="${poly}" fill="rgba(227,179,65,.22)" stroke="#e3b341" stroke-width="2"/>
    ${labels}
  </svg>`;
}
/* ---------- 打卡热力图（GitHub 风格，近 15 周） ---------- */
function heatmapHTML() {
  const WEEKS = 15;
  const t = new Date(todayStr() + 'T00:00:00');
  const start = new Date(t);
  start.setDate(start.getDate() - (WEEKS * 7 - 1));
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 对齐到周一
  const today = todayStr();
  const cols = [];
  const d = new Date(start);
  while (true) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const ds = todayStr(d);
      if (d > t) {
        col.push(`<div class="hm-cell hm-future"></div>`);
      } else {
        const cnt = ds === today
          ? Object.values(S.daily.done).filter(Boolean).length
          : (S.history[ds] || 0);
        const lv = cnt === 0 ? 0 : cnt <= 2 ? 1 : cnt <= 4 ? 2 : 3;
        col.push(`<div class="hm-cell hm${lv}${ds === today ? ' hm-today' : ''}" title="${ds} · 完成 ${cnt}/6 项"></div>`);
      }
      d.setDate(d.getDate() + 1);
    }
    cols.push(`<div class="hm-col">${col.join('')}</div>`);
    if (d > t) break;
  }
  return `<div class="heatmap">${cols.join('')}</div>
    <div class="hm-legend"><span class="muted">少</span><i class="hm-cell hm0"></i><i class="hm-cell hm1"></i><i class="hm-cell hm2"></i><i class="hm-cell hm3"></i><span class="muted">多</span></div>`;
}

/* ---------- 六维属性成长曲线 ---------- */
const ATTR_COLORS = { mind: '#e3b341', value: '#5b9bd5', frame: '#9b59d0', comm: '#4caf7d', charm: '#e56ba0', image: '#e8963c' };
function growthChartHTML() {
  const today = todayStr();
  const pts = Object.keys(S.attrHistory).sort().map(d => ({ d, v: S.attrHistory[d] }));
  const todayLive = { ...S.attrs };
  const idx = pts.findIndex(p => p.d === today);
  if (idx >= 0) pts[idx] = { d: today, v: todayLive };
  else pts.push({ d: today, v: todayLive });
  if (pts.length < 2) {
    return '<div class="empty-tip">📈 从明天起自动记录属性快照——7 天后，你会看到一条肉眼可见的成长曲线。</div>';
  }
  const W = 560, H = 190, P = 30;
  const maxV = Math.max(10, ...pts.flatMap(p => ATTRS.map(a => p.v[a.key] || 0)));
  const x = i => P + (W - 2 * P) * i / (pts.length - 1);
  const y = v => H - P - (H - 2 * P) * v / maxV;
  const grid = [0.25, 0.5, 0.75, 1].map(f =>
    `<line x1="${P}" y1="${y(maxV * f)}" x2="${W - P}" y2="${y(maxV * f)}" stroke="#1d212e" stroke-width="1"/>`
  ).join('');
  const lines = ATTRS.map(a => {
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v[a.key] || 0).toFixed(1)}`).join('');
    const lastY = y(pts[pts.length - 1].v[a.key] || 0);
    return `<path d="${path}" fill="none" stroke="${ATTR_COLORS[a.key]}" stroke-width="2" stroke-linejoin="round"/>
            <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="${ATTR_COLORS[a.key]}"/>`;
  }).join('');
  const xlabels = `<text x="${P}" y="${H - 8}" fill="#565d70" font-size="10">${pts[0].d.slice(5)}</text>
    <text x="${W - P}" y="${H - 8}" fill="#565d70" font-size="10" text-anchor="end">${pts[pts.length - 1].d.slice(5)}</text>`;
  const legend = ATTRS.map(a => `<span style="color:${ATTR_COLORS[a.key]}">● ${a.name}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${grid}${lines}${xlabels}</svg>
    <div class="hm-legend" style="justify-content:center;gap:14px;flex-wrap:wrap">${legend}</div>`;
}

function renderStatus() {
  const li = levelInfo();
  const day = seasonDay();
  const phase = currentPhase();
  const hp = hpState();
  const seasonPct = Math.min(100, day / 90 * 100);
  const attrLines = ATTRS.map(a => `
    <div class="attr-line">
      <span class="aname">${a.icon} ${a.name}</span>
      ${bar(S.attrs[a.key] / Math.max(30, ...ATTRS.map(x => S.attrs[x.key])) * 100, 'attr-fill')}
      <span class="aval">${S.attrs[a.key]}</span>
    </div>`).join('');

  $('#sec-status').innerHTML = `
    <div class="card">
      <div class="hero">
        <div class="avatar">🜲</div>
        <div class="hero-info">
          <div><span class="hero-name">${esc(S.name)}</span><span class="hero-title">「${titleOf(li.lv)}」</span></div>
          <div class="hero-meta">赛季第 ${day} 天 · ${phase.name} · 心力状态：${hp.name}</div>
          <div class="stat-row">
            <div class="stat-box"><b>${S.streak}</b><span>连续修行</span></div>
            <div class="stat-box"><b>${S.bestStreak}</b><span>最长连击</span></div>
            <div class="stat-box"><b>${S.redClean}</b><span>无红线天数</span></div>
            <div class="stat-box"><b>${Object.keys(S.skills).length}</b><span>已解锁技能</span></div>
            <div class="stat-box"><b>${Object.keys(S.ach).length}</b><span>成就</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>⚔️ 90天赛季 · ${phase.name}</h2>
      <div class="bar-label"><span>Day ${day} / 90</span><span>${seasonPct.toFixed(0)}%</span></div>
      <div class="season-track"><i style="width:${seasonPct}%"></i></div>
      <div class="phase-marks"><span>觉醒</span><span>锤炼</span><span>蜕变</span><span>自由修行</span></div>
      <p class="small muted" style="margin-top:10px">🎯 本幕修行重点：${phase.focus}</p>
    </div>

    <div class="grid2">
      <div class="card">
        <h2>📊 魅力雷达</h2>
        <div class="radar-wrap">${radarSVG()}</div>
      </div>
      <div class="card">
        <h2>💠 六维属性 <span class="sub">完成任务与解锁技能可提升</span></h2>
        <div class="attr-list">${attrLines}</div>
        <div style="margin-top:14px">
          <div class="bar-label"><span>❤️ HP 心力值 · ${hp.name}</span><span>${S.hp}/100</span></div>
          ${bar(S.hp, 'hp-fill ' + hp.cls)}
          <div class="bar-label" style="margin-top:10px"><span>⭐ 经验值</span><span>${li.cur}/${li.need}</span></div>
          ${bar(li.cur / li.need * 100, 'xp-fill')}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>🗓️ 修行足迹 <span class="sub">近 15 周打卡热力 · 颜色越深完成越多</span></h2>
      ${heatmapHTML()}
    </div>

    <div class="card">
      <h2>📈 属性成长曲线 <span class="sub">每天自动快照</span></h2>
      ${growthChartHTML()}
    </div>

    <div class="card">
      <h2>⚙️ 设置与存档</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn-ghost btn-sm" data-action="toggle-sound">${S.settings.sound ? '🔊 音效：开' : '🔇 音效：关'}</button>
        <button class="btn-ghost btn-sm" data-action="rename">✏️ 修改道号</button>
        <button class="btn-ghost btn-sm" data-action="export">📤 导出存档</button>
        <button class="btn-ghost btn-sm" data-action="import">📥 导入存档</button>
        <input type="file" id="import-file" accept=".json" style="display:none">
        <button class="btn-danger btn-sm" data-action="reset">🗑️ 重开新档</button>
      </div>
    </div>`;
}

/* ---------- iOS 安装引导 & 晚间提醒 ---------- */
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function installBannerHTML() {
  if (!isIOS() || isStandalone()) return '';
  if (localStorage.getItem('gqmx_install_dismissed')) return '';
  return `<div class="install-banner">
    <div class="ib-icon">📲</div>
    <div class="ib-body"><b>装到主屏幕，像原生 App 一样修行</b><br>点 Safari 底部分享按钮 →「添加到主屏幕」，全屏离线也能打卡。</div>
    <button class="ib-close" data-action="dismiss-install" title="不再提示">✕</button>
  </div>`;
}
function eveningTipHTML() {
  const h = new Date().getHours();
  if (h < 20) return '';
  const done = Object.values(S.daily.done).filter(Boolean).length;
  if (done >= 3) return '';
  return `<div class="evening-tip">🌙 已是晚间 —— 今日修行还未达成（${done}/6）。哪怕只完成健身+阅读两项，也别让今天断签。</div>`;
}

/* ---------- 今日修行页 ---------- */
function renderDaily() {
  const day = seasonDay();
  const phase = currentPhase();
  const quote = QUOTES[(day - 1) % QUOTES.length];
  const doneCount = Object.values(S.daily.done).filter(Boolean).length;
  const nextSkill = SKILLS.find(sk => skillState(sk) === 'avail');

  const quests = DAILY_QUESTS.map(q => {
    const done = !!S.daily.done[q.id];
    return `<div class="quest ${done ? 'done' : ''}" role="button" tabindex="0" data-action="toggle-daily" data-id="${q.id}">
      <div class="check">✓</div>
      <div class="q-body">
        <div class="q-name">${q.name}</div>
        <div class="q-desc">${q.desc}</div>
      </div>
      <div class="q-reward">+${q.xp}XP · ${ATTR_MAP[q.attr].name}+${q.n}</div>
    </div>`;
  }).join('');

  const recovery = S.daily.recovery ? `
    <div class="quest recovery" role="button" tabindex="0" data-action="do-recovery">
      <div class="check" style="border-color:var(--red);color:var(--red)">!</div>
      <div class="q-body">
        <div class="q-name">修正任务 · 复盘今日违规</div>
        <div class="q-desc">写下复盘：触碰了哪条红线？当时的心理？下次怎么做？完成后 HP+8、+20XP</div>
      </div>
      <div class="q-reward">HP+8 · +20XP</div>
    </div>` : '';

  const warn = S.hp < 30 ? `
    <div class="warn-banner">🚨 <b>你正处于「迷失状态」。</b>今天请优先完成健身与复盘，把注意力拉回自己身上——情绪稳定，是男人最性感的品质。</div>` : '';

  $('#sec-daily').innerHTML = `
    ${installBannerHTML()}
    ${eveningTipHTML()}
    <div class="quote-card">
      <p>${quote}</p>
      <div class="focus-tip"><b>${phase.name}</b> · ${phase.focus}</div>
      ${nextSkill ? `<div class="focus-tip">🌱 当前可解锁技能：<b>「${nextSkill.name}」</b>（去技能树看看）</div>` : ''}
    </div>
    ${warn}
    <div class="card">
      <h2>📅 今日任务 <span class="sub">${todayStr()} · 已完成 ${doneCount}/${DAILY_QUESTS.length} · 完成≥3项计为修行日${S.daily.bonus ? ' · 🌟已全勤' : ' · 六项全完成再+20XP'}</span></h2>
      ${quests}
      ${recovery}
      <p class="small muted center" style="margin-top:6px">诚实打卡：这是单人游戏，作弊只能骗自己。</p>
    </div>`;
}

/* ---------- 挑战页 ---------- */
function renderChallenge() {
  const weekly = WEEKLY_QUESTS.map(q => {
    const done = !!S.weekly.done[q.id];
    let prog = '';
    if (q.id === 'w_gym') prog = `<div class="q-progress">${Math.min(S.weekly.gym, 3)}/3</div>`;
    if (q.id === 'w_read') prog = `<div class="q-progress">${Math.min(S.weekly.read, 4)}/4</div>`;
    const click = done ? '' : (q.auto ? '' : `role="button" tabindex="0" data-action="claim-weekly" data-id="${q.id}"`);
    return `<div class="quest ${done ? 'done' : ''}" ${click}>
      <div class="check">✓</div>
      <div class="q-body"><div class="q-name">${q.name}</div><div class="q-desc">${q.desc}</div></div>
      ${prog}<div class="q-reward">+${q.xp}XP · ${ATTR_MAP[q.attr].name}+${q.n}</div>
    </div>`;
  }).join('');

  const bosses = MONTHLY_BOSSES.map(b => {
    const done = !!S.monthly.done[b.id];
    return `<div class="quest boss ${done ? 'done' : ''}" ${done ? '' : `role="button" tabindex="0" data-action="claim-boss" data-id="${b.id}"`}>
      <div class="check">${done ? '✓' : '👹'}</div>
      <div class="q-body"><div class="q-name">${b.name}</div><div class="q-desc">${b.desc}（需提交行动记录）</div></div>
      <div class="q-reward">+${b.xp}XP · ${ATTR_MAP[b.attr].name}+${b.n} · 技能点+1</div>
    </div>`;
  }).join('');

  const journals = S.journal.length
    ? S.journal.slice(0, 20).map(j => `
      <div class="journal-item">
        <div class="j-meta"><span class="j-tag">${esc(j.tag)}</span>${j.date}</div>
        <div class="j-text">${esc(j.text)}</div>
      </div>`).join('')
    : '<div class="empty-tip">还没有日志。完成一次复盘或BOSS战后，记录会出现在这里。</div>';

  $('#sec-challenge').innerHTML = `
    <div class="card">
      <h2>🗓️ 每周任务 <span class="sub">随赛季周数自动刷新</span></h2>
      ${weekly}
    </div>
    <div class="card">
      <h2>👹 月度BOSS战 <span class="sub">每月刷新 · 需提交行动证据</span></h2>
      ${bosses}
    </div>
    <div class="card">
      <h2>📜 修行日志 <span class="sub">最近 ${Math.min(S.journal.length, 20)} 条</span></h2>
      ${journals}
    </div>`;
}

/* ---------- 训练场 ---------- */
function renderTrainer() {
  const correct = Object.values(S.trainer).filter(t => t.correct).length;
  const cards = SCENARIOS.map((sc, idx) => {
    const rec = S.trainer[sc.id];
    let body;
    if (!rec) {
      body = sc.options.map((o, oi) =>
        `<button class="sc-opt" data-action="answer" data-id="${sc.id}" data-oi="${oi}">${esc(o.text)}</button>`
      ).join('');
    } else {
      body = sc.options.map((o, oi) => {
        const cls = o.good ? 'good' : (rec.oi === oi ? 'bad' : '');
        const mark = o.good ? '✅ ' : (rec.oi === oi ? '❌ ' : '');
        return `<div class="sc-opt ${cls}" style="cursor:default">${mark}${esc(o.text)}<span class="fb">${esc(o.fb)}</span></div>`;
      }).join('') + `
        <div class="sc-explain">💡 <b>解析</b>（${sc.chapter}）：${sc.explain}</div>
        ${rec.correct ? '' : `<div style="margin-top:10px"><button class="btn-ghost btn-sm" data-action="retry-scenario" data-id="${sc.id}">🔄 重新挑战</button></div>`}`;
    }
    return `<div class="scenario ${rec ? 'answered' : ''}">
      <div class="sc-title">第${idx + 1}关 · ${sc.title}<span class="sc-tag">${sc.chapter}</span></div>
      <div class="sc-scene">${sc.scene}</div>
      ${body}
    </div>`;
  }).join('');

  $('#sec-trainer').innerHTML = `
    <div class="card">
      <h2>🎯 对话训练场 <span class="sub">在安全的游戏里犯错，好过在现实里犯错</span></h2>
      <div class="bar-label"><span>掌握度</span><span>${correct}/${SCENARIOS.length}</span></div>
      ${bar(correct / SCENARIOS.length * 100, 'xp-fill')}
      <p class="small muted" style="margin-top:8px">首次答对 +20XP 与属性奖励；答错 HP-5，可无限重试。</p>
    </div>
    ${cards}`;
}

/* ---------- 技能树 ---------- */
function renderSkills() {
  const li = levelInfo();
  const branches = ATTRS.map(a => {
    const nodes = SKILLS.filter(sk => sk.branch === a.key).map(sk => {
      const st = skillState(sk);
      let reqText = '';
      if (st === 'locked') {
        const parts = [];
        if (li.lv < sk.lv) parts.push(`需 Lv.${sk.lv}`);
        if (sk.req && !S.skills[sk.req]) {
          const r = SKILLS.find(x => x.id === sk.req);
          parts.push(`前置：${r ? r.name : ''}`);
        }
        if (li.lv >= sk.lv && (!sk.req || S.skills[sk.req]) && S.sp < sk.cost) parts.push(`需 ${sk.cost} 技能点`);
        reqText = parts.join(' · ');
      } else if (st === 'avail') {
        reqText = `消耗 ${sk.cost} 技能点 · 点击解锁`;
      } else {
        reqText = '已掌握';
      }
      return `<div class="skill ${st}" ${st === 'avail' ? `role="button" tabindex="0" data-action="unlock-skill" data-id="${sk.id}"` : ''}>
        <div class="sk-name">${st === 'owned' ? '✓ ' : ''}${sk.name}</div>
        <div class="sk-desc">${sk.desc}</div>
        <div class="sk-req">${reqText}</div>
      </div>`;
    }).join('');
    const owned = SKILLS.filter(sk => sk.branch === a.key && S.skills[sk.id]).length;
    const total = SKILLS.filter(sk => sk.branch === a.key).length;
    return `<div class="branch">
      <div class="branch-head">${a.icon} ${a.name}系 <span class="small muted">${owned}/${total} · ${a.desc}</span></div>
      <div class="skill-grid">${nodes}</div>
    </div>`;
  }).join('');

  $('#sec-skills').innerHTML = `
    <div class="card">
      <h2>🌳 技能树 <span class="sub">可用技能点 🔷 ${S.sp} · 每解锁一个技能，对应属性 +5</span></h2>
      <p class="small muted">技能描述即手册原文精华——解锁技能的过程，就是把手册重新刻进脑子的过程。</p>
    </div>
    ${branches}`;
}

/* ---------- 图书馆 ---------- */
function renderLibrary() {
  const doneCount = Object.keys(S.books).length;
  const mk = b => {
    const done = !!S.books[b.id];
    return `<div class="book ${done ? 'done' : ''}">
      <div class="b-info">
        <div class="b-title">${done ? '✅ ' : '📖 '}《${b.title}》</div>
        <div class="b-meta">${b.author} · 推荐阅读：${b.phase} · ${b.note}</div>
      </div>
      <button class="btn-ghost btn-sm" data-action="toggle-book" data-id="${b.id}">${done ? '取消标记' : '标记读完'}</button>
    </div>`;
  };
  $('#sec-library').innerHTML = `
    <div class="card">
      <h2>📚 三个月学习计划 <span class="sub">已读完 ${doneCount}/${BOOKS.length} · 每本 +80XP</span></h2>
      <p class="small" style="line-height:1.9">
        <b>第1个月</b>：读完《No More Mr. Nice Guy》+《The Rational Male》前半部，建立正确心态。<br>
        <b>第2个月</b>：读完《Models》+ 看实操视频，理解真诚吸引力，开始改变对话方式。<br>
        <b>第3个月</b>：读完《The Game》或《The 3% Man》+ 复盘聊天记录，形成自己的风格。
      </p>
      <div class="bar-label" style="margin-top:8px"><span>阅读进度</span><span>${doneCount}/${BOOKS.length}</span></div>
      ${bar(doneCount / BOOKS.length * 100, 'xp-fill')}
    </div>
    <div class="card"><h2>⭐ 核心必读</h2>${BOOKS.filter(b => b.core).map(mk).join('')}</div>
    <div class="card"><h2>📖 进阶补充</h2>${BOOKS.filter(b => !b.core).map(mk).join('')}</div>`;
}

/* ---------- 成就 ---------- */
function renderAch() {
  const cards = ACHIEVEMENTS.map(a => {
    const un = S.ach[a.id];
    return `<div class="ach ${un ? 'unlocked' : ''}">
      <div class="a-name">${a.name}</div>
      <div class="a-desc">${a.desc}</div>
      ${un ? `<div class="a-date">解锁于 ${un}</div>` : '<div class="a-date" style="color:var(--muted)">未解锁 · +30XP</div>'}
    </div>`;
  }).join('');
  $('#sec-ach').innerHTML = `
    <div class="card">
      <h2>🏆 成就殿堂 <span class="sub">已解锁 ${Object.keys(S.ach).length}/${ACHIEVEMENTS.length}</span></h2>
      <div class="ach-grid">${cards}</div>
    </div>`;
}

/* ---------- 红线 ---------- */
function renderRed() {
  const lines = RED_LINES.map((r, i) =>
    `<div class="redline-item"><span class="no">${i + 1}.</span><span>${r}</span></div>`).join('');
  const hp = hpState();
  $('#sec-red').innerHTML = `
    <div class="card">
      <h2>🚫 八条红线 <span class="sub">不可触碰的禁忌 · 手册第七章</span></h2>
      ${lines}
    </div>
    <div class="card">
      <h2>⚠️ 违规申报 <span class="sub">诚实是这套系统的地基</span></h2>
      <div class="bar-label"><span>❤️ 当前心力 · ${hp.name}</span><span>${S.hp}/100</span></div>
      ${bar(S.hp, 'hp-fill ' + hp.cls)}
      <p class="small muted" style="margin:10px 0;line-height:1.8">
        现实中触碰红线后，回到这里诚实申报：<b>HP -15</b>，并生成「修正任务」——写下复盘后 HP +8、+20XP。<br>
        连续无红线天数：<b style="color:var(--gold2)">${S.redClean}</b> 天（满 14 天解锁成就「坐怀不乱」）。<br>
        惩罚不是目的，「违规 → 复盘 → 修正」的闭环才是。诚实申报本身，就是在练结果脱敏。
      </p>
      <button class="btn-danger" data-action="report-violation">⚠️ 申报今日违规</button>
    </div>`;
}

/* ---------- 弹窗 / Toast ---------- */
let modalLocked = false; // 锁定时不允许点击遮罩关闭（用于新手引导）
function openModal(html) { $('#modal-root').innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`; }
function closeModal() { $('#modal-root').innerHTML = ''; pendingJournal = null; modalLocked = false; }
function toast(msg, type) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.innerHTML = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 2800);
}

/* ---------- 改名 / 存档管理 ---------- */
function openRename() {
  openModal(`
    <h3>✏️ 修改道号</h3>
    <input type="text" id="rename-input" maxlength="12" value="${esc(S.name)}" placeholder="输入你的道号">
    <div class="modal-btns">
      <button class="btn-ghost" data-action="close">取消</button>
      <button class="btn" data-action="submit-rename">确定</button>
    </div>`);
}
function exportSave() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `蜕变存档_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('📤 存档已导出');
}
function importSave(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      if (!obj || obj.v !== 1 || !obj.attrs) throw new Error('bad');
      S = obj;
      ensureResets(); save(); render();
      toast('📥 存档导入成功，欢迎回来。', 'gold');
    } catch (e) { toast('导入失败：文件不是有效的存档', 'bad'); }
  };
  reader.readAsText(file);
}
function confirmReset() {
  openModal(`
    <h3>🗑️ 重开新档</h3>
    <p>这将<b style="color:var(--red)">永久删除</b>当前所有进度（等级、技能、成就、日志），且不可恢复。确定要重新踏上这条路吗？</p>
    <div class="modal-btns">
      <button class="btn-ghost" data-action="close">再想想</button>
      <button class="btn-danger" data-action="do-reset">删除并重开</button>
    </div>`);
}

/* ---------- 引导页 ---------- */
function showOnboarding() {
  modalLocked = true;
  openModal(`
    <h3>🔥 欢迎来到《蜕变》</h3>
    <p>这不是一款普通的游戏——<b>游戏里的每一点成长，都必须先在现实世界里真实发生</b>。</p>
    <p>接下来的 90 天，你将：</p>
    <p>📅 <b>每天</b>完成现实任务（健身 / 阅读 / 守住原则）换取经验值<br>
       ⚔️ <b>每周</b>接受挑战，主动破圈与复盘<br>
       👹 <b>每月</b>讨伐 BOSS（新技能 / 新朋友 / 断舍离 / 焕新形象）<br>
       🎯 在<b>对话训练场</b>里把手册知识练成本能<br>
       🚫 触碰红线要诚实申报，用复盘完成自我修正</p>
    <p class="muted small">90天后，愿你从「愣头青」蜕变为「高质量男性」。</p>
    <input type="text" id="onboard-name" maxlength="12" placeholder="报上你的道号（名字）">
    <div class="modal-btns">
      <button class="btn" data-action="start-game">🔥 开启蜕变 · Day 1</button>
    </div>`);
}
function startGame() {
  const input = $('#onboard-name');
  S = freshState(input && input.value.trim() ? input.value.trim() : '修行者');
  save(); closeModal(); render();
  toast('🔥 <b>赛季开启！</b>第一幕 · 觉醒。记住：一次只练一条，直到它变成本能。', 'gold');
}

/* ============================================================
 *  事件 & 启动
 * ============================================================ */
function switchTab(id) {
  currentTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'sec-' + id));
}

function render() {
  ensureResets();
  renderHUD();
  renderStatus();
  renderDaily();
  renderChallenge();
  renderTrainer();
  renderSkills();
  renderLibrary();
  renderAch();
  renderRed();
  switchTab(currentTab);
  showWeeklyReport(); // 若跨周生成了战报，则弹出
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (e.target.classList && e.target.classList.contains('modal-mask')) { if (!modalLocked) closeModal(); return; }
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  switch (a) {
    case 'tab': switchTab(id); break;
    case 'toggle-daily': toggleDaily(id); break;
    case 'claim-weekly': claimWeekly(id); break;
    case 'claim-boss': claimBoss(id); break;
    case 'answer': answerScenario(id, Number(el.dataset.oi)); break;
    case 'retry-scenario': retryScenario(id); break;
    case 'unlock-skill': unlockSkill(id); break;
    case 'toggle-book': toggleBook(id); break;
    case 'report-violation': openViolationModal(); break;
    case 'submit-violation': submitViolation(); break;
    case 'do-recovery': doRecovery(); break;
    case 'submit-journal': submitJournal(); break;
    case 'rename': openRename(); break;
    case 'submit-rename': {
      const inp = $('#rename-input');
      if (inp && inp.value.trim()) { S.name = inp.value.trim(); save(); render(); toast('道号已更新'); }
      closeModal(); break;
    }
    case 'export': exportSave(); break;
    case 'import': $('#import-file').click(); break;
    case 'toggle-sound': {
      S.settings.sound = !S.settings.sound;
      save(); render();
      if (S.settings.sound) { sfx.quest(); toast('🔊 音效已开启'); } else { toast('🔇 音效已关闭'); }
      break;
    }
    case 'reset': confirmReset(); break;
    case 'do-reset': localStorage.removeItem(SAVE_KEY); location.reload(); break;
    case 'start-game': startGame(); break;
    case 'dismiss-install': localStorage.setItem('gqmx_install_dismissed', '1'); render(); break;
    case 'close': closeModal(); break;
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'import-file' && e.target.files.length) {
    importSave(e.target.files[0]);
  }
});

/* 键盘可访问性：Enter/空格 触发任务卡片 */
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.quest[role="button"], .skill[role="button"]')) {
    e.preventDefault();
    e.target.click();
  }
});

/* ---------- 启动 ---------- */
(function init() {
  S = load();
  if (!S) { showOnboarding(); return; } // 无存档：仅显示引导弹窗，开始游戏后再渲染
  ensureResets();
  save();
  render();
})();
