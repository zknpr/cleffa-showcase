// Question schemas, one per mode, and the drawer that edits them. The editor keeps an ordered list
// (editor shape, see presets.js); buildRequest() turns it into the SystemOne request shape and is
// the only place that does, so every mode sends what the drawer shows.

import { PRESETS } from "../presets.js";
import { $, $$, el, icon, autosize } from "./dom.js";
import { settings, emit } from "./store.js";
import { openOverlay, toast } from "./ui.js";
import { optionColor } from "./answers.js";

const LABEL = { live: "Live", video: "Video", batch: "Batch", ask: "Ask" };
const schemas = {};
let mode = "live";

const stateToText = (s) => (typeof s === "string" ? s : JSON.stringify(s, null, 2));

// Option descriptions, levels and yes/no meanings are any JSON value in the reference (it renders
// non-strings as JSON). Values from the JSON view are kept as they are until edited in a text box.
const present = (v) => (typeof v === "string" ? v.trim() !== "" : v != null);
const asText = (v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

function parseState(text) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { /* not JSON: send it as text */ }
  }
  return text;
}

function editorShape(p) {
  return {
    state: stateToText(p.state),
    questions: p.questions.map((q) => ({
      id: q.id, type: q.type, instructions: q.instructions ?? "",
      options: (q.options ?? []).map((o) => ({ ...o })),
      levels: [...(q.levels ?? [])],
      trueDesc: q.trueDesc ?? "", falseDesc: q.falseDesc ?? "",
    })),
  };
}

function ensure(m) {
  if (!schemas[m]) schemas[m] = { preset: 0, ...editorShape(PRESETS[m][0]) };
  return schemas[m];
}

export function setSchemaMode(m) {
  mode = m;
  ensure(m);
  if ($("#editor").classList.contains("open")) renderEditor();
}

export function buildRequest(images, extra = {}, m = mode) {
  const s = ensure(m);
  // User-chosen IDs are dictionary keys, including the valid JSON key "__proto__".
  const questions = Object.create(null);
  for (const q of s.questions) {
    const id = q.id.trim();
    if (!id) throw new Error("every question needs an id");
    if (Object.hasOwn(questions, id)) throw new Error(`duplicate question id "${id}"`);
    const out = { type: q.type };
    if (typeof q.instructions === "string") { if (q.instructions.trim()) out.instructions = q.instructions; }
    else if (q.instructions != null) out.instructions = q.instructions; // a JSON value from the JSON view, sent as is
    if (q.type === "choice") {
      const opts = q.options.filter((o) => o.id.trim());
      if (opts.length < 2) throw new Error(`"${id}": a one-of question needs at least two options`);
      out.criteria = Object.create(null);
      for (const o of opts) {
        const oid = o.id.trim();
        if (Object.hasOwn(out.criteria, oid)) throw new Error(`"${id}": duplicate option "${oid}"`);
        out.criteria[oid] = present(o.description) ? o.description : null;
      }
    } else if (q.type === "score") {
      const lv = q.levels.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => typeof x !== "string" || x !== "");
      if (lv.length < 2) throw new Error(`"${id}": a scale needs at least two levels`);
      out.criteria = lv;
    } else if (present(q.trueDesc) || present(q.falseDesc)) {
      out.criteria = {};
      if (present(q.trueDesc)) out.criteria.true = q.trueDesc;
      if (present(q.falseDesc)) out.criteria.false = q.falseDesc;
    }
    questions[id] = out;
  }
  if (!Object.keys(questions).length) throw new Error("at least one question is required");
  const req = { model: settings.model, state: parseState(s.state) };
  if (images && images.length) req.images = images;
  Object.assign(req, extra);
  req.questions = questions;
  return req;
}

export function tryQuestions(m = mode) {
  try { return { questions: buildRequest(["<image>"], {}, m).questions, error: null }; }
  catch (e) { return { questions: null, error: e.message }; }
}

function fromRequest(req) {
  if (!req || typeof req !== "object" || !req.questions || typeof req.questions !== "object" || Array.isArray(req.questions)) {
    throw new Error("the request needs a questions object");
  }
  const questions = Object.entries(req.questions).map(([id, q]) => {
    if (!q || typeof q !== "object") throw new Error(`"${id}": a question must be an object`);
    const out = { id, type: q.type, instructions: q.instructions ?? "", options: [], levels: [], trueDesc: "", falseDesc: "" };
    if (q.type === "choice") {
      if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria)) throw new Error(`"${id}": choice criteria must be an object`);
      out.options = Object.entries(q.criteria).map(([oid, d]) => ({ id: oid, description: d ?? null }));
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria)) throw new Error(`"${id}": score criteria must be a list`);
      out.levels = [...q.criteria];
    } else if (q.type === "noul") {
      if (q.criteria && typeof q.criteria === "object") {
        out.trueDesc = q.criteria.true ?? "";
        out.falseDesc = q.criteria.false ?? "";
      }
    } else {
      throw new Error(`"${id}": type must be noul, choice or score`);
    }
    return out;
  });
  return { state: stateToText(req.state ?? ""), questions };
}

// ------------------------------------------------------------------------------------- the drawer

export function openEditor() {
  renderEditor();
  openOverlay($("#editor"));
}

export function initEditor() {
  $("#editor-state").addEventListener("input", (e) => { ensure(mode).state = e.target.value; autosize(e.target); changed(); });
  $("#editor-add").addEventListener("click", () => {
    const s = ensure(mode);
    s.questions.push({ id: `q${s.questions.length + 1}`, type: "noul", instructions: "", options: [], levels: [], trueDesc: "", falseDesc: "" });
    renderQuestions();
    changed();
    $$(".q-id", $("#editor-questions")).at(-1)?.select();
  });
  // `toggle` is queued asynchronously: it can overwrite text already pasted into the opened
  // editor. Populate synchronously before the summary's default action reveals the textarea.
  $("#editor-json-box summary").addEventListener("click", () => { if (!$("#editor-json-box").open) syncJson(); });
  $("#editor-json-apply").addEventListener("click", applyJson);
  $("#editor-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildRequest([]), null, 2));
      toast("Request copied, without images.");
    } catch (e) { showError(e.message); }
  });
}

function renderEditor() {
  const s = ensure(mode);
  $("#editor-mode").textContent = LABEL[mode] ?? mode;
  $("#editor-presets").replaceChildren(...PRESETS[mode].map((p, i) =>
    el("button", { type: "button", class: "preset", "aria-pressed": String(i === s.preset), text: p.name, onclick: () => {
      schemas[mode] = { preset: i, ...editorShape(PRESETS[mode][i]) };
      renderEditor();
      emit("schema", { mode });
    } })));
  const st = $("#editor-state");
  st.value = s.state;
  requestAnimationFrame(() => autosize(st));
  renderQuestions();
  validate();
  if ($("#editor-json-box").open) syncJson();
}

function renderQuestions() {
  const s = ensure(mode);
  $("#editor-questions").replaceChildren(...s.questions.map((q, i) => questionNode(q, i)));
}

function questionNode(q, i) {
  const node = $("#q-tpl").content.firstElementChild.cloneNode(true);
  $(".q-num", node).textContent = String(i + 1);
  const idIn = $(".q-id", node), ins = $(".q-ins", node), crit = $(".q-criteria", node);
  idIn.value = q.id;
  ins.value = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
  idIn.addEventListener("input", () => { q.id = idIn.value; changed(); });
  ins.addEventListener("input", () => { q.instructions = ins.value; autosize(ins); changed(); });
  requestAnimationFrame(() => autosize(ins));
  const typeButtons = $$(".q-type button", node);
  const markType = () => typeButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.type === q.type)));
  markType();
  for (const b of typeButtons) {
    b.addEventListener("click", () => {
      if (q.type === b.dataset.type) return;
      q.type = b.dataset.type;
      if (q.type === "choice" && q.options.length < 2) q.options = [{ id: "a", description: null }, { id: "b", description: null }];
      if (q.type === "score" && q.levels.length < 2) q.levels = ["low", "medium", "high"];
      markType();
      renderCriteria(q, crit);
      changed();
    });
  }
  $(".q-del", node).addEventListener("click", () => {
    ensure(mode).questions.splice(i, 1);
    renderQuestions();
    changed();
  });
  renderCriteria(q, crit);
  return node;
}

function delButton(label, onclick) {
  return el("button", { type: "button", class: "icon-btn", "aria-label": label, title: label, onclick }, [icon("close")]);
}

function renderCriteria(q, crit) {
  crit.replaceChildren();
  if (q.type === "choice") {
    q.options.forEach((o, k) => {
      const sw = el("i", { class: "sw" });
      sw.style.background = optionColor(k);
      const idIn = el("input", { class: "mono-in", placeholder: "option_id", value: o.id, "aria-label": `Option ${k + 1} id`, spellcheck: "false" });
      const dIn = el("input", { placeholder: "description (optional)", value: asText(o.description), "aria-label": `Option ${k + 1} description` });
      idIn.addEventListener("input", () => { o.id = idIn.value; changed(); });
      dIn.addEventListener("input", () => { o.description = dIn.value || null; changed(); });
      crit.append(el("div", { class: "crit-row opt-row" }, [sw, idIn, dIn, delButton("Remove option", () => { q.options.splice(k, 1); renderCriteria(q, crit); changed(); })]));
    });
    crit.append(el("button", { type: "button", class: "btn sm ghost add-crit", onclick: () => { q.options.push({ id: "", description: null }); renderCriteria(q, crit); $$(".opt-row input.mono-in", crit).at(-1)?.focus(); } }, [icon("plus"), "Option"]));
  } else if (q.type === "score") {
    q.levels.forEach((lv, k) => {
      const inp = el("input", { value: asText(lv), placeholder: `level ${k}`, "aria-label": `Level ${k}` });
      inp.addEventListener("input", () => { q.levels[k] = inp.value; changed(); });
      crit.append(el("div", { class: "crit-row lvl-row" }, [el("span", { class: "n", text: String(k) }), inp, delButton("Remove level", () => { q.levels.splice(k, 1); renderCriteria(q, crit); changed(); })]));
    });
    crit.append(el("button", { type: "button", class: "btn sm ghost add-crit", onclick: () => { q.levels.push(""); renderCriteria(q, crit); $$(".lvl-row input", crit).at(-1)?.focus(); } }, [icon("plus"), "Level"]));
  } else {
    const t = el("input", { placeholder: "what yes means (optional)", value: asText(q.trueDesc), "aria-label": "What yes means" });
    const f = el("input", { placeholder: "what no means (optional)", value: asText(q.falseDesc), "aria-label": "What no means" });
    t.addEventListener("input", () => { q.trueDesc = t.value; changed(); });
    f.addEventListener("input", () => { q.falseDesc = f.value; changed(); });
    crit.append(el("div", { class: "crit-row noul-row" }, [el("span", { class: "k", text: "yes" }), t]), el("div", { class: "crit-row noul-row" }, [el("span", { class: "k", text: "no" }), f]));
  }
}

function showError(msg) { $("#editor-error").textContent = msg; }

function validate() {
  const { error } = tryQuestions(mode);
  showError(error ?? "");
}

function changed() {
  ensure(mode).preset = -1;
  for (const b of $$("#editor-presets .preset")) b.setAttribute("aria-pressed", "false");
  validate();
  if ($("#editor-json-box").open) syncJson();
  emit("schema", { mode });
}

function syncJson() {
  const media = mode === "video" ? [[], { videos: [{ frames: ["<frame data URL>", "…"], fps: 2 }] }] : [["<image data URL>"], {}];
  try { $("#editor-json").value = JSON.stringify(buildRequest(...media), null, 2); }
  catch (e) { showError(e.message); }
}

function applyJson() {
  try {
    const req = JSON.parse($("#editor-json").value);
    const shape = fromRequest(req);
    schemas[mode] = { preset: -1, ...shape };
    if (req.model === "clef" || req.model === "clef-flash") emit("model", req.model);
    renderEditor();
    emit("schema", { mode });
    toast("Applied.");
  } catch (e) {
    showError(`JSON: ${e.message}`);
  }
}
