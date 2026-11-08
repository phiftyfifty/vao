const UNITS = window.VAO_UNITS;
const ITEMS = new Map();
const TEACHER = window.VAO_TEACHER || {};
UNITS.forEach(u => u.items.forEach(it => {
  it.unit = u.id; ITEMS.set(it.id, it);
  if (TEACHER[it.key]) { it.audio = `teacher/${it.key}.mp3?v=${TEACHER[it.key]}`; it.audio_src = "teacher"; }
}));

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const NODE_ICONS = ["★", "♪", "✎", "◆", "✦", "☀"];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a, n) => shuffle(a).slice(0, n);

/* ---------- persisted state ---------- */
const KEY = "vao.mock.v1";
const fresh = () => ({ done: {}, xp: 0, mistakes: [], roman: true, unlockAll: false });
let S = Object.assign(fresh(), JSON.parse(localStorage.getItem(KEY) || "{}"));
const save = () => localStorage.setItem(KEY, JSON.stringify(S));

const lessonKey = (u, i) => `${u.id}#${i}`;
const allLessons = UNITS.flatMap(u => u.lessons.map((ids, i) => ({ unit: u, idx: i, ids, key: lessonKey(u, i) })));
const currentIndex = () => { const i = allLessons.findIndex(l => !S.done[l.key]); return i === -1 ? allLessons.length : i; };
const isUnlocked = l => S.unlockAll || allLessons.indexOf(l) <= currentIndex();

/* ---------- audio ---------- */
let audioEl = null;
function setPlaying(on) { document.querySelectorAll(".play").forEach(b => b.classList.toggle("playing", on)); }
function playItem(it, quiet) {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  speechSynthesis.cancel();
  if (it.audio) {
    audioEl = new Audio("media/" + it.audio);
    setPlaying(true);
    audioEl.onended = () => setPlaying(false);
    audioEl.play().catch(() => setPlaying(false));
    return;
  }
  const v = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith("lo"));
  if (v) {
    const u = new SpeechSynthesisUtterance(it.lao); u.voice = v; u.lang = v.lang;
    setPlaying(true); u.onend = () => setPlaying(false); speechSynthesis.speak(u);
  } else if (!quiet) {
    toast("No clip for this word yet. The audio step would fill it with TTS, then a native recording.");
  }
}
const hasSound = it => !!it.audio;
const SRC_LABEL = { teacher: "teacher recording", native: "native recording", tts: "synthetic voice" };
function srcTag(it) {
  return it.audio
    ? `<div class="src ${it.audio_src === "tts" ? "synth" : ""}"><i></i>${SRC_LABEL[it.audio_src] || "recording"}</div>`
    : '<div class="src pending"><i></i>no audio yet</div>';
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2800);
}
const romanHtml = it => S.roman ? `<div class="hero-roman">${esc(it.roman)}</div>` : "";

/* ---------- lesson generation ---------- */
function distractors(it, pool, n, field) {
  const seen = new Set([it[field], it.en.toLowerCase()]);
  const out = [];
  for (const o of shuffle(pool)) {
    if (o.id === it.id || seen.has(o[field]) || seen.has(o.en.toLowerCase())) continue;
    seen.add(o[field]); seen.add(o.en.toLowerCase()); out.push(o);
    if (out.length === n) break;
  }
  return out;
}

function romanWords(it) {
  return it.roman.replace(/\([^)]*\)/g, " ").replace(/[?]/g, " ").replace(/\s*\/.*$/, "").split(/\s+/).filter(Boolean);
}
const buildable = it => it.tiles || romanWords(it).length >= 2;

function recognizeStep(it) { return { type: hasSound(it) ? "listen_pick" : "read_pick", item: it }; }

function generateLesson(ids, unit) {
  const items = ids.map(id => ITEMS.get(id));
  const pool = unit.items.length >= 8 ? unit.items : UNITS.flatMap(u => u.items);
  const half = Math.ceil(items.length / 2);
  const steps = [];
  items.slice(0, half).forEach(it => { steps.push({ type: "intro", item: it }); steps.push(recognizeStep(it)); });
  if (half >= 2) steps.push({ type: "match", items: items.slice(0, half) });
  items.slice(half).forEach(it => { steps.push({ type: "intro", item: it }); steps.push({ type: "pick_lao", item: it }); });
  items.filter(buildable).slice(0, 2).forEach(it => steps.push({ type: "build", item: it }));
  [...items.filter(hasSound), ...items.filter(it => !hasSound(it))].slice(0, 2)
    .forEach(it => steps.push({ type: "speak", item: it }));
  pick(items, 3).forEach((it, k) => steps.push(k % 2 ? { type: "pick_lao", item: it } : recognizeStep(it)));
  steps.forEach(s => s.pool = pool);
  return steps;
}

/* ---------- views ---------- */
let tab = "learn";
let L = null; // active lesson

function renderShell() {
  if (L) return renderLesson();
  if (tab === "learn") renderPath(); else if (tab === "play") renderGame(); else renderReview();
}

function navHtml() {
  return `<div class="nav">
    <button class="${tab === "learn" ? "on" : ""}" data-tab="learn"><span class="ic">◉</span>Learn</button>
    <button class="${tab === "play" ? "on" : ""}" data-tab="play"><span class="ic">◈</span>Play</button>
    <button class="${tab === "review" ? "on" : ""}" data-tab="review"><span class="ic">↻</span>Review${S.mistakes.length ? ` (${S.mistakes.length})` : ""}</button>
  </div>`;
}
function wireNav() {
  document.querySelectorAll(".nav button").forEach(b => b.onclick = () => { window.stopGame?.(); tab = b.dataset.tab; R = null; renderShell(); });
}

function topStats() {
  return `<div class="topstats">
    <div class="brand">vao</div>
    <div class="pills">
      <button class="pill toggle" id="romanToggle" title="Show romanization">${S.roman ? "ກ + abc" : "ກ only"}</button>
      <span class="pill streak">● 1</span>
      <span class="pill xp">${S.xp} xp</span>
    </div>
  </div>`;
}

function renderPath() {
  const cur = currentIndex();
  let html = topStats() + '<div class="path" id="path">';
  for (const u of UNITS) {
    const lessons = allLessons.filter(l => l.unit === u);
    const unitLocked = !lessons.some(isUnlocked);
    const level = /^L\d+$/.test(u.level) ? `Level ${u.level.slice(1)} · Unit ${parseInt(u.id.split("-")[1], 10)}` : u.level;
    html += `<div class="unit-head ${unitLocked ? "locked" : ""}"><small>${level}</small><h3>${esc(u.title)}</h3><div class="sub">${u.items.length} words · ${u.lessons.length} lessons</div></div><div class="nodes">`;
    lessons.forEach((l, k) => {
      const done = !!S.done[l.key];
      const isCur = allLessons.indexOf(l) === cur;
      const locked = !isUnlocked(l);
      const off = Math.round(Math.sin((k + (u.id.charCodeAt(4) || 0)) * 1.1) * 70);
      const first = ITEMS.get(l.ids[0]);
      html += `<div class="node-wrap" style="transform:translateX(${off}px)">
        ${isCur ? '<div class="start-tip">START</div>' : ""}
        <button class="node ${done ? "done" : ""} ${locked ? "locked" : ""} ${isCur ? "current" : ""}" data-key="${l.key}">${done ? "✓" : locked ? "🔒︎" : NODE_ICONS[k % NODE_ICONS.length]}</button>
        <div class="node-label">${esc(first.en)}${l.ids.length > 1 ? " …" : ""}</div>
      </div>`;
    });
    html += "</div>";
  }
  html += "</div>" + navHtml();
  $("view").innerHTML = html;
  wireNav();
  $("romanToggle").onclick = () => { S.roman = !S.roman; save(); renderPath(); };
  document.querySelectorAll(".node").forEach(n => n.onclick = () => {
    const l = allLessons.find(x => x.key === n.dataset.key);
    if (!isUnlocked(l)) return toast("Finish the lesson before this one to unlock it.");
    startLesson(l);
  });
  const curNode = document.querySelector(".node.current");
  if (curNode) { const p = $("path"); p.style.scrollBehavior = "auto"; p.scrollTop = curNode.offsetTop - 260; p.style.scrollBehavior = ""; }
}

/* ---------- lesson engine ---------- */
function startLesson(l, steps) {
  window.stopGame?.();
  L = {
    lesson: l, steps: steps || generateLesson(l.ids, l.unit), i: 0,
    graded: 0, firstTry: 0, missed: new Set(), combo: 0, state: "answering", answer: null, demo: !!steps,
  };
  L.base = L.steps.filter(s => s.type !== "intro").length;
  renderLesson();
}

function renderLesson() {
  if (L.i >= L.steps.length) return renderComplete();
  const st = L.steps[L.i];
  const pct = Math.min(100, Math.round(L.i / L.steps.length * 100));
  $("view").innerHTML = `
    <div class="lesson-top">
      <button class="x" id="quit" title="Quit">✕</button>
      <div class="lbar"><div style="width:${pct}%"></div></div>
      <div class="combo">${L.combo >= 3 ? `${L.combo} in a row` : ""}</div>
    </div>
    <div class="lesson-body" id="lbody"></div>
    <div class="lfoot" id="lfoot"></div>`;
  $("quit").onclick = () => { L = null; renderShell(); };
  RENDER[st.type](st);
  renderFooter(st);
}

function renderFooter(st, result) {
  const f = $("lfoot");
  f.className = "lfoot" + (result ? " " + result.cls : "");
  if (result) {
    f.innerHTML = `<div class="fb"><b>${result.title}</b>${result.detail || ""}</div><button class="cta" id="cta">Continue</button>`;
    $("cta").onclick = next;
    return;
  }
  if (st.type === "intro") {
    f.innerHTML = '<button class="cta" id="cta">Continue</button>';
    $("cta").onclick = next;
  } else if (st.type === "match") {
    f.innerHTML = '<button class="cta" id="cta" disabled>Match all pairs</button>';
  } else if (st.type === "speak") {
    f.innerHTML = '<button class="cta" id="cta">Show answer</button>';
    $("cta").onclick = () => speakReveal(st);
  } else {
    f.innerHTML = '<button class="cta" id="cta" disabled>Check</button>';
    $("cta").onclick = () => check(st);
  }
}

function setAnswer(a) { L.answer = a; const c = $("cta"); if (c) c.disabled = a == null || (Array.isArray(a) && !a.length); }

function answerDetail(it) {
  return `<span class="lao">${esc(it.lao)}</span> <span>${S.roman ? "· " + esc(it.roman) + " " : ""}· ${esc(it.en)}</span>`;
}

function grade(st, ok) {
  L.graded++;
  const it = st.item;
  if (ok) {
    L.combo++;
    if (!st.retry) L.firstTry++;
  } else {
    L.combo = 0;
    if (it) { L.missed.add(it.id); L.steps.push({ ...st, retry: true }); }
  }
  return ok
    ? { cls: "right", title: ["Nice!", "Correct", "ດີຫຼາຍ! Great!", "Spot on"][Math.floor(Math.random() * 4)], detail: it && st.type !== "pick_lao" ? `<div>${answerDetail(it)}</div>` : "" }
    : { cls: "wrong", title: "Correct answer:", detail: `<div>${answerDetail(it)}</div>` };
}

function check(st) {
  if (L.state !== "answering" || L.answer == null) return;
  L.state = "checked";
  const ok = CHECK[st.type](st, L.answer);
  document.querySelectorAll(".opt, .tile").forEach(b => b.disabled = true);
  if (st.type === "listen_pick" || st.type === "read_pick" || st.type === "pick_lao") {
    document.querySelectorAll(".opt").forEach(b => {
      if (b.dataset.id === st.item.id) b.classList.add("right");
      else if (b.classList.contains("sel")) b.classList.add("wrong");
    });
  }
  if (st.type === "pick_lao" && ok) playItem(st.item, true);
  renderFooter(st, grade(st, ok));
}

function next() {
  L.i++; L.state = "answering"; L.answer = null;
  renderLesson();
}

/* each exercise type: render into #lbody */
const RENDER = {
  intro(st) {
    const it = st.item;
    $("lbody").innerHTML = `
      <div class="label new">New word</div>
      <div class="center">
        <div class="lao hero-lao">${esc(it.lao)}</div>
        ${romanHtml(it)}
        <div class="hero-en">${esc(it.en)}</div>
        ${it.note ? `<div class="note">${esc(it.note)}</div>` : ""}
        <button class="play sm" id="p" style="margin-top:16px">${ICON_PLAY}</button>
        ${srcTag(it)}
        ${it.img ? `<img class="slide" src="media/${esc(it.img)}" alt="class slide">` : ""}
      </div>`;
    $("p").onclick = () => playItem(it);
    if (hasSound(it)) setTimeout(() => playItem(it, true), 250);
    wireSlides();
  },
  listen_pick(st) { renderChoice(st, true); },
  read_pick(st) { renderChoice(st, false); },
  pick_lao(st) {
    const it = st.item;
    const opts = shuffle([it, ...distractors(it, st.pool, 3, "lao")]);
    $("lbody").innerHTML = `
      <div class="label">Pick the Lao</div>
      <div class="q">Which one is “${esc(it.en)}”?</div>
      <div class="opts grid">${opts.map((o, k) => `
        <button class="opt" data-id="${o.id}"><span class="k">${k + 1}</span>
          <span class="lao ol">${esc(o.lao)}</span>${S.roman ? `<span class="or">${esc(o.roman)}</span>` : ""}
        </button>`).join("")}</div>`;
    wireOptions();
  },
  match(st) {
    const left = shuffle(st.items), right = shuffle(st.items);
    $("lbody").innerHTML = `
      <div class="label">Match the pairs</div>
      <div class="q">Tap the matching pairs</div>
      <div class="match">
        <div class="col">${left.map(o => `<button class="mt lao" data-id="${o.id}" data-side="l">${esc(o.lao)}</button>`).join("")}</div>
        <div class="col">${right.map(o => `<button class="mt" data-id="${o.id}" data-side="r">${esc(o.en)}</button>`).join("")}</div>
      </div>`;
    let sel = null, left_ = st.items.length, misses = 0;
    document.querySelectorAll(".mt").forEach(b => b.onclick = () => {
      if (b.dataset.side === "l") playItem(ITEMS.get(b.dataset.id), true);
      if (!sel || sel.dataset.side === b.dataset.side) {
        document.querySelectorAll(`.mt[data-side="${b.dataset.side}"]`).forEach(x => x.classList.remove("sel"));
        sel = b; b.classList.add("sel"); return;
      }
      if (sel.dataset.id === b.dataset.id) {
        sel.classList.replace("sel", "ok"); b.classList.add("ok"); sel = null;
        if (--left_ === 0) {
          L.state = "checked"; L.graded++;
          if (misses === 0) { L.combo++; L.firstTry++; } else L.combo = 0;
          renderFooter(st, { cls: "right", title: misses ? `Done, ${misses} slip${misses > 1 ? "s" : ""}` : "All pairs matched!" });
        }
      } else {
        misses++; L.missed.add(sel.dataset.id); L.missed.add(b.dataset.id);
        const a = sel; a.classList.remove("sel"); a.classList.add("no"); b.classList.add("no"); sel = null;
        setTimeout(() => { a.classList.remove("no"); b.classList.remove("no"); }, 450);
      }
    });
  },
  build(st) {
    const it = st.item;
    const laoMode = !!it.tiles;
    const target = laoMode ? it.tiles : romanWords(it);
    const extra = laoMode
      ? shuffle(st.pool.concat(UNITS.flatMap(u => u.items)).filter(o => o.tiles && o.id !== it.id).flatMap(o => o.tiles)).filter(t => !target.includes(t))
      : shuffle(st.pool.filter(o => o.id !== it.id).flatMap(romanWords)).filter(t => !target.includes(t));
    const bank = shuffle([...target, ...[...new Set(extra)].slice(0, Math.max(2, 6 - target.length))]);
    st.target = target;
    $("lbody").innerHTML = `
      <div class="label">Build it</div>
      <div class="q">Say “${esc(it.en)}” in Lao</div>
      ${laoMode ? "" : `<div class="mode-note">Romanized tiles for this one. The segmenter couldn't split it into Lao words that match the romanization.</div>`}
      <div class="answer-line" id="ans"></div><div class="answer-line"></div>
      <div class="bank" id="bank">${bank.map((t, k) => `<button class="tile ${laoMode ? "lao" : ""}" data-k="${k}">${esc(t)}</button>`).join("")}</div>`;
    const chosen = [];
    const draw = () => {
      $("ans").innerHTML = chosen.map((k, pos) => `<button class="tile ${laoMode ? "lao" : ""}" data-pos="${pos}">${esc(bank[k])}</button>`).join("");
      document.querySelectorAll("#bank .tile").forEach(b => b.classList.toggle("used", chosen.includes(+b.dataset.k)));
      document.querySelectorAll("#ans .tile").forEach(b => b.onclick = () => { if (L.state !== "answering") return; chosen.splice(+b.dataset.pos, 1); draw(); });
      setAnswer(chosen.length ? chosen.map(k => bank[k]) : null);
    };
    document.querySelectorAll("#bank .tile").forEach(b => b.onclick = () => { if (L.state !== "answering" || chosen.includes(+b.dataset.k)) return; chosen.push(+b.dataset.k); draw(); });
    draw();
  },
  speak(st) {
    const it = st.item;
    myClip = null; myScore = null;
    $("lbody").innerHTML = `
      <div class="label">Speak</div>
      <div class="q">Say this out loud in Lao</div>
      <div class="center">
        <div class="hero-en" style="font-size:28px;font-weight:700;margin-top:30px">${esc(it.en)}</div>
        <button class="mic" id="mic">${ICON_MIC}</button>
        <div class="src" id="micHint">Tap to record yourself (optional)</div>
        <div id="micScore"></div>
        <div id="reveal" class="speak-reveal" style="display:none"></div>
      </div>`;
    $("mic").onclick = () => toggleRecord(st);
  },
};

function renderChoice(st, listen) {
  const it = st.item;
  const opts = shuffle([it, ...distractors(it, st.pool, 3, "en")]);
  $("lbody").innerHTML = `
    <div class="label">${listen ? "Listen" : "Read"}</div>
    <div class="q">${listen ? "What did you hear?" : "What does this mean?"}</div>
    <div class="center">
      ${listen
        ? `<button class="play" id="p">${ICON_PLAY}</button>${srcTag(it)}`
        : `<div class="lao hero-lao">${esc(it.lao)}</div>${romanHtml(it)}`}
    </div>
    <div class="opts">${opts.map((o, k) => `<button class="opt" data-id="${o.id}"><span class="k">${k + 1}</span>${esc(o.en)}</button>`).join("")}</div>`;
  if (listen) { $("p").onclick = () => playItem(it); setTimeout(() => playItem(it, true), 250); }
  wireOptions();
}

function wireOptions() {
  document.querySelectorAll(".opt").forEach(b => b.onclick = () => {
    if (L.state !== "answering") return;
    document.querySelectorAll(".opt").forEach(x => x.classList.remove("sel"));
    b.classList.add("sel"); setAnswer(b.dataset.id);
    const it = ITEMS.get(b.dataset.id);
    if (L.steps[L.i].type === "pick_lao" && it) playItem(it, true);
  });
}

const CHECK = {
  listen_pick: (st, a) => a === st.item.id,
  read_pick: (st, a) => a === st.item.id,
  pick_lao: (st, a) => a === st.item.id,
  build: (st, a) => a.join(" ").toLowerCase() === st.target.join(" ").toLowerCase(),
};

/* speak: optional recording, scored by local Whisper when server/score.py is serving the page, then self-grade */
let rec = null, recChunks = [], myClip = null, myScore = null, SCORER = false;
fetch("/api/health").then(r => r.ok && r.json()).then(j => { SCORER = !!(j && j.ok); }).catch(() => {});
function scoreHtml(sc) {
  if (!sc) return "";
  if (sc.pending) return `<div class="score pending">Scoring…</div>`;
  if (sc.error) return `<div class="score bad">Couldn't score: ${esc(sc.error)}</div>`;
  const cls = sc.score >= 80 ? "good" : sc.score >= 50 ? "ok" : "bad";
  return `<div class="score ${cls}"><b>${sc.score}</b><span>Heard “${esc((sc.heard || "").replace(/[.!?。]+$/, "") || "nothing")}”. This checks the sounds, not the tones.</span></div>`;
}
function showScore() {
  const html = scoreHtml(myScore);
  ["micScore", "revealScore"].forEach(id => { if ($(id)) $(id).innerHTML = html; });
}
async function scoreClip(blob, it) {
  myScore = { pending: true }; showScore();
  try {
    const r = await fetch(`/api/score?target=${encodeURIComponent(it.lao)}&roman=${encodeURIComponent(it.roman)}`, { method: "POST", body: blob });
    const j = await r.json();
    myScore = r.ok ? j : { error: j.error || `HTTP ${r.status}` };
  } catch (e) {
    myScore = { error: e.message };
  }
  showScore();
}
async function toggleRecord(st) {
  if (rec && rec.state === "recording") { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = []; rec = new MediaRecorder(stream);
    rec.ondataavailable = e => recChunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recChunks, { type: rec.mimeType });
      myClip = URL.createObjectURL(blob);
      $("mic")?.classList.remove("rec");
      if ($("micHint")) $("micHint").textContent = "Recorded. Show the answer to compare.";
      if (SCORER) scoreClip(blob, st.item);
    };
    rec.start(); $("mic").classList.add("rec"); $("micHint").textContent = "Recording… tap to stop";
  } catch (e) {
    toast("Mic not available here (" + e.name + "). Say it out loud and self-check instead.");
  }
}
function speakReveal(st) {
  if (rec && rec.state === "recording") rec.stop();
  const it = st.item;
  const r = $("reveal"); r.style.display = "flex";
  r.innerHTML = `
    <div class="lao hero-lao" style="margin-top:0">${esc(it.lao)}</div>${romanHtml(it)}
    <div class="cmp">
      <div><button class="play sm" id="ref">${ICON_PLAY}</button>reference</div>
      ${myClip ? `<div><button class="play sm" id="mine" style="background:var(--good);box-shadow:0 4px 0 #225a33">${ICON_PLAY}</button>you</div>` : ""}
    </div><div id="revealScore"></div>${srcTag(it)}`;
  $("micScore")?.remove();
  showScore();
  $("ref").onclick = () => playItem(it);
  if ($("mine")) $("mine").onclick = () => new Audio(myClip).play();
  setTimeout(() => playItem(it, true), 150);
  const f = $("lfoot");
  f.innerHTML = '<div class="row2"><button class="cta ghost" id="no">Not yet</button><button class="cta" id="yes">I said it</button></div>';
  $("yes").onclick = () => { myClip = null; myScore = null; L.state = "checked"; renderFooter(st, grade(st, true)); };
  $("no").onclick = () => { myClip = null; myScore = null; L.state = "checked"; renderFooter(st, grade(st, false)); };
}

function renderComplete() {
  const acc = L.graded ? Math.round(L.firstTry / L.base * 100) : 100;
  const xp = 10 + L.firstTry;
  if (!L.demo) {
    S.done[L.lesson.key] = { acc, at: Date.now() };
    S.xp += xp;
  }
  L.missed.forEach(id => { if (!S.mistakes.includes(id)) S.mistakes.push(id); });
  save();
  const missed = L.missed.size;
  $("view").innerHTML = `
    <div class="complete">
      <div class="lao hero-lao">ເກັ່ງຫຼາຍ!</div>
      ${S.roman ? '<div class="hero-roman">geng laai</div>' : ""}
      <div class="hero-en">${L.demo ? "Demo finished" : "Lesson complete"}</div>
      <div class="cards3">
        <div class="c3 xp"><b>+${xp}</b><span>xp</span></div>
        <div class="c3 acc"><b>${Math.min(100, acc)}%</b><span>first try</span></div>
        <div class="c3 mis"><b>${missed}</b><span>to review</span></div>
      </div>
      <div class="small-note">${missed ? "Words you missed went into Review, where spaced repetition brings them back before you forget them." : "No misses. These words will come back in Review on a longer interval."}</div>
    </div>
    <div class="lfoot"><button class="cta" id="cta">Continue</button></div>`;
  $("cta").onclick = () => { L = null; renderShell(); };
}

/* ---------- review tab (spaced repetition over missed + learned words) ---------- */
let R = null;
const INTERVALS = ["<1m", "10m", "2d", "5d"];
function reviewQueue() {
  const learned = allLessons.filter(l => S.done[l.key]).flatMap(l => l.ids);
  return [...new Set([...S.mistakes, ...learned])].map(id => ITEMS.get(id)).filter(Boolean);
}
function renderReview() {
  const q = reviewQueue();
  if (!R) {
    $("view").innerHTML = topStats() + `
      <div class="review-body">
        <div class="label">Spaced repetition</div>
        <div class="q">${q.length ? `${q.length} card${q.length > 1 ? "s" : ""} due` : "Nothing due"}</div>
        ${q.length ? `<div class="queue-list">${q.slice(0, 8).map(it => `<div><span class="lao">${esc(it.lao)}</span><span>${esc(it.en)}${S.mistakes.includes(it.id) ? ' <span style="color:var(--bad)">●</span>' : ""}</span></div>`).join("")}${q.length > 8 ? `<div><span>+ ${q.length - 8} more</span><span></span></div>` : ""}</div>`
          : '<div class="empty">Finish a lesson and its words show up here. Anything you miss comes back first (red dot).</div>'}
      </div>
      ${q.length ? '<div class="lfoot"><button class="cta" id="go">Start review</button></div>' : ""}` + navHtml();
    wireNav();
    $("romanToggle").onclick = () => { S.roman = !S.roman; save(); renderReview(); };
    if ($("go")) $("go").onclick = () => { R = { q: q.slice(0, 10), i: 0, shown: false }; renderReview(); };
    return;
  }
  if (R.i >= R.q.length) { R = null; toast("Review done. Intervals would sync to the scheduler."); return renderReview(); }
  const it = R.q[R.i];
  const listen = R.i % 2 === 0;
  $("view").innerHTML = `
    <div class="lesson-top"><button class="x" id="quit">✕</button><div class="lbar"><div style="width:${R.i / R.q.length * 100}%"></div></div><div class="combo">${R.i + 1}/${R.q.length}</div></div>
    <div class="review-body">
      <div class="label">${listen ? "Listen" : "Speak"}</div>
      ${listen
        ? `<div class="q">What does it mean?</div><button class="play" id="p">${ICON_PLAY}</button>${srcTag(it)}${hasSound(it) ? "" : `<div class="lao hero-lao" style="font-size:34px">${esc(it.lao)}</div>`}`
        : `<div class="q">Say it in Lao</div><div class="hero-en" style="font-size:28px;font-weight:700;margin-top:30px">${esc(it.en)}</div>`}
      ${R.shown ? `<div class="speak-reveal"><div class="lao hero-lao" style="margin-top:0">${esc(it.lao)}</div>${romanHtml(it)}<div class="hero-en">${esc(it.en)}</div></div>` : ""}
    </div>
    <div class="lfoot">${R.shown
      ? `<div class="rates">${["Again", "Hard", "Good", "Easy"].map((n, k) => `<button class="r${k + 1}" data-r="${k}">${n}<small>${INTERVALS[k]}</small></button>`).join("")}</div>`
      : '<button class="cta" id="show">Show answer</button>'}</div>`;
  $("quit").onclick = () => { R = null; renderReview(); };
  if ($("p")) { $("p").onclick = () => playItem(it); if (!R.shown) setTimeout(() => playItem(it, true), 250); }
  if ($("show")) $("show").onclick = () => { R.shown = true; renderReview(); if (!listen) setTimeout(() => playItem(it, true), 150); };
  document.querySelectorAll(".rates button").forEach(b => b.onclick = () => {
    if (+b.dataset.r >= 2) S.mistakes = S.mistakes.filter(id => id !== it.id);
    save(); R.i++; R.shown = false; renderReview();
  });
}

/* ---------- misc wiring ---------- */
function wireSlides() {
  document.querySelectorAll(".slide").forEach(img => img.onclick = () => { $("lbimg").src = img.src; $("lightbox").classList.add("show"); });
}
$("lightbox").onclick = () => $("lightbox").classList.remove("show");

document.addEventListener("keydown", e => {
  if (!L) return;
  const opts = [...document.querySelectorAll(".opt")];
  if (/^[1-4]$/.test(e.key) && opts[+e.key - 1] && L.state === "answering") opts[+e.key - 1].click();
  if (e.key === "Enter") { const c = $("cta") || $("yes"); if (c && !c.disabled) { e.preventDefault(); c.click(); } }
});

/* side panel: demos and stats */
const greet = UNITS[0];
const demoItems = greet.items.slice(0, 6);
const DEMOS = {
  "New word": () => [{ type: "intro", item: greet.items[0] }],
  "Listen and pick": () => [{ type: "listen_pick", item: greet.items.find(hasSound) }],
  "Read and pick": () => [{ type: "read_pick", item: greet.items[3] }],
  "Pick the Lao": () => [{ type: "pick_lao", item: greet.items[5] }],
  "Match pairs": () => [{ type: "match", items: demoItems.slice(0, 5) }],
  "Build (Lao tiles)": () => [{ type: "build", item: greet.items.find(i => i.tiles) }],
  "Build (romanized)": () => [{ type: "build", item: greet.items.find(i => !i.tiles && romanWords(i).length >= 2) || UNITS[1].items.find(i => romanWords(i).length >= 2) }],
  "Speak": () => [{ type: "speak", item: greet.items.find(hasSound) }],
};
$("demos").innerHTML = Object.keys(DEMOS).map(k => `<button data-d="${k}">${k}</button>`).join("");
$("demos").onclick = e => {
  const d = e.target.dataset.d; if (!d) return;
  const steps = DEMOS[d]().filter(s => s.item || s.items);
  steps.forEach(s => s.pool = greet.items);
  R = null;
  startLesson({ unit: greet, ids: [], key: "demo" }, steps);
};
$("unlock").onclick = () => { S.unlockAll = !S.unlockAll; save(); $("unlock").textContent = S.unlockAll ? "Lock ahead lessons" : "Unlock all lessons"; L = null; renderShell(); };
$("unlock").textContent = S.unlockAll ? "Lock ahead lessons" : "Unlock all lessons";
$("reset").onclick = () => { S = fresh(); save(); L = null; R = null; tab = "learn"; renderShell(); toast("Progress reset."); };

const all = UNITS.flatMap(u => u.items);
$("nums").innerHTML = [
  [UNITS.length, "units"], [allLessons.length, "lessons"], [all.length, "words + phrases"], [all.filter(hasSound).length, "native clips"],
].map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join("");

speechSynthesis.getVoices();
renderShell();
