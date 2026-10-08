// The last request and response as sent and received. Credentials never enter this event stream
// or the exported request. The curl example uses placeholders for visitor credentials.

import { $, $$, el, fmtMs, downloadBlob } from "./dom.js";
import { on } from "./store.js";
import { openOverlay, setRadio, toast } from "./ui.js";

let last = null, tab = "request", shown = "";

export function initInspector() {
  on("exchange", (ex) => {
    last = ex;
    const b = $("#open-inspector");
    b.classList.remove("flash");
    void b.offsetWidth; // restart the animation
    b.classList.add("flash");
    if ($("#inspector").classList.contains("open")) render();
  });
  $("#open-inspector").addEventListener("click", () => { render(); openOverlay($("#inspector")); });
  for (const b of $$("[data-tab]", $("#inspector"))) b.addEventListener("click", () => { tab = b.dataset.tab; render(); });
  $("#insp-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(shown); toast("Copied."); } catch (e) { toast(`copy failed: ${e.message}`, "bad"); }
  });
  $("#insp-download").addEventListener("click", () => {
    if (last) downloadBlob(new Blob([JSON.stringify(last.req)], { type: "application/json" }), "request.json");
  });
}

const elide = (_key, v) => (typeof v === "string" && v.length > 160 && /^data:|^[A-Za-z0-9+/]{160}/.test(v) ? `${v.slice(0, 32)}… (${(v.length / 1024).toFixed(1)} KB elided)` : v);

function render() {
  setRadio($("#inspector"), "data-tab", tab);
  $("#insp-download").disabled = !last;
  if (!last) {
    $("#insp-meta").textContent = "";
    $("#insp-code").replaceChildren("Nothing sent yet.");
    $("#insp-note").textContent = "";
    shown = "";
    return;
  }
  $("#insp-meta").textContent = [last.source, last.backend, last.status ? `HTTP ${last.status}` : "no response", `engine ${fmtMs(last.server)}`, `round trip ${fmtMs(last.total)}`].filter(Boolean).join(", ");
  let note = "";
  if (tab === "request") {
    shown = JSON.stringify(last.req, elide, 2);
    note = "Image data elided. The download has the complete request.";
  } else if (tab === "response") {
    shown = last.body ? JSON.stringify(last.body, null, 2) : last.text ?? "";
    note = last.backend === "hosted" ? "Workers AI's result field, unwrapped by the relay." : "";
  } else {
    const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
    const lines = [`curl -s ${quote(last.endpoint)}`, "  -H 'Content-Type: application/json'"];
    if (last.authorized) lines.push('  -H "Authorization: Bearer $API_TOKEN"');
    if (last.relay) lines.push('  -H "X-Cloudflare-Account: $CLOUDFLARE_ACCOUNT_ID"');
    lines.push("  --data-binary @request.json");
    shown = lines.join(" \\\n");
    note = "request.json is the download. Credentials are never exported; set the variables yourself.";
  }
  $("#insp-code").replaceChildren(tab === "curl" ? shown : highlight(shown));
  $("#insp-note").textContent = note;
}

// Colours JSON tokens with spans built from text nodes; nothing is parsed as HTML.
function highlight(json) {
  const frag = document.createDocumentFragment();
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let at = 0, m;
  while ((m = re.exec(json))) {
    if (m.index > at) frag.append(json.slice(at, m.index));
    if (m[1]) {
      const cls = m[2] ? "tk-key" : m[1].includes("… (") ? "tk-elided" : "tk-str";
      frag.append(el("span", { class: cls, text: m[1] }));
      if (m[2]) frag.append(m[2]);
    } else if (m[3]) frag.append(el("span", { class: "tk-lit", text: m[3] }));
    else frag.append(el("span", { class: "tk-num", text: m[4] }));
    at = re.lastIndex;
  }
  frag.append(json.slice(at));
  return frag;
}
