// Laser-Panel (Laser, Verschieben, Konsole), Geräteeinstellungen, Vorschau und G-Code-Ausgabe.
import type { Editor } from './editor';
import { h, numInput } from './dom';
import { ICONS } from './icons';
import { saveText } from './files';
import { native } from './native';
import {
  anchorOf, BedCheck, Box, buildJob, burns, checkBed, DEFAULT_ROTARY, Device, estimate, Firmware, FIRMWARES, formatDuration, frameGCode, Job, jogLines, jogToLines, loadDevices, Moves, newDevice,
  prepareGCode, Rotary, RotaryAxis, rotaryCirc, rotaryOn, rotaryTestLines, sameMoves, saveDevices, StartFrom, startHere, ruidaConnect, RuidaOrigin,
} from './gcode';
import { isTauri, machine, PortInfo } from './machine';
import type { PreparedGCode } from './gcode';
import { airProblem, digitalOutputs, FluidFs, listCmd, outputCmd, OVERRIDE, parseFileList, pinNames, RAPID_OVERRIDE, TOGGLE_FLOOD, TOGGLE_MIST } from './fluidnc';
import type { Doc, ImageLayer, Layer } from './model';
import { materialTab } from './materialui';
import { cameraTab } from './cameraui';
import { dockWindow, windowBody } from './dock';
import { loadCheckSettings } from './check';
import { openCheck } from './checkPanel';
import { presetList } from './packs';
import { presetOption } from './packsDialog';
import { dec, locale, t, tBackend, tn } from './i18n';

const store = loadDevices();
/** Das gewählte Gerät (live gebunden: wechselt mit der Auswahl) */
export let device: Device = store.devices.find((d) => d.id === store.current) ?? store.devices[0];
const deviceListeners = new Set<() => void>();
function deviceChanged() {
  saveDevices(store);
  deviceListeners.forEach((f) => f());
}
/** Wird bei jedem Geräte- oder Einstellungswechsel aufgerufen; liefert eine Abmeldefunktion */
export const onDeviceChange = (f: () => void) => (deviceListeners.add(f), () => deviceListeners.delete(f));
const fw = () => FIRMWARES[device.fw];
/** Startmodus des gewählten Geräts ändern (z. B. Print and Cut braucht absolute Koordinaten) */
export function setStartFrom(v: StartFrom) {
  device.startFrom = v;
  deviceChanged();
}

/** Arbeitsfläche an das Bett des gewählten Geräts anpassen */
function applyBed(ed: Editor) {
  if (ed.doc.bed.w === device.bedW && ed.doc.bed.h === device.bedH) return;
  ed.doc.bed.w = device.bedW;
  ed.doc.bed.h = device.bedH;
  ed.emit('doc');
  ed.zoomPage();
}

export function selectDevice(ed: Editor, id: string) {
  const d = store.devices.find((x) => x.id === id);
  if (!d || d === device) return;
  if (machine.connected || machine.connecting) {
    notify(t('Zum Wechseln des Geräts erst die Verbindung trennen.'), true);
    deviceChanged();
    return;
  }
  device = d;
  store.current = id;
  applyBed(ed);
  deviceChanged();
}

/** Einstellungen des gewählten Geräts ändern und speichern (Assistent „Laser einrichten“) */
export function patchDevice(ed: Editor, patch: Partial<Device>) {
  Object.assign(device, patch);
  applyBed(ed);
  deviceChanged();
}

/** Neues Gerät anlegen und auswählen */
export function addDevice(ed: Editor, d: Device) {
  store.devices.push(d);
  deviceChanged();
  selectDevice(ed, d.id);
}

/** Kurze Meldung im Laser-Panel (und in der Konsole) */
let notify: (msg: string, error?: boolean) => void = (m) => machine.log(m);
/** Meldung im Laser-Panel, auch für Aktionen von KI-Agenten */
export const laserNotify = (msg: string, error = false) => notify(msg, error);

// ---------- Job ----------

/**
 * Woher ein Job kommt: normalerweise das Dokument im Editor, beim Materialtest ein eigenes Testdokument
 * mit eigenen Layern, das nie auf der Arbeitsfläche erscheint.
 */
export interface JobSource {
  doc: Doc;
  layer: (i: number) => Layer;
  imgLayer: (i: number) => ImageLayer;
  /** Name in der G-Code-Datei und Vorschlag für den Dateinamen */
  name: string;
  /** Farbe je Layer in der Vorschau */
  color: (i: number) => string;
}

export async function makeJob(ed: Editor, forPreview: boolean, src?: JobSource): Promise<Job> {
  const pos = machine.status.wpos;
  return buildJob({
    doc: src?.doc ?? ed.doc,
    layer: src?.layer ?? ((i) => ed.layer(i)),
    imgLayer: src?.imgLayer ?? ((i) => ed.imgLayer(i)),
    device,
    only: !src && device.cutSelected ? ed.sel : null,
    position: pos ? { x: pos[0], y: pos[1] } : null,
    forPreview,
  });
}

function nothingToDo(job: Job): boolean {
  if (job.moves.n) return false;
  notify(device.cutSelected ? t('Nichts zu lasern: Die Auswahl ist leer oder liegt nur auf Layern ohne Ausgabe.') : t('Nichts zu lasern: Keine Objekte auf Layern mit Ausgabe.'), true);
  return true;
}

/** Fahrwege des Jobs gegen den Arbeitsbereich prüfen, mit dem Werkstück-Nullpunkt, den die Steuerung meldet */
export const bedCheck = (ed: Editor, job: Job): BedCheck => checkBed(job.travel, ed.doc.bed, device, machine.workOffset());

const mm = (v: number) => v.toFixed(1);
const range = (b: Box) => ({ x0: mm(b.x0), x1: mm(b.x1), y0: mm(b.y0), y1: mm(b.y1) });

/** Warnung zur Prüfung (null = alles im Arbeitsbereich) */
export function bedProblem(ed: Editor, job: Job, c = bedCheck(ed, job)): string | null {
  const { w, h: bh } = ed.doc.bed;
  if (c.kind === 'ok') return null;
  if (c.kind === 'unknown')
    return (
      t('Start ab Benutzer-Ursprung: Die Steuerung hat noch nicht gemeldet, wo der Ursprung liegt. Ob der Job im Arbeitsbereich ({w} × {bh} mm) bleibt, lässt sich deshalb nicht prüfen.', { w, bh }) +
      '\n' +
      t('Vom Ursprung aus reicht er von X {x0} … {x1}, Y {y0} … {y1} mm (inkl. Überfahrweg).', range(job.travel!))
    );
  const o = machine.workOffset();
  return (
    t('Der Job reicht über den Arbeitsbereich ({w} × {bh} mm) hinaus:', { w, bh }) +
    '\n' +
    (c.measured && o && (o.x || o.y)
      ? t('Mit dem Ursprung der Steuerung (X {ox}, Y {oy}) liegen die Fahrwege bei X {x0} … {x1}, Y {y0} … {y1} mm Maschinenkoordinaten (inkl. Überfahrweg).', { ox: mm(o.x), oy: mm(o.y), ...range(c.box) })
      : t('X {x0} … {x1}, Y {y0} … {y1} mm (inkl. Überfahrweg).', range(c.box)))
  );
}

/** Liegt der Job (inkl. Überfahrwegen) im Arbeitsbereich? Sonst deutlich warnen und nachfragen. */
function boundsOk(ed: Editor, job: Job): boolean {
  const c = bedCheck(ed, job);
  const why = bedProblem(ed, job, c);
  if (!why) return true;
  const hint =
    c.kind === 'unknown'
      ? t('Prüfe vor dem Start, dass vom Ursprung aus genug Platz ist, zum Beispiel mit dem Rahmen.') +
        (fw().realtime ? ' ' + t('Den Ursprung meldet die Steuerung meist nach wenigen Sekunden, dann prüft KizamuBeam selbst.') : '')
      : device.startFrom === 'user'
        ? t('Wahrscheinlich ist der Ursprung falsch gesetzt oder der Job-Ursprung passt nicht dazu.')
        : '';
  notify(why.split('\n')[0], true);
  return confirm(t('⚠ Achtung') + '\n\n' + why + (hint ? '\n\n' + hint : '') + '\n\n' + t('Trotzdem starten?'));
}

/** Konstruktion prüfen vor dem Start: bei Fehlern oder Warnungen nachfragen, sonst die Stellen zeigen */
function designOk(ed: Editor): boolean {
  if (!loadCheckSettings().beforeLaser) return true;
  let xs = ed.runCheck().filter((x) => x.level !== 'info');
  if (device.cutSelected) xs = xs.filter((x) => x.objs.some((o) => ed.sel.includes(o)));
  if (!xs.length) return true;
  const lines = xs.slice(0, 6).map((x) => '• ' + x.msg);
  if (xs.length > 6) lines.push(t('… und {n} weitere', { n: xs.length - 6 }));
  const ok = confirm(
    tn('Konstruktion prüfen hat {n} Problem gefunden:', 'Konstruktion prüfen hat {n} Probleme gefunden:', xs.length) +
      '\n\n' + lines.join('\n') + '\n\n' + t('Trotzdem starten? (Abbrechen zeigt die Stellen im Fenster Prüfung.)'),
  );
  if (!ok) openCheck();
  return ok;
}

/** Warum gerade kein Job oder Rahmen laufen kann (null = es geht) */
export function runBlocker(): string | null {
  if (!machine.connected) return t('Nicht verbunden.');
  if (machine.running || uploading) return t('Es läuft bereits ein Auftrag.');
  if (machine.status.state.startsWith('Alarm'))
    return fw().unlock
      ? t('Die Maschine ist im Alarmzustand. Erst referenzieren (Home) oder entsperren ({unlock}).', { unlock: fw().unlock! })
      : t('Die Maschine ist im Alarmzustand. Erst referenzieren (Home).');
  if (device.startFrom === 'current' && !machine.status.wpos) return t('Die aktuelle Position ist noch nicht bekannt.');
  return null;
}

/** Air Assist ist auf einem Layer an, die FluidNC-Konfiguration hat aber keinen passenden Ausgang: nachfragen */
function airOk(job: Job): boolean {
  if (!job.air.length || !machine.fluid) return true;
  const why = airProblem(machine.fluid.values, device.airCmd);
  return !why || confirm(t('⚠ Achtung') + '\n\n' + why + '\n\n' + t('Trotzdem starten?'));
}

/** Datei, unter der Jobs auf SD-Karte/Flash landen; wird jedes Mal überschrieben */
const JOB_FILE = 'kizamubeam.gcode';
/** Fortschritt beim Hochladen auf die Steuerung */
let uploading: { sent: number; total: number } | null = null;
const uploadListeners = new Set<() => void>();
const uploadChanged = () => uploadListeners.forEach((f) => f());

/**
 * G-Code auf SD-Karte oder Flash der FluidNC-Steuerung laden und die Größe in der Dateiliste prüfen.
 * Liefert die Größe in Bytes oder null (Fehler schon gemeldet).
 */
export async function uploadGCode(g: PreparedGCode, fs: FluidFs, file: string): Promise<number | null> {
  const where = fs === 'sd' ? t('SD-Karte') : t('Flash');
  if (uploading) return notify(t('Es wird schon eine Datei hochgeladen.'), true), null;
  uploading = { sent: 0, total: 1 };
  uploadChanged();
  let size = 0;
  try {
    size = await machine.upload(device, fs, file, g, (sent, total) => ((uploading = { sent, total }), uploadChanged()));
  } catch (e) {
    notify(t('Hochladen auf die {where} fehlgeschlagen: {error}', { where, error: (e as Error).message }), true);
    return null;
  } finally {
    uploading = null;
    uploadChanged();
  }
  // Angekommen? Größe in der Dateiliste vergleichen (fehlt die Datei in der Liste, trotzdem weiter)
  const f = parseFileList(await machine.query([listCmd(fs)], 4000, true)).find((x) => x.name.replace(/^\//, '') === file);
  if (f && f.size !== size) {
    notify(t('Die Datei auf der {where} ist unvollständig ({got} von {size} Bytes).', { where, got: f.size, size }), true);
    return null;
  }
  machine.log(t('{file} auf die {where} geladen ({size} kB).', { file, where, size: Math.ceil(size / 1024) }));
  return size;
}

/** Job senden: vom Rechner aus oder (FluidNC, Einstellung „Job ausführen“) erst hochladen und auf der Steuerung starten */
export async function runGCode(g: PreparedGCode): Promise<boolean> {
  if (device.runFrom === 'stream' || fw().read !== 'fluidnc') return machine.runPrepared(g);
  if ((await uploadGCode(g, device.runFrom, JOB_FILE)) === null) return false;
  await machine.runStored(device.runFrom, JOB_FILE);
  return true;
}

/** Aktuellen Job berechnen und als Datei auf die Steuerung laden (ohne zu starten) */
export async function uploadJob(ed: Editor, fs: FluidFs, file: string): Promise<number | null> {
  const job = await makeJob(ed, false);
  if (nothingToDo(job)) return null;
  job.warnings.forEach((w) => notify(w));
  const g = await prepareGCode(job, device, estimate(job.moves, device));
  return uploadGCode(g, fs, file);
}

function canRun(): boolean {
  const why = runBlocker();
  if (why) notify(why, true);
  return !why;
}

export async function startJob(ed: Editor, src?: JobSource) {
  if (!canRun()) return;
  const job = await makeJob(ed, false, src);
  if (nothingToDo(job) || (!src && !designOk(ed)) || !boundsOk(ed, job) || !airOk(job)) return;
  job.warnings.forEach((w) => notify(w));
  const est = estimate(job.moves, device);
  const g = await prepareGCode(job, device, est, src?.name);
  notify(t('Job gestartet, geschätzt {total}.', { total: formatDuration(est.total) }));
  if ((await runGCode(g)) && !src) ed.afterJob();
}

/**
 * „Start Here“: den Job ab einer Stelle der Vorschau lasern. preview sind die Bewegungen der Vorschau,
 * die Stelle ist Bewegung i bei Anteil frac. Der Job wird neu berechnet und muss zur Vorschau passen.
 */
export async function startJobAt(ed: Editor, preview: Moves, i: number, frac: number, src?: JobSource): Promise<boolean> {
  if (!canRun()) return false;
  const job = await makeJob(ed, false, src);
  if (nothingToDo(job) || (!src && !designOk(ed)) || !boundsOk(ed, job) || !airOk(job)) return false;
  if (!sameMoves(preview, job.moves, job.offset)) {
    notify(t('Die Vorschau passt nicht mehr zum Job (z. B. weil sich die Laserposition geändert hat). Bitte die Vorschau neu öffnen.'), true);
    return false;
  }
  const total = estimate(job.moves, device).total;
  job.moves = startHere(job.moves, i, frac);
  if (!burns(job.moves)) {
    notify(t('Ab dieser Stelle gibt es nichts mehr zu lasern.'), true);
    return false;
  }
  job.warnings.forEach((w) => notify(w));
  const est = estimate(job.moves, device);
  const at = formatDuration(Math.max(0, total - est.total));
  const g = await prepareGCode(job, device, est, t('{name} ab {at}', { name: src?.name ?? 'KizamuBeam', at }));
  notify(t('Job ab {at} gestartet, geschätzt {total}.', { at, total: formatDuration(est.total) }));
  return runGCode(g);
}

export async function frameJob(ed: Editor, contour: boolean, src?: JobSource) {
  if (!canRun()) return;
  const job = await makeJob(ed, false, src);
  const lines = frameGCode(job, device, contour);
  if (!lines) return void nothingToDo(job);
  if (!boundsOk(ed, job)) return;
  await machine.runJob(lines, null, true);
}

export async function saveGCode(ed: Editor, src?: JobSource) {
  const job = await makeJob(ed, false, src);
  if (nothingToDo(job)) return;
  if (device.startFrom === 'current') notify(t('Hinweis: Die Datei enthält die aktuelle Laserposition als Startpunkt.'));
  const g = await prepareGCode(job, device, estimate(job.moves, device), src?.name);
  if (device.fw === 'ruida') return saveRd(ed, g, src);
  const name = src ? `${src.name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-')}.gcode` : 'projekt.gcode';
  const saved = g.lines
    ? await saveText(name, 'G-Code', 'gcode', 'text/plain', g.lines.join('\n') + '\n')
    : (await native<string | null>('gcode_save', { id: g.id, defaultName: name, filterName: 'G-Code' })) !== null;
  if (saved && !src) ed.afterJob();
}

/**
 * Ruida: Job als .rd-Datei speichern (z. B. für den USB-Stick an der Steuerung). Die Datei ist in Maschinenkoordinaten;
 * mit Benutzer-Ursprung muss die Steuerung verbunden sein, damit KizamuBeam den Ursprung kennt.
 */
async function saveRd(ed: Editor, g: PreparedGCode, src?: JobSource) {
  if (!isTauri()) return notify(t('RD-Dateien lassen sich nur in der Desktop-App speichern.'), true);
  const wco = machine.workOffset();
  if (device.startFrom === 'user' && !wco) return notify(t('Für eine RD-Datei mit Benutzer-Ursprung erst mit der Steuerung verbinden und den Ursprung setzen.'), true);
  const name = src ? `${src.name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-')}.rd` : 'projekt.rd';
  const pos = machine.status.mpos;
  try {
    const saved = await native<string | null>('ruida_save', {
      id: g.id, lines: g.lines, connect: ruidaConnect(device), offset: wco ? [wco.x, wco.y] : [0, 0],
      start: pos ? [pos[0], pos[1]] : null, defaultName: name, filterName: t('Ruida-Datei'),
    });
    if (saved !== null && !src) ed.afterJob();
  } catch (e) {
    notify(tBackend(String(e)), true);
  }
}

/** Job und Zeitschätzung des Dokuments ohne Ausgabe (für KI-Agenten) */
export async function jobInfo(ed: Editor) {
  const job = await makeJob(ed, true);
  return { job, est: job.moves.n ? estimate(job.moves, device) : null, device };
}

/** Alle Geräte und die ID des gewählten */
export const deviceList = () => ({ devices: store.devices, current: device.id });

// ---------- Laser-Panel ----------

export function buildLaser(ed: Editor) {
  applyBed(ed);
  // Die Lage auf dem Bett zählt nur, wenn absolut gelasert wird und keine Drehachse läuft
  ed.checkBedApplies = () => device.startFrom === 'absolute' && !rotaryOn(device);
  // Jeder Bereich ist ein eigenes Fenster (andockbar, als Reiter stapelbar, siehe dock.ts)
  const wins: [string, string, HTMLElement, (() => void)?][] = [
    ['laser', t('Laser'), laserTab(ed)],
    ['move', t('Verschieben'), moveTab(ed)],
    ['console', t('Konsole'), consoleTab(), () => windowBody('console').querySelector('input')?.focus()],
    ['material', t('Material'), materialTab(ed)],
    ['camera', t('Kamera'), cameraTab(ed)],
  ];
  for (const [id, title, el, onShow] of wins) dockWindow(id, title, { onShow }).append(el);
  // Laserkopf auf der Arbeitsfläche
  machine.on((e) => {
    if (e.type !== 'status' && e.type !== 'connection') return;
    const p = machine.connected ? machine.status.wpos : null;
    const old = ed.laserPos;
    if (!p) {
      if (old) ((ed.laserPos = null), ed.redraw());
    } else if (!old || Math.abs(old.x - p[0]) > 1e-3 || Math.abs(old.y - p[1]) > 1e-3) {
      ed.laserPos = { x: p[0], y: p[1] };
      ed.redraw();
    }
  });
  window.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openPreview(ed);
    }
  });
}

function stateText(): [string, string] {
  if (machine.connecting) return [t('Verbinde …'), 'busy'];
  if (!machine.connected) return [t('Nicht verbunden'), ''];
  const s = machine.status.state;
  const names: Record<string, string> = {
    Idle: t('Bereit'), Run: t('Läuft'), Hold: t('Angehalten'), Jog: t('Fährt'), Alarm: t('Alarm'), Door: t('Tür offen'), Home: t('Referenzfahrt'), Check: t('Prüfmodus'), Sleep: t('Ruhezustand'),
  };
  const label = names[s] ?? (s || t('Verbunden'));
  return [label, s === 'Alarm' || s === 'Door' ? 'error' : s === 'Idle' || !s ? 'ok' : 'busy'];
}

function laserTab(ed: Editor): HTMLElement {
  const root = h('div', { class: 'laser-tab' });
  const big = (icon: string, label: string, title: string, onclick: () => void) =>
    h('button', { class: 'btn', title, onclick }, h('span', { html: ICONS[icon] }), label);
  const dot = h('span', { class: 'dot' });
  const stTxt = h('span', {});
  const posTxt = h('span', { class: 'pos' });
  const portSel = h('select', { class: 'port', title: t('Schnittstelle oder Netzwerk') }) as HTMLSelectElement;
  const refreshBtn = h('button', { class: 'ib small', title: t('Schnittstellen neu suchen'), html: ICONS.refresh, onclick: () => loadPorts() });
  const connBtn = h('button', { class: 'btn' }, t('Verbinden')) as HTMLButtonElement;
  connBtn.addEventListener('click', async () => {
    if (machine.connected) return machine.disconnect();
    applyPortChoice();
    await machine.connect(device);
  });
  const startB = big('play', t('Start'), t('Job starten'), () => startJob(ed));
  const pauseB = big('pause', t('Pause'), t('Anhalten / fortsetzen'), () => (machine.status.state.startsWith('Hold') ? machine.resume() : machine.pause()));
  const stopB = big('stop', t('Stopp'), t('Job abbrechen'), () => machine.stop());
  const frameB = big('frame', t('Rahmen'), t('Rechteck um den Job abfahren'), () => frameJob(ed, false));
  const contourB = big('contour', t('Kontur'), t('Umriss des Jobs abfahren (Gummiband)'), () => frameJob(ed, true));
  const homeB = big('home', t('Home'), t('Referenzfahrt'), () => {
    if (device.limitSwitches === 'no' && !confirm(t('Für dieses Gerät ist angegeben, dass es keine Endschalter hat. Eine Referenzfahrt fährt dann bis zum Anschlag.\n\nTrotzdem referenzieren?'))) return;
    if (rotaryOn(device) && device.rotary.axis === 'Y' && !confirm(t('Die Drehachse steckt am Y-Anschluss. Eine Referenzfahrt kann sie endlos drehen lassen, weil es dort keinen Endschalter gibt.\n\nTrotzdem referenzieren?'))) return;
    machine.send(fw().home);
  });
  const originB = big('origin', t('Ursprung'), t('Zum Nullpunkt fahren'), () => machine.send('G0 X0 Y0'));
  const previewB = big('preview', t('Vorschau'), t('Vorschau mit Zeitschätzung (Alt+P)'), () => openPreview(ed));
  const saveB = big('gcode', 'G-Code', t('G-Code speichern'), () => saveGCode(ed));
  const bar = h('div', { class: 'progress' }, h('div', { class: 'fill' }));
  const progTxt = h('div', { class: 'progress-text' });
  const msg = h('div', { class: 'note laser-msg' });
  const startFrom = h('select', { onchange: (e: Event) => ((device.startFrom = (e.target as HTMLSelectElement).value as StartFrom), deviceChanged()) },
    h('option', { value: 'absolute' }, t('Absolute Koordinaten')),
    h('option', { value: 'user' }, t('Benutzer-Ursprung')),
    h('option', { value: 'current' }, t('Aktuelle Position')),
  ) as HTMLSelectElement;
  const originGrid = h('div', { class: 'origin-grid', title: t('Job-Ursprung: dieser Punkt des Jobs liegt am Startpunkt') });
  const originBtns = Array.from({ length: 9 }, (_, k) => {
    const b = h('button', { onclick: () => ((device.jobOrigin = k), deviceChanged()) });
    originGrid.append(b);
    return b;
  });
  const check = (label: string, title: string, get: () => boolean, set: (v: boolean) => void) => {
    const c = h('input', { type: 'checkbox', onchange: (e: Event) => (set((e.target as HTMLInputElement).checked), deviceChanged()) }) as HTMLInputElement;
    deviceListeners.add(() => (c.checked = get()));
    c.checked = get();
    return h('label', { class: 'check', title }, c, label);
  };
  // Während des Jobs nachsteuern: Overrides für Leistung, Vorschub und Eilgang, Air Assist, Ausgänge (GRBL-Familie)
  const ovVal: Record<'feed' | 'power', HTMLButtonElement> = {} as never;
  const ovRow = (kind: 'feed' | 'power', label: string, title: string) => {
    const c = OVERRIDE[kind];
    const b = (txt: string, code: number, tip: string) => h('button', { class: 'btn small', title: tip, onclick: () => machine.realtime(code) }, txt);
    ovVal[kind] = h('button', { class: 'btn small ov-val', title: t('Auf 100 % zurücksetzen'), onclick: () => machine.realtime(c.reset) }, '100 %') as HTMLButtonElement;
    return [h('label', { title }, label), h('div', { class: 'ov-row' }, b('−10', c.minus10, t('10 % weniger')), b('−1', c.minus1, t('1 % weniger')), ovVal[kind], b('+1', c.plus1, t('1 % mehr')), b('+10', c.plus10, t('10 % mehr')))];
  };
  const rapidBtns = ([25, 50, 100] as const).map((p) => h('button', { class: 'btn small', onclick: () => machine.realtime(RAPID_OVERRIDE[p]) }, `${p} %`) as HTMLButtonElement);
  const airBtn = h('button', {
    class: 'btn small',
    title: t('Air Assist sofort ein- oder ausschalten, auch während des Jobs'),
    onclick: () => machine.realtime(device.airCmd === 'M7' ? TOGGLE_MIST : TOGGLE_FLOOD),
  }, t('Air Assist')) as HTMLButtonElement;
  const outRow = h('div', { class: 'ov-row' });
  // Zu, solange nichts läuft (spart Platz); beim Start eines Jobs geht es von selbst auf
  const ovBox = h('details', { class: 'ov-box' },
    h('summary', {}, t('Nachsteuern')),
    h('div', { class: 'form' },
      ...ovRow('power', t('Leistung'), t('Laserleistung des laufenden Jobs in Prozent der eingestellten Werte (10 … 200 %)')),
      ...ovRow('feed', t('Geschwindigkeit'), t('Vorschub des laufenden Jobs in Prozent der eingestellten Werte (10 … 200 %)')),
      h('label', { title: t('Eilgang (Leerfahrten) in Prozent') }, t('Eilgang')), h('div', { class: 'ov-row' }, ...rapidBtns),
      h('label', {}, t('Zubehör')), h('div', { class: 'ov-row' }, airBtn),
      h('label', { class: 'ov-out-label', title: t('Freie Ausgänge der FluidNC-Konfiguration (user_outputs), z. B. für Absaugung oder Licht') }, t('Ausgänge')), outRow,
    ),
  );
  const fillOutputs = () => {
    outRow.textContent = '';
    const outs = machine.fluid ? digitalOutputs(machine.fluid.values) : [];
    for (const o of outs)
      outRow.append(h('span', { class: 'ov-out', title: o.pin }, `P${o.n}`,
        h('button', { class: 'btn small', onclick: () => machine.send(outputCmd(o.n, true)) }, t('an')),
        h('button', { class: 'btn small', onclick: () => machine.send(outputCmd(o.n, false)) }, t('aus'))));
    outRow.hidden = !outs.length;
    (ovBox.querySelector('.ov-out-label') as HTMLElement).hidden = !outs.length;
  };
  fillOutputs();
  let ovOpened = false;
  const pinTxt = h('div', { class: 'note pins' });
  const devSel = h('select', { class: 'port', title: t('Gerät'), onchange: (e: Event) => selectDevice(ed, (e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
  const fillDevices = () => {
    devSel.textContent = '';
    for (const d of store.devices) devSel.append(h('option', { value: d.id }, `${d.name} (${FIRMWARES[d.fw].label})`));
    devSel.value = device.id;
  };
  root.append(
    h('div', { class: 'conn-row' }, devSel, h('button', { class: 'btn', title: t('Geräte hinzufügen, bearbeiten, löschen'), onclick: () => openDevicesDialog(ed) }, t('Geräte …'))),
    h('div', { class: 'laser-status' }, h('span', {}, dot, stTxt), posTxt),
    pinTxt,
    h('div', { class: 'conn-row' }, portSel, refreshBtn, connBtn),
    h('div', { class: 'laser-grid' }, startB, pauseB, stopB, frameB, contourB, homeB, originB, previewB, saveB),
    bar,
    progTxt,
    ovBox,
    h('div', { class: 'form' },
      h('label', {}, t('Starten ab')), startFrom,
      h('label', {}, t('Job-Ursprung')), originGrid,
    ),
    h('div', { class: 'checks' },
      check(t('Nur Auswahl'), t('Nur die ausgewählten Objekte lasern'), () => device.cutSelected, (v) => (device.cutSelected = v)),
      check(t('Pfad optimieren'), t('Innere Formen zuerst, kurze Leerwege'), () => device.optimize, (v) => (device.optimize = v)),
      check(t('Drehachse'), t('Rotary einschalten: Y wird zur Umfangsrichtung des Objekts'), () => device.rotary.enabled, (v) => (device.rotary = { ...device.rotary, enabled: v })),
      h('button', { class: 'btn small', title: t('Drehachse (Rotary) einrichten'), onclick: () => openRotaryDialog() }, t('Drehachse …')),
    ),
    h('div', { class: 'conn-row' },
      h('button', { class: 'btn', onclick: () => openDeviceDialog(ed) }, h('span', { html: ICONS.settings }), t('Geräteeinstellungen')),
      h('button', { class: 'btn', title: t('Schritt für Schritt von der Verbindung bis zum ersten Testauftrag'), onclick: () => import('./setupWizard').then((m) => m.openSetupWizard(ed)) }, t('Laser einrichten …')),
    ),
    msg,
  );
  let msgTimer = 0;
  notify = (m, error = false) => {
    machine.log(m, error ? 'error' : 'info');
    msg.textContent = m;
    msg.classList.toggle('error', error);
    clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => (msg.textContent = ''), 12000);
  };

  let ports: PortInfo[] = [];
  const NET = '__net__';
  const NET_WS = '__ws__';
  const NET_UDP = '__udp__';
  const fillPorts = () => {
    portSel.textContent = '';
    const names = ports.map((p) => p.name);
    if (device.port && !names.includes(device.port)) names.unshift(device.port);
    for (const n of names) {
      const p = ports.find((x) => x.name === n);
      portSel.append(h('option', { value: n }, p?.description ? `${n} (${p.description})` : n));
    }
    if (!names.length) portSel.append(h('option', { value: '', disabled: true }, t('Keine serielle Schnittstelle gefunden')));
    // Ruida: Ethernet über UDP statt Telnet/WebSocket
    if (device.fw === 'ruida') portSel.append(h('option', { value: NET_UDP }, t('Ethernet (Ruida): {address}', { address: device.host || '?' })));
    else {
      portSel.append(h('option', { value: NET }, t('WLAN: {address}', { address: `${device.host}:${device.tcpPort}` })));
      portSel.append(h('option', { value: NET_WS }, t('WLAN (WebSocket): {address}', { address: `${device.host}:${device.wsPort}` })));
    }
    const net = device.fw === 'ruida' ? NET_UDP : NET;
    portSel.value = device.conn === 'tcp' || device.conn === 'udp' ? net : device.conn === 'ws' ? NET_WS : device.port || names[0] || net;
  };
  const applyPortChoice = () => {
    if (portSel.value === NET_UDP) device.conn = 'udp';
    else if (portSel.value === NET) device.conn = 'tcp';
    else if (portSel.value === NET_WS) device.conn = 'ws';
    else if (portSel.value) ((device.conn = 'serial'), (device.port = portSel.value));
    deviceChanged();
  };
  portSel.addEventListener('change', applyPortChoice);
  const loadPorts = async () => {
    try {
      ports = await machine.ports();
    } catch (e) {
      notify(t('Schnittstellen konnten nicht gelesen werden: {error}', { error: tBackend(String(e)) }), true);
    }
    fillPorts();
  };
  if (isTauri()) loadPorts();
  else fillPorts();

  const refresh = () => {
    const [stateLabel, cls] = stateText();
    stTxt.textContent = stateLabel + (machine.connected ? ` · ${machine.where}` : '');
    dot.className = `dot ${cls}`;
    const p = machine.connected ? machine.status.wpos : null;
    posTxt.textContent = p ? `X ${p[0].toFixed(2)}  Y ${p[1].toFixed(2)}` : '';
    devSel.disabled = machine.connected || machine.connecting;
    const on = machine.connected,
      busy = machine.running || !!uploading;
    connBtn.textContent = on ? t('Trennen') : machine.connecting ? t('Verbinde …') : t('Verbinden');
    connBtn.disabled = machine.connecting || (!isTauri() && !on);
    portSel.disabled = on || machine.connecting || !isTauri();
    refreshBtn.disabled = portSel.disabled;
    for (const b of [startB, frameB, contourB, homeB, originB]) b.disabled = !on || busy;
    pauseB.disabled = !on;
    stopB.disabled = !on;
    const hold = machine.status.state.startsWith('Hold');
    pauseB.lastChild!.textContent = hold ? t('Weiter') : t('Pause');
    (pauseB.firstChild as HTMLElement).innerHTML = hold ? ICONS.play : ICONS.pause;
    const pr = machine.progress;
    const stored = machine.storedJob;
    const showProg = (!!pr && !machine.jobIsFrame) || !!stored || !!uploading;
    bar.hidden = progTxt.hidden = !showProg;
    const el = (since: number) => t('{time} vergangen', { time: formatDuration((performance.now() - since) / 1000) });
    if (uploading) {
      const f = uploading.total ? uploading.sent / uploading.total : 0;
      (bar.firstChild as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
      progTxt.textContent = t('Lade auf die Steuerung … {pct} %', { pct: Math.floor(f * 100) });
    } else if (stored) {
      const f = (machine.status.sd?.pct ?? 0) / 100;
      (bar.firstChild as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
      progTxt.textContent = `${Math.floor(f * 100)} % · ${t('läuft auf der Steuerung')} · ${el(stored.started)}`;
    } else if (pr && showProg) {
      const f = machine.jobFraction();
      (bar.firstChild as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
      const rest = machine.remaining();
      progTxt.textContent = `${Math.floor(f * 100)} % · ${el(machine.jobStarted)}${rest !== null ? t(' · noch etwa {rest}', { rest: formatDuration(rest) }) : ''}${pr.errors ? tn(' · {n} Fehler', ' · {n} Fehler', pr.errors) : ''}`;
    }
    // Nachsteuern: nur GRBL-Familie; Ov meldet die Steuerung nur ab und zu
    ovBox.hidden = !on || !fw().overrides;
    if (busy && !ovOpened) ((ovBox as HTMLDetailsElement).open = true), (ovOpened = true);
    if (!busy) ovOpened = false;
    const ov = machine.status.ov;
    ovVal.feed.textContent = `${ov ? ov[0] : 100} %`;
    ovVal.power.textContent = `${ov ? ov[2] : 100} %`;
    ovVal.feed.classList.toggle('changed', !!ov && ov[0] !== 100);
    ovVal.power.classList.toggle('changed', !!ov && ov[2] !== 100);
    rapidBtns.forEach((b, i) => b.classList.toggle('cur', (ov ? ov[1] : 100) === [25, 50, 100][i]));
    airBtn.classList.toggle('cur', /[FM]/.test(machine.status.acc));
    const pins = on ? pinNames(machine.status.pins) : [];
    pinTxt.textContent = pins.length ? t('Aktive Eingänge: {pins}', { pins: pins.join(', ') }) : '';
    pinTxt.hidden = !pins.length;
    startFrom.value = device.startFrom;
    originBtns.forEach((b, k) => b.classList.toggle('cur', k === device.jobOrigin));
    originGrid.classList.toggle('disabled', device.startFrom === 'absolute');
  };
  machine.on((e) => {
    if (e.type === 'done') notify(e.message, !e.ok);
    if (e.type === 'config' || e.type === 'connection') fillOutputs();
    if (e.type !== 'line') refresh();
  });
  uploadListeners.add(refresh);
  deviceListeners.add(() => (fillDevices(), fillPorts(), refresh()));
  fillDevices();
  // Fortschrittstext auch ohne neue Ereignisse aktualisieren (vergangene Zeit)
  setInterval(() => machine.running && refresh(), 1000);
  refresh();
  return root;
}

// ---------- Verschieben ----------

function moveTab(ed: Editor): HTMLElement {
  const root = h('div', { class: 'move-tab' });
  const st = { step: 10, speed: 3000 };
  const jog = (dx: number, dy: number) => {
    if (!machine.connected) return notify(t('Nicht verbunden.'), true);
    for (const l of jogLines(device, dx * st.step, dy * st.step, st.speed)) machine.send(l);
  };
  const pad = h('div', { class: 'jog' });
  const arrows: [number, number, string][] = [
    [-1, 1, '↖'], [0, 1, '↑'], [1, 1, '↗'],
    [-1, 0, '←'], [0, 0, '⌖'], [1, 0, '→'],
    [-1, -1, '↙'], [0, -1, '↓'], [1, -1, '↘'],
  ];
  for (const [dx, dy, label] of arrows)
    pad.append(
      h('button', {
        class: 'btn',
        title: dx || dy ? t('{step} mm verfahren', { step: st.step }) : t('Zum Nullpunkt fahren'),
        onclick: () => (dx || dy ? jog(dx, dy) : machine.send('G0 X0 Y0')),
      }, label),
    );
  const stepSel = h('select', { onchange: (e: Event) => (st.step = Number((e.target as HTMLSelectElement).value)) },
    ...[0.1, 1, 5, 10, 50, 100].map((v) => h('option', { value: String(v), selected: v === st.step }, `${dec(String(v))} mm`)),
  );
  const speed = numInput('', (v) => v > 0 && (st.speed = v), t('Geschwindigkeit in mm/min'));
  speed.value = String(st.speed);
  const pos = h('div', { class: 'move-pos' });
  const toSelection = () => {
    const b = ed.selBounds();
    if (!b) return notify(t('Keine Auswahl.'), true);
    const box = { x0: b.x, y0: ed.doc.bed.h - b.y - b.h, x1: b.x + b.w, y1: ed.doc.bed.h - b.y };
    const a = anchorOf(box, device.jobOrigin);
    machine.send(`G0 X${a.x.toFixed(3)} Y${a.y.toFixed(3)}`);
  };
  // Laser zur Klickposition: solange aktiv, fährt jeder Klick auf die Arbeitsfläche den Laser dorthin (Esc beendet)
  const goTo = (p: { x: number; y: number }) => {
    if (!machine.connected) return notify(t('Nicht verbunden.'), true);
    if (machine.running) return notify(t('Während eines Jobs nicht möglich.'), true);
    const bed = ed.doc.bed;
    if (p.x < 0 || p.y < 0 || p.x > bed.w || p.y > bed.h) return notify(t('Die Position liegt außerhalb des Arbeitsbereichs.'), true);
    // Werkstückkoordinaten wie die Laserkopf-Anzeige (y nach oben); mit Drehachse nur X
    for (const l of jogToLines(device, p.x, rotaryOn(device) ? null : bed.h - p.y, st.speed)) machine.send(l);
  };
  const clickB = h('button', {
    class: 'btn', title: t('Danach fährt jeder Klick auf die Arbeitsfläche den Laser dorthin (Esc beendet)'),
    onclick: () => {
      if (ed.pickHandler === goTo) return ed.endPick();
      ed.startPick(goTo, () => clickB.classList.remove('on'), t('Klick auf die Arbeitsfläche fährt den Laser dorthin. Esc beendet.'));
      clickB.classList.add('on');
      if (rotaryOn(device)) notify(t('Mit Drehachse fährt der Klick nur in X.'));
    },
  }, t('Laser zur Klickposition')) as HTMLButtonElement;
  const setO = h('button', { class: 'btn', title: t('Werkstück-Nullpunkt an die aktuelle Position legen'), onclick: () => machine.send(fw().setOrigin) }, t('Ursprung hier setzen')) as HTMLButtonElement;
  const clearO = h('button', { class: 'btn', title: t('Werkstück-Nullpunkt auf den Maschinen-Nullpunkt zurücksetzen'), onclick: () => fw().clearOrigin && machine.send(fw().clearOrigin!) }, t('Ursprung löschen')) as HTMLButtonElement;
  const unlock = h('button', { class: 'btn', title: t('Alarm aufheben'), onclick: () => fw().unlock && machine.send(fw().unlock!) }, t('Entsperren')) as HTMLButtonElement;
  root.append(
    pos,
    h('div', { class: 'move-row' }, pad,
      h('div', { class: 'form move-form' },
        h('label', {}, t('Schritt')), stepSel,
        h('label', {}, 'mm/min'), speed,
      ),
    ),
    h('div', { class: 'move-buttons' },
      setO,
      clearO,
      h('button', { class: 'btn', title: t('Laser zum Job-Ursprung der Auswahl fahren (absolute Koordinaten)'), onclick: toSelection }, t('Laser zur Auswahl')),
      clickB,
      unlock,
    ),
  );
  const refresh = () => {
    const s = machine.status;
    pos.textContent = machine.connected && s.wpos
      ? t('Position X {x}  Y {y} mm', { x: s.wpos[0].toFixed(2), y: s.wpos[1].toFixed(2) }) + (s.mpos && (Math.abs(s.mpos[0] - s.wpos[0]) > 1e-3 || Math.abs(s.mpos[1] - s.wpos[1]) > 1e-3) ? t(' (Maschine {x} / {y})', { x: s.mpos[0].toFixed(2), y: s.mpos[1].toFixed(2) }) : '')
      : t('Nicht verbunden');
    root.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = !machine.connected || machine.running));
    if (!fw().clearOrigin) clearO.disabled = true;
    if (!fw().unlock) unlock.disabled = true;
  };
  machine.on((e) => e.type !== 'line' && refresh());
  deviceListeners.add(refresh);
  refresh();
  return root;
}

// ---------- Konsole ----------

function consoleTab(): HTMLElement {
  const root = h('div', { class: 'console-tab' });
  const log = h('div', { class: 'console-log' });
  const input = h('input', { type: 'text', placeholder: t('Befehl, z. B. $I oder G0 X10'), spellcheck: false }) as HTMLInputElement;
  const history: string[] = [];
  let hi = 0;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && input.value.trim()) {
      const v = input.value.trim();
      history.push(v);
      hi = history.length;
      input.value = '';
      if (v === '?' && fw().realtime) machine.realtime(0x3f);
      else machine.send(v);
    } else if (e.key === 'ArrowUp' && hi > 0) {
      e.preventDefault();
      input.value = history[--hi];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      hi = Math.min(history.length, hi + 1);
      input.value = history[hi] ?? '';
    }
  });
  const quick = (label: string, cmd: string, title: string) => h('button', { class: 'btn', title, onclick: () => machine.send(cmd) }, label);
  const quickRow = h('div', { class: 'console-quick' });
  // Schnellknöpfe passend zur Firmware des gewählten Geräts
  const fillQuick = () => {
    quickRow.textContent = '';
    const f = fw();
    if (device.fw === 'marlin') quickRow.append(quick('M115', 'M115', t('Firmware-Version')), quick('M114', 'M114', t('Position')), quick('M503', 'M503', t('Einstellungen anzeigen')));
    else if (device.fw === 'ruida')
      quickRow.append(
        quick(f.home, f.home, t('Referenzfahrt')),
        quick('$I', '$I', t('Version und Gerät')),
        h('button', { class: 'btn', title: t('Einstellungen der Ruida-Steuerung lesen und ändern'), onclick: () => import('./ruidaDialog').then((m) => m.openRuidaSettings()) }, t('Einstellungen …')),
      );
    else {
      if (f.unlock) quickRow.append(quick(f.unlock, f.unlock, t('Entsperren')));
      quickRow.append(quick(f.home, f.home, t('Referenzfahrt')));
      if (device.fw !== 'smoothie') quickRow.append(quick('$I', '$I', t('Version und Gerät')), quick('$$', '$$', t('Einstellungen anzeigen')));
    }
    quickRow.append(h('button', { class: 'btn', title: t('Konsole leeren'), onclick: () => (log.textContent = '') }, t('Leeren')));
  };
  fillQuick();
  deviceListeners.add(fillQuick);
  root.append(log, h('div', { class: 'console-input' }, input), quickRow);
  machine.on((e) => {
    if (e.type !== 'line') return;
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.append(h('div', { class: `ln ${e.dir}` }, e.dir === 'out' ? `> ${e.line}` : e.line));
    while (log.childElementCount > 1000) log.firstChild!.remove();
    if (atEnd) log.scrollTop = log.scrollHeight;
  });
  if (!isTauri()) machine.log(t('Im Browser gibt es keine Maschinenanbindung. Vorschau und G-Code speichern funktionieren.'));
  return root;
}

// ---------- Geräteeinstellungen ----------

/** Einstellungen eines Geräts bearbeiten (ohne Angabe: das gewählte) */
export function openDeviceDialog(ed: Editor, target: Device = device, onDone?: () => void) {
  const d = { ...target };
  const bed = { w: d.bedW, h: d.bedH };
  const isCurrent = target === device;
  const rows: (HTMLElement | string)[] = [];
  const num = (label: string, get: () => number, set: (v: number) => void, title?: string) => {
    const el = numInput('', (v) => v > 0 && set(v), title);
    el.value = String(get());
    rows.push(h('label', { title }, label), el);
    return el;
  };
  const text = (label: string, get: () => string, set: (v: string) => void) => {
    const el = h('input', { type: 'text', value: get(), oninput: (e: Event) => set((e.target as HTMLInputElement).value) }) as HTMLInputElement;
    rows.push(h('label', {}, label), el);
  };
  const bool = (label: string, get: () => boolean, set: (v: boolean) => void, title?: string) => {
    const el = h('input', { type: 'checkbox', checked: get(), onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
    rows.push(h('label', { title }, label), h('span', {}, el));
  };
  const head = (t: string) => rows.push(h('div', { class: 'sub' }, t));
  head(t('Gerät'));
  text(t('Name'), () => d.name, (v) => (d.name = v));
  const sMaxRef: { el?: HTMLInputElement } = {};
  const fwSel = h('select', {
    onchange: (e: Event) => {
      const old = FIRMWARES[d.fw];
      d.fw = (e.target as HTMLSelectElement).value as Firmware;
      // Leistungsskala mitziehen, wenn sie noch dem Standard der alten Firmware entsprach
      if (d.sMax === old.sMax && sMaxRef.el) ((d.sMax = FIRMWARES[d.fw].sMax), (sMaxRef.el.value = String(d.sMax)));
      readBtn.disabled = !canRead();
    },
  }, ...(Object.keys(FIRMWARES) as Firmware[]).map((k) => h('option', { value: k, selected: k === d.fw }, FIRMWARES[k].label))) as HTMLSelectElement;
  rows.push(h('label', {}, t('Steuerung (Firmware)')), fwSel);
  const bw = num(t('Breite (mm)'), () => bed.w, (v) => (bed.w = v), t('Arbeitsbereich X'));
  const bh = num(t('Höhe (mm)'), () => bed.h, (v) => (bed.h = v), t('Arbeitsbereich Y'));
  sMaxRef.el = num(t('S-Wert für 100 %'), () => d.sMax, (v) => (d.sMax = v), t('GRBL $30 bzw. FluidNC speed_map (meist 1000), Marlin meist 255, Smoothieware 1'));
  head(t('Verbindung|Gerät'));
  rows.push(h('label', {}, t('Anschluss')), h('select', { onchange: (e: Event) => (d.conn = (e.target as HTMLSelectElement).value as Device['conn']) },
    h('option', { value: 'serial', selected: d.conn === 'serial' }, t('USB (seriell)')),
    h('option', { value: 'tcp', selected: d.conn === 'tcp' }, t('WLAN (Telnet)')),
    h('option', { value: 'ws', selected: d.conn === 'ws' }, t('WLAN (WebSocket)')),
    h('option', { value: 'udp', selected: d.conn === 'udp' }, t('Ethernet (Ruida, UDP)')),
  ));
  // Schnittstelle frei eintragbar (z. B. COM3, /dev/ttyUSB0), erkannte Schnittstellen als Vorschlag
  const portList = h('datalist', { id: `ports-${Math.random().toString(36).slice(2)}` });
  const portIn = h('input', { type: 'text', value: d.port, placeholder: t('z. B. COM3 oder /dev/ttyUSB0'), oninput: (e: Event) => (d.port = (e.target as HTMLInputElement).value.trim()) });
  portIn.setAttribute('list', portList.id);
  rows.push(h('label', { title: t('Feste USB-Schnittstelle dieses Geräts') }, t('USB-Schnittstelle')), portIn, portList);
  machine.ports().then((ps) => ps.forEach((p) => portList.append(h('option', { value: p.name }, p.description || p.name)))).catch(() => {});
  const baud = h('select', { onchange: (e: Event) => (d.baud = Number((e.target as HTMLSelectElement).value)) },
    ...[57600, 115200, 230400, 250000, 460800, 921600].map((b) => h('option', { value: String(b), selected: b === d.baud }, String(b))),
  );
  rows.push(h('label', {}, t('Baudrate')), baud);
  const hostIn = h('input', { type: 'text', value: d.host, oninput: (e: Event) => (d.host = (e.target as HTMLInputElement).value.trim()) }) as HTMLInputElement;
  rows.push(h('label', {}, t('WLAN-Adresse')), h('span', { class: 'conn-row' }, hostIn,
    h('button', {
      class: 'btn small', title: t('FluidNC-Steuerungen im lokalen Netzwerk suchen'),
      onclick: () => import('./fluidncDialog').then((m) => m.openDiscovery(d.httpPort || 80, (host) => ((d.host = host), (hostIn.value = host)))),
    }, t('Suchen …'))));
  num(t('Telnet-Port'), () => d.tcpPort, (v) => (d.tcpPort = Math.round(v)));
  num(t('WebSocket-Port'), () => d.wsPort, (v) => (d.wsPort = Math.round(v)), t('FluidNC: 81; ist er nicht erreichbar, wird 80 versucht'));
  num(t('Web-Port'), () => d.httpPort, (v) => (d.httpPort = Math.round(v)), t('Weboberfläche von FluidNC (meist 80): zum Hochladen auf SD-Karte/Flash und für die Suche'));
  // Empfangspuffer für die Zeichenzählung; größer = flüssiger bei vielen kurzen Zeilen (Bildgravur)
  const bufNote = h('div', { class: 'note wide' });
  const bufSel = h('select', { onchange: (e: Event) => (d.rxBuffer = Number((e.target as HTMLSelectElement).value)) },
    ...[127, 256, 512, 1024].map((b) => h('option', { value: String(b), selected: b === d.rxBuffer }, b === 127 ? t('127 Bytes (sicher)') : t('{n} Bytes', { n: b }))),
  ) as HTMLSelectElement;
  if (![127, 256, 512, 1024].includes(d.rxBuffer)) bufSel.append(h('option', { value: String(d.rxBuffer), selected: true }, t('{n} Bytes', { n: d.rxBuffer })));
  const measureBuf = () => {
    const bf = machine.status.bf;
    if (!isCurrent || !machine.connected) return void (bufNote.textContent = t('Zum Messen erst verbinden.'));
    if (machine.running || machine.status.state !== 'Idle') return void (bufNote.textContent = t('Zum Messen muss die Maschine still stehen.'));
    if (!bf) return void (bufNote.textContent = t('Die Steuerung meldet ihren Puffer nicht (Bf: im Statusbericht; bei GRBL mit $10=2). Größere Werte nur ausprobieren: treten Fehler oder Aussetzer auf, zurück auf 127.'));
    const free = Math.max(64, bf[1] - 1);
    if (![...bufSel.options].some((o) => o.value === String(free))) bufSel.append(h('option', { value: String(free) }, t('{n} Bytes', { n: free })));
    bufSel.value = String(free);
    d.rxBuffer = free;
    bufNote.textContent = t('Die Steuerung meldet {n} Bytes freien Empfangspuffer; eingestellt auf {m}.', { n: bf[1], m: free });
  };
  rows.push(h('label', { title: t('Wie viele Zeichen KizamuBeam an die Steuerung schickt, bevor sie bestätigt hat. Wirkt beim nächsten Verbinden.') }, t('Empfangspuffer')),
    h('span', { class: 'conn-row' }, bufSel, h('button', { class: 'btn small', title: t('Pufferstand der verbundenen Steuerung lesen'), onclick: measureBuf }, t('Messen'))), bufNote);
  bool(t('Beim Verbinden referenzieren'), () => d.homeOnConnect, (v) => (d.homeOnConnect = v), t('Nach dem Verbinden eine Referenzfahrt starten'));
  rows.push(h('label', { title: t('Ohne Endschalter bietet der Assistent „Laser einrichten“ keine Referenzfahrt an') }, t('Endschalter')), h('select', { onchange: (e: Event) => (d.limitSwitches = (e.target as HTMLSelectElement).value as Device['limitSwitches']) },
    h('option', { value: 'unknown', selected: d.limitSwitches === 'unknown' }, t('Unbekannt')),
    h('option', { value: 'yes', selected: d.limitSwitches === 'yes' }, t('Vorhanden')),
    h('option', { value: 'no', selected: d.limitSwitches === 'no' }, t('Keine')),
  ));
  head(t('Bewegung (für die Zeitschätzung)'));
  const rapid = num(t('Eilgang (mm/min)'), () => d.rapid, (v) => (d.rapid = v));
  const accel = num(t('Beschleunigung (mm/s²)'), () => d.accel, (v) => (d.accel = v));
  bool(t('Nach dem Job zurück zum Start'), () => d.returnHome, (v) => (d.returnHome = v));
  head(t('Rahmen'));
  num(t('Geschwindigkeit (mm/min)'), () => d.frameSpeed, (v) => (d.frameSpeed = v));
  bool(t('Mit Laser (schwach)'), () => d.frameLaser, (v) => (d.frameLaser = v), t('Rahmen mit niedriger Leistung sichtbar machen'));
  num(t('Leistung (%)'), () => d.framePower, (v) => (d.framePower = Math.min(100, v)));
  head(t('Air Assist'));
  rows.push(h('label', { title: t('Wird auf Layern mit „Air Assist“ vor dem Lasern gesendet, ausgeschaltet wird mit M9') }, t('Einschalten mit')), h('select', { onchange: (e: Event) => (d.airCmd = (e.target as HTMLSelectElement).value as Device['airCmd']) },
    h('option', { value: 'M8', selected: d.airCmd !== 'M7' }, t('M8 (Flood, üblich)')),
    h('option', { value: 'M7', selected: d.airCmd === 'M7' }, 'M7 (Mist)'),
  ));
  head(t('Z-Achse'));
  bool(t('Motorische Z-Achse vorhanden'), () => d.zAxis, (v) => (d.zAxis = v), t('Layer dürfen den Fokus verschieben (Z-Versatz, tiefer je Durchgang). Z fährt relativ zur Höhe beim Start und am Ende zurück.'));
  bool(t('Z+ fährt Richtung Material'), () => d.zFlip, (v) => (d.zFlip = v), t('Einschalten, wenn bei dieser Maschine positive Z-Werte den Tisch anheben oder den Kopf absenken'));
  head('FluidNC');
  rows.push(h('label', { title: t('Bei WLAN-Aussetzern läuft ein Job von SD-Karte oder Flash weiter; er wird vor dem Start über die Weboberfläche hochgeladen') }, t('Job ausführen')),
    h('select', { onchange: (e: Event) => (d.runFrom = (e.target as HTMLSelectElement).value as Device['runFrom']) },
      h('option', { value: 'stream', selected: d.runFrom === 'stream' }, t('Vom Rechner senden')),
      h('option', { value: 'sd', selected: d.runFrom === 'sd' }, t('Auf SD-Karte laden und dort starten')),
      h('option', { value: 'localfs', selected: d.runFrom === 'localfs' }, t('Im Flash speichern und dort starten')),
    ));
  const outsIn = h('input', {
    type: 'text', value: d.jobOutputs.join(', '), placeholder: t('z. B. 0, 1'),
    onchange: (e: Event) => {
      const el = e.target as HTMLInputElement;
      d.jobOutputs = [...new Set(el.value.split(/[\s,;]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 8))];
      el.value = d.jobOutputs.join(', ');
    },
  }) as HTMLInputElement;
  rows.push(h('label', { title: t('Digitale Ausgänge (user_outputs, M64/M65 P…), die während jedes Jobs an sind, z. B. Absaugung') }, t('Ausgänge im Job')), outsIn);
  rows.push(h('label', {}, ''), h('span', { class: 'conn-row' },
    h('button', { class: 'btn small', title: t('config.yaml der verbundenen Steuerung lesen und ändern'), onclick: () => import('./fluidncDialog').then((m) => m.openFluidConfig()) }, t('Konfiguration …')),
    h('button', { class: 'btn small', title: t('Dateien auf SD-Karte und Flash'), onclick: () => import('./fluidncDialog').then((m) => m.openFluidFiles(ed)) }, t('Dateien …')),
  ));
  head('Ruida');
  rows.push(h('div', { class: 'note wide' }, t('Für CO2-Laser mit Ruida-Steuerung (RDC6442, RDC6445, RDC6332 …): als Firmware „Ruida“ wählen, Anschluss „Ethernet (Ruida, UDP)“ mit der IP-Adresse der Steuerung (ab Werk meist 192.168.1.100) oder USB. LightBurn und RDWorks dürfen dabei nicht verbunden sein.')));
  rows.push(h('label', { title: t('Ecke, an die die Steuerung bei der Referenzfahrt fährt; dort ist ihr Nullpunkt') }, t('Nullpunkt der Steuerung')),
    h('select', { onchange: (e: Event) => (d.ruidaOrigin = (e.target as HTMLSelectElement).value as RuidaOrigin) },
      h('option', { value: 'tr', selected: d.ruidaOrigin === 'tr' }, t('Oben rechts (üblich)')),
      h('option', { value: 'tl', selected: d.ruidaOrigin === 'tl' }, t('Oben links')),
      h('option', { value: 'br', selected: d.ruidaOrigin === 'br' }, t('Unten rechts')),
      h('option', { value: 'bl', selected: d.ruidaOrigin === 'bl' }, t('Unten links')),
    ));
  rows.push(h('label', { title: t('Ruida-Steuerungen verwürfeln jedes Byte mit einem Schlüssel; er hängt von der Baureihe ab') }, t('Schlüssel')),
    h('select', { onchange: (e: Event) => (d.ruidaMagic = Number((e.target as HTMLSelectElement).value)) },
      h('option', { value: '0', selected: !d.ruidaMagic }, t('Beim Verbinden erkennen')),
      h('option', { value: String(0x88), selected: d.ruidaMagic === 0x88 }, t('0x88 (RDC644x, die meisten)')),
      h('option', { value: String(0x11), selected: d.ruidaMagic === 0x11 }, t('0x11 (RDC634x)')),
      h('option', { value: String(0x38), selected: d.ruidaMagic === 0x38 }, '0x38'),
    ));
  num(t('Min-Leistung in Ecken (%)'), () => d.ruidaMinPower, (v) => (d.ruidaMinPower = Math.min(100, v)),
    t('Ruida senkt die Leistung beim Abbremsen bis auf diesen Anteil der Layer-Leistung (nur bei Leistung je Geschwindigkeit, M4). 100 = immer volle Layer-Leistung'));
  rows.push(h('label', {}, ''), h('span', { class: 'conn-row' },
    h('button', { class: 'btn small', title: t('Einstellungen der verbundenen Ruida-Steuerung lesen und ändern'), onclick: () => import('./ruidaDialog').then((m) => m.openRuidaSettings()) }, t('Steuerung …')),
  ));
  rows.push(h('div', { class: 'note wide' }, t('Mit Ruida nicht möglich: Z-Versatz im Job, Zusatzachsen als Drehachse, Ausgänge im Job, eigene G-Code-Skripte. Eine Drehachse am Y-Anschluss geht nur, solange der Job in den Y-Fahrbereich passt; sonst den Rotary-Modus der Steuerung verwenden und die Drehachse hier ausschalten. Solche Jobs lehnt KizamuBeam vor dem Senden mit einer Meldung ab. Speichern erzeugt eine .rd-Datei.')));
  head(t('G-Code-Skripte'));
  const script = (label: string, title: string, get: () => string, set: (v: string) => void) => {
    const el = h('textarea', { class: 'script', rows: 3, spellcheck: false, placeholder: t('Eine Zeile je Befehl'), oninput: (e: Event) => set((e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
    el.value = get();
    rows.push(h('label', { class: 'wide', title }, label), el);
  };
  script(t('Vor dem Job'), t('Wird nach G21, G90 und dem Laser-Modus gesendet, vor der ersten Bewegung'), () => d.startScript, (v) => (d.startScript = v));
  script(t('Nach dem Job'), t('Wird nach dem Ausschalten des Lasers (M5) gesendet, vor dem Programmende'), () => d.endScript, (v) => (d.endScript = v));
  rows.push(h('div', { class: 'note wide' }, t('Gilt für Jobs und gespeicherten G-Code, nicht für Rahmenfahrten. Die Zeilen werden unverändert gesendet.')));
  head(t('KI-Agenten'));
  const limit = (label: string, title: string, get: () => number, set: (v: number) => void) => {
    const el = numInput('', (v) => {
      set(v);
      el.value = String(get());
    }, title);
    el.value = String(get());
    rows.push(h('label', { title }, label), el);
  };
  limit(t('Höchste Leistung (%)'), t('Jobs, die ein KI-Agent anfordert, dürfen auf keinem Layer mehr Leistung haben'),
    () => d.agentMaxPower, (v) => (d.agentMaxPower = Math.max(0, Math.min(100, v))));
  limit(t('Kleinste Geschwindigkeit (mm/min)'), t('Jobs, die ein KI-Agent anfordert, dürfen nirgends langsamer sein (0 = keine Grenze)'),
    () => d.agentMinSpeed, (v) => (d.agentMinSpeed = Math.max(0, v)));
  const readNote = h('div', { class: 'note' });
  // Lesen nur vom verbundenen Gerät und nur bei FluidNC und GRBL-artigen Steuerungen
  const canRead = () => isCurrent && machine.connected && !machine.running && FIRMWARES[d.fw].read !== null;
  const readBtn: HTMLButtonElement = h('button', {
    class: 'btn',
    disabled: !canRead(),
    title: t('Arbeitsbereich, Eilgang, Beschleunigung und Leistungsskala aus der Steuerung lesen (FluidNC, GRBL, grblHAL)'),
    onclick: () => {
      readNote.textContent = t('Lese Einstellungen …');
      const got: Record<string, number> = {};
      const off = machine.on((e) => {
        if (e.type !== 'line') return;
        // FluidNC: $/axes/x/max_travel_mm=400.000 · GRBL: $130=400.000
        let m = /\/axes\/([xy])\/(max_travel_mm|max_rate_mm_per_min|acceleration_mm_per_sec2)\s*[=:]\s*([\d.]+)/i.exec(e.line);
        if (m) got[`${m[1].toLowerCase()}.${m[2]}`] = Number(m[3]);
        m = /^\$(30|11[01]|12[01]|13[01])=([\d.]+)/.exec(e.line);
        if (m) {
          const key: Record<string, string> = { '30': 'smax', '110': 'x.max_rate_mm_per_min', '111': 'y.max_rate_mm_per_min', '120': 'x.acceleration_mm_per_sec2', '121': 'y.acceleration_mm_per_sec2', '130': 'x.max_travel_mm', '131': 'y.max_travel_mm' };
          got[key[m[1]]] = Number(m[2]);
        }
      });
      if (FIRMWARES[d.fw].read === 'fluidnc') {
        for (const ax of ['x', 'y']) for (const k of ['max_travel_mm', 'max_rate_mm_per_min', 'acceleration_mm_per_sec2']) machine.send(`$/axes/${ax}/${k}`);
      } else machine.send('$$');
      setTimeout(() => {
        off();
        const found: string[] = [];
        if (got['x.max_travel_mm'] && got['y.max_travel_mm']) {
          bed.w = got['x.max_travel_mm'];
          bed.h = got['y.max_travel_mm'];
          bw.value = String(bed.w);
          bh.value = String(bed.h);
          found.push(t('Arbeitsbereich {w} × {h} mm', { w: bed.w, h: bed.h }));
        }
        const r = Math.min(got['x.max_rate_mm_per_min'] || Infinity, got['y.max_rate_mm_per_min'] || Infinity);
        if (isFinite(r)) ((d.rapid = r), (rapid.value = String(r)), found.push(t('Eilgang {r} mm/min', { r })));
        const a = Math.min(got['x.acceleration_mm_per_sec2'] || Infinity, got['y.acceleration_mm_per_sec2'] || Infinity);
        if (isFinite(a)) ((d.accel = a), (accel.value = String(a)), found.push(t('Beschleunigung {a} mm/s²', { a })));
        if (got.smax && sMaxRef.el) ((d.sMax = got.smax), (sMaxRef.el.value = String(got.smax)), found.push(t('S-Wert für 100 % {smax}', { smax: got.smax })));
        readNote.textContent = found.length ? t('Gelesen: {found}. Mit „Übernehmen“ speichern.', { found: found.join(', ') }) : t('Keine Werte erhalten. Details stehen in der Konsole.');
      }, 2500);
    },
  }, t('Von der Maschine lesen'));
  const dlg = h('dialog', { class: 'device-dialog' },
    h('h3', {}, t('Geräteeinstellungen: {name}', { name: target.name })),
    h('div', { class: 'form' }, ...rows),
    h('div', { class: 'conn-row' }, readBtn),
    readNote,
    h('div', { class: 'dialog-buttons' },
      h('button', { class: 'btn', onclick: () => dlg.close() }, t('Abbrechen')),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          // Felder, die noch den Fokus haben, zuerst übernehmen
          (document.activeElement as HTMLElement | null)?.blur();
          Object.assign(target, d, { bedW: bed.w, bedH: bed.h });
          if (isCurrent) applyBed(ed);
          deviceChanged();
          dlg.close();
          onDone?.();
        },
      }, t('Übernehmen')),
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- Drehachse ----------

/** Drehachse (Rotary) des gewählten Geräts einrichten, wie „Rotary Setup“ in LightBurn */
export function openRotaryDialog() {
  const target = device;
  const r: Rotary = { ...DEFAULT_ROTARY, ...target.rotary };
  const rows: HTMLElement[] = [];
  const row = (label: string, el: HTMLElement, title?: string) => {
    const lab = h('label', { title }, label);
    rows.push(lab, el);
    return [lab, el];
  };
  const numField = (get: () => number, set: (v: number) => void, title?: string) => {
    const el = numInput('', (v) => v > 0 && (set(v), update()), title);
    el.value = String(get());
    return el;
  };
  const enabled = h('input', { type: 'checkbox', checked: r.enabled, onchange: (e: Event) => ((r.enabled = (e.target as HTMLInputElement).checked), update()) });
  row(t('Drehachse einschalten'), h('span', {}, enabled));
  const kind = h('select', { onchange: (e: Event) => ((r.kind = (e.target as HTMLSelectElement).value as Rotary['kind']), update()) },
    h('option', { value: 'roller', selected: r.kind === 'roller' }, t('Walzen')),
    h('option', { value: 'chuck', selected: r.kind === 'chuck' }, t('Futter')),
  );
  row(t('Art'), kind);
  const axis = h('select', { onchange: (e: Event) => ((r.axis = (e.target as HTMLSelectElement).value as RotaryAxis), update()) },
    h('option', { value: 'Y', selected: r.axis === 'Y' }, t('Y (Rotary statt Y-Motor angeschlossen)')),
    ...(['A', 'B', 'C', 'Z'] as RotaryAxis[]).map((a) => h('option', { value: a, selected: r.axis === a }, t('{axis} (eigene Achse)', { axis: a }))),
  );
  row(t('Achse'), axis, t('Wo der Rotary an der Steuerung hängt'));
  const perRevLabel = h('span', {});
  const perRev = numField(() => r.perRev, (v) => (r.perRev = v), t('Achsweg, den die Steuerung für eine volle Umdrehung der Walze bzw. des Futters fährt'));
  rows.push(h('label', {}, perRevLabel), perRev);
  const [rollerLab, rollerEl] = row(t('Walzendurchmesser (mm)'), numField(() => r.rollerDiam, (v) => (r.rollerDiam = v)), t('Durchmesser der angetriebenen Walze'));
  const objDiam = numField(() => r.objectDiam, (v) => ((r.objectDiam = v), (circ.value = (Math.PI * v).toFixed(2))), t('Am breitesten Punkt der Gravur messen'));
  row(t('Objektdurchmesser (mm)'), objDiam);
  const circ = numInput('', (v) => v > 0 && ((r.objectDiam = v / Math.PI), (objDiam.value = r.objectDiam.toFixed(2)), update()), t('Umfang statt Durchmesser eingeben, z. B. mit einem Maßband gemessen'));
  circ.value = (Math.PI * r.objectDiam).toFixed(2);
  row(t('Objektumfang (mm)'), circ);
  const taper = h('input', { type: 'checkbox', checked: r.taper, onchange: (e: Event) => ((r.taper = (e.target as HTMLInputElement).checked), update()) });
  row(t('Konisches Objekt'), h('span', {}, taper), t('Für Becher und andere Objekte, die zu einem Ende dünner werden: die Gravur bleibt überall maßhaltig'));
  const taperRows = [
    ...row(t('Durchmesser am linken Rand (mm)'), numField(() => r.taperLeft, (v) => (r.taperLeft = v)), t('Durchmesser des Objekts dort, wo der Job links beginnt (kleinstes X); mit dem Rahmen anfahren und messen')),
    ...row(t('Durchmesser am rechten Rand (mm)'), numField(() => r.taperRight, (v) => (r.taperRight = v)), t('Durchmesser des Objekts dort, wo der Job rechts endet (größtes X)')),
  ];
  const taperNote = h('div', { class: 'note' }, t('Konisch: Das Objekt so unterlegen, dass seine Oberseite waagerecht liegt. Die Mitte des Jobs in Y bleibt eine gerade Linie, nach oben und unten wird zum dünnen Ende hin stärker gedreht. Bei Walzen wird angenommen, dass das Objekt am dickeren Ende aufliegt. Ändert sich der Job, die Durchmesser an den neuen Rändern messen.'));
  const mirror = h('input', { type: 'checkbox', checked: r.mirror, onchange: (e: Event) => ((r.mirror = (e.target as HTMLInputElement).checked), update()) });
  row(t('Drehrichtung umkehren'), h('span', {}, mirror), t('Wenn die Gravur gespiegelt herauskommt'));
  const info = h('div', { class: 'note' });
  const testNote = h('div', { class: 'note' });
  const testBtn = h('button', {
    class: 'btn',
    title: t('Das Objekt mit den eingegebenen Werten genau einmal herumdrehen'),
    onclick: () => {
      const why = runBlocker();
      if (why) return void (testNote.textContent = why);
      for (const l of rotaryTestLines({ ...target, rotary: { ...r, enabled: true } })) machine.send(l);
      testNote.textContent = t('Das Objekt sollte sich jetzt genau einmal drehen. Dreht es zu weit oder zu kurz, den Achsweg pro Umdrehung im gleichen Verhältnis anpassen.');
    },
  }, t('Testdrehung')) as HTMLButtonElement;
  const update = () => {
    const deg = r.axis !== 'Y' && r.axis !== 'Z';
    perRevLabel.textContent = deg ? t('Achsweg pro Umdrehung (meist 360°)') : t('Achsweg pro Umdrehung (mm)');
    rollerLab.hidden = rollerEl.hidden = r.kind !== 'roller';
    for (const el of taperRows) el.hidden = !r.taper;
    taperNote.hidden = !r.taper;
    const c = rotaryCirc(r);
    const k = c > 0 ? r.perRev / c : 0;
    info.textContent =
      t('1 mm auf dem Objekt = {k} {unit} auf Achse {axis}.', { k: k.toFixed(4), unit: deg ? '°' : 'mm', axis: r.axis }) +
      ' ' +
      (r.axis === 'Y'
        ? t('Am Y-Anschluss: Soft-Limits bzw. Endschalter der Y-Achse dürfen nicht stören, und nicht referenzieren, solange der Rotary steckt.')
        : t('Eigene Achse: Sie muss in der Steuerung eingerichtet sein (bei FluidNC in der config.yaml). KizamuBeam setzt zu Beginn jedes Jobs die aktuelle Stellung mit G92 auf 0.'));
  };
  update();
  const dlg = h('dialog', { class: 'device-dialog' },
    h('h3', {}, t('Drehachse: {name}', { name: target.name })),
    h('div', { class: 'form' }, ...rows),
    info,
    taperNote,
    h('div', { class: 'note' }, t('Die Y-Richtung des Entwurfs wird zur Umfangsrichtung des Objekts. Den Laserkopf vor dem Start über die höchste Stelle des Objekts stellen und fokussieren; als Startpunkt eignet sich „Aktuelle Position“.')),
    h('div', { class: 'conn-row' }, testBtn),
    testNote,
    h('div', { class: 'dialog-buttons' },
      h('button', { class: 'btn', onclick: () => dlg.close() }, t('Abbrechen')),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          (document.activeElement as HTMLElement | null)?.blur();
          target.rotary = { ...r };
          deviceChanged();
          dlg.close();
        },
      }, t('Übernehmen')),
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- Geräteliste ----------

/** Geräte verwalten: aus Vorlagen anlegen, bearbeiten, kopieren, löschen, auswählen */
export function openDevicesDialog(ed: Editor) {
  const list = h('table', { class: 'devices' });
  const fill = () => {
    list.textContent = '';
    list.append(h('tr', {}, h('th', {}), h('th', {}, t('Name')), h('th', {}, t('Steuerung')), h('th', {}, t('Bereich (mm)')), h('th', {})));
    for (const d of store.devices) {
      const radio = h('input', {
        type: 'radio', name: 'cur-device', checked: d === device, title: t('Dieses Gerät verwenden'),
        disabled: machine.connected || machine.connecting,
        onchange: () => (selectDevice(ed, d.id), fill()),
      });
      const btn = (label: string, title: string, f: () => void, disabled = false) => h('button', { class: 'btn', title, disabled, onclick: f }, label);
      list.append(h('tr', { class: d === device ? 'active' : '' },
        h('td', {}, radio),
        h('td', {}, d.name),
        h('td', {}, FIRMWARES[d.fw].label),
        h('td', {}, `${d.bedW} × ${d.bedH}`),
        h('td', {}, h('div', { class: 'actions' },
          btn(t('Bearbeiten'), t('Einstellungen dieses Geräts'), () => openDeviceDialog(ed, d, fill)),
          btn(t('Kopieren'), t('Als neues Gerät kopieren'), () => {
            store.devices.push({ ...d, rotary: { ...d.rotary }, id: newDevice(d).id, name: t('{name} (Kopie)', { name: d.name }) });
            deviceChanged();
            fill();
          }),
          btn(t('Löschen'), store.devices.length < 2 ? t('Das letzte Gerät kann nicht gelöscht werden') : t('Gerät löschen'), () => {
            if (!confirm(t('Gerät „{name}“ löschen?', { name: d.name }))) return;
            store.devices = store.devices.filter((x) => x !== d);
            if (d === device) selectDevice(ed, store.devices[0].id);
            deviceChanged();
            fill();
          }, store.devices.length < 2 || (d === device && (machine.connected || machine.connecting))),
        )),
      ));
    }
  };
  const presets = presetList();
  const presetSel = h('select', {}, ...presets.map((p, i) => presetOption(p, i))) as HTMLSelectElement;
  const add = () => {
    const d = newDevice(presets[Number(presetSel.value)].preset);
    store.devices.push(d);
    deviceChanged();
    fill();
    openDeviceDialog(ed, d, fill);
  };
  const dlg = h('dialog', { class: 'devices-dialog' },
    h('h3', {}, t('Geräte')),
    list,
    h('div', { class: 'conn-row' }, h('label', {}, t('Neues Gerät aus Vorlage')), presetSel, h('button', { class: 'btn primary', onclick: add }, t('Hinzufügen'))),
    h('div', { class: 'note' }, t('Die Maße der Vorlagen stammen aus den Herstellerangaben. Bitte vor dem ersten Job prüfen, am einfachsten mit „Von der Maschine lesen“ in den Geräteeinstellungen (FluidNC, GRBL, grblHAL).')),
    h('div', { class: 'dialog-buttons' }, h('button', { class: 'btn', onclick: () => dlg.close() }, t('Schließen'))),
  );
  fill();
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- Vorschau ----------

export async function openPreview(ed: Editor, src?: JobSource) {
  const job = await makeJob(ed, true, src);
  if (nothingToDo(job)) return;
  const est = estimate(job.moves, device);
  const mv = job.moves;
  const bed = ed.doc.bed;
  const cv = h('canvas', { class: 'preview-canvas' }) as HTMLCanvasElement;
  const acc = document.createElement('canvas');
  const slider = h('input', { type: 'range', min: '0', max: '1000', value: '1000', step: '1' }) as HTMLInputElement;
  const timeTxt = h('span', { class: 'preview-time' });
  const playBtn = h('button', { class: 'btn', title: t('Abspielen') }, h('span', { html: ICONS.play }));
  const hereBtn = h('button', {
    class: 'btn',
    title: t('Den Job ab der Stelle des Schiebereglers lasern, z. B. nach einem Abbruch'),
    onclick: async () => {
      setPlaying(false);
      const i = indexAt(time);
      const t0 = i ? est.t[i - 1] : 0,
        t1 = i < mv.n ? est.t[i] : t0;
      const frac = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
      if (await startJobAt(ed, mv, i, frac, src)) dlg.close();
    },
  }, t('Hier starten')) as HTMLButtonElement;
  const updateHere = () => {
    const why = runBlocker();
    hereBtn.disabled = !!why;
    hereBtn.title = why ?? t('Den Job ab der Stelle des Schiebereglers lasern, z. B. nach einem Abbruch');
  };
  const offMachine = machine.on(updateHere);
  const speedSel = h('select', { title: t('Abspielgeschwindigkeit') },
    ...[1, 2, 5, 10, 20, 50, 100, 200].map((v) => h('option', { value: String(v), selected: v === 10 }, `${v}×`)),
  ) as HTMLSelectElement;
  const rapidChk = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const shadeChk = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const stat = (k: string, v: string) => [h('dt', {}, k), h('dd', {}, v)];
  const b = job.bounds!;
  const info = h('dl', { class: 'preview-stats' },
    ...stat(t('Geschätzte Dauer'), formatDuration(est.total)),
    ...stat(t('Laserweg'), `${(est.cutLength / 1000).toFixed(2)} m`),
    ...stat(t('Leerweg'), `${(est.rapidLength / 1000).toFixed(2)} m`),
    ...stat(t('Bereich'), `${(b.x1 - b.x0).toFixed(1)} × ${(b.y1 - b.y0).toFixed(1)} mm`),
    ...stat(t('Bewegungen'), mv.n.toLocaleString(locale)),
    ...(rotaryOn(device) ? stat(t('Drehachse'), t('Achse {axis}, Umfang {c} mm', { axis: device.rotary.axis, c: (Math.PI * device.rotary.objectDiam).toFixed(1) })) : []),
  );
  const warn = h('div', { class: 'note' }, ...job.warnings.map((w) => h('div', {}, w)));
  const dlg = h('dialog', { class: 'preview-dialog' },
    h('div', { class: 'preview-main' },
      cv,
      h('div', { class: 'preview-side' },
        h('h3', {}, t('Vorschau')),
        info,
        h('label', { class: 'check' }, rapidChk, t('Leerwege zeigen')),
        h('label', { class: 'check' }, shadeChk, t('Nach Leistung schattieren')),
        warn,
        h('div', { class: 'note' }, t('Mausrad zoomt, Ziehen verschiebt, Doppelklick passt ein. Die Zeit ist eine Schätzung aus Eilgang und Beschleunigung in den Geräteeinstellungen.')),
        h('div', { class: 'dialog-buttons' },
          h('button', { class: 'btn', onclick: () => saveGCode(ed, src) }, t('G-Code speichern')),
          h('button', { class: 'btn primary', onclick: () => dlg.close() }, t('Schließen')),
        ),
      ),
    ),
    h('div', { class: 'preview-bar' }, playBtn, slider, timeTxt, speedSel, hereBtn),
  );
  document.body.append(dlg);
  dlg.addEventListener('keydown', (e) => e.stopPropagation());
  dlg.showModal();

  // Ansicht: mm → Pixel, y nach oben
  let view = { z: 1, ox: 0, oy: 0 };
  let W = 0,
    H = 0,
    dpr = 1;
  const fit = () => {
    const r = cv.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    cv.width = acc.width = W * dpr;
    cv.height = acc.height = H * dpr;
    const bx0 = Math.min(0, job.travel?.x0 ?? 0),
      by0 = Math.min(0, job.travel?.y0 ?? 0),
      bx1 = Math.max(bed.w, job.travel?.x1 ?? 0),
      by1 = Math.max(bed.h, job.travel?.y1 ?? 0);
    const z = Math.min((W - 30) / (bx1 - bx0), (H - 30) / (by1 - by0));
    view = { z, ox: (W - (bx1 - bx0) * z) / 2 - bx0 * z, oy: (H + (by1 - by0) * z) / 2 + by0 * z };
    accN = 0;
  };
  const sx = (x: number) => x * view.z + view.ox;
  const sy = (y: number) => view.oy - y * view.z;

  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const css = getComputedStyle(document.documentElement);
  const bedColor = css.getPropertyValue('--surface').trim() || '#fff';
  const lineColor = css.getPropertyValue('--line').trim() || '#ccc';
  const colorOf = (layer: number) => (layer < 0 ? '#888' : src ? src.color(layer) : ed.layerDrawColor(layer));

  // Schattierung relativ zur höchsten Leistung des Layers, damit Graustufenbilder auch bei wenig Leistung lesbar sind
  const maxS = new Map<number, number>();
  for (let i = 0; i < mv.n; i++) if (mv.s[i] > (maxS.get(mv.layer[i]) ?? 0)) maxS.set(mv.layer[i], mv.s[i]);

  /** Bewegungen bis Index n (ausschließlich) in den Zwischenspeicher zeichnen, ab dem bereits gezeichneten Stand */
  let accN = 0;
  const drawUpTo = (n: number) => {
    const c = acc.getContext('2d')!;
    if (n < accN || accN === 0) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = dark ? '#15171b' : '#d9dce1';
      c.fillRect(0, 0, W, H);
      c.fillStyle = bedColor;
      c.fillRect(sx(0), sy(bed.h), bed.w * view.z, bed.h * view.z);
      c.strokeStyle = lineColor;
      c.lineWidth = 1;
      c.strokeRect(sx(0), sy(bed.h), bed.w * view.z, bed.h * view.z);
      accN = 0;
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineWidth = Math.max(1, Math.min(3, view.z * 0.1));
    const batches = new Map<string, Path2D>();
    const rapids = new Path2D();
    let px = accN ? mv.x[accN - 1] : mv.x0,
      py = accN ? mv.y[accN - 1] : mv.y0;
    for (let i = accN; i < n; i++) {
      const x = mv.x[i],
        y = mv.y[i];
      if (mv.f[i] === 0 || mv.s[i] === 0) {
        if (mv.f[i] === 0 && rapidChk.checked) {
          rapids.moveTo(sx(px), sy(py));
          rapids.lineTo(sx(x), sy(y));
        }
      } else {
        const lvl = shadeChk.checked ? Math.max(1, Math.round((mv.s[i] / (maxS.get(mv.layer[i]) || 1)) * 16)) : 16;
        const key = `${mv.layer[i]}|${lvl}`;
        let p = batches.get(key);
        if (!p) batches.set(key, (p = new Path2D()));
        p.moveTo(sx(px), sy(py));
        p.lineTo(sx(x), sy(y));
      }
      px = x;
      py = y;
    }
    for (const [key, p] of batches) {
      const [layer, lvl] = key.split('|').map(Number);
      c.strokeStyle = colorOf(layer);
      c.globalAlpha = 0.1 + (0.9 * lvl) / 16;
      c.stroke(p);
    }
    c.globalAlpha = 1;
    if (rapidChk.checked) {
      c.strokeStyle = 'rgba(230,60,40,0.55)';
      c.lineWidth = 1;
      c.setLineDash([3, 3]);
      c.stroke(rapids);
      c.setLineDash([]);
    }
    accN = n;
  };

  let time = est.total;
  const indexAt = (t: number) => {
    let lo = 0,
      hi = mv.n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (est.t[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const render = () => {
    const i = indexAt(time);
    drawUpTo(Math.min(i, mv.n));
    const c = cv.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(acc, 0, 0);
    // Laserkopf mit Teilstück der aktuellen Bewegung
    let hx = mv.x0,
      hy = mv.y0;
    if (i < mv.n) {
      const t0 = i ? est.t[i - 1] : 0,
        t1 = est.t[i];
      const f = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 1;
      const ax = i ? mv.x[i - 1] : mv.x0,
        ay = i ? mv.y[i - 1] : mv.y0;
      hx = ax + (mv.x[i] - ax) * f;
      hy = ay + (mv.y[i] - ay) * f;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (mv.f[i] > 0 && mv.s[i] > 0) {
        c.strokeStyle = colorOf(mv.layer[i]);
        c.lineWidth = Math.max(1, Math.min(3, view.z * 0.1));
        c.beginPath();
        c.moveTo(sx(ax), sy(ay));
        c.lineTo(sx(hx), sy(hy));
        c.stroke();
      }
    } else if (mv.n) {
      hx = mv.x[mv.n - 1];
      hy = mv.y[mv.n - 1];
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.strokeStyle = '#e02020';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(sx(hx), sy(hy), 5, 0, Math.PI * 2);
    c.stroke();
    timeTxt.textContent = `${formatDuration(time)} / ${formatDuration(est.total)}`;
    slider.value = String(est.total ? Math.round((time / est.total) * 1000) : 1000);
  };

  let playing = false,
    last = 0;
  const step = (now: number) => {
    if (!playing || !dlg.open) return;
    time = Math.min(est.total, time + ((now - last) / 1000) * Number(speedSel.value));
    last = now;
    render();
    if (time >= est.total) return setPlaying(false);
    requestAnimationFrame(step);
  };
  const setPlaying = (p: boolean) => {
    playing = p;
    playBtn.innerHTML = p ? ICONS.pause : ICONS.play;
    if (p) {
      if (time >= est.total) time = 0;
      last = performance.now();
      requestAnimationFrame(step);
    }
  };
  playBtn.addEventListener('click', () => setPlaying(!playing));
  slider.addEventListener('input', () => {
    time = (Number(slider.value) / 1000) * est.total;
    render();
  });
  const redrawAll = () => ((accN = 0), render());
  rapidChk.addEventListener('change', redrawAll);
  shadeChk.addEventListener('change', redrawAll);

  // Zoomen und Verschieben
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left,
      my = e.clientY - r.top;
    const k = e.deltaY < 0 ? 1.25 : 0.8;
    view.ox = mx - (mx - view.ox) * k;
    view.oy = my - (my - view.oy) * k;
    view.z *= k;
    redrawAll();
  }, { passive: false });
  let drag: { x: number; y: number } | null = null;
  cv.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.ox += e.clientX - drag.x;
    view.oy += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    redrawAll();
  });
  cv.addEventListener('pointerup', () => (drag = null));
  cv.addEventListener('dblclick', () => (fit(), render()));
  const ro = new ResizeObserver(() => (fit(), render()));
  ro.observe(cv);
  updateHere();
  dlg.addEventListener('close', () => {
    playing = false;
    offMachine();
    ro.disconnect();
    dlg.remove();
  });
}
