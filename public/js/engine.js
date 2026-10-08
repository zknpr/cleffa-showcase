import { $, $$, fmtMs } from "./dom.js";
import { settings, emit, on } from "./store.js";
import { setRadio } from "./ui.js";
import { configureConnection, connectionHealth, discoverCompanion, disconnect, snapshotConnection, proxyCredentialsAvailable } from "./connection.js";

let localModel = null, draftBackend = "local", draftModel = settings.model, checking = false;

function setModel(model, touched = true) {
  if (settings.backend === "local" && localModel) model = localModel;
  if (touched) settings.modelTouched = true;
  if (settings.model === model) return;
  settings.model = model;
  if (draftBackend === settings.backend) {
    draftModel = model;
    setRadio($("#engine-pop"), "data-model", model);
  }
  for (const mode of ["live", "video", "batch", "ask"]) emit("schema", { mode });
}

function renderModelChoices() {
  for (const b of $$("[data-model]", $("#engine-pop"))) {
    b.disabled = draftBackend === "local" && !!localModel && b.dataset.model !== localModel;
    b.title = b.disabled ? `Restart clef-server with gguf/${b.dataset.model}.gguf to use this model.` : "";
  }
}

function showBackend(backend) {
  draftBackend = backend;
  draftModel = settings.model;
  setRadio($("#engine-pop"), "data-backend", backend);
  setRadio($("#engine-pop"), "data-model", draftModel);
  for (const kind of ["local", "remote", "hosted"]) $(`#connection-${kind}`).hidden = kind !== backend;
  renderModelChoices();
}

function status(ok, name, detail) {
  $("#engine-pill").className = `pill ${ok ? "ok" : "bad"}`;
  // The empty Live stage offers "Connect an engine" only once a check has said there is none.
  document.body.classList.add("engine-known");
  document.body.classList.toggle("engine-ok", ok);
  $("#engine-name").textContent = name;
  $("#engine-detail").textContent = detail;
}

async function pollHealth() {
  if (checking) return;
  const connection = snapshotConnection();
  if (!connection.enabled) { status(false, "Connect your engine", "This site runs no inference of its own. Pick a service and connect."); return; }
  checking = true;
  try {
    const h = await connectionHealth(connection);
    if (connection.revision !== snapshotConnection().revision) return;
    emit("health", h);
    localModel = h.local?.ok && typeof h.local.model === "string" ? (/flash/i.test(h.local.model) ? "clef-flash" : "clef") : null;
    if (connection.backend === "local") {
      if (localModel) setModel(localModel, false);
      status(!!h.local?.ok, h.local?.ok ? `${settings.model} · local` : "clef-server offline",
        h.local?.ok ? `Connected to ${connection.url}, running ${h.local.model}.`
          : `The companion answers, but clef-server at ${h.clef} is offline. Start it and try again.`);
    } else {
      status(true, `${settings.model} · ${connection.backend === "hosted" ? "Cloudflare" : "SystemOne"}`,
        "Saved. The service checks the credentials on the first request.");
    }
    renderModelChoices();
  } catch (e) {
    if (connection.revision !== snapshotConnection().revision) return;
    localModel = null;
    status(false, "Connection unavailable", `${e.message} Check the URL, --allow-origin and the browser's local-network permission.`);
  } finally { checking = false; }
}

export function initEngineMenu() {
  const pill = $("#engine-pill"), pop = $("#engine-pop");
  const toggle = (show) => { pop.hidden = !show; pill.setAttribute("aria-expanded", String(show)); };
  pill.addEventListener("click", (e) => { e.stopPropagation(); toggle(pop.hidden); });
  for (const b of $$('[data-action="connect"]')) b.addEventListener("click", (e) => { e.stopPropagation(); toggle(true); $$("input", pop).find((i) => i.getClientRects().length)?.focus(); });
  // The companion command only matters when this page is not served by the companion itself.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  $("#connection-origin-note").hidden = loopback;
  $("#connection-command").textContent = `bun run start --allow-origin ${location.origin}`;
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) toggle(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) toggle(false); });
  for (const b of $$("[data-backend]", pop)) b.addEventListener("click", () => showBackend(b.dataset.backend));
  for (const b of $$("[data-model]", pop)) b.addEventListener("click", () => {
    draftModel = b.dataset.model;
    setRadio(pop, "data-model", draftModel);
    // The loaded local model must not override a model chosen for a new remote connection.
    if (draftBackend === settings.backend) { setModel(draftModel); pollHealth(); }
  });
  $("#connection-connect").addEventListener("click", async () => {
    try {
      const values = draftBackend === "hosted" ? { account: $("#connection-account").value, token: $("#connection-cloudflare-token").value }
        : { url: $(`#connection-${draftBackend}-url`).value, token: draftBackend === "remote" ? $("#connection-remote-token").value : "" };
      configureConnection(draftBackend, values);
      localModel = null;
      setModel(draftModel);
      await pollHealth();
    } catch (e) { $("#engine-detail").textContent = e.message; }
  });
  $("#connection-disconnect").addEventListener("click", () => {
    disconnect();
    $("#connection-remote-token").value = $("#connection-cloudflare-token").value = "";
    localModel = null;
    renderModelChoices();
    pollHealth();
  });
  on("model", (m) => setModel(m));
  on("exchange", (ex) => { $("#engine-ms").textContent = ex.server ? fmtMs(ex.server) : ""; });
  showBackend("local");
  discoverCompanion().then(() => {
    const connection = snapshotConnection();
    if (connection.enabled) $("#connection-local-url").value = connection.url;
    $("#connection-proxy-note").hidden = !proxyCredentialsAvailable();
    pollHealth();
  }).catch(e => status(false, "Connect your engine", `Automatic check failed: ${e.message}. Pick a service and connect.`));
  setInterval(pollHealth, 5000);
}
