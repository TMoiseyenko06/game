/* CIPHER — a deduction console
   Pure JS, no deps. Persistence via localStorage.
   ------------------------------------------------- */
(() => {
  "use strict";

  // ── Symbol catalogue ──────────────────────────────
  const SYMBOLS = [
    { glyph: "◆", color: "#ef4444", name: "ruby" },
    { glyph: "▲", color: "#f97316", name: "amber" },
    { glyph: "●", color: "#eab308", name: "sol"   },
    { glyph: "■", color: "#22c55e", name: "jade"  },
    { glyph: "★", color: "#14b8a6", name: "mint"  },
    { glyph: "⬢", color: "#3b82f6", name: "azure" },
    { glyph: "✦", color: "#8b5cf6", name: "amethyst" },
    { glyph: "♦", color: "#ec4899", name: "rose"  },
    { glyph: "◉", color: "#e5e7eb", name: "ivory" },
    { glyph: "▼", color: "#94a3b8", name: "slate" },
  ];

  // ── Tiers (progressive difficulty) ────────────────
  // Unlocks next tier after solving `advance` codes at current tier.
  const TIERS = [
    { roman: "I",   slots: 4, palette: 6,  guesses: 10, advance: 2 },
    { roman: "II",  slots: 4, palette: 8,  guesses: 10, advance: 3 },
    { roman: "III", slots: 5, palette: 8,  guesses: 12, advance: 3 },
    { roman: "IV",  slots: 5, palette: 10, guesses: 12, advance: 4 },
    { roman: "V",   slots: 6, palette: 10, guesses: 14, advance: Infinity },
  ];

  // ── State ─────────────────────────────────────────
  const SAVE_KEY = "cipher.save.v1";
  const defaultSave = () => ({
    tier: 0,
    solved: 0,
    streak: 0,
    bestStreak: 0,
    insight: 2,
    clearedAtTier: 0, // progress within current tier
    mode: "classic", // classic | strict
    muted: false,
    stats: { attempts: [], fastest: null, abandons: 0 },
  });

  let save = loadSave();
  let game = newRound();

  // ── DOM refs ──────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const boardEl = $("board");
  const stageEl = $("stage");
  const paletteEl = $("palette");
  const briefEl = $("brief");
  const attemptsEl = $("attempts");
  const hintLine = $("hint-line");
  const submitBtn = $("submit");
  const clearBtn = $("clear");
  const insightBtn = $("insight");
  const surrenderBtn = $("surrender");
  const modalRoot = $("modal-root");
  const toastEl = $("toast");

  // ── Audio (Web Audio synthesis; no asset files) ───
  const Audio = (() => {
    let ctx = null;
    const ensure = () => {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    };
    const tone = (freq, dur = 0.12, type = "sine", vol = 0.12, attack = 0.005, release = 0.08) => {
      if (save.muted) return;
      const ac = ensure();
      const now = ac.currentTime;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(vol, now + attack);
      gain.gain.linearRampToValueAtTime(0, now + dur + release);
      osc.connect(gain).connect(ac.destination);
      osc.start(now);
      osc.stop(now + dur + release + 0.02);
    };
    const chord = (freqs, dur = 0.18, type = "triangle", vol = 0.1) => {
      freqs.forEach(f => tone(f, dur, type, vol));
    };
    return {
      click: () => tone(540, 0.04, "square", 0.05),
      pick:  () => tone(720, 0.05, "triangle", 0.06),
      erase: () => tone(260, 0.06, "square", 0.05),
      submit: () => chord([440, 660], 0.15, "triangle", 0.06),
      exact: (n) => { for (let i = 0; i < n; i++) setTimeout(() => tone(880 + i * 80, 0.06, "sine", 0.06), i * 70); },
      present: (n) => { for (let i = 0; i < n; i++) setTimeout(() => tone(520 + i * 40, 0.05, "triangle", 0.04), i * 80 + 200); },
      win: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.22, "triangle", 0.1), i * 120)); },
      lose: () => { [440, 330, 220].forEach((f, i) => setTimeout(() => tone(f, 0.3, "sawtooth", 0.08), i * 160)); },
      insight: () => { [660, 880, 1100].forEach((f, i) => setTimeout(() => tone(f, 0.08, "sine", 0.07), i * 50)); },
      levelup: () => { [523, 659, 784, 988, 1175].forEach((f, i) => setTimeout(() => tone(f, 0.18, "triangle", 0.09), i * 90)); },
    };
  })();

  // ── Persistence ───────────────────────────────────
  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return defaultSave();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultSave(), parsed);
    } catch { return defaultSave(); }
  }
  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch {}
  }

  // ── Round / game logic ────────────────────────────
  function tier() { return TIERS[save.tier]; }

  function newRound() {
    const t = TIERS[save.tier];
    const secret = [];
    for (let i = 0; i < t.slots; i++) {
      secret.push(Math.floor(Math.random() * t.palette));
    }
    return {
      secret,
      guesses: [],
      current: Array(t.slots).fill(null),
      activeIdx: 0,
      over: false,
      won: false,
      hintsUsed: 0,
      revealed: Array(t.slots).fill(false), // for insight reveals
    };
  }

  function computeFeedback(guess, code) {
    let exact = 0;
    const cUsed = Array(code.length).fill(false);
    const gUsed = Array(guess.length).fill(false);
    const perSlot = Array(guess.length).fill("wrong");
    for (let i = 0; i < guess.length; i++) {
      if (guess[i] === code[i]) {
        exact++; cUsed[i] = true; gUsed[i] = true;
        perSlot[i] = "exact";
      }
    }
    let present = 0;
    for (let i = 0; i < guess.length; i++) {
      if (gUsed[i]) continue;
      for (let j = 0; j < code.length; j++) {
        if (cUsed[j]) continue;
        if (guess[i] === code[j]) {
          present++; cUsed[j] = true; gUsed[i] = true;
          perSlot[i] = "present";
          break;
        }
      }
    }
    return { exact, present, perSlot };
  }

  function submitGuess() {
    if (game.over) return;
    const t = tier();
    if (game.current.some(v => v === null)) {
      toast("all slots must be filled");
      return;
    }
    const guess = [...game.current];
    const fb = computeFeedback(guess, game.secret);
    game.guesses.push({ guess, fb });
    Audio.submit();
    setTimeout(() => {
      if (fb.exact > 0) Audio.exact(fb.exact);
      if (fb.present > 0) Audio.present(fb.present);
    }, 100);

    const remaining = t.guesses - game.guesses.length;
    if (fb.exact === t.slots) {
      game.over = true; game.won = true;
      onWin(game.guesses.length);
    } else if (remaining <= 0) {
      game.over = true; game.won = false;
      onLose();
    } else {
      // Reset current guess for next attempt
      game.current = Array(t.slots).fill(null);
      game.activeIdx = 0;
    }
    render();
  }

  function onWin(attempts) {
    const t = tier();
    save.solved += 1;
    save.streak += 1;
    save.bestStreak = Math.max(save.bestStreak, save.streak);
    save.clearedAtTier += 1;
    save.stats.attempts.push(attempts);
    if (save.stats.fastest === null || attempts < save.stats.fastest) save.stats.fastest = attempts;

    // Reward insight for efficient solves
    const par = Math.ceil(t.guesses * 0.6);
    let earned = 0;
    if (attempts <= Math.ceil(t.guesses * 0.3)) earned = 3;
    else if (attempts <= par) earned = 2;
    else if (attempts < t.guesses) earned = 1;
    save.insight += earned;

    let advanced = false;
    if (save.clearedAtTier >= t.advance && save.tier < TIERS.length - 1) {
      save.tier += 1;
      save.clearedAtTier = 0;
      advanced = true;
      Audio.levelup();
    } else {
      Audio.win();
    }

    persist();
    showWinModal(attempts, earned, advanced);
  }

  function onLose() {
    save.streak = 0;
    save.stats.abandons += 0; // keep separate
    persist();
    Audio.lose();
    showLoseModal();
  }

  function setSlot(idx, sym) {
    if (game.over) return;
    game.current[idx] = sym;
    // advance to next empty slot
    const t = tier();
    let next = (idx + 1) % t.slots;
    for (let i = 0; i < t.slots; i++) {
      if (game.current[next] === null && !game.revealed[next]) break;
      next = (next + 1) % t.slots;
    }
    game.activeIdx = next;
    Audio.pick();
    render();
  }

  function clearCurrent() {
    const t = tier();
    // keep any insight-locked reveals
    for (let i = 0; i < t.slots; i++) {
      if (!game.revealed[i]) game.current[i] = null;
    }
    game.activeIdx = game.current.findIndex(v => v === null);
    if (game.activeIdx < 0) game.activeIdx = 0;
    Audio.erase();
    render();
  }

  function useInsight() {
    if (game.over) return;
    if (save.insight <= 0) { toast("no insight available — solve efficiently to earn"); return; }
    const t = tier();
    const unrevealed = [];
    for (let i = 0; i < t.slots; i++) if (!game.revealed[i]) unrevealed.push(i);
    if (unrevealed.length === 0) { toast("all slots already revealed"); return; }
    const idx = unrevealed[Math.floor(Math.random() * unrevealed.length)];
    save.insight -= 1;
    game.hintsUsed += 1;
    game.revealed[idx] = true;
    game.current[idx] = game.secret[idx];
    Audio.insight();
    persist();
    toast(`insight: slot ${idx + 1} = ${SYMBOLS[game.secret[idx]].name}`);
    render();
  }

  function surrender() {
    if (game.over) return;
    openModal({
      title: "ABANDON CODE",
      sub: "// this resets your streak",
      body: `<p>You'll see the solution and start a fresh code at the same tier.</p>`,
      actions: [
        { label: "cancel", action: closeModal },
        { label: "abandon", danger: true, action: () => {
          closeModal();
          game.over = true;
          save.streak = 0;
          save.stats.abandons += 1;
          persist();
          Audio.lose();
          showLoseModal(true);
        } },
      ],
    });
  }

  function nextRound() {
    game = newRound();
    render();
  }

  // ── Render ────────────────────────────────────────
  function pegEl(symIdx, { small = false, empty = false, slot = null, kbHint = null } = {}) {
    const el = document.createElement("div");
    el.className = "peg" + (small ? " small" : "") + (empty ? " empty" : "");
    if (slot) el.classList.add(`slot-${slot}`);
    if (symIdx === null || symIdx === undefined) {
      el.textContent = "·";
    } else {
      const s = SYMBOLS[symIdx];
      el.dataset.sym = symIdx;
      el.style.setProperty("--sym-color", s.color);
      el.textContent = s.glyph;
      el.setAttribute("aria-label", s.name);
    }
    if (kbHint !== null) {
      const k = document.createElement("span");
      k.className = "kb";
      k.textContent = kbHint;
      el.appendChild(k);
    }
    return el;
  }

  function renderHUD() {
    const t = tier();
    $("meta-tier").textContent = t.roman;
    $("meta-solved").textContent = save.solved;
    $("meta-streak").textContent = save.streak;
    $("meta-insight").textContent = save.insight;
    briefEl.textContent = `TIER ${t.roman} · ${t.slots} SLOTS · ${t.palette} SYMBOLS`;
    const left = t.guesses - game.guesses.length;
    attemptsEl.textContent = `attempts ${game.guesses.length}/${t.guesses}  ·  ${left} left`;
    insightBtn.disabled = save.insight <= 0 || game.over;
    submitBtn.disabled = game.over;

    // Hint line context
    const progressNote = save.clearedAtTier < t.advance && t.advance !== Infinity
      ? `  ·  ${t.advance - save.clearedAtTier} more to tier ${TIERS[save.tier + 1]?.roman ?? "∞"}`
      : "";
    hintLine.textContent = `// ${game.over ? "round complete" : "pick symbols, then lock"}${progressNote}`;

    document.querySelectorAll(".mode-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === save.mode);
    });
  }

  function renderBoard() {
    boardEl.innerHTML = "";
    const t = tier();
    if (game.guesses.length === 0) {
      const blank = document.createElement("div");
      blank.className = "row";
      blank.innerHTML = `<div class="row-index">—</div><div class="row-pegs" style="color:var(--ink-faint); font-size:12px; letter-spacing:2px">NO GUESSES YET · LOCK YOUR FIRST TO RECEIVE FEEDBACK</div>`;
      boardEl.appendChild(blank);
    }
    game.guesses.forEach((g, i) => {
      const row = document.createElement("div");
      row.className = "row";
      const idx = document.createElement("div");
      idx.className = "row-index";
      idx.textContent = String(i + 1).padStart(2, "0");
      row.appendChild(idx);

      const pegs = document.createElement("div");
      pegs.className = "row-pegs";
      g.guess.forEach((sym, j) => {
        const slotStatus = save.mode === "strict" ? g.fb.perSlot[j] : null;
        pegs.appendChild(pegEl(sym, { small: true, slot: slotStatus }));
      });
      row.appendChild(pegs);

      const fb = document.createElement("div");
      fb.className = "row-fb";
      if (save.mode === "classic") {
        // dots summary
        const dots = document.createElement("div");
        dots.className = "fb-dots";
        for (let k = 0; k < g.fb.exact; k++) {
          const d = document.createElement("span"); d.className = "fb-dot exact"; dots.appendChild(d);
        }
        for (let k = 0; k < g.fb.present; k++) {
          const d = document.createElement("span"); d.className = "fb-dot present"; dots.appendChild(d);
        }
        const empty = t.slots - g.fb.exact - g.fb.present;
        for (let k = 0; k < empty; k++) {
          const d = document.createElement("span"); d.className = "fb-dot"; dots.appendChild(d);
        }
        fb.appendChild(dots);
        const ex = document.createElement("span");
        ex.className = "fb-exact";
        ex.innerHTML = `exact <strong>${g.fb.exact}</strong>`;
        const pr = document.createElement("span");
        pr.className = "fb-present";
        pr.innerHTML = `present <strong>${g.fb.present}</strong>`;
        fb.appendChild(ex); fb.appendChild(pr);
      } else {
        const note = document.createElement("span");
        note.className = "fb-exact";
        note.textContent = `per-slot marks below`;
        fb.appendChild(note);
      }
      row.appendChild(fb);
      boardEl.appendChild(row);
    });
    boardEl.scrollTop = boardEl.scrollHeight;
  }

  function renderStage() {
    stageEl.innerHTML = "";
    const t = tier();
    for (let i = 0; i < t.slots; i++) {
      const v = game.current[i];
      const isActive = i === game.activeIdx && !game.over;
      const p = pegEl(v, { empty: v === null });
      if (isActive) p.classList.add("active");
      if (game.revealed[i]) {
        p.title = "locked by insight";
        p.style.outline = "1px dashed " + "#fbbf24";
      }
      p.addEventListener("click", () => {
        if (game.revealed[i] || game.over) return;
        game.current[i] = null;
        game.activeIdx = i;
        Audio.erase();
        render();
      });
      stageEl.appendChild(p);
    }
  }

  function renderPalette() {
    paletteEl.innerHTML = "";
    const t = tier();
    paletteEl.style.gridTemplateColumns = `repeat(${Math.min(5, t.palette)}, 1fr)`;
    for (let i = 0; i < t.palette; i++) {
      const p = pegEl(i, { kbHint: ((i + 1) % 10).toString() });
      p.addEventListener("click", () => {
        // find next open slot (respecting reveals)
        let idx = game.activeIdx;
        if (game.current[idx] !== null || game.revealed[idx]) {
          idx = game.current.findIndex((v, k) => v === null && !game.revealed[k]);
        }
        if (idx < 0) return;
        setSlot(idx, i);
      });
      paletteEl.appendChild(p);
    }
  }

  function render() {
    renderHUD();
    renderBoard();
    renderStage();
    renderPalette();
  }

  // ── Modals ────────────────────────────────────────
  let modalSticky = false;
  function openModal({ title, sub, body, actions = [], sticky = false }) {
    modalSticky = sticky;
    modalRoot.hidden = false;
    modalRoot.innerHTML = "";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `
      <h2>${title}</h2>
      <div class="sub">${sub || ""}</div>
      <div class="body">${body || ""}</div>
      <div class="modal-actions"></div>
    `;
    const acts = modal.querySelector(".modal-actions");
    actions.forEach(a => {
      const b = document.createElement("button");
      b.className = "ctl" + (a.primary ? " ctl-primary" : "") + (a.danger ? " ctl-danger" : "");
      b.textContent = a.label;
      b.addEventListener("click", a.action);
      acts.appendChild(b);
    });
    modalRoot.appendChild(modal);
  }
  function closeModal() {
    modalSticky = false;
    modalRoot.hidden = true;
    modalRoot.innerHTML = "";
  }

  function revealRow(code) {
    return `<div class="reveal">${code.map(i => {
      const s = SYMBOLS[i];
      return `<div class="peg" data-sym="${i}" style="--sym-color:${s.color}">${s.glyph}</div>`;
    }).join("")}</div>`;
  }

  function showWinModal(attempts, earned, advanced) {
    const t = tier();
    openModal({
      title: advanced ? "TIER CLEARED" : "CODE CRACKED",
      sub: advanced ? `// advancing to tier ${TIERS[save.tier].roman}` : `// solved in ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      body: `
        ${revealRow(game.secret)}
        <div class="row-result"><span>attempts</span><span>${attempts} / ${TIERS[save.tier - (advanced ? 1 : 0)].guesses}</span></div>
        <div class="row-result"><span>insight earned</span><span>+${earned}</span></div>
        <div class="row-result"><span>streak</span><span>${save.streak} (best ${save.bestStreak})</span></div>
        ${advanced ? `<p style="margin-top:10px; color:var(--accent); letter-spacing:2px;">→ tier ${TIERS[save.tier].roman}: ${TIERS[save.tier].slots} slots, ${TIERS[save.tier].palette} symbols</p>` : ""}
      `,
      sticky: true,
      actions: [
        { label: "next code", primary: true, action: () => { closeModal(); nextRound(); } },
      ],
    });
  }

  function showLoseModal(abandoned = false) {
    openModal({
      title: abandoned ? "CODE ABANDONED" : "TRANSMISSION LOST",
      sub: "// the code was…",
      body: `
        ${revealRow(game.secret)}
        <div class="row-result"><span>streak</span><span>reset to 0</span></div>
        <p style="color:var(--ink-faint); margin-top:10px; font-size:12px;">
          Tip: use <kbd>INSIGHT</kbd> tokens to reveal one slot on tough codes.
        </p>
      `,
      sticky: true,
      actions: [
        { label: "retry tier", primary: true, action: () => { closeModal(); nextRound(); } },
      ],
    });
  }

  function showHowTo() {
    openModal({
      title: "HOW TO PLAY",
      sub: "// deduce the hidden code",
      body: `
        <p>Each round the console generates a hidden <strong>code</strong> of symbols. You have a limited number of <strong>guesses</strong> to break it.</p>
        <p>After each locked guess, feedback is returned:</p>
        <ul>
          <li><span style="color:var(--ok)">●</span> <strong>exact</strong>: a symbol is in the correct slot</li>
          <li><span style="color:var(--warn)">●</span> <strong>present</strong>: the symbol exists but is in the wrong slot</li>
          <li><span style="color:var(--ink-faint)">●</span> <strong>absent</strong>: not in the code at all</li>
        </ul>
        <p>Duplicates allowed in the code. Feedback pairs each guess peg with at most one code peg — so a repeated guess won't double-count.</p>
        <p><strong>STRICT</strong> mode shows which specific slot each status belongs to (underlined per peg). <strong>CLASSIC</strong> mode only shows totals — harder but more satisfying.</p>
        <p><strong>INSIGHT</strong> tokens reveal one random slot. Earn them by solving efficiently:</p>
        <ul>
          <li>top ⅓ of attempts → +3</li>
          <li>top ⅔ of attempts → +2</li>
          <li>solved at all → +1</li>
        </ul>
        <p>Clear a few codes at each tier to unlock a harder one — more slots, more symbols. There are five tiers. Tier <strong>V</strong> is infinite.</p>
        <p style="color:var(--ink-faint); font-size:11px; margin-top:14px;">keys — 1–0 pick · ⏎ lock · ⌫ clear · H insight · M mute</p>
      `,
      actions: [{ label: "got it", primary: true, action: closeModal }],
    });
  }

  function showStats() {
    const a = save.stats.attempts;
    const avg = a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "—";
    openModal({
      title: "STATISTICS",
      sub: "// a record of deduction",
      body: `
        <div class="row-result"><span>codes solved</span><span>${save.solved}</span></div>
        <div class="row-result"><span>current streak</span><span>${save.streak}</span></div>
        <div class="row-result"><span>best streak</span><span>${save.bestStreak}</span></div>
        <div class="row-result"><span>avg attempts / solve</span><span>${avg}</span></div>
        <div class="row-result"><span>fastest solve</span><span>${save.stats.fastest ?? "—"} attempts</span></div>
        <div class="row-result"><span>abandons</span><span>${save.stats.abandons}</span></div>
        <div class="row-result"><span>insight tokens</span><span>${save.insight}</span></div>
        <div class="row-result"><span>tier</span><span>${tier().roman} (${save.clearedAtTier}/${tier().advance === Infinity ? "∞" : tier().advance} to next)</span></div>
      `,
      actions: [{ label: "close", primary: true, action: closeModal }],
    });
  }

  function confirmReset() {
    openModal({
      title: "RESET PROGRESS",
      sub: "// this cannot be undone",
      body: `<p>All stats, tier progress, streaks, and insight tokens will be wiped.</p>`,
      actions: [
        { label: "cancel", action: closeModal },
        { label: "reset", danger: true, action: () => {
          save = defaultSave();
          persist();
          game = newRound();
          closeModal();
          toast("progress reset");
          render();
        } },
      ],
    });
  }

  // ── Toast ─────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, dur = 1800) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, dur);
  }

  // ── Events ────────────────────────────────────────
  function bind() {
    submitBtn.addEventListener("click", submitGuess);
    clearBtn.addEventListener("click", clearCurrent);
    insightBtn.addEventListener("click", useInsight);
    surrenderBtn.addEventListener("click", surrender);
    document.querySelectorAll(".mode-btn").forEach(b => {
      b.addEventListener("click", () => {
        save.mode = b.dataset.mode;
        persist();
        Audio.click();
        render();
      });
    });
    $("how").addEventListener("click", showHowTo);
    $("stats").addEventListener("click", showStats);
    $("reset").addEventListener("click", confirmReset);

    document.addEventListener("keydown", (e) => {
      if (!modalRoot.hidden) {
        if (e.key === "Escape" && !modalSticky) closeModal();
        if (e.key === "Enter" && modalSticky) {
          e.preventDefault();
          const primary = modalRoot.querySelector(".ctl-primary");
          if (primary) primary.click();
        }
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); submitGuess(); }
      else if (e.key === "Backspace") { e.preventDefault(); clearCurrent(); }
      else if (e.key === "h" || e.key === "H") { useInsight(); }
      else if (e.key === "m" || e.key === "M") { save.muted = !save.muted; persist(); toast(save.muted ? "sound muted" : "sound on"); }
      else if (/^[0-9]$/.test(e.key)) {
        const t = tier();
        const n = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
        if (n >= 0 && n < t.palette) {
          let idx = game.activeIdx;
          if (game.current[idx] !== null || game.revealed[idx]) {
            idx = game.current.findIndex((v, k) => v === null && !game.revealed[k]);
          }
          if (idx >= 0) setSlot(idx, n);
        }
      }
    });
  }

  // ── Boot ──────────────────────────────────────────
  function boot() {
    bind();
    render();
    if (save.solved === 0 && save.stats.attempts.length === 0) {
      // First-run onboarding
      setTimeout(showHowTo, 300);
    }
  }

  boot();
})();
