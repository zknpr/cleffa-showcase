// Page-wide settings and a tiny event bus. Events:
//   exchange  {req, status, body, text, total, server, backend, source, at}  every API round trip
//   health    the proxy's /api/health body
//   schema    {mode}                                                        a mode's questions changed
//   activity  {mode, running}                                               a long run started or ended

export const settings = { backend: "local", model: "clef-flash", modelTouched: false };

const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
