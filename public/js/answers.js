// How answers are drawn. The response carries, per question, `noul` (probability of yes), or the
// winning `choice` with every option's probability, or the expected `score` level with per-level
// probabilities. Cards are built once per schema and then updated in place, so the bars animate
// between frames instead of flickering.

import { el, pct } from "./dom.js";

// Option colours for `choice` answers, the same in cards, chips, filters and the score lanes.
// Assigned by the option's position in the request's criteria, so they stay put across frames.
export const PALETTE = ["#5fb2ff", "#fbad41", "#c49bff", "#ff6f91", "#5fd39a", "#f5e663", "#4fd8dc", "#ff9d7a", "#a3a3a3"];
export const optionColor = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

export const instructionText = (id, q) =>
  q.instructions == null || q.instructions === "" ? id : typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);

// An answer is drawn only if it fits the question as asked: a response to an older schema can
// arrive after an edit, and its option set may no longer match the card.
export function fits(q, a) {
  if (!a || typeof a !== "object") return false;
  if (q.type === "noul") return typeof a.noul === "number";
  if (q.type === "choice") return typeof a.choice === "string" && Object.hasOwn(q.criteria, a.choice) && a.probabilities && typeof a.probabilities === "object";
  return typeof a.score === "number" && a.probabilities && typeof a.probabilities === "object";
}

export function nearestLevel(q, a) {
  return Math.min(q.criteria.length - 1, Math.max(0, Math.round(a.score)));
}

// One line per answer, for tooltips, tables and exports.
export function answerText(q, a) {
  if (!fits(q, a)) return "—";
  if (q.type === "noul") return `${a.noul >= 0.5 ? "yes" : "no"} ${pct(a.noul >= 0.5 ? a.noul : 1 - a.noul)}`;
  if (q.type === "choice") return `${a.choice} ${pct(a.confidence ?? a.probabilities[a.choice] ?? 0)}`;
  return `${a.score.toFixed(2)} · ${q.criteria[nearestLevel(q, a)]}`;
}

function head(id, q, kind) {
  const text = instructionText(id, q);
  return el("header", { class: "dhead" }, [
    el("h4", { class: "dq", text, title: text }),
    el("code", { class: "did", text: id, title: `${id} · ${kind}` }),
  ]);
}

function noulCard(id, q) {
  const verdict = el("span", { class: "verdict", text: "—" });
  const prob = el("span", { class: "vprob" });
  const fill = el("i", { class: "meter-fill" });
  const meter = el("div", { class: "meter", role: "meter", "aria-valuemin": "0", "aria-valuemax": "1", "aria-label": `${id}, probability of yes` }, [fill, el("i", { class: "meter-mid" })]);
  const node = el("article", { class: "dcard noul pending" }, [head(id, q, "yes / no"), el("div", { class: "dv" }, [verdict, prob]), meter]);
  return {
    id, q, node,
    update(a) {
      if (!fits(q, a)) { node.classList.add("pending"); return; }
      const p = a.noul, yes = p >= 0.5;
      node.classList.remove("pending");
      node.classList.toggle("yes", yes);
      node.classList.toggle("no", !yes);
      verdict.textContent = yes ? "Yes" : "No";
      prob.textContent = pct(yes ? p : 1 - p);
      fill.style.width = `${p * 100}%`;
      meter.setAttribute("aria-valuenow", p.toFixed(4));
      meter.title = `p(yes) = ${p.toFixed(4)}`;
    },
  };
}

function choiceCard(id, q) {
  const keys = Object.keys(q.criteria);
  const swatch = el("i", { class: "swatch" });
  const verdict = el("span", { class: "verdict", text: "—" });
  const prob = el("span", { class: "vprob" });
  const segs = keys.map((k, i) => { const s = el("i", { title: k }); s.style.background = optionColor(i); return s; });
  const rows = keys.map((k, i) => {
    const sw = el("i", { class: "sw" });
    sw.style.background = optionColor(i);
    const fill = el("i");
    fill.style.background = optionColor(i);
    const p = el("span", { class: "p", text: "" });
    const desc = q.criteria[k];
    const row = el("li", { class: "opt" }, [sw, el("span", { class: "name", text: k, title: desc == null ? k : `${k}: ${typeof desc === "string" ? desc : JSON.stringify(desc)}` }), el("span", { class: "bar" }, [fill]), p]);
    return { k, row, fill, p };
  });
  const node = el("article", { class: "dcard choice pending" }, [
    head(id, q, "one of"),
    el("div", { class: "dv" }, [swatch, verdict, prob]),
    el("div", { class: "stack", "aria-hidden": "true" }, segs),
    el("ul", { class: "opts" }, rows.map((r) => r.row)),
  ]);
  return {
    id, q, node,
    update(a) {
      if (!fits(q, a)) { node.classList.add("pending"); return; }
      node.classList.remove("pending");
      const win = keys.indexOf(a.choice);
      swatch.style.background = optionColor(win);
      verdict.textContent = a.choice;
      verdict.title = a.choice;
      prob.textContent = pct(a.confidence ?? a.probabilities[a.choice] ?? 0);
      rows.forEach((r, i) => {
        const p = Number(a.probabilities[r.k]) || 0;
        segs[i].style.width = `${p * 100}%`;
        r.fill.style.width = `${p * 100}%`;
        r.p.textContent = pct(p);
        r.row.classList.toggle("win", i === win);
      });
    },
  };
}

function scoreCard(id, q) {
  const levels = q.criteria.map((c) => (typeof c === "string" ? c : JSON.stringify(c)));
  const n = levels.length;
  const verdict = el("span", { class: "verdict", text: "—" });
  const prob = el("span", { class: "vprob" });
  const bars = levels.map((name) => el("i", { class: "lvbar", title: name }));
  const names = levels.map((name) => el("span", { text: name, title: name }));
  const marker = el("i", { class: "scale-marker" });
  const node = el("article", { class: "dcard score pending" }, [
    head(id, q, "scale"),
    el("div", { class: "dv" }, [verdict, prob]),
    el("div", { class: "scale-wrap" }, [
      el("div", { class: "scale", "aria-hidden": "true" }, bars),
      el("div", { class: "scale-track", "aria-hidden": "true" }, [marker]),
      el("div", { class: "scale-names" }, names),
    ]),
  ]);
  return {
    id, q, node,
    update(a) {
      if (!fits(q, a)) { node.classList.add("pending"); return; }
      node.classList.remove("pending");
      const near = nearestLevel(q, a);
      verdict.textContent = levels[near];
      verdict.title = levels[near];
      prob.textContent = `${a.score.toFixed(2)} of 0–${n - 1}`;
      bars.forEach((b, k) => {
        const p = Number(a.probabilities[String(k)]) || 0;
        b.style.height = `${Math.max(4, p * 100)}%`;
        b.title = `${levels[k]}: ${pct(p)}`;
        b.classList.toggle("near", k === near);
        names[k].classList.toggle("near", k === near);
      });
      // Column k is centred at (k + 0.5) / n of the width, so the expected level lands between them.
      marker.style.left = `${((Math.min(n - 1, Math.max(0, a.score)) + 0.5) / n) * 100}%`;
    },
  };
}

const CARD = { noul: noulCard, choice: choiceCard, score: scoreCard };

export class DecisionPanel {
  constructor(root) {
    this.root = root;
    this.key = null;
    this.cards = [];
  }

  // Rebuilds the cards only when the questions actually change, so values carry over and animate.
  setQuestions(questions, error = null) {
    const key = questions ? JSON.stringify(questions) : `!${error}`;
    if (key === this.key) return;
    this.key = key;
    if (!questions) {
      this.cards = [];
      this.root.replaceChildren(el("p", { class: "panel-note bad", text: error ?? "No questions." }));
      return;
    }
    this.cards = Object.entries(questions).map(([id, q]) => (CARD[q.type] ?? noulCard)(id, q));
    this.root.replaceChildren(...this.cards.map((c) => c.node));
  }

  update(answers) {
    for (const c of this.cards) c.update(answers ? answers[c.id] : null);
  }

  show(questions, answers) {
    this.setQuestions(questions);
    this.update(answers);
  }
}

// Compact chips for gallery cards and the Ask history.
export function answerChips(questions, answers) {
  const out = [];
  for (const [id, q] of Object.entries(questions ?? {})) {
    const a = answers?.[id];
    if (!fits(q, a)) continue;
    if (q.type === "noul") {
      const yes = a.noul >= 0.5;
      out.push(el("span", { class: `chip ${yes ? "yes" : "no"}`, title: `${id}: p(true) ${a.noul.toFixed(4)}` }, [yes ? "✓ " : "✕ ", id]));
    } else if (q.type === "choice") {
      const sw = el("i", { class: "sw" });
      sw.style.background = optionColor(Object.keys(q.criteria).indexOf(a.choice));
      out.push(el("span", { class: "chip", title: `${id}: ${answerText(q, a)}` }, [sw, a.choice, el("small", { text: pct(a.confidence ?? 0) })]));
    } else {
      out.push(el("span", { class: "chip score", title: `${id}: ${answerText(q, a)}` }, [`${id} `, el("b", { text: a.score.toFixed(1) }), el("small", { text: `/${q.criteria.length - 1}` })]));
    }
  }
  return out;
}
