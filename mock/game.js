/* Play tab: cross the river by hopping onto the lily pad with the right Lao word. */
(() => {
  const ROWS = 5, PADS = 3, BANK_H = 58, PAD_W = 104, PAD_H = 54, FROG_W = 46, FROG_H = 40;
  const BEST_KEY = "vao.mock.best";
  const FROG = `<svg viewBox="0 0 64 56" width="${FROG_W}" height="${FROG_H}">
    <ellipse cx="32" cy="36" rx="25" ry="17" fill="#3f9a4f"/>
    <ellipse cx="32" cy="40" rx="16" ry="10" fill="#8fd19e"/>
    <circle cx="19" cy="17" r="10" fill="#3f9a4f"/><circle cx="45" cy="17" r="10" fill="#3f9a4f"/>
    <circle cx="19" cy="16" r="6" fill="#fff"/><circle cx="45" cy="16" r="6" fill="#fff"/>
    <circle cx="20" cy="17" r="3" fill="#14213a"/><circle cx="44" cy="17" r="3" fill="#14213a"/>
    <path d="M23 33 Q32 40 41 33" stroke="#14213a" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="16" cy="32" r="3" fill="#f2a7a7" opacity=".7"/><circle cx="48" cy="32" r="3" fill="#f2a7a7" opacity=".7"/>
  </svg>`;
  const STUPA = `<svg viewBox="0 0 120 60" width="96" height="48">
    <rect x="18" y="46" width="84" height="10" rx="2" fill="#d29b2a"/>
    <rect x="30" y="38" width="60" height="9" rx="2" fill="#e0ae3e"/>
    <path d="M40 38 Q60 6 80 38 Z" fill="#e8bd52"/>
    <rect x="57" y="4" width="6" height="16" rx="3" fill="#d29b2a"/>
  </svg>`;

  let G = null, raf = 0;

  window.stopGame = () => {
    cancelAnimationFrame(raf); raf = 0;
    if (G) clearTimeout(G.timer);
    G = null;
  };

  function gamePool() {
    const learned = allLessons.filter(l => S.done[l.key]).flatMap(l => l.ids).map(id => ITEMS.get(id));
    const base = learned.length >= 10 ? learned : [...learned, ...UNITS[0].items, ...UNITS[1].items, ...UNITS[6].items];
    return [...new Map(base.map(i => [i.id, i])).values()]
      .filter(i => i.lao.length <= 10 && !/[\/_…]/.test(i.lao));
  }

  window.renderGame = function () {
    stopGame();
    const best = +localStorage.getItem(BEST_KEY) || 0;
    const pool = gamePool();
    $("view").innerHTML = topStats() + `
      <div class="game-intro">
        <div class="gi-art">${STUPA}<div class="gi-water"></div><div class="gi-frog">${FROG}</div></div>
        <div class="label">Play</div>
        <div class="q">Cross the Mekong</div>
        <p>Hop onto the lily pad with the right Lao word. Wrong pads sink, the clock is ticking, and don't ride a pad off the edge.</p>
        <div class="gi-stats"><div><b>${pool.length}</b><span>words in play</span></div><div><b>${best}</b><span>best score</span></div></div>
        <p class="gi-note">Uses words from lessons you've finished, topped up from the first units.</p>
      </div>
      <div class="lfoot"><button class="cta" id="startGame">Play</button></div>` + navHtml();
    wireNav();
    $("romanToggle").onclick = () => { S.roman = !S.roman; save(); renderGame(); };
    $("startGame").onclick = startGame;
  };

  function startGame() {
    $("view").innerHTML = `
      <div class="hud">
        <button class="x" id="gquit" title="Quit">✕</button>
        <div class="hearts" id="hearts"></div>
        <div class="gscore"><span id="level">Lv 1</span><b id="score">0</b></div>
      </div>
      <div class="gprompt" id="gprompt"></div>
      <div class="tbar"><div id="tfill"></div></div>
      <div class="game" id="game">
        <div class="shore top">${STUPA}</div>
        <div class="river"></div>
        <div class="shore bottom"></div>
        <div class="frog" id="frog">${FROG}</div>
        <div class="gtoast" id="gtoast"></div>
      </div>`;
    const game = $("game");
    const W = game.clientWidth, H = game.clientHeight;
    const rowH = (H - 2 * BANK_H) / ROWS;
    const rows = [];
    for (let r = 1; r <= ROWS; r++) {
      const top = H - BANK_H - r * rowH;
      const band = document.createElement("div");
      band.className = "lane"; band.style.top = top + "px"; band.style.height = rowH + "px";
      game.insertBefore(band, $("frog"));
      const pads = [];
      for (let i = 0; i < PADS; i++) {
        const el = document.createElement("button");
        el.className = "pad"; el.dataset.row = r; el.dataset.i = i;
        el.style.top = (top + (rowH - PAD_H) / 2) + "px";
        game.insertBefore(el, $("frog"));
        pads.push({ el, item: null, x: 0 });
      }
      rows[r] = { top, band, pads, dir: r % 2 ? 1 : -1, offset: Math.random() * 400 };
    }
    G = {
      W, H, rowH, rows, pool: gamePool(), row: 0, pad: -1, bankX: (W - FROG_W) / 2,
      hearts: 3, score: 0, level: 1, combo: 0, target: null, lock: false, deadline: 0, last: performance.now(),
      missed: new Set(), listen: false,
    };
    $("gquit").onclick = () => { stopGame(); renderGame(); };
    game.addEventListener("click", e => { const p = e.target.closest(".pad"); if (p) hop(+p.dataset.row, +p.dataset.i); });
    drawHud();
    nextPrompt();
    raf = requestAnimationFrame(loop);
  }

  const speed = () => 18 + G.level * 9;
  const timeLimit = () => Math.max(3.5, 8 - G.level * 0.8) * 1000;
  const span = () => G.W + PAD_W;

  function padX(row, i) {
    const s = span();
    return ((row.offset + i * s / PADS) % s + s) % s - PAD_W;
  }

  function nextPrompt() {
    const r = G.row + 1;
    G.rows.forEach((row, k) => row && row.pads.forEach(p => { p.item = null; p.el.className = "pad" + (k === r ? " active" : ""); p.el.innerHTML = ""; delete p.el.dataset.id; }));
    G.rows.forEach((row, k) => row && row.band.classList.toggle("active", k === r));
    const target = G.pool[Math.floor(Math.random() * G.pool.length)];
    const opts = shuffle([target, ...distractors(target, G.pool, PADS - 1, "lao")]);
    G.rows[r].pads.forEach((p, i) => {
      p.item = opts[i]; p.el.dataset.id = opts[i].id;
      p.el.innerHTML = `<span class="lao">${esc(opts[i].lao)}</span>${S.roman ? `<small>${esc(opts[i].roman)}</small>` : ""}`;
    });
    G.target = target; $("gprompt").dataset.id = target.id;
    G.listen = !!target.audio && Math.random() < 0.5;
    $("gprompt").innerHTML = G.listen
      ? `<span>Hop to what you hear</span><button class="play sm" id="gplay">${ICON_PLAY}</button>`
      : `<span>Hop to</span><b>“${esc(target.en)}”</b>`;
    if (G.listen) { $("gplay").onclick = () => playItem(target); setTimeout(() => G && playItem(target, true), 200); }
    G.deadline = performance.now() + timeLimit();
  }

  function hop(r, i) {
    if (!G || G.lock || G.over) return;
    if (r !== G.row + 1) return gtoast(r <= G.row ? "Keep going forward" : "One row at a time");
    const p = G.rows[r].pads[i];
    if (p.item && p.item.id === G.target.id) {
      G.combo++;
      G.score += 10 * (1 + Math.floor(G.combo / 3));
      G.row = r; G.pad = i;
      bounce();
      if (!G.listen) playItem(p.item, true);
      if (G.combo >= 3 && G.combo % 3 === 0) gtoast(`${G.combo} in a row! x${1 + Math.floor(G.combo / 3)}`);
      drawHud();
      if (r === ROWS) return cross();
      nextPrompt();
    } else {
      p.el.classList.add("sink");
      miss("Not that one");
    }
  }

  function miss(msg) {
    G.combo = 0; G.hearts--; G.missed.add(G.target.id);
    G.rows[G.row + 1].pads.forEach(p => { if (p.item && p.item.id === G.target.id) p.el.classList.add("reveal"); });
    gtoast(`${msg}: ${G.target.lao} = ${G.target.en}`);
    drawHud();
    if (G.hearts <= 0) return gameOver();
    G.lock = true;
    G.timer = setTimeout(() => { if (!G) return; G.lock = false; nextPrompt(); }, 1300);
  }

  function splash() {
    const f = $("frog");
    f.classList.add("splash");
    G.combo = 0; G.hearts--; G.lock = true;
    gtoast("Splash! Don't ride off the edge");
    drawHud();
    if (G.hearts <= 0) return gameOver();
    G.timer = setTimeout(() => { if (!G) return; f.classList.remove("splash"); G.row = 0; G.pad = -1; G.lock = false; nextPrompt(); }, 900);
  }

  function cross() {
    G.lock = true;
    G.timer = setTimeout(() => {
      if (!G) return;
      G.row = ROWS + 1; G.pad = -1; G.bankX = (G.W - FROG_W) / 2;
      G.score += 50 * G.level;
      gtoast(`Crossed! +${50 * G.level}. Level ${G.level + 1}, the river speeds up`);
      G.level++;
      drawHud();
      G.timer = setTimeout(() => { if (!G) return; G.row = 0; G.lock = false; nextPrompt(); }, 1200);
    }, 350);
  }

  function gameOver() {
    G.over = true; G.lock = true;
    const best = Math.max(G.score, +localStorage.getItem(BEST_KEY) || 0);
    localStorage.setItem(BEST_KEY, best);
    G.missed.forEach(id => { if (!S.mistakes.includes(id)) S.mistakes.push(id); });
    save();
    const missed = [...G.missed].map(id => ITEMS.get(id));
    const o = document.createElement("div");
    o.className = "gover";
    o.innerHTML = `
      <div class="lao hero-lao" style="margin:0">ຈົບເກມ</div>
      <div class="hero-roman">jop gem · game over</div>
      <div class="cards3" style="margin-top:14px">
        <div class="c3 xp"><b>${G.score}</b><span>score</span></div>
        <div class="c3 acc"><b>${G.level}</b><span>level</span></div>
        <div class="c3"><b>${best}</b><span>best</span></div>
      </div>
      ${missed.length ? `<div class="gmissed"><div class="label" style="margin-bottom:6px">Sent to Review</div>${missed.map(it => `<div><span class="lao">${esc(it.lao)}</span><span>${esc(it.en)}</span></div>`).join("")}</div>` : ""}
      <div class="row2" style="width:100%;margin-top:16px"><button class="cta ghost" id="gback">Back</button><button class="cta" id="gagain">Play again</button></div>`;
    $("game").appendChild(o);
    $("gback").onclick = () => { stopGame(); renderGame(); };
    $("gagain").onclick = () => { stopGame(); startGame(); };
  }

  function bounce() {
    const f = $("frog"); f.classList.remove("hop"); void f.offsetWidth; f.classList.add("hop");
  }

  function drawHud() {
    $("hearts").innerHTML = [0, 1, 2].map(k => `<span class="${k < G.hearts ? "" : "lost"}">♥</span>`).join("");
    $("score").textContent = G.score;
    $("level").textContent = "Lv " + G.level;
  }

  function gtoast(msg) {
    const t = $("gtoast"); if (!t) return;
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1500);
  }

  function loop(now) {
    if (!G) return;
    const dt = Math.min(50, now - G.last) / 1000; G.last = now;
    if (!G.over) {
      for (let r = 1; r <= ROWS; r++) {
        const row = G.rows[r];
        row.offset += row.dir * speed() * dt;
        row.pads.forEach((p, i) => { p.x = padX(row, i); p.el.style.transform = `translateX(${p.x}px)`; });
      }
      const f = $("frog");
      let x, y;
      if (G.row >= 1 && G.row <= ROWS && G.pad >= 0) {
        const p = G.rows[G.row].pads[G.pad];
        x = p.x + (PAD_W - FROG_W) / 2;
        y = G.rows[G.row].top + (G.rowH - FROG_H) / 2 - 4;
        const cx = x + FROG_W / 2;
        if (!G.lock && (cx < 4 || cx > G.W - 4)) splash();
      } else {
        x = G.bankX;
        y = G.row > ROWS ? (BANK_H - FROG_H) / 2 : G.H - BANK_H + (BANK_H - FROG_H) / 2;
      }
      f.style.left = x + "px"; f.style.top = y + "px";
      if (!G.lock) {
        const left = G.deadline - now;
        $("tfill").style.width = Math.max(0, left / timeLimit() * 100) + "%";
        $("tfill").classList.toggle("low", left < 1500);
        if (left <= 0) miss("Too slow");
      }
    }
    raf = requestAnimationFrame(loop);
  }

  document.addEventListener("keydown", e => {
    if (!G || G.lock || !/^[1-3]$/.test(e.key)) return;
    const r = G.rows[G.row + 1];
    if (!r) return;
    const order = r.pads.map((p, i) => ({ i, x: p.x })).sort((a, b) => a.x - b.x);
    hop(G.row + 1, order[+e.key - 1].i);
  });
})();
