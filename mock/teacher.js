const UNITS = window.VAO_UNITS;
const recorded = { ...(window.VAO_TEACHER || {}) };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SRC_LABEL = { native: "native recording", tts: "synthetic voice" };

$("unit").innerHTML = UNITS.map((u, i) => `<option value="${i}">${esc(`${u.level} · ${u.title}`)}</option>`).join("");

let rec = null, recKey = null, player = null, offline = false;

function audioFor(it) {
  if (recorded[it.key]) return { url: `media/teacher/${it.key}.mp3?v=${recorded[it.key]}`, label: "your recording", cls: "teacher" };
  if (it.audio) return { url: `media/${it.audio}`, label: SRC_LABEL[it.audio_src] || "recording", cls: "" };
  return null;
}

function countText() {
  const keys = new Set(UNITS.flatMap(u => u.items.map(it => it.key)));
  const done = [...keys].filter(k => recorded[k]).length;
  return `${done} of ${keys.size} phrases recorded`;
}

function render() {
  const u = UNITS[+$("unit").value];
  const items = u.items.filter(it => !$("only").checked || !recorded[it.key]);
  $("count").textContent = countText();
  $("list").innerHTML = items.length ? items.map(it => {
    const a = audioFor(it);
    const recording = recKey === it.key;
    return `<div class="row" data-key="${it.key}">
      <div>
        <div class="lao">${esc(it.lao)}</div>
        <div class="meta"><b>${esc(it.roman)}</b> · ${esc(it.en)}</div>
        <span class="src ${a ? a.cls : ""}">${a ? a.label : "no audio yet"}</span>
        <div class="err" hidden></div>
      </div>
      <div class="actions">
        <button data-act="play" ${a ? "" : "disabled"}>Play</button>
        <button class="rec ${recording ? "on" : ""}" data-act="rec" ${offline || (recKey && !recording) ? "disabled" : ""}>${recording ? "Stop" : recorded[it.key] ? "Record again" : "Record"}</button>
        ${recorded[it.key] ? `<button data-act="del" ${offline ? "disabled" : ""}>Remove</button>` : ""}
      </div>
    </div>`;
  }).join("") : `<p class="intro">Every phrase in this unit has your recording.</p>`;
}

function rowError(key, msg) {
  const el = document.querySelector(`.row[data-key="${key}"] .err`);
  if (el) { el.textContent = msg; el.hidden = !msg; }
}

async function startRecording(key) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    rowError(key, `The microphone isn't available (${e.name}). Allow it in the browser and try again.`);
    return;
  }
  const chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType });
    rec = null; recKey = null; render();
    await save(key, blob);
  };
  recKey = key; rec.start(); render();
}

async function save(key, blob) {
  try {
    const r = await fetch(`/api/teacher?key=${key}`, { method: "POST", body: blob });
    const j = await r.json();
    if (!r.ok) { render(); rowError(key, j.error || `Saving failed (HTTP ${r.status}).`); return; }
    recorded[key] = j.v; render();
    play(`media/teacher/${key}.mp3?v=${j.v}`);
  } catch (e) {
    render(); rowError(key, `Saving failed: ${e.message}`);
  }
}

async function remove(key) {
  const r = await fetch(`/api/teacher?key=${key}`, { method: "DELETE" });
  if (!r.ok) { rowError(key, (await r.json()).error || `Removing failed (HTTP ${r.status}).`); return; }
  delete recorded[key]; render();
}

function play(url) {
  if (player) player.pause();
  player = new Audio(url); player.play();
}

$("list").onclick = e => {
  const btn = e.target.closest("button"); if (!btn) return;
  const key = btn.closest(".row").dataset.key;
  const it = UNITS.flatMap(u => u.items).find(i => i.key === key);
  if (btn.dataset.act === "play") play(audioFor(it).url);
  if (btn.dataset.act === "rec") recKey === key ? rec.stop() : startRecording(key);
  if (btn.dataset.act === "del") remove(key);
};
$("unit").onchange = render;
$("only").onchange = render;

fetch("/api/health").then(r => { if (!r.ok) throw new Error(r.status); }).catch(() => {
  offline = true; $("offline").hidden = false; render();
});
render();
