// The score: one lane per question against a shared time axis, the way a musical score lays voices
// against bars. Live mode draws a rolling window that ends now; Video mode a fixed one, the length of
// the clip, with a playhead, where each sample is a window of the clip with an explicit end. A yes/no lane is p(yes) as a filled
// step, a one-of lane is a ribbon in the winning option's colour (fainter when less confident), a
// scale lane is the expected level. Each frame holds until the next one, which is exactly what the
// Decisions panel showed in between. Canvas, because a minute at seven frames a second is a few
// hundred samples per lane, redrawn every animation frame while the window scrolls.

import { el, fitCanvas, fmtMs, fmtClock } from "./dom.js";
import { optionColor, instructionText, answerText, fits } from "./answers.js";

const RULER = 22, LANE = 30, GAP = 8;
const YES = "246, 130, 31", SCORE = "255, 208, 138", BAD = "255, 107, 129";

export class Score {
  constructor(root, { window: span = 60, emptyText = "", fixed = false, onSeek = null } = {}) {
    this.root = root;
    this.span = span;
    this.fixed = fixed; // a fixed axis from t0 over span seconds, instead of one that ends now
    this.t0 = 0;
    this.playhead = null;
    this.marks = [];
    this.lanes = [];
    this.samples = [];
    this.dt = 0.25; // typical spacing between samples, seconds; a gap over 2.5x breaks the trace
    this.hoverX = null;
    this.raf = 0;
    this.running = false;
    this.labels = el("div", { class: "score-labels" });
    this.canvas = el("canvas", { class: "score-canvas", role: "img", "aria-label": fixed ? "Answers along the video, one lane per question" : "Answers over the last minute, one lane per question" });
    this.tip = el("div", { class: "score-tip", hidden: true });
    this.plot = el("div", { class: "score-plot" }, [this.canvas, this.tip]);
    this.legend = el("div", { class: "score-legend" });
    this.empty = el("p", { class: "score-empty", text: emptyText });
    root.classList.add("score");
    root.style.setProperty("--ruler", `${RULER}px`);
    root.style.setProperty("--lane", `${LANE}px`);
    root.style.setProperty("--gap", `${GAP}px`);
    root.replaceChildren(el("div", { class: "score-body" }, [this.labels, this.plot]), this.legend, this.empty);
    new ResizeObserver(() => this.draw()).observe(this.plot);
    this.canvas.addEventListener("pointermove", (e) => { this.hoverX = e.clientX - this.canvas.getBoundingClientRect().left; this.draw(); });
    this.canvas.addEventListener("pointerleave", () => { this.hoverX = null; this.tip.hidden = true; this.draw(); });
    if (onSeek) {
      this.canvas.classList.add("seekable");
      this.canvas.addEventListener("pointerdown", (e) => {
        const W = this.plot.clientWidth;
        if (W > 0) onSeek(this.t0 + ((e.clientX - this.canvas.getBoundingClientRect().left) / W) * this.span);
      });
    }
  }

  setQuestions(questions) {
    this.lanes = Object.entries(questions ?? {}).map(([id, q]) => ({ id, q, keys: q.type === "choice" ? Object.keys(q.criteria) : null }));
    this.labels.replaceChildren(...this.lanes.map(({ id, q }) =>
      el("div", { class: "lane-label", title: `${id}: ${instructionText(id, q)}` }, [el("span", { class: "lane-id", text: id })])));
    const groups = this.lanes.filter((l) => l.keys).map(({ id, keys }) =>
      el("span", { class: "legend-group" }, [el("b", { text: `${id}:` }), ...keys.map((k, i) => {
        const sw = el("i");
        sw.style.background = optionColor(i);
        return el("span", { class: "legend-item" }, [sw, k]);
      })]));
    this.legend.replaceChildren(...groups);
    this.draw();
  }

  // `samples` is owned by the caller: [{t (seconds, performance clock), answers, thumb}], ascending.
  // A sample with `end` holds exactly until then; one with `error` shows it in the tooltip.
  setSamples(samples) { this.samples = samples; this.draw(); }
  // Fixed axis only: the range, the playhead, and marked spans [{t, end, kind: "running" | "error"}].
  setRange(t0, t1) { this.t0 = t0; this.span = Math.max(1e-3, t1 - t0); this.draw(); }
  setPlayhead(t) { this.playhead = t; this.draw(); }
  setMarks(marks) { this.marks = marks; this.draw(); }
  setSpacing(dt) { if (dt > 0 && Number.isFinite(dt)) this.dt = dt; }
  setEmpty(text) { this.empty.textContent = text; }

  // While running the window scrolls every animation frame; stopped, it freezes where it was.
  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => { if (!this.running) return; this.paint(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  stop() { this.running = false; this.draw(); }

  draw() {
    if (this.raf || this.running) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const W = this.plot.clientWidth;
    const H = RULER + Math.max(1, this.lanes.length) * (LANE + GAP) - GAP + 2;
    if (W <= 0) return;
    this.canvas.style.height = `${H}px`;
    const ctx = fitCanvas(this.canvas, W, H);
    let t0, t1;
    if (this.fixed) {
      t0 = this.t0;
      t1 = t0 + this.span;
    } else {
      // Stopped, the window stays where it was, extended only to show a frame sent on its own.
      const last = this.samples.length ? this.samples[this.samples.length - 1].t + this.dt : 0;
      t1 = this.running || this.frozenAt == null ? performance.now() / 1000 : Math.max(this.frozenAt, last);
      this.frozenAt = t1;
      t0 = t1 - this.span;
    }
    const X = (t) => ((t - t0) / this.span) * W;
    if (this.fixed) this.paintClockRuler(ctx, t0, X, W, H);
    else this.paintRuler(ctx, t1, X, W, H);
    const gap = this.dt * 2.5;
    this.lanes.forEach((lane, i) => {
      const y = RULER + i * (LANE + GAP);
      ctx.fillStyle = "rgba(255, 255, 255, 0.025)";
      ctx.beginPath();
      ctx.roundRect(0, y, W, LANE, 6);
      ctx.fill();
      if (lane.keys) this.paintChoice(ctx, lane, y, X, t0, t1, gap, W);
      else this.paintLevel(ctx, lane, y, X, t0, t1, gap, W);
    });
    for (const m of this.marks) {
      // A window in the engine glows faintly across every lane; a failed one is tinted red.
      const x0 = Math.round(Math.max(0, X(m.t))), x1 = Math.round(Math.min(W, X(m.end)));
      if (x1 <= x0) continue;
      ctx.fillStyle = m.kind === "error" ? `rgba(${BAD}, 0.16)` : `rgba(${YES}, 0.10)`;
      ctx.fillRect(x0, RULER, x1 - x0, H - RULER);
      ctx.fillStyle = m.kind === "error" ? `rgb(${BAD})` : `rgb(${YES})`;
      ctx.fillRect(x0, RULER - 3, x1 - x0, 2);
    }
    if (this.playhead != null && this.fixed) {
      const x = Math.round(Math.min(W - 1, Math.max(0, X(this.playhead)))) + 0.5;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER - 6);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(x - 5, RULER - 9);
      ctx.lineTo(x + 5, RULER - 9);
      ctx.lineTo(x, RULER - 3);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1;
    }
    if (this.hoverX != null) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(this.hoverX) + 0.5, RULER);
      ctx.lineTo(Math.round(this.hoverX) + 0.5, H);
      ctx.stroke();
      ctx.setLineDash([]);
      this.showTip(t0 + (this.hoverX / W) * this.span, t1, W);
    }
  }

  // Ticks are anchored to now ("now", "-10s", ...) so the labels stay still while the data scrolls.
  paintRuler(ctx, t1, X, W, H) {
    const step = [5, 10, 15, 30].find((s) => (s / this.span) * W >= 64) ?? 30;
    ctx.font = "11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
    ctx.beginPath();
    ctx.moveTo(0, RULER - 0.5);
    ctx.lineTo(W, RULER - 0.5);
    ctx.stroke();
    for (let k = 0; k * step <= this.span; k++) {
      const x = Math.round(X(t1 - k * step)) - 0.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.035)";
      ctx.beginPath();
      ctx.moveTo(x, RULER);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = "#6e6e6e";
      ctx.textAlign = k === 0 ? "right" : x < 24 ? "left" : "center";
      ctx.fillText(k === 0 ? "now" : `-${k * step}s`, k === 0 ? W - 2 : x, 9);
    }
  }

  // Clock ticks from the start of the clip (0:00, 0:05, ...), at a step that leaves room for labels.
  paintClockRuler(ctx, t0, X, W, H) {
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => (s / this.span) * W >= 56) ?? 600;
    ctx.font = "11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
    ctx.beginPath();
    ctx.moveTo(0, RULER - 0.5);
    ctx.lineTo(W, RULER - 0.5);
    ctx.stroke();
    for (let k = Math.ceil(t0 / step); k * step <= t0 + this.span + 1e-9; k++) {
      const x = Math.round(X(k * step)) + 0.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.035)";
      ctx.beginPath();
      ctx.moveTo(x, RULER);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = "#6e6e6e";
      ctx.textAlign = x < 24 ? "left" : x > W - 24 ? "right" : "center";
      ctx.fillText(fmtClock(k * step, step < 1), x < 24 ? x + 2 : x > W - 24 ? W - 2 : x, 9);
    }
  }

  // Visible samples as [sample, from, to]: each holds until its end, or else the next sample or the gap limit.
  *spans(t0, t1, gap) {
    const s = this.samples;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].t < t0 - gap) lo = m + 1; else hi = m; }
    for (let i = lo; i < s.length && s[i].t <= t1; i++) {
      const next = s[i + 1];
      yield [s[i], s[i].t, s[i].end ?? Math.min(next ? next.t : t1, s[i].t + gap)];
    }
  }

  paintChoice(ctx, lane, y, X, t0, t1, gap, W) {
    for (const [s, a0, a1] of this.spans(t0, t1, gap)) {
      const a = s.answers?.[lane.id];
      if (!fits(lane.q, a)) continue;
      // Whole pixels: adjacent steps then share an edge exactly, with neither seams nor overlaps
      // (an overlap doubles the alpha and shows as a stripe).
      const x0 = Math.round(Math.max(0, X(a0))), x1 = Math.round(Math.min(W, X(a1)));
      if (x1 <= x0) continue;
      ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, Math.max(0, a.confidence ?? 0));
      ctx.fillStyle = optionColor(lane.keys.indexOf(a.choice));
      ctx.fillRect(x0, y + 4, x1 - x0, LANE - 8);
    }
    ctx.globalAlpha = 1;
  }

  paintLevel(ctx, lane, y, X, t0, t1, gap, W) {
    const noul = lane.q.type === "noul";
    const n = noul ? 0 : lane.q.criteria.length;
    const rgb = noul ? YES : SCORE;
    const value = (a) => (!fits(lane.q, a) ? null : noul ? a.noul : n > 1 ? Math.min(1, Math.max(0, a.score / (n - 1))) : 0);
    const top = y + 3, h = LANE - 6, base = top + h;
    // Guides: the 50% line for yes/no, one line per level for a scale.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    ctx.setLineDash(noul ? [2, 4] : []);
    ctx.beginPath();
    const guides = noul ? [0.5] : Array.from({ length: Math.max(0, n - 2) }, (_, k) => (k + 1) / (n - 1));
    for (const g of guides) { const gy = Math.round(base - g * h) + 0.5; ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
    ctx.stroke();
    ctx.setLineDash([]);
    const grad = ctx.createLinearGradient(0, top, 0, base);
    grad.addColorStop(0, `rgba(${rgb}, 0.38)`);
    grad.addColorStop(1, `rgba(${rgb}, 0.03)`);
    let run = [], end = null;
    const flush = () => {
      if (!run.length) return;
      ctx.beginPath();
      ctx.moveTo(run[0][0], base);
      for (const [x0, x1, yy] of run) { ctx.lineTo(x0, yy); ctx.lineTo(x1, yy); }
      ctx.lineTo(run[run.length - 1][1], base);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(run[0][0], run[0][2]);
      for (const [x0, x1, yy] of run) { ctx.lineTo(x0, yy); ctx.lineTo(x1, yy); }
      ctx.strokeStyle = `rgb(${rgb})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      run = [];
    };
    for (const [s, a0, a1] of this.spans(t0, t1, gap)) {
      const v = value(s.answers?.[lane.id]);
      if (v == null) { flush(); end = null; continue; }
      if (end !== null && a0 - end > 1e-6) flush();
      run.push([Math.max(0, X(a0)), Math.min(W, X(a1)), base - v * h]);
      end = a1;
    }
    flush();
  }

  showTip(t, now, W) {
    let s = null;
    for (const x of this.samples) { if (x.t > t) break; s = x; }
    if (!s || (s.end != null ? t > s.end : t - s.t > this.dt * 2.5)) { this.tip.hidden = true; this.tipFor = null; return; }
    if (this.tipFor !== s) {
      this.tipFor = s;
      const rows = s.error
        ? [el("div", { class: "tip-err", text: s.error })]
        : this.lanes.map(({ id, q }) => el("div", { class: "tip-row" }, [el("span", { text: id }), el("span", { text: answerText(q, s.answers?.[id]) })]));
      // A sample may stand for a longer span than it is drawn over (an overlapping video window).
      const [a, b] = s.span ?? [s.t, s.end ?? s.t];
      const when = this.fixed ? `${fmtClock(a, true)}–${fmtClock(b, true)}` : `${(s.t - now).toFixed(1)} s`;
      this.tip.replaceChildren(
        s.thumb ? el("img", { src: s.thumb, alt: "" }) : "",
        el("div", { class: "tip-t", text: s.error ? when : `${when} · engine ${fmtMs(s.server)}` }),
        ...rows,
      );
    }
    this.tip.hidden = false;
    const left = this.hoverX + 14 + 230 > W ? this.hoverX - 14 - 230 : this.hoverX + 14;
    this.tip.style.left = `${Math.max(0, left)}px`;
    this.tip.style.top = `${RULER + 2}px`;
  }
}

