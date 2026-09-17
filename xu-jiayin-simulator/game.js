
/* =========================================================
   0. 工具
   ========================================================= */
const $  = (s) => document.querySelector(s);
const rnd = Math.random;
const clamp = (v,a,b) => Math.min(b, Math.max(a, v));
const fmt = (n) => (Math.round(n*100)/100).toFixed(2);
const fmt4 = (n) => (Math.round(n*10000)/10000).toFixed(4);

/* =========================================================
   1. 音频引擎
   - 合成 BGM（原创旋律，非任何版权歌曲）
   - 合成「哦！耶！」人声（浏览器语音合成）+ 和声 stab
   - 支持加载用户自己的本地音乐文件
   ========================================================= */
const Sound = (() => {
  let ctx = null;
  let master = null, musicGain = null, sfxGain = null, duckGain = null;
  let schedulerId = null, step = 0, nextTime = 0;
  let musicOn = true, sfxOn = true;
  let noiseBuf = null;
  let externalEl = null;        // 用户提供的音乐
  let externalActive = false;
  let externalLabel = '';
  let lastVocal = 0;
  let voice = null;

  const TEMPO = 116;
  const STEP  = 60 / TEMPO / 2;      // 八分音符
  const STEPS = 32;                  // 4 小节 × 8 步

  // I – V – vi – IV（C 大调五声音阶，欢快酒桌风）
  const BARS = [
    { bass: 48, chord:[60,64,67], mel:[72,74,76,74,72,69,72,0] },
    { bass: 43, chord:[59,62,67], mel:[71,74,76,79,76,74,71,0] },
    { bass: 45, chord:[60,64,69], mel:[69,72,76,74,72,69,67,0] },
    { bass: 41, chord:[60,65,69], mel:[65,69,72,74,72,69,65,0] },
  ];
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function ensure() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();  master.gain.value = 0.9;
    duckGain = ctx.createGain(); duckGain.gain.value = 1;
    musicGain = ctx.createGain(); musicGain.gain.value = 0.30;
    sfxGain = ctx.createGain();  sfxGain.gain.value = 0.75;
    musicGain.connect(duckGain); duckGain.connect(master);
    sfxGain.connect(master);     master.connect(ctx.destination);

    // 噪声（军鼓 / 踩镲）
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;

    // 中文语音（「哦！耶！」）
    if ('speechSynthesis' in window) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        voice = vs.find(v => /zh[-_]?CN|Chinese|中文|普通话/i.test(v.lang + v.name)) || vs[0] || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
    return ctx;
  }
  function resume(){ ensure(); if (ctx.state === 'suspended') ctx.resume(); }

  /* ---- 单个音 ---- */
  function tone(t, freq, dur, type, gain, dest) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'triangle'; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || musicGain);
    o.start(t); o.stop(t + dur + 0.03);
  }
  function noise(t, dur, gain, hp, dest) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 3000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest || musicGain);
    s.start(t); s.stop(t + dur + 0.02);
  }

  /* ---- BGM 调度 ---- */
  function scheduleStep(s, t) {
    const bar = BARS[Math.floor(s / 8) % 4];
    const k = s % 8;
    if (k === 0) {                                   // 贝斯
      tone(t, mtof(bar.bass), 0.46, 'triangle', 0.30);
      bar.chord.forEach((n, i) => tone(t + i * 0.02, mtof(n), 1.7, 'sine', 0.055)); // 铺底和弦
    }
    const m = bar.mel[k];                            // 主旋律
    if (m) {
      tone(t, mtof(m), 0.20, 'square', 0.085);
      tone(t + 0.01, mtof(m + 12), 0.12, 'sine', 0.03);
    }
    if (k === 0 || k === 4) tone(t, 110, 0.16, 'sine', 0.34);         // 底鼓
    if (k === 2 || k === 6) noise(t, 0.13, 0.14, 1600);               // 军鼓
    noise(t, 0.032, 0.045, 7000);                                     // 踩镲
  }
  function pump() {
    if (!ctx || !musicOn) return;
    while (nextTime < ctx.currentTime + 0.25) {
      scheduleStep(step % STEPS, nextTime);
      nextTime += STEP; step++;
    }
  }

  function startSynth() {
    ensure();
    if (schedulerId) return;
    nextTime = ctx.currentTime + 0.08;
    schedulerId = setInterval(pump, 40);
    pump();
  }
  function stopSynth(){ if (schedulerId) { clearInterval(schedulerId); schedulerId = null; } }

  /* ---- 「哦！耶！」 ---- */
  function say(text, pitch, rate, vol) {
    if (!('speechSynthesis' in window)) return false;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.pitch = pitch; u.rate = rate; u.volume = vol;
      if (voice) u.voice = voice;
      u.onstart = () => { if (duckGain) duckGain.gain.setTargetAtTime(0.35, ctx.currentTime, 0.05); };
      u.onend   = () => { if (duckGain) duckGain.gain.setTargetAtTime(1,    ctx.currentTime, 0.25); };
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }
  function cheerSynth(t, big) {
    const notes = big ? [523,659,784,1047,1319] : [659,880];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      const st = t + i * (big ? 0.085 : 0.055);
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 0.75, st);
      o.frequency.exponentialRampToValueAtTime(f, st + 0.07);
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(big ? 0.14 : 0.10, st + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, st + (big ? 0.38 : 0.22));
      o.connect(g); g.connect(sfxGain);
      o.start(st); o.stop(st + 0.45);
    });
  }
  /** kind: 'small' | 'big' | 'sad' | 'cash' */
  function sfx(kind) {
    if (!musicOn && !sfxOn) return;
    ensure();
    const t = ctx.currentTime;
    if (!sfxOn) return;

    if (kind === 'sad') {
      [392, 330, 262].forEach((f, i) => tone(t + i * 0.14, f, 0.5, 'sine', 0.16, sfxGain));
      return;
    }
    if (kind === 'cash') {
      [1047, 1319, 1568].forEach((f, i) => tone(t + i * 0.05, f, 0.16, 'triangle', 0.11, sfxGain));
      return;
    }
    const big = kind === 'big';
    cheerSynth(t, big);

    const now = performance.now();
    if (now - lastVocal < (big ? 700 : 420)) return;     // 节流，别太吵
    lastVocal = now;
    const spoken = say(big ? '哦——耶——！' : '哦耶！', big ? 1.7 : 1.5, big ? 1.05 : 1.25, 1);
    if (!spoken) cheerSynth(t, true);
  }

  /* ---- 外部音乐 ---- */
  function setBgmLabel(txt, ok) {
    const l = $('#bgmLabel'), d = $('#bgmDot');
    if (l) l.textContent = txt;
    if (d) d.classList.toggle('off', !ok);
  }
  // 反复重试外部音乐：浏览器自动播放策略会在"用户手势之前"拒绝 play()，
  // 所以这里不能一失败就把元素丢掉，要留到点击「开始游戏」之后再试。
  function tryExternal() {
    if (!externalEl || externalActive) return;
    externalEl.play().then(() => {
      externalActive = true;
      stopSynth();
      setBgmLabel(externalLabel || '本地音乐播放中', true);
    }).catch(() => { /* 还没拿到用户手势，或文件损坏；保持合成旋律兜底 */ });
  }
  function useExternal(src, label) {
    try {
      if (externalEl) { try { externalEl.pause(); } catch (e) {} externalEl = null; }
      externalActive = false;
      externalLabel = label || '本地音乐播放中';
      externalEl = new Audio(src);
      externalEl.loop = true;
      externalEl.volume = 0.55;
      externalEl.addEventListener('error', () => {
        externalEl = null; externalActive = false; externalLabel = '';
        setBgmLabel('内置合成旋律（原创 · 非《朋友的酒》）', musicOn);
        if (musicOn) startSynth();
      });
      tryExternal();
      return true;
    } catch (e) { return false; }
  }
  function autoLoad() {
    // 同目录下的《朋友的酒》会被自动加载；文件不存在就一路退回合成旋律
    try {
      const probe = new Audio('朋友的酒.mp3');
      probe.addEventListener('canplaythrough', () => {
        if (!externalEl) useExternal('朋友的酒.mp3', '🎵 朋友的酒 · 本地文件');
      }, { once: true });
      probe.addEventListener('error', () => {}, { once: true });
      probe.load();
    } catch (e) {}
  }

  /* ---- 开关 ---- */
  function setMusic(on) {
    musicOn = on;
    if (!on) {
      stopSynth();
      if (externalEl) { try { externalEl.pause(); } catch (e) {} }
      if (duckGain && ctx) duckGain.gain.value = 0;
      setBgmLabel(externalActive ? (externalLabel + '（已暂停）') : '音乐已关闭', false);
      return;
    }
    resume();
    if (duckGain) duckGain.gain.value = 1;
    if (externalActive && externalEl) externalEl.play().catch(() => {});
    tryExternal();
    if (!externalActive) startSynth();
  }
  function setSfx(on) { sfxOn = on; }

  function boot() {
    resume();
    tryExternal();                       // 这次带着用户手势，成功就自动接管
    if (!externalActive) startSynth();   // 先放合成旋律兜底
    autoLoad();
  }

  return { boot, sfx, setMusic, setSfx, useExternal, resume,
           get musicOn(){ return musicOn; }, get sfxOn(){ return sfxOn; } };
})();

/* =========================================================
   2. 游戏状态（与 Python 原版一一对应）
   ========================================================= */
const INIT = () => ({
  cash: 1.0, land: 0, buildings: 0, debt: 0,
  reputation: 50, prestige: 50, day: 1,
  interestRate: 0.08, landPrice: 1.0, buildCost: 0.5, housePrice: 1.5,
  creditRating: 'AAA', fraudExposed: false, wifeTransferred: false,
  over: false, turnDone: false,
});
let S = INIT();
const RATING_LIMIT = { AAA: 50, AA: 30, A: 15, BBB: 8, B: 3 };

const dailyInterest = () => S.debt * S.interestRate / 365;
const totalAssets   = () => S.cash + S.land * S.landPrice + S.buildings * (S.buildCost + S.housePrice) / 2;
const netWorth      = () => totalAssets() - S.debt;
function ratingOf(rep) {
  if (rep >= 80) return 'AAA';
  if (rep >= 50) return 'AA';
  if (rep >= 30) return 'A';
  if (rep >= 15) return 'BBB';
  return 'B';
}

/* =========================================================
   3. 渲染
   ========================================================= */
function log(text, cls) {
  const d = document.createElement('div');
  d.className = 'li ' + (cls || '');
  d.innerHTML = '<span class="t">D' + S.day + '</span>' + text;
  const box = $('#log');
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 220) box.removeChild(box.firstChild);
}
function toast(text, cls, ms) {
  const d = document.createElement('div');
  d.className = 'toast ' + (cls || '');
  d.textContent = text;
  $('#toasts').appendChild(d);
  setTimeout(() => { d.style.transition = '.4s'; d.style.opacity = '0'; d.style.transform = 'translateY(-12px)'; }, (ms || 2200) - 400);
  setTimeout(() => d.remove(), ms || 2200);
}
function statCard(k, v, x, cls, id) {
  return `<div class="stat ${cls||''}" ${id?`id="${id}"`:''}><div class="k">${k}</div><div class="v">${v}</div><div class="x">${x||''}</div></div>`;
}
function render() {
  const di = dailyInterest(), nw = netWorth(), ta = totalAssets();
  const danger = S.debt > 0 && S.cash < di * 3;
  $('#hud').innerHTML =
    statCard('📅 天数', '第 ' + S.day + ' 天', '') +
    statCard('💰 现金', fmt(S.cash) + ' 亿', '日利息 ' + fmt4(di) + ' 亿', danger ? 'red danger' : 'gold') +
    statCard('💳 负债', fmt(S.debt) + ' 亿', '年化 ' + (S.interestRate*100).toFixed(1) + '%', 'red') +
    statCard('🏦 净资产', fmt(nw) + ' 亿', '目标 100 亿', nw >= 50 ? 'gold' : (nw < 0 ? 'red' : '')) +
    statCard('🏞️ 土地', S.land + ' 块', fmt(S.landPrice) + ' 亿/块', '') +
    statCard('🏗️ 在建', S.buildings + ' 栋', '售价 ' + fmt(S.housePrice) + ' 亿/栋', '') +
    statCard('📊 信誉', S.reputation + ' / 100', '评级 ' + S.creditRating, 'blue') +
    statCard('🌟 声望', S.prestige + ' / 100', '总资产 ' + fmt(ta) + ' 亿', 'purple');

  $('#barRep').style.width = clamp(S.reputation,0,100) + '%';
  $('#barPre').style.width = clamp(S.prestige,0,100) + '%';
  $('#barNet').style.width = clamp(nw,0,100) + '%';
  $('#numRep').textContent = S.reputation;
  $('#numPre').textContent = S.prestige;
  $('#numNet').textContent = fmt(nw);
  $('#ratingTag').textContent = '信用评级 ' + S.creditRating + '　·　最高可借 ' + (RATING_LIMIT[S.creditRating]||3) + ' 亿';
  $('#dayTag').textContent = '第 ' + S.day + ' 天';
}

/* =========================================================
   4. 操作按钮
   ========================================================= */
const ACTIONS = [
  { id:'land',    icon:'🏞️', t:'买地',      d:'囤地储备，等涨价',            run:actLand },
  { id:'build',   icon:'🏗️', t:'盖楼',      d:'把土地变成在建项目',          run:actBuild },
  { id:'sell',    icon:'🏘️', t:'卖房',      d:'回笼现金',                    run:actSell },
  { id:'borrow',  icon:'🏦', t:'借钱',      d:'银行贷款，受评级限制',        run:actBorrow },
  { id:'raise',   icon:'📢', t:'吸收资金',  d:'高息理财 / 商票 / 预售房',    run:actRaise },
  { id:'repay',   icon:'💸', t:'还债',      d:'降负债，信誉 +2',             run:actRepay },
  { id:'enjoy',   icon:'🌟', t:'享乐',      d:'豪宅 / 游艇 / 足球队 / 歌舞团', run:actEnjoy },
  { id:'cheat',   icon:'🎭', t:'欺骗系统',  d:'造假 / 转移资产 / 技术性离婚', run:actCheat, danger:true },
  { id:'buyrep',  icon:'💎', t:'买信誉',    d:'慈善捐款 / 公关',             run:actBuyRep },
  { id:'skip',    icon:'⏭️', t:'跳过一天',  d:'什么都不做，只滚利息',        run:actSkip, day:true },
];
function renderActions() {
  $('#acts').innerHTML = ACTIONS.map(a =>
    `<button class="act ${a.danger?'danger':''} ${a.day?'day':''}" data-id="${a.id}">
       <span class="t">${a.icon} ${a.t}</span><span class="d">${a.d}</span>
     </button>`).join('');
  document.querySelectorAll('.act').forEach(b =>
    b.addEventListener('click', () => onAction(b.dataset.id)));
  refreshActionState();
}
function setActionsEnabled(on) {
  document.querySelectorAll('.act').forEach(b => { b.disabled = !on; });
}
function refreshActionState() {
  const m = Object.fromEntries(ACTIONS.map(a => [a.id, true]));
  if (S.land <= 0) m.build = false;
  if (S.buildings <= 0) m.sell = false;
  if (S.debt <= 0) m.repay = false;
  document.querySelectorAll('.act').forEach(b => {
    if (S.turnDone) { b.disabled = true; return; }
    b.disabled = !m[b.dataset.id];
  });
}

/* =========================================================
   5. 弹窗组件
   ========================================================= */
function closeDlg() { $('#veil').classList.remove('show'); $('#dlg').innerHTML = ''; }
function showDlg(html, wire) {
  $('#dlg').innerHTML = html;
  $('#veil').classList.add('show');
  if (wire) wire();
}
function askNumber({ title, hint, min, max, step, integer }) {
  return new Promise(resolve => {
    const id = 'num' + Date.now();
    showDlg(`
      <h3>${title}</h3>
      <p class="hint">${hint}</p>
      <input type="number" id="${id}" value="${min}" min="${min}" max="${max}" step="${integer?1:0.1}" />
      <div class="quick">
        <button data-q="${min}">最小 ${integer?min:fmt(min)}</button>
        <button data-q="half">一半</button>
        <button data-q="${max}">最大 ${integer?max:fmt(max)}</button>
      </div>
      <div class="foot">
        <button class="btn ghost" data-cancel>取消</button>
        <button class="btn primary" data-ok>确定</button>
      </div>`, () => {
      const inp = $('#' + id);
      inp.focus(); inp.select();
      const done = (v) => { closeDlg(); resolve(v); };
      $('#dlg').querySelector('[data-cancel]').onclick = () => done(null);
      $('#dlg').querySelector('[data-ok]').onclick = () => {
        let v = parseFloat(inp.value);
        if (isNaN(v)) return;
        if (integer) v = Math.floor(v);
        v = clamp(v, min, max);
        done(v);
      };
      $('#dlg').querySelectorAll('.quick button').forEach(b => b.onclick = () => {
        const q = b.dataset.q;
        inp.value = q === 'half' ? (integer ? Math.floor((min+max)/2) : Math.round((min+max)/2*100)/100) : q;
        inp.focus();
      });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') $('#dlg').querySelector('[data-ok]').click(); });
    });
  });
}
function askOptions({ title, hint, options }) {
  return new Promise(resolve => {
    showDlg(`
      <h3>${title}</h3>
      ${hint ? `<p class="hint">${hint}</p>` : ''}
      <div class="opts">
        ${options.map((o,i) => `<button class="opt" data-i="${i}" ${o.disabled?'disabled':''}>
            <span>${o.label}${o.sub?`<small>${o.sub}</small>`:''}</span>
            <span class="price">${o.price||''}</span></button>`).join('')}
      </div>
      <div class="foot"><button class="btn ghost" data-cancel>取消</button></div>`, () => {
      $('#dlg').querySelector('[data-cancel]').onclick = () => { closeDlg(); resolve(null); };
      $('#dlg').querySelectorAll('.opt').forEach(b => b.onclick = () => {
        const o = options[+b.dataset.i];
        if (o.disabled) return;
        closeDlg(); resolve(o.value);
      });
    });
  });
}
function alertDlg(title, text) {
  return new Promise(resolve => {
    showDlg(`<h3>${title}</h3><p class="hint">${text}</p>
      <div class="foot"><button class="btn primary" data-ok>知道了</button></div>`, () => {
      $('#dlg').querySelector('[data-ok]').onclick = () => { closeDlg(); resolve(); };
    });
  });
}

/* =========================================================
   6. 各操作（严格照搬 Python 原版数值）
   ========================================================= */
async function actLand() {
  const max = Math.floor(S.cash / S.landPrice);
  const n = await askNumber({ title:'🏞️ 买地', hint:`每块 ${fmt(S.landPrice)} 亿，你有现金 ${fmt(S.cash)} 亿，最多买 ${max} 块。`, min:0, max:Math.max(0,max), integer:true });
  if (n === null) return false;
  if (n <= 0) { log('❌ 数量无效！', 'bad'); return false; }
  const cost = n * S.landPrice;
  if (cost > S.cash) { log('❌ 现金不足！', 'bad'); Sound.sfx('sad'); return false; }
  S.cash -= cost; S.land += n;
  log(`✅ 买入 ${n} 块地，花费 ${fmt(cost)} 亿。`, 'good');
  return true;
}
async function actBuild() {
  if (S.land <= 0) { log('❌ 没有土地，无法盖楼！', 'bad'); return false; }
  const max = Math.min(S.land, Math.floor(S.cash / S.buildCost));
  const n = await askNumber({ title:'🏗️ 盖楼', hint:`每栋成本 ${fmt(S.buildCost)} 亿，土地 ${S.land} 块，现金最多支持 ${max} 栋。`, min:0, max:Math.max(0,max), integer:true });
  if (n === null) return false;
  if (n <= 0) { log('❌ 条件不满足！', 'bad'); return false; }
  const cost = n * S.buildCost;
  if (n > S.land || cost > S.cash) { log('❌ 条件不满足！', 'bad'); Sound.sfx('sad'); return false; }
  S.cash -= cost; S.land -= n; S.buildings += n;
  log(`✅ 盖了 ${n} 栋楼，花费 ${fmt(cost)} 亿。`, 'good');
  return true;
}
async function actSell() {
  if (S.buildings <= 0) { log('❌ 没有可售房源！', 'bad'); return false; }
  const n = await askNumber({ title:'🏘️ 卖房', hint:`每栋售价 ${fmt(S.housePrice)} 亿，共有 ${S.buildings} 栋。`, min:0, max:S.buildings, integer:true });
  if (n === null) return false;
  if (n <= 0 || n > S.buildings) { log('❌ 数量无效！', 'bad'); return false; }
  const rev = n * S.housePrice;
  S.cash += rev; S.buildings -= n;
  log(`✅ 卖出 ${n} 栋，回款 ${fmt(rev)} 亿。`, 'good');
  Sound.sfx('cash');
  return true;
}
async function actBorrow() {
  const limit = RATING_LIMIT[S.creditRating] || 3;
  const avail = Math.max(0, limit - S.debt);
  if (avail <= 0) { log(`❌ 评级 ${S.creditRating}，额度 ${limit} 亿已用满，借不到了！`, 'bad'); Sound.sfx('sad'); return false; }
  const n = await askNumber({ title:'🏦 借钱', hint:`信用评级 ${S.creditRating}，最多可再借 ${fmt(avail)} 亿。借钱不提升净资产，但每天都要付利息。`, min:0, max:avail });
  if (n === null) return false;
  if (n <= 0 || n > avail) { log('❌ 超出借款额度！', 'bad'); return false; }
  S.cash += n; S.debt += n;
  log(`✅ 借款 ${fmt(n)} 亿，总负债 ${fmt(S.debt)} 亿。`, 'warn');
  return true;
}
async function actRaise() {
  const m = await askOptions({ title:'📢 吸收资金', hint:'来钱最快，但都会变成日后的负债或交付义务。', options:[
    { label:'① 高息理财', sub:'承诺高回报，吸收多但要还 130%', price:'信誉 −5', value:'1' },
    { label:'② 商业承兑汇票', sub:'只能拿到 80% 现金，负债记 100%', price:'信誉 −3', value:'2' },
    { label:'③ 预售房', sub:'提前回款，但未来要交付', price:'信誉 +3', value:'3' },
  ]});
  if (m === null) return false;
  const n = await askNumber({ title:'📢 吸收多少？', hint:'单位：亿。这笔钱会立刻进账，代价在后面。', min:0, max:200, step:1 });
  if (n === null) return false;
  if (n <= 0) { log('❌ 金额无效！', 'bad'); return false; }
  if (m === '1') {
    S.cash += n; S.debt += n * 1.3; S.reputation -= 5;
    log(`✅ 高息理财吸收 ${fmt(n)} 亿，未来需偿还 ${fmt(n*1.3)} 亿，信誉 −5。`, 'warn');
  } else if (m === '2') {
    S.cash += n * 0.8; S.debt += n; S.reputation -= 3;
    log(`✅ 商票融资到账 ${fmt(n*0.8)} 亿，负债增加 ${fmt(n)} 亿，信誉 −3。`, 'warn');
  } else {
    S.cash += n; S.debt += n * 0.5; S.reputation += 3;
    log(`✅ 预售房回款 ${fmt(n)} 亿，未来需交付，信誉 +3。`, 'good');
  }
  return true;
}
async function actRepay() {
  if (S.debt <= 0) { log('❌ 没有负债！', 'bad'); return false; }
  const max = Math.min(S.cash, S.debt);
  const n = await askNumber({ title:'💸 还债', hint:`现金 ${fmt(S.cash)} 亿，负债 ${fmt(S.debt)} 亿。还债信誉 +2。`, min:0, max });
  if (n === null) return false;
  if (n <= 0 || n > S.cash || n > S.debt) { log('❌ 金额无效！', 'bad'); return false; }
  S.cash -= n; S.debt -= n; S.reputation += 2;
  log(`✅ 还债 ${fmt(n)} 亿，信誉 +2。`, 'good');
  return true;
}
async function actEnjoy() {
  const items = [
    { label:'① 买豪宅', sub:'声望 +10', price:'1 亿', cost:1,   fn:() => { S.prestige += 10; } },
    { label:'② 买游艇', sub:'声望 +5',  price:'0.5 亿', cost:.5, fn:() => { S.prestige += 5; } },
    { label:'③ 买足球队', sub:'声望 +25、信誉 +5', price:'5 亿', cost:5, fn:() => { S.prestige += 25; S.reputation += 5; } },
    { label:'④ 养歌舞团', sub:'声望 +8', price:'0.3 亿', cost:.3, fn:() => { S.prestige += 8; } },
  ].map(o => ({ ...o, value:o, disabled:S.cash < o.cost }));
  const pick = await askOptions({ title:'🌟 享乐系统', hint:`现金 ${fmt(S.cash)} 亿。花钱买面子，声望涨，但现金变少。`, options:items });
  if (!pick) return false;
  if (S.cash < pick.cost) { log('❌ 现金不足！', 'bad'); Sound.sfx('sad'); return false; }
  S.cash -= pick.cost; pick.fn();
  log(`✅ ${pick.label.slice(2)}，花费 ${fmt(pick.cost)} 亿。`, 'good');
  return true;
}
async function actCheat() {
  const m = await askOptions({ title:'🎭 欺骗系统', hint:'收益高，但被抓到代价很大。', options:[
    { label:'① 财务造假', sub:'50% 概率虚增现金 2 亿；失败信誉 −30 并留下案底', price:'信誉 −10', value:'1' },
    { label:'② 转移资产', sub:'70% 概率转走 30% 现金到海外', price:'声望 +5', value:'2' },
    { label:'③ 技术性离婚', sub:'把资产转到配偶名下，暴雷时可保住一半', price:'信誉 −10', value:'3' },
  ]});
  if (m === null) return false;
  if (m === '1') {
    if (rnd() < 0.5) { S.cash += 2; S.reputation -= 10; log('✅ 财务造假成功，虚增现金 2 亿，信誉 −10。', 'warn'); }
    else { S.fraudExposed = true; S.reputation -= 30; log('❌ 财务造假被查出！信誉 −30，后续暴雷罪加一等！', 'bad'); Sound.sfx('sad'); }
  } else if (m === '2') {
    if (rnd() < 0.7) { const tr = S.cash * 0.3; S.cash -= tr; S.prestige += 5; log(`✅ 成功转移 ${fmt(tr)} 亿资产到海外，声望 +5。`, 'warn'); }
    else { S.reputation -= 15; log('❌ 转移资产被发现，信誉 −15。', 'bad'); Sound.sfx('sad'); }
  } else {
    if (!S.wifeTransferred) { S.wifeTransferred = true; S.reputation -= 10; log('✅ 技术性离婚完成，资产已部分转移，信誉 −10。', 'warn'); }
    else log('⚠️ 已经离过了。', 'warn');
  }
  return true;
}
async function actBuyRep() {
  const m = await askOptions({ title:'💎 买信誉', hint:'用钱换评级，评级决定借款额度。', options:[
    { label:'① 慈善捐款', sub:'信誉 +10', price:'0.5 亿', value:'1', disabled:S.cash < .5 },
    { label:'② 公关公关', sub:'信誉 +20', price:'1 亿',   value:'2', disabled:S.cash < 1 },
  ]});
  if (m === null) return false;
  if (m === '1') { S.cash -= 0.5; S.reputation += 10; log('✅ 慈善捐款，信誉 +10。', 'good'); }
  else { S.cash -= 1; S.reputation += 20; log('✅ 公关成功，信誉 +20。', 'good'); }
  return true;
}
async function actSkip() { log('⏭️ 跳过一天。', ''); return true; }

/* =========================================================
   7. 回合流程（对应 Python 主循环）
   ========================================================= */
function beginTurn() {
  S.turnDone = false;
  S.creditRating = ratingOf(S.reputation);
  render();

  const di = dailyInterest(), nw = netWorth();

  /* --- 暴雷判定 --- */
  if (S.cash < di && S.debt > 0) return endingCrash();

  /* --- 胜利判定 --- */
  if (nw >= 100) return endingWin();

  /* --- 扣当日利息 --- */
  S.cash -= di;

  /* --- 随机市场事件（20%） --- */
  if (rnd() < 0.2) {
    const evts = [
      ['🏦 央行降准降息，信贷宽松！', () => { S.interestRate = Math.max(0.03, S.interestRate - 0.01);
        log(`✅ 利率降至 ${(S.interestRate*100).toFixed(1)}%，融资更容易了。`, 'good'); }],
      ['📉 楼市调控加码，限购限贷！', () => { S.housePrice *= 0.9;
        log(`❌ 房价下跌，当前售价 ${fmt(S.housePrice)} 亿/栋。`, 'bad'); }],
      ['🏗️ 政府鼓励基建，土地供应增加！', () => { S.landPrice *= 0.85;
        log(`✅ 地价下降，当前地价 ${fmt(S.landPrice)} 亿/块。`, 'good'); }],
      ['📈 房价上涨，销售回暖！', () => { S.housePrice *= 1.15;
        log(`✅ 房价上涨，当前售价 ${fmt(S.housePrice)} 亿/栋。`, 'good'); }],
      ['💀 某房企暴雷，市场信心崩溃！', () => { S.housePrice *= 0.8; S.landPrice *= 0.8; S.reputation -= 10;
        log(`💀 资产贬值，信誉下降至 ${S.reputation}。`, 'bad'); }],
      ['🤝 银行抽贷，融资渠道收紧！', () => { S.interestRate += 0.02;
        log(`⚠️ 融资困难，利率升至 ${(S.interestRate*100).toFixed(1)}%。`, 'warn'); }],
      ['📰 媒体曝光房企高负债，舆论哗然！', () => { S.reputation -= 5; S.prestige -= 5;
        log(`📰 舆论压力大，信誉降至 ${S.reputation}，声望降至 ${S.prestige}。`, 'warn'); }],
    ];
    const pick = evts[Math.floor(rnd() * evts.length)];
    log('📰 市场事件：' + pick[0], 'evt');
    toast(pick[0], '', 2400);
    pick[1]();
    S.creditRating = ratingOf(S.reputation);
  }

  render();
  refreshActionState();
  $('#log').scrollTop = $('#log').scrollHeight;
}

function endTurn() {
  S.turnDone = true;
  setActionsEnabled(false);
  /* 价格波动 + 信誉自然衰减 + 天数 */
  S.landPrice  *= 0.97 + rnd() * 0.06;
  S.housePrice *= 0.97 + rnd() * 0.06;
  S.landPrice  = Math.max(0.3, Math.round(S.landPrice * 100) / 100);
  S.housePrice = Math.max(0.5, Math.round(S.housePrice * 100) / 100);
  S.reputation = Math.max(0, S.reputation - 1);
  S.day += 1;
  setTimeout(beginTurn, 180);
}

async function onAction(id) {
  if (S.over || S.turnDone) return;
  S.turnDone = true;                 // 防止连点
  setActionsEnabled(false);
  Sound.resume();

  const a = ACTIONS.find(x => x.id === id);
  const ok = await a.run();
  render();

  if (!ok) { S.turnDone = false; refreshActionState(); return; }   // 操作失败不消耗一天

  Sound.sfx('small');
  endTurn();
}

/* =========================================================
   8. 结局
   ========================================================= */
function showEnd({ win, title, desc }) {
  S.over = true;
  setActionsEnabled(false);
  const nw = netWorth();
  $('#endTitle').textContent = title;
  $('#endTitle').className = 'big ' + (win ? 'win' : 'lose');
  $('#endDesc').textContent = desc;
  $('#endStats').innerHTML = [
    ['坚持天数', S.day + ' 天'],
    ['净资产', fmt(nw) + ' 亿'],
    ['现金', fmt(S.cash) + ' 亿'],
    ['负债', fmt(S.debt) + ' 亿'],
    ['信誉', S.reputation + ' / 100'],
    ['声望', S.prestige + ' / 100'],
  ].map(([k,v]) => `<div class="f"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  $('#end').classList.remove('hidden');
  $('#end').style.animation = 'fade .4s';
  Sound.sfx(win ? 'big' : 'sad');
}

function endingWin() {
  log('🎉🎉🎉 恭喜！你的净资产突破 100 亿！成为地产大亨！ 🎉🎉🎉', 'good');
  toast('🎉 净资产突破 100 亿！', 'gold', 3200);
  render();
  showEnd({
    win: true,
    title: '🎉 恭喜通关：地产大亨',
    desc: `第 ${S.day} 天，你的净资产突破 100 亿。\n\n在债务暴雷之前，你把数字做上去了——地还在囤，楼还在盖，报表还在美化。至于那 100 亿里有多少是自己的，只有你知道。`
  });
}

function endingCrash() {
  log('💥💥💥 资金链断裂！债务暴雷！ 💥💥💥', 'bad');
  toast('💥 资金链断裂，暴雷了！', 'bad', 3200);
  let lines = '债权人纷纷上门，项目停工，股价暴跌……\n';
  if (S.fraudExposed) lines += '\n⚠️ 财务造假已被查出，罪加一等！\n';
  lines += '\n你试图技术性离婚转移资产……\n';

  const nw = netWorth();
  if (!S.wifeTransferred && rnd() < 0.3) {
    lines += `✅ 转移成功！你带着部分资产远走他乡。\n最终转移资产：${fmt(Math.max(0, nw * 0.3))} 亿`;
  } else if (S.wifeTransferred) {
    lines += `✅ 你早已技术性离婚，资产已转移。\n最终转移资产：${fmt(Math.max(0, nw * 0.5))} 亿`;
  } else {
    lines += '❌ 转移失败！资产被冻结，你被带走调查。';
  }
  render();
  setTimeout(() => showEnd({ win: false, title: '💥 暴雷：游戏结束', desc: lines }), 400);
}

/* =========================================================
   9. 启动 / 重开 / 顶栏
   ========================================================= */
function restart() {
  S = INIT();
  $('#log').innerHTML = '';
  $('#end').classList.add('hidden');
  log('🏢 <b>许家印模拟器 · 终极版</b>', 'day');
  log('目标：在债务暴雷前，把净资产做到 100 亿，或者带着钱跑路。', '');
  log('初始：现金 1.00 亿｜信誉 50｜声望 50｜信用评级 AAA', '');
  renderActions();
  render();
  beginTurn();
}
function toggleMusic() {
  Sound.setMusic(!Sound.musicOn);
  const b = $('#tMusic');
  b.textContent = Sound.musicOn ? '🎵 音乐：开' : '🎵 音乐：关';
  b.classList.toggle('on', Sound.musicOn);
  b.classList.toggle('off', !Sound.musicOn);
  const d = $('#bgmDot'); if (d) d.classList.toggle('off', !Sound.musicOn);
}
function toggleSfx() {
  Sound.setSfx(!Sound.sfxOn);
  const b = $('#tSfx');
  b.textContent = Sound.sfxOn ? '🔊 音效：开' : '🔇 音效：关';
  b.classList.toggle('on', Sound.sfxOn);
  b.classList.toggle('off', !Sound.sfxOn);
}

$('#btnStart').addEventListener('click', () => {
  Sound.boot();
  $('#start').classList.add('hidden');
  restart();
  Sound.sfx('big');
});
$('#tMusic').addEventListener('click', toggleMusic);
$('#tSfx').addEventListener('click', toggleSfx);
$('#tRestart').addEventListener('click', () => { restart(); });
$('#btnAgain').addEventListener('click', () => { $('#end').classList.add('hidden'); restart(); Sound.sfx('big'); });
$('#tFile').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  Sound.resume();
  Sound.setMusic(true);
  $('#tMusic').textContent = '🎵 音乐：开'; $('#tMusic').classList.add('on'); $('#tMusic').classList.remove('off');
  Sound.useExternal(url, '🎵 ' + f.name);
  toast('已切换背景音乐：' + f.name, 'gold');
  e.target.value = '';
});

/* 首次任意点击都尝试解锁音频 */
document.addEventListener('click', () => Sound.resume(), { once: true });
renderActions();
render();
