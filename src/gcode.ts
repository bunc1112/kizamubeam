// Maschinenausgabe: aus dem Dokument einen Job berechnen (Linien, Füllen, Bilder), G-Code schreiben,
// Laufzeit schätzen und Rahmenfahrten erzeugen. Alles in Maschinenkoordinaten (mm, Ursprung unten links, y nach oben).
import ClipperLib from 'clipper-lib';
import { apply, CutSettings, Doc, ImageLayer, ImageShape, inv, isGrayMode, laserLeaves, Layer, LeadSettings, Mat, mul, normalizeLayer, Obj, PerfSettings, Pt, RampSettings, SubLayer, SubPath, TabSettings } from './model';
import { bezierPt, segments, shapeSubs } from './geom';
import { loadFont, textToSubs } from './fonts';
import { nativeScanLines, outputGrid, processImage } from './images';
import { hasNative, native } from './native';
import { locale, t, tn } from './i18n';
import { jobOutputsOff, jobOutputsOn } from './fluidnc';
import { parkedObjs } from './parking';

// ---------- Geräte und Firmware ----------

export type StartFrom = 'absolute' | 'user' | 'current';

export type Firmware = 'fluidnc' | 'grbl' | 'grblhal' | 'marlin' | 'smoothie' | 'ruida';

/** Was je Steuerung anders ist: Übertragung, Laserbefehle, Maschinenbefehle */
export interface FirmwareInfo {
  label: string;
  /** Übliche Leistungsskala (S-Wert für 100 %) */
  sMax: number;
  /** Zeile für Zeile senden statt Zeichenzählung */
  sync: boolean;
  /** Echtzeitbefehle ? ! ~ 0x18 */
  realtime: boolean;
  /** Positionsabfrage per Befehl, wenn es keinen Echtzeitstatus gibt */
  poll: string | null;
  /** Laser vorbereiten (vor der ersten Bewegung) */
  laserOn: string[];
  /** Laser für den Rahmen mit fester Leistung einschalten */
  frameOn: string[];
  /** Ende des Jobs */
  footer: string[];
  home: string;
  unlock: string | null;
  /** Relativ verfahren; axis ist der Buchstabe für die Y-Richtung (bei Rotary z. B. A) */
  jog: (x: number, y: number, f: number, axis?: string) => string[];
  setOrigin: string;
  clearOrigin: string | null;
  /** Einstellungen der Maschine lesen: FluidNC-Pfade, GRBL-$$ oder gar nicht */
  read: 'fluidnc' | 'grbl' | null;
  /** Echtzeit-Overrides für Vorschub, Eilgang und Leistung (0x90 …), Kühlmittel umschalten (0xA0/0xA1) */
  overrides: boolean;
}

const grblJog = (x: number, y: number, f: number, axis = 'Y') => [`$J=G91 G21${x ? ` X${num(x)}` : ''}${y ? ` ${axis}${num(y)}` : ''} F${Math.round(f)}`];
const relJog = (x: number, y: number, f: number, axis = 'Y') => ['G91', `G0${x ? ` X${num(x)}` : ''}${y ? ` ${axis}${num(y)}` : ''} F${Math.round(f)}`, 'G90'];
const GRBL_BASE = {
  sync: false, realtime: true, poll: null, laserOn: ['M4 S0'], frameOn: ['M3 S0'], footer: ['M5', 'M2'],
  home: '$H', unlock: '$X', jog: grblJog, setOrigin: 'G10 L20 P1 X0 Y0', clearOrigin: 'G10 L2 P1 X0 Y0', overrides: true,
};

export const FIRMWARES: Record<Firmware, FirmwareInfo> = {
  fluidnc: { ...GRBL_BASE, label: 'FluidNC', sMax: 1000, read: 'fluidnc' },
  grbl: { ...GRBL_BASE, label: 'GRBL 1.1', sMax: 1000, read: 'grbl' },
  grblhal: { ...GRBL_BASE, label: 'grblHAL', sMax: 1000, read: 'grbl' },
  marlin: {
    label: 'Marlin (Laser)', sMax: 255, sync: true, realtime: false, poll: 'M114',
    // Inline-Modus: S an jedem G1 setzt die Leistung, G0 fährt aus
    laserOn: ['M3 I S0'], frameOn: ['M3 I S0'], footer: ['M5', 'M400'],
    home: 'G28 X Y', unlock: null, jog: relJog, setOrigin: 'G92 X0 Y0', clearOrigin: null, read: null, overrides: false,
  },
  smoothie: {
    label: 'Smoothieware', sMax: 1, sync: true, realtime: true, poll: null,
    // Smoothieware feuert nur bei G1, S ist der Anteil 0 … 1
    laserOn: [], frameOn: [], footer: [],
    home: '$H', unlock: '$X', jog: relJog, setOrigin: 'G10 L20 P1 X0 Y0', clearOrigin: 'G10 L2 P1 X0 Y0', read: null, overrides: false,
  },
  // Ruida (CO2-Steuerungen RDC644x/634x …): kein G-Code auf der Leitung. Der Treiber im Rust-Teil (src-tauri/src/ruida.rs)
  // übersetzt den Job in eine Ruida-Datei und versteht für Bewegen, Referenzfahrt und Ursprung genau diese Zeilen.
  ruida: {
    label: 'Ruida (CO2, RDC644x/634x)', sMax: 1000, sync: false, realtime: true, poll: null,
    laserOn: ['M4 S0'], frameOn: ['M3 S0'], footer: ['M5', 'M2'],
    home: '$H', unlock: null, jog: grblJog, setOrigin: 'G10 L20 P1 X0 Y0', clearOrigin: 'G10 L2 P1 X0 Y0', read: null, overrides: false,
  },
};

/** Nullpunkt-Ecke der Ruida-Steuerung (dort fährt sie bei der Referenzfahrt hin) */
export type RuidaOrigin = 'tr' | 'tl' | 'br' | 'bl';

/** Einstellungen für den Ruida-Treiber (machine_connect, ruida_save) */
export function ruidaConnect(d: Device) {
  return {
    magic: d.ruidaMagic || 0,
    bedW: d.bedW,
    bedH: d.bedH,
    origin: d.ruidaOrigin || 'tr',
    sMax: d.sMax,
    minPower: Math.max(0, Math.min(100, d.ruidaMinPower ?? 100)) / 100,
  };
}

/** Achse, auf der die Drehung ausgegeben wird: Y = Rotary steckt am Y-Anschluss, sonst eine eigene Achse */
export type RotaryAxis = 'Y' | 'Z' | 'A' | 'B' | 'C';

/** Drehachse (Rotary): Die Y-Richtung des Entwurfs wird zur Umfangsrichtung des Objekts */
export interface Rotary {
  enabled: boolean;
  /** Walzen (Objekt liegt auf zwei Rollen) oder Futter (Objekt ist eingespannt) */
  kind: 'roller' | 'chuck';
  axis: RotaryAxis;
  /** Achsweg für eine volle Umdrehung der Walze bzw. des Futters, in den Einheiten der Steuerung (mm, bei A/B/C meist Grad) */
  perRev: number;
  /** Durchmesser der angetriebenen Walze in mm (nur Walzen) */
  rollerDiam: number;
  /** Durchmesser des Objekts in mm (Futter: bestimmt den Maßstab; Walzen: nur für den Umfang-Hinweis und die Testdrehung) */
  objectDiam: number;
  /** Drehrichtung umkehren */
  mirror: boolean;
  /** Konisches Objekt (Becher): der Durchmesser ändert sich entlang X linear von taperLeft zu taperRight */
  taper: boolean;
  /** Objektdurchmesser in mm am linken bzw. rechten Rand des Jobs (kleinstes bzw. größtes X) */
  taperLeft: number;
  taperRight: number;
}

export const DEFAULT_ROTARY: Rotary = { enabled: false, kind: 'roller', axis: 'Y', perRev: 360, rollerDiam: 25, objectDiam: 80, mirror: false, taper: false, taperLeft: 80, taperRight: 70 };

export interface Device {
  id: string;
  name: string;
  fw: Firmware;
  /** Arbeitsbereich in mm */
  bedW: number;
  bedH: number;
  /** Verbindung: USB-Seriell oder Netzwerk (Telnet, z. B. FluidNC Port 23, oder WebSocket, FluidNC Port 81; UDP = Ruida-Ethernet) */
  conn: 'serial' | 'tcp' | 'ws' | 'udp';
  port: string;
  baud: number;
  host: string;
  tcpPort: number;
  wsPort: number;
  /** Port der Weboberfläche (FluidNC: Dateien hochladen, Suche im Netzwerk) */
  httpPort: number;
  /** Empfangspuffer der Steuerung in Bytes für die Zeichenzählung (GRBL 128 → 127; FluidNC hat mehr) */
  rxBuffer: number;
  /** Job vom Rechner senden oder bei FluidNC erst auf SD-Karte/Flash hochladen und dort starten */
  runFrom: 'stream' | 'sd' | 'localfs';
  /** Digitale Ausgänge (M64/M65 P…), die während eines Jobs eingeschaltet sind, z. B. Absaugung */
  jobOutputs: number[];
  /** S-Wert für 100 % Leistung (FluidNC/GRBL meist 1000, Marlin 255, Smoothieware 1) */
  sMax: number;
  /** Eilgang in mm/min (für Zeitschätzung und Leerwege) */
  rapid: number;
  /** Beschleunigung in mm/s² (Zeitschätzung) */
  accel: number;
  /** Junction Deviation in mm (Zeitschätzung, GRBL-Standard 0,01) */
  junction: number;
  startFrom: StartFrom;
  /** Job-Ursprung 0 … 8: Zeilen von oben nach unten, je links → rechts */
  jobOrigin: number;
  cutSelected: boolean;
  optimize: boolean;
  /** Nach dem Job zum Startpunkt zurückfahren */
  returnHome: boolean;
  homeOnConnect: boolean;
  /** Hat die Maschine Endschalter? Angabe aus dem Assistenten „Laser einrichten“; ohne gibt es dort keine Referenzfahrt */
  limitSwitches: 'yes' | 'no' | 'unknown';
  /** Rahmen mit eingeschaltetem Laser (niedrige Leistung) */
  frameLaser: boolean;
  framePower: number;
  frameSpeed: number;
  /** Befehl für Air Assist an (aus immer mit M9): M8 = Flood, M7 = Mist */
  airCmd: 'M8' | 'M7';
  /** Eigene G-Code-Zeilen vor dem Job (nach Einheiten und Laser-Modus) und nach dem Job (nach Laser aus) */
  startScript: string;
  endScript: string;
  /** Grenzen für Jobs, die ein KI-Agent anfordert: höchste Leistung in %, kleinste Geschwindigkeit in mm/min (0 = keine) */
  agentMaxPower: number;
  agentMinSpeed: number;
  rotary: Rotary;
  /** Motorische Z-Achse (Fokus) vorhanden: Layer dürfen den Fokus versetzen (Z-Versatz, tiefer je Durchgang) */
  zAxis: boolean;
  /** Z+ fährt Richtung Material (z. B. Tisch hebt sich); Standard: Z+ fährt den Kopf nach oben */
  zFlip: boolean;
  /** Ruida: Ecke des Nullpunkts der Steuerung */
  ruidaOrigin: RuidaOrigin;
  /** Ruida: Schlüssel zum Verwürfeln (0x88, 0x11, 0x38); 0 = beim Verbinden erkennen */
  ruidaMagic: number;
  /** Ruida: Min-Leistung in Ecken in % der Layer-Leistung (nur im Modus M4, der Leistung je Geschwindigkeit) */
  ruidaMinPower: number;
}

export const DEFAULT_DEVICE: Device = {
  id: 'standard',
  name: 'Swiitol E6 Pro',
  fw: 'fluidnc',
  bedW: 400,
  bedH: 400,
  conn: 'serial',
  port: '',
  baud: 115200,
  host: 'fluidnc.local',
  tcpPort: 23,
  wsPort: 81,
  httpPort: 80,
  rxBuffer: 127,
  runFrom: 'stream',
  jobOutputs: [],
  sMax: 1000,
  rapid: 6000,
  accel: 1500,
  junction: 0.01,
  startFrom: 'absolute',
  jobOrigin: 6,
  cutSelected: false,
  optimize: true,
  returnHome: true,
  homeOnConnect: false,
  limitSwitches: 'unknown',
  frameLaser: false,
  framePower: 1,
  frameSpeed: 3000,
  airCmd: 'M8',
  startScript: '',
  endScript: '',
  agentMaxPower: 100,
  agentMinSpeed: 0,
  rotary: DEFAULT_ROTARY,
  zAxis: false,
  zFlip: false,
  ruidaOrigin: 'tr',
  ruidaMagic: 0,
  ruidaMinPower: 100,
};

/**
 * Vorlagen für neue Geräte. Maße nach Herstellerseite oder Testbericht (Quelle je Zeile, Stand 2026-10-19);
 * Händler geben oft die Größe der Wabenplatte statt des Fahrwegs an. Vor dem ersten Job mit
 * „Von der Maschine lesen“ oder dem Assistenten „Laser einrichten“ prüfen.
 */
export const PRESETS: (Partial<Device> & { name: string; fw: Firmware })[] = [
  // Steuerung an Hanjos Gerät bestätigt; 365 × 305 laut notebookcheck.com und macitynet.it, Herstellerseite nicht lesbar
  { name: 'Swiitol E6 Pro', fw: 'fluidnc', bedW: 365, bedH: 305 },
  // 3dprintbeginner.com/ortur-laser-master-3-preview, clevercreations.org
  { name: 'Ortur Laser Master 3', fw: 'grbl', bedW: 400, bedH: 400 },
  // techradar.com/reviews/ortur-laser-master-2-pro
  { name: 'Ortur Laser Master 2 Pro S2', fw: 'grbl', bedW: 400, bedH: 400 },
  // atomstack.com/products/atomstack-a20-pro-130w
  { name: 'Atomstack A20 Pro', fw: 'grbl', bedW: 400, bedH: 365 },
  // Herstellerangabe 410 × 400; Nutzer messen im LightBurn-Forum etwa 374 × 362
  { name: 'Sculpfun S30', fw: 'grbl', bedW: 410, bedH: 400 },
  // crealityfalcon.com/blogs/product-reviews/sculpfun-s9-review
  { name: 'Sculpfun S9', fw: 'grbl', bedW: 410, bedH: 420 },
  // atomm.com/blog/2535-what-is-xtool-d1 (ca.); 230400 Baud laut LightBurn-Forum
  { name: 'xTool D1', fw: 'grbl', bedW: 432, bedH: 406, baud: 230400 },
  { name: 'xTool D1 Pro', fw: 'grbl', bedW: 430, bedH: 400, baud: 230400 },
  // crealityfalcon.com/products/10w-cr-laser-falcon-engraver
  { name: 'Creality CR-Laser Falcon 10W', fw: 'grbl', bedW: 400, bedH: 415 },
  // filament2print.com
  { name: 'Creality Falcon 2', fw: 'grbl', bedW: 400, bedH: 415 },
  // techradar.com/reviews/two-trees-ts2-laser-engraver
  { name: 'Two Trees TS2', fw: 'grbl', bedW: 450, bedH: 450 },
  // longer.net, Ray5 5 W/10 W (20 W: 400 × 365, 40 W: 385 × 385); 115200 Baud
  { name: 'Longer Ray5 5/10 W', fw: 'grbl', bedW: 400, bedH: 400 },
  { name: 'Longer Ray5 20 W', fw: 'grbl', bedW: 400, bedH: 365 },
  // Bedienungsanleitung COMGO Z1 V1.1; 115200 Baud
  { name: 'Comgrow Z1', fw: 'grbl', bedW: 400, bedH: 400 },
  { name: t('GRBL-Laser (allgemein)'), fw: 'grbl', bedW: 400, bedH: 400 },
  { name: t('grblHAL-Laser (allgemein)'), fw: 'grblhal', bedW: 400, bedH: 400 },
  { name: t('FluidNC-Laser (allgemein)'), fw: 'fluidnc', bedW: 400, bedH: 400 },
  { name: t('Marlin mit Laser'), fw: 'marlin', bedW: 300, bedH: 300, baud: 250000 },
  { name: t('Smoothieware-Laser'), fw: 'smoothie', bedW: 300, bedH: 200 },
  // Ruida-Steuerungen werden ab Werk meist mit 192.168.1.100 ausgeliefert; Nullpunkt meist oben rechts
  { name: t('Ruida-CO2-Laser (allgemein)'), fw: 'ruida', bedW: 600, bedH: 400, conn: 'udp', host: '192.168.1.100', limitSwitches: 'yes', rapid: 18000, accel: 3000 },
  // Virtuelle Maschine zum Testen ohne Hardware (vm/ im Repo, eigener Download); Ports wie dort voreingestellt
  { name: 'KizamuBeam Virtual Machine', fw: 'fluidnc', bedW: 400, bedH: 400, conn: 'tcp', host: '127.0.0.1', tcpPort: 2323, wsPort: 8181, limitSwitches: 'yes' },
];

export function newDevice(preset: Partial<Device> & { fw: Firmware }): Device {
  const fw = FIRMWARES[preset.fw];
  return {
    ...DEFAULT_DEVICE,
    host: preset.fw === 'fluidnc' ? 'fluidnc.local' : '',
    sMax: fw.sMax,
    ...preset,
    rotary: { ...DEFAULT_ROTARY, ...preset.rotary },
    id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  };
}

export interface DeviceStore {
  devices: Device[];
  current: string;
}

const STORE_KEY = 'kizamubeam.devices';
const OLD_KEY = 'kizamubeam.device';

export function loadDevices(): DeviceStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const st = JSON.parse(raw) as DeviceStore;
      st.devices = st.devices.map((d) => ({ ...DEFAULT_DEVICE, ...d, rotary: { ...DEFAULT_ROTARY, ...d.rotary } }));
      if (st.devices.length) {
        if (!st.devices.some((d) => d.id === st.current)) st.current = st.devices[0].id;
        return st;
      }
    }
    // Früher gab es nur ein Gerät
    const old = localStorage.getItem(OLD_KEY);
    if (old) return { devices: [{ ...DEFAULT_DEVICE, ...JSON.parse(old), id: 'standard', rotary: { ...DEFAULT_ROTARY } }], current: 'standard' };
  } catch {
    /* Standardwerte */
  }
  return { devices: [{ ...DEFAULT_DEVICE, rotary: { ...DEFAULT_ROTARY } }], current: DEFAULT_DEVICE.id };
}

export function saveDevices(st: DeviceStore) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(st));
  } catch {
    /* nicht speicherbar, z. B. privates Fenster */
  }
}

// ---------- Drehachse ----------

/** Weg auf der Objektoberfläche für eine volle Umdrehung der Walze bzw. des Futters (mm) */
export const rotaryCirc = (r: Rotary) => Math.PI * (r.kind === 'chuck' ? r.objectDiam : r.rollerDiam);

/** Ist die Drehachse eingeschaltet und vollständig eingestellt? */
export const rotaryOn = (d: Device) => !!d.rotary?.enabled && d.rotary.perRev > 0 && rotaryCirc(d.rotary) > 0;

/** Achsweg je mm auf der Objektoberfläche, negativ bei umgekehrter Drehrichtung */
export const rotaryScale = (r: Rotary) => (r.perRev / rotaryCirc(r)) * (r.mirror ? -1 : 1);

/** Buchstabe, unter dem die Y-Richtung des Entwurfs ausgegeben wird */
export const outAxis = (d: Device): RotaryAxis => (rotaryOn(d) ? d.rotary.axis : 'Y');

/** Drehachse als eigene Achse (nicht am Y-Anschluss): sie wird zu Beginn mit G92 auf 0 gesetzt */
export const separateAxis = (d: Device) => rotaryOn(d) && d.rotary.axis !== 'Y';

/** Konischer Ausgleich eingeschaltet und beide Durchmesser gültig? */
export const taperOn = (r: Rotary) => !!r.taper && r.taperLeft > 0 && r.taperRight > 0;

/** Kleinster Objektdurchmesser im Job: bei konischen Objekten der dünnere Rand */
export const minObjectDiam = (r: Rotary) => (taperOn(r) ? Math.min(r.taperLeft, r.taperRight) : r.objectDiam);

/** Größte Abweichung der Ausgabe von der Sollkurve beim Unterteilen gerader Strecken (mm auf der Oberfläche) */
const TAPER_TOL = 0.01;

/**
 * Bewegungen für die Ausgabe mit Drehachse. Y (Weg auf der Oberfläche) wird in Achsweg umgerechnet;
 * am Y-Anschluss bleibt der Startpunkt, wo er ist, eine eigene Achse beginnt bei 0.
 * Der Vorschub wird je Bewegung so angepasst, dass die Geschwindigkeit auf der Oberfläche stimmt
 * (die Steuerung rechnet F über X und den Achsweg). Ohne Drehachse kommen die Bewegungen unverändert zurück.
 *
 * Konisch (taper): Der Durchmesser D(x) wächst linear über die Breite des Jobs (box). Damit die Gravur überall
 * maßhaltig ist, dreht ein mm auf der Oberfläche um 1 / (π·D(x)) Umdrehungen, gerechnet ab der Mitte des Jobs
 * in Y (diese Linie bleibt gerade). Walzen treiben das Objekt am dickeren Ende an. Weil die Umrechnung von X
 * abhängt, werden Strecken entlang X so unterteilt, dass die Ausgabe höchstens TAPER_TOL abweicht; t (Endzeit
 * jeder Bewegung) wird dabei mit aufgeteilt.
 */
export function rotaryMoves(mv: Moves, d: Device, box: Box | null = null, t?: Float64Array): { mv: Moves; t?: Float64Array } {
  if (!rotaryOn(d)) return { mv, t };
  const r = d.rotary;
  const k0 = rotaryScale(r);
  const ref = mv.y0,
    base = r.axis === 'Y' ? ref : 0;
  let kAt = (_x: number) => k0,
    yc = ref;
  if (taperOn(r)) {
    let x0 = box?.x0 ?? Infinity,
      x1 = box?.x1 ?? -Infinity;
    if (!box) for (let i = 0; i < mv.n; i++) (x0 = Math.min(x0, mv.x[i])), (x1 = Math.max(x1, mv.x[i]));
    if (!(x1 >= x0)) x0 = x1 = mv.x0;
    const big = Math.max(r.taperLeft, r.taperRight);
    // Walzen: am dicken Ende dreht das Objekt so weit wie die Walze, am dünnen Ende entsprechend weniger
    const c = (r.kind === 'roller' ? r.rollerDiam / big : 1) * Math.PI;
    const sign = r.mirror ? -1 : 1;
    kAt = (x: number) => {
      const u = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0.5;
      return (sign * r.perRev) / (c * (r.taperLeft + (r.taperRight - r.taperLeft) * u));
    };
    yc = box ? (box.y0 + box.y1) / 2 : ref;
  }
  const zero = (ref - yc) * kAt(mv.x0);
  const map = (x: number, y: number) => base + (y - yc) * kAt(x) - zero;
  const tapered = taperOn(r);
  const out = new Moves(mv.x0, map(mv.x0, mv.y0));
  const tt: number[] = [];
  let px = mv.x0,
    py = mv.y0,
    pa = out.y0,
    pt = 0;
  const emit = (x: number, y: number, a: number, f: number, s: number, layer: number) => {
    const dx = x - px,
      l = Math.hypot(dx, y - py);
    if (f > 0 && l > 1e-9) f = Math.max(1, Math.round((f * Math.hypot(dx, a - pa)) / l));
    out.push(x, a, f, s, layer);
    px = x;
    py = y;
    pa = a;
  };
  for (let i = 0; i < mv.n; i++) {
    const x = mv.x[i],
      y = mv.y[i],
      ti = t ? t[i] : 0;
    const sx = px,
      sy = py;
    let n = 1;
    if (tapered && mv.f[i] > 0) {
      // Abweichung in der Mitte jedes Stücks, umgerechnet auf mm der Oberfläche; sie fällt etwa mit n²
      const at = (u: number) => sx + (x - sx) * u;
      const worst = (n: number) => {
        let e = 0;
        for (let j = 0; j < n; j++) {
          const u0 = j / n,
            u1 = (j + 1) / n,
            um = (u0 + u1) / 2;
          const ym = sy + (y - sy) * um;
          e = Math.max(e, Math.abs(map(at(um), ym) - (map(at(u0), sy + (y - sy) * u0) + map(at(u1), sy + (y - sy) * u1)) / 2) / Math.abs(kAt(at(um))));
        }
        return e;
      };
      const e1 = worst(1);
      if (e1 > TAPER_TOL) {
        n = Math.min(1000, Math.ceil(Math.sqrt(e1 / TAPER_TOL)));
        while (n < 1000 && worst(n) > TAPER_TOL) n = Math.min(1000, Math.ceil(n * 1.25));
      }
    }
    out.zCur = mv.z[i];
    for (let j = 1; j <= n; j++) {
      const u = j / n,
        qx = sx + (x - sx) * u,
        qy = sy + (y - sy) * u;
      emit(qx, qy, map(qx, qy), mv.f[i], mv.s[i], mv.layer[i]);
      tt.push(pt + (ti - pt) * u);
    }
    pt = ti;
  }
  return { mv: out, t: t ? Float64Array.from(tt) : undefined };
}

/** Relatives Verfahren um dx, dy mm (Oberfläche); mit Drehachse geht dy auf die Drehachse, f gilt für die Oberfläche */
export function jogLines(d: Device, dx: number, dy: number, f: number): string[] {
  const fw = FIRMWARES[d.fw];
  if (!rotaryOn(d)) return fw.jog(dx, dy, f);
  const k = rotaryScale(d.rotary);
  const l = Math.hypot(dx, dy);
  return fw.jog(dx, dy * k, l > 0 ? (f * Math.hypot(dx, dy * k)) / l : f, d.rotary.axis);
}

/** Absolut an eine Werkstückposition fahren (Laser zur Klickposition). y = null lässt Y stehen (z. B. mit Drehachse).
 *  GRBL-Familie über $J (Soft-Limits, Abbruch mit Jog-Cancel), sonst G0 in G90. */
export function jogToLines(d: Device, x: number, y: number | null, f: number): string[] {
  const fw = FIRMWARES[d.fw];
  const axes = `X${num(x)}${y === null ? '' : ` Y${num(y)}`}`;
  return fw.jog === grblJog ? [`$J=G90 G21 ${axes} F${Math.round(f)}`] : ['G90', `G0 ${axes} F${Math.round(f)}`];
}

/** Testdrehung: das Objekt einmal ganz herumdrehen (bei Walzen hängt das vom Objektdurchmesser ab) */
export function rotaryTestLines(d: Device, speed = 1500): string[] {
  return jogLines(d, 0, Math.PI * d.rotary.objectDiam, speed);
}

// ---------- Bewegungsliste ----------

/** Bewegungen als typisierte Felder (Rasterjobs haben schnell Hunderttausende davon). f = 0 bedeutet Eilgang. */
export class Moves {
  n = 0;
  x = new Float64Array(1024);
  y = new Float64Array(1024);
  /** Leistung 0 … 1 */
  s = new Float32Array(1024);
  /** Vorschub mm/min, 0 = Eilgang */
  f = new Float32Array(1024);
  /** Layer-Index; Int16, weil der Materialtest bis zu 400 eigene Testlayer anlegt */
  layer = new Int16Array(1024);
  /** Z-Versatz in mm gegenüber der Höhe beim Start (positiv = Fokus tiefer), gilt ab dieser Bewegung */
  z = new Float32Array(1024);
  /** Z-Versatz für die folgenden push-Aufrufe */
  zCur = 0;
  constructor(public x0 = 0, public y0 = 0) {}
  push(x: number, y: number, f: number, s: number, layer: number) {
    if (this.n === this.x.length) {
      const grow = <T extends Float64Array | Float32Array | Int16Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.x = grow(this.x);
      this.y = grow(this.y);
      this.s = grow(this.s);
      this.f = grow(this.f);
      this.layer = grow(this.layer);
      this.z = grow(this.z);
    }
    const i = this.n++;
    this.z[i] = this.zCur;
    this.x[i] = x;
    this.y[i] = y;
    this.f[i] = f;
    this.s[i] = s;
    this.layer[i] = layer;
  }
  lastX() {
    return this.n ? this.x[this.n - 1] : this.x0;
  }
  lastY() {
    return this.n ? this.y[this.n - 1] : this.y0;
  }
}

/**
 * „Start Here“: Job ab einer Stelle fortsetzen. Eilgang zum Punkt bei Anteil frac der Bewegung i,
 * dann der Rest dieser Bewegung und alle folgenden. Liegt die Stelle in einem Eilgang, geht es an dessen Ziel weiter.
 */
export function startHere(mv: Moves, i: number, frac: number): Moves {
  const out = new Moves(mv.x0, mv.y0);
  if (i < 0 || i >= mv.n) return out;
  const ax = i ? mv.x[i - 1] : mv.x0,
    ay = i ? mv.y[i - 1] : mv.y0;
  const f = mv.f[i] > 0 ? Math.min(1, Math.max(0, frac)) : 1;
  out.zCur = mv.z[i];
  out.push(ax + (mv.x[i] - ax) * f, ay + (mv.y[i] - ay) * f, 0, 0, mv.layer[i]);
  if (f < 1) out.push(mv.x[i], mv.y[i], mv.f[i], mv.s[i], mv.layer[i]);
  for (let k = i + 1; k < mv.n; k++) {
    out.zCur = mv.z[k];
    out.push(mv.x[k], mv.y[k], mv.f[k], mv.s[k], mv.layer[k]);
  }
  return out;
}

/** Wird bei diesen Bewegungen überhaupt gelasert? */
export function burns(mv: Moves): boolean {
  for (let i = 0; i < mv.n; i++) if (mv.f[i] > 0 && mv.s[i] > 0) return true;
  return false;
}

/** Gleiche Bahnen, nur um offset verschoben (Vorschau gegen den Job zum Lasern) */
export function sameMoves(a: Moves, b: Moves, offset: Pt): boolean {
  if (a.n !== b.n) return false;
  const e = 1e-6;
  for (let i = 0; i < a.n; i++)
    if (a.f[i] !== b.f[i] || a.s[i] !== b.s[i] || a.layer[i] !== b.layer[i] || a.z[i] !== b.z[i] || Math.abs(a.x[i] + offset.x - b.x[i]) > e || Math.abs(a.y[i] + offset.y - b.y[i]) > e) return false;
  return true;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Ergebnis der Prüfung „liegen alle Fahrwege auf dem Bett?“. box = Fahrbereich in Maschinenkoordinaten
 * (Bett von 0,0 bis Breite × Höhe), measured = mit dem von der Steuerung gemeldeten Werkstück-Nullpunkt gerechnet.
 */
export type BedCheck =
  | { kind: 'ok'; measured: boolean }
  | { kind: 'out'; box: Box; measured: boolean }
  /** Benutzer-Ursprung, dessen Lage die Steuerung (noch) nicht gemeldet hat */
  | { kind: 'unknown' };

/**
 * Fahrwege eines Jobs gegen den Arbeitsbereich prüfen. Der G-Code ist in Werkstückkoordinaten, auf der Maschine
 * landet er um den Werkstück-Nullpunkt wco versetzt. Ist wco unbekannt (null), gilt bei „Absolut“ und
 * „Aktuelle Position“ wie bisher Werkstück = Maschine; beim Benutzer-Ursprung lässt sich dann nichts sagen.
 */
export function checkBed(travel: Box | null, bed: { w: number; h: number }, d: Device, wco: Pt | null): BedCheck {
  if (!travel) return { kind: 'ok', measured: !!wco };
  if (!wco && d.startFrom === 'user') return { kind: 'unknown' };
  const o = wco ?? { x: 0, y: 0 };
  const box = { x0: travel.x0 + o.x, y0: travel.y0 + o.y, x1: travel.x1 + o.x, y1: travel.y1 + o.y };
  const e = 0.01;
  // Mit Drehachse ist Y der Umfang des Objekts, nur X muss aufs Bett passen
  const yOk = rotaryOn(d) || (box.y0 >= -e && box.y1 <= bed.h + e);
  if (box.x0 >= -e && box.x1 <= bed.w + e && yOk) return { kind: 'ok', measured: !!wco };
  return { kind: 'out', box, measured: !!wco };
}

export interface Job {
  moves: Moves;
  /** Ausdehnung der Laserbahnen (ohne Überfahrwege) in Ausgabekoordinaten */
  bounds: Box | null;
  /** Ausdehnung inkl. Überfahrwegen */
  travel: Box | null;
  /** Kontur aller Laserbahnen (konvexe Hülle) für den Gummiband-Rahmen */
  hull: Pt[];
  warnings: string[];
  /** Verschiebung von Bettkoordinaten auf Ausgabekoordinaten */
  offset: Pt;
  /** Layer, bei denen Air Assist läuft */
  air: number[];
}

export interface JobInput {
  doc: Doc;
  layer: (i: number) => Layer;
  imgLayer: (i: number) => ImageLayer;
  device: Device;
  /** Nur diese Objekte (für „Nur Auswahl lasern“) */
  only?: Obj[] | null;
  /** Aktuelle Werkstückposition des Lasers (für „Aktuelle Position“) */
  position?: Pt | null;
  /** Für die Vorschau: Lage auf dem Bett zeigen, unabhängig von „Starten ab“ */
  forPreview?: boolean;
}

// ---------- Geometrie ----------

interface Poly {
  pts: Pt[];
  closed: boolean;
  /** Haltestege: off[i] = 1 heißt, die Strecke von pts[i] zum nächsten Punkt wird ohne Laser gefahren */
  off?: Uint8Array;
  /** Startpunkt und Richtung vom Nutzer gesetzt: die Optimierung beginnt hier und kehrt nicht um */
  fixed?: boolean;
  /** Loch (liegt in einer ungeraden Zahl anderer Formen): Anschnitt und Auslauf liegen innen */
  hole?: boolean;
}

const FLATTEN_TOL = 0.01;

function flatten(sp: SubPath, m: Mat): Poly {
  const pts: Pt[] = [];
  const push = (p: Pt) => {
    const q = apply(m, p.x, p.y);
    const l = pts[pts.length - 1];
    if (!l || Math.abs(l.x - q.x) > 1e-6 || Math.abs(l.y - q.y) > 1e-6) pts.push(q);
  };
  if (sp.nodes.length) push(sp.nodes[0]);
  for (const s of segments(sp)) {
    if (!s.curve) {
      push(s.b);
      continue;
    }
    const w = [s.a, s.c1, s.c2, s.b].map((p) => apply(m, p.x, p.y));
    const len = Math.hypot(w[1].x - w[0].x, w[1].y - w[0].y) + Math.hypot(w[2].x - w[1].x, w[2].y - w[1].y) + Math.hypot(w[3].x - w[2].x, w[3].y - w[2].y);
    const n = Math.max(2, Math.min(4096, Math.ceil(Math.sqrt(len / FLATTEN_TOL) * 0.6)));
    for (let i = 1; i <= n; i++) push(bezierPt(s.a, s.c1, s.c2, s.b, i / n));
  }
  if (sp.closed && pts.length > 2) {
    const a = pts[0],
      b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) pts.pop();
  }
  return { pts, closed: sp.closed && pts.length > 2, ...(sp.start ? { fixed: true } : {}) };
}

function emptyBox(): Box {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}
function addPt(b: Box, x: number, y: number) {
  if (x < b.x0) b.x0 = x;
  if (y < b.y0) b.y0 = y;
  if (x > b.x1) b.x1 = x;
  if (y > b.y1) b.y1 = y;
}
const finite = (b: Box) => (isFinite(b.x0) ? b : null);

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Konvexe Hülle (monotone Kette) */
export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [],
    upper: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Ankerpunkt des Job-Ursprungs (0 … 8, oben links bis unten rechts) in einem Rahmen mit y nach oben */
export function anchorOf(b: Box, k: number): Pt {
  const col = k % 3,
    row = Math.floor(k / 3);
  return { x: b.x0 + ((b.x1 - b.x0) * col) / 2, y: b.y1 - ((b.y1 - b.y0) * row) / 2 };
}

// ---------- Reihenfolge der Linien ----------

/**
 * Optimierte Reihenfolge: Innere Formen vor den umgebenden, sonst immer die nächstgelegene Form.
 * Geschlossene Formen beginnen am nächsten Knoten, offene am näheren Ende.
 */
function orderPolys(polys: Poly[], from: Pt): Poly[] {
  const n = polys.length;
  const boxes = polys.map((p) => {
    const b = emptyBox();
    for (const q of p.pts) addPt(b, q.x, q.y);
    return b;
  });
  // Für jede Form: wie viele noch ungeschnittene Formen liegen in ihr?
  const pending = new Int32Array(n);
  const containers: number[][] = polys.map(() => []);
  for (let i = 0; i < n; i++) {
    const bi = boxes[i];
    for (let j = 0; j < n; j++) {
      if (i === j || !polys[j].closed) continue;
      const bj = boxes[j];
      if (bi.x0 < bj.x0 || bi.y0 < bj.y0 || bi.x1 > bj.x1 || bi.y1 > bj.y1) continue;
      // gleich große Rahmen: nur eine Richtung zählen, sonst blockieren sich deckungsgleiche Formen
      if (bi.x0 === bj.x0 && bi.y0 === bj.y0 && bi.x1 === bj.x1 && bi.y1 === bj.y1 && i < j) continue;
      if (!pointInPoly(polys[i].pts[0], polys[j].pts) && !pointInPoly(midOf(bi), polys[j].pts)) continue;
      containers[i].push(j);
      pending[j]++;
    }
  }
  const done = new Uint8Array(n);
  const out: Poly[] = [];
  let cur = from;
  for (let k = 0; k < n; k++) {
    let best = -1,
      bestD = Infinity,
      bestIdx = 0,
      bestRev = false;
    for (let i = 0; i < n; i++) {
      if (done[i] || pending[i] > 0) continue;
      const b = boxes[i];
      // Untergrenze über den Rahmen: weiter entfernte Formen gar nicht erst durchsuchen
      const dx = Math.max(b.x0 - cur.x, 0, cur.x - b.x1),
        dy = Math.max(b.y0 - cur.y, 0, cur.y - b.y1);
      if (dx * dx + dy * dy >= bestD) continue;
      const p = polys[i];
      if (p.fixed) {
        // gesetzter Startpunkt: nur dort beginnen, Richtung bleibt
        const d = (p.pts[0].x - cur.x) ** 2 + (p.pts[0].y - cur.y) ** 2;
        if (d < bestD) [bestD, best, bestIdx, bestRev] = [d, i, 0, false];
      } else if (p.closed) {
        for (let j = 0; j < p.pts.length; j++) {
          const d = (p.pts[j].x - cur.x) ** 2 + (p.pts[j].y - cur.y) ** 2;
          if (d < bestD) [bestD, best, bestIdx, bestRev] = [d, i, j, false];
        }
      } else {
        const a = p.pts[0],
          e = p.pts[p.pts.length - 1];
        const da = (a.x - cur.x) ** 2 + (a.y - cur.y) ** 2,
          de = (e.x - cur.x) ** 2 + (e.y - cur.y) ** 2;
        if (da < bestD) [bestD, best, bestIdx, bestRev] = [da, i, 0, false];
        if (de < bestD) [bestD, best, bestIdx, bestRev] = [de, i, 0, true];
      }
    }
    if (best < 0) {
      // Zyklus (sollte nicht vorkommen): Rest in Dokumentreihenfolge
      for (let i = 0; i < n; i++) if (!done[i]) ((done[i] = 1), out.push(polys[i]));
      break;
    }
    done[best] = 1;
    for (const c of containers[best]) pending[c]--;
    const p = polys[best];
    let q = p.closed && bestIdx ? startAt(p, bestIdx) : p;
    if (bestRev) q = { pts: [...q.pts].reverse(), closed: false, ...(q.off ? { off: q.off.slice().reverse() } : {}) };
    out.push(q);
    const pts = q.pts;
    const last = p.closed ? pts[0] : pts[pts.length - 1];
    cur = last;
  }
  return out;
}
const midOf = (b: Box): Pt => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

/** Geschlossene Form ab Punkt k beginnen lassen (Haltestege wandern mit) */
function startAt(p: Poly, k: number): Poly {
  const pts = p.pts.slice(k).concat(p.pts.slice(0, k));
  if (!p.off) return { pts, closed: p.closed, fixed: p.fixed, hole: p.hole };
  const off = new Uint8Array(p.off.length);
  off.set(p.off.subarray(k));
  off.set(p.off.subarray(0, k), p.off.length - k);
  return { pts, closed: p.closed, off, fixed: p.fixed, hole: p.hole };
}

// ---------- Kerf und Haltestege ----------

/** Clipper rechnet mit Ganzzahlen: 1 Einheit = 0,1 µm */
const KSCALE = 10000;

/**
 * Kerf-Versatz der geschlossenen Konturen eines Objekts: Fläche nach Gerade-Ungerade-Regel bilden,
 * dann um d versetzen. Positiv vergrößert Außenkonturen und verkleinert Löcher, sodass ausgeschnittene
 * Teile die gezeichneten Maße behalten. Runde Ecken entsprechen dem runden Laserfleck.
 */
export function kerfOffset(polys: Poly[], d: number): Poly[] {
  if (!polys.length || !d) return polys;
  const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType } = ClipperLib;
  const paths = polys.map((p) => p.pts.map((q) => ({ X: Math.round(q.x * KSCALE), Y: Math.round(q.y * KSCALE) })));
  const c = new Clipper();
  c.AddPaths(paths, PolyType.ptSubject, true);
  const area: ClipperLib.Paths = [];
  c.Execute(ClipType.ctUnion, area, PolyFillType.pftEvenOdd, PolyFillType.pftEvenOdd);
  const co = new ClipperOffset(2, 0.002 * KSCALE);
  co.AddPaths(area, JoinType.jtRound, EndType.etClosedPolygon);
  const out: ClipperLib.Paths = [];
  co.Execute(out, d * KSCALE);
  return out.filter((p) => p.length > 2).map((p) => ({ pts: p.map((q) => ({ x: q.X / KSCALE, y: q.Y / KSCALE })), closed: true }));
}

/** Höchstzahl der Ringe je Insel, falls Abstand und Fläche nicht zusammenpassen */
const MAX_RINGS = 20000;

/**
 * Konturfolgende Füllung (Offset Fill): die Fläche (Gerade-Ungerade) wird in Ringen abgetragen, die der Kontur
 * nach innen folgen. Der erste Ring liegt einen halben Abstand innerhalb, damit die Gravur die gezeichneten Maße
 * behält. Jede zusammenhängende Fläche (Insel samt Löchern) wird vollständig von außen nach innen gefüllt,
 * bevor es zur nächstgelegenen weitergeht; jeder Ring beginnt am Punkt, der dem vorigen Ende am nächsten liegt.
 */
function offsetFillRings(polys: Poly[], step: number, from: Pt): Poly[] {
  const closed = polys.filter((p) => p.closed);
  if (!closed.length || !(step > 0)) return [];
  const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree } = ClipperLib;
  const c = new Clipper();
  c.AddPaths(closed.map((p) => p.pts.map((q) => ({ X: Math.round(q.x * KSCALE), Y: Math.round(q.y * KSCALE) }))), PolyType.ptSubject, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftEvenOdd, PolyFillType.pftEvenOdd);
  // Inseln: Außenkontur mit ihren Löchern; Inseln in Löchern sind eigene Inseln
  const islands: ClipperLib.Paths[] = [];
  const walk = (outers: ClipperLib.PolyNode[]) => {
    for (const o of outers) {
      islands.push([o.Contour(), ...o.Childs().map((h) => h.Contour())]);
      for (const h of o.Childs()) walk(h.Childs());
    }
  };
  walk(tree.Childs());
  const ringsOf = (island: ClipperLib.Paths): Poly[] => {
    // Ring für Ring vom vorigen aus versetzen; Aufräumen hält die Punktzahl an runden Ecken klein
    const out: Poly[] = [];
    let area = island;
    for (let k = 0; k < MAX_RINGS && area.length; k++) {
      const co = new ClipperOffset(2, FLATTEN_TOL * KSCALE);
      co.AddPaths(area, JoinType.jtRound, EndType.etClosedPolygon);
      const next: ClipperLib.Paths = [];
      co.Execute(next, -(k ? step : step / 2) * KSCALE);
      area = Clipper.CleanPolygons(next, FLATTEN_TOL * KSCALE).filter((p) => p.length > 2);
      for (const p of area) out.push({ pts: p.map((q) => ({ x: q.X / KSCALE, y: q.Y / KSCALE })), closed: true });
    }
    return out;
  };
  const groups = islands.map(ringsOf).filter((g) => g.length);
  const dist2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const nearest = (p: Poly, cur: Pt) => {
    let best = 0;
    for (let j = 1; j < p.pts.length; j++) if (dist2(p.pts[j], cur) < dist2(p.pts[best], cur)) best = j;
    return best;
  };
  const out: Poly[] = [];
  let cur = from;
  const done = new Uint8Array(groups.length);
  for (let k = 0; k < groups.length; k++) {
    // nächste Insel nach ihrem äußersten Ring
    let gi = -1,
      gd = Infinity;
    for (let i = 0; i < groups.length; i++) {
      if (done[i]) continue;
      const d = dist2(groups[i][0].pts[nearest(groups[i][0], cur)], cur);
      if (d < gd) [gd, gi] = [d, i];
    }
    done[gi] = 1;
    for (const r of groups[gi]) {
      const q = startAt(r, nearest(r, cur));
      out.push(q);
      cur = q.pts[0];
    }
  }
  return out;
}

/** Haltestege gleichmäßig über den Umfang einer geschlossenen Form verteilen */
export function addTabs(p: Poly, T: TabSettings): Poly {
  const P = p.pts,
    n = P.length;
  if (!p.closed || n < 3 || T.size <= 0) return p;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = P[i],
      b = P[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = cum[n];
  let k = T.useCount ? Math.round(T.count) : Math.max(1, Math.round(total / Math.max(0.1, T.spacing)));
  // Stege dürfen höchstens die Hälfte des Umfangs ausmachen
  while (k > 0 && T.size >= (total / k) * 0.5) k--;
  if (k < 1) return p;
  const step = total / k,
    half = T.size / 2;
  const cuts: number[] = [];
  for (let j = 0; j < k; j++) cuts.push(step * (j + 0.5) - half, step * (j + 0.5) + half);
  const inTab = (d: number) => Math.abs(d - step * (Math.floor(d / step) + 0.5)) < half;
  const pts: Pt[] = [],
    off: number[] = [];
  let b = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i],
      e = P[(i + 1) % n];
    const d0 = cum[i],
      d1 = cum[i + 1],
      l = d1 - d0;
    pts.push(a);
    let last = d0;
    while (b < cuts.length && cuts[b] <= d0) b++;
    while (l > 1e-9 && b < cuts.length && cuts[b] < d1) {
      const t = (cuts[b] - d0) / l;
      off.push(inTab((last + cuts[b]) / 2) ? 1 : 0);
      pts.push({ x: a.x + (e.x - a.x) * t, y: a.y + (e.y - a.y) * t });
      last = cuts[b++];
    }
    off.push(inTab((last + d1) / 2) ? 1 : 0);
  }
  return { pts, closed: true, off: Uint8Array.from(off), fixed: p.fixed, hole: p.hole };
}

/** Haltestege für alle geschlossenen Formen eines Layers; innere Formen auf Wunsch auslassen */
function withTabs(polys: Poly[], T: TabSettings): Poly[] {
  const boxes = polys.map((p) => {
    const b = emptyBox();
    for (const q of p.pts) addPt(b, q.x, q.y);
    return b;
  });
  const inner = (i: number) =>
    polys.some((o, j) => {
      if (j === i || !o.closed) return false;
      const a = boxes[i],
        c = boxes[j];
      if (a.x0 < c.x0 || a.y0 < c.y0 || a.x1 > c.x1 || a.y1 > c.y1) return false;
      return pointInPoly(polys[i].pts[0], o.pts);
    });
  return polys.map((p, i) => (p.closed && !(T.skipInner && inner(i)) ? addTabs(p, T) : p));
}

// ---------- Rasterzeilen ----------

/** Ein Lauf auf einer Zeile: von x0 nach x1 (x0 < x1) mit Leistung s (0 … 1) */
type Run = [x0: number, x1: number, s: number];

interface ScanOptions {
  speed: number;
  bidirectional: boolean;
  /** Überfahrweg in mm */
  overscan: number;
  layer: number;
  /** Zeilen liegen in einem um diesen Winkel (rad) gedrehten System */
  angle?: number;
}

/** Lücken bis zu dieser Länge fährt der Laser ausgeschaltet mit Arbeitsgeschwindigkeit durch */
const GAP_RAPID = 10;

function emitScanlines(out: Moves, lines: { y: number; runs: Run[] }[], o: ScanOptions, flip: { v: boolean }) {
  const { speed: F, overscan: ov, layer } = o;
  const rc = Math.cos(o.angle ?? 0),
    rs = Math.sin(o.angle ?? 0);
  const mv = o.angle
    ? { push: (x: number, y: number, f: number, s: number, l: number) => out.push(x * rc - y * rs, x * rs + y * rc, f, s, l) }
    : out;
  for (const ln of lines) {
    if (!ln.runs.length) continue;
    const rev = o.bidirectional && flip.v;
    flip.v = !flip.v;
    const runs = rev ? ln.runs.map(([a, b, s]) => [-b, -a, s] as Run).reverse() : ln.runs;
    const sx = rev ? -1 : 1;
    const y = ln.y;
    let first = true;
    let px = 0;
    for (const [a, b, s] of runs) {
      if (first) {
        mv.push(sx * (a - ov), y, 0, 0, layer);
        mv.push(sx * a, y, F, 0, layer);
        first = false;
      } else if (a - px > GAP_RAPID + 2 * ov) {
        mv.push(sx * (px + ov), y, F, 0, layer);
        mv.push(sx * (a - ov), y, 0, 0, layer);
        mv.push(sx * a, y, F, 0, layer);
      } else if (a > px) mv.push(sx * a, y, F, 0, layer);
      mv.push(sx * b, y, F, s, layer);
      px = b;
    }
    mv.push(sx * (px + ov), y, F, 0, layer);
  }
}

/** Füllen: Zeilen im Abstand interval über alle geschlossenen Formen (gerade-ungerade-Regel) */
function fillLines(polys: Poly[], interval: number, s: number): { y: number; runs: Run[] }[] {
  const edges: [number, number, number, number][] = []; // ymin, ymax, x bei ymin, dx/dy
  const b = emptyBox();
  for (const p of polys) {
    if (!p.closed) continue;
    const n = p.pts.length;
    for (let i = 0; i < n; i++) {
      const a = p.pts[i],
        c = p.pts[(i + 1) % n];
      addPt(b, a.x, a.y);
      if (a.y === c.y) continue;
      const [lo, hi] = a.y < c.y ? [a, c] : [c, a];
      edges.push([lo.y, hi.y, lo.x, (hi.x - lo.x) / (hi.y - lo.y)]);
    }
  }
  if (!edges.length) return [];
  edges.sort((e, f) => e[0] - f[0]);
  const out: { y: number; runs: Run[] }[] = [];
  let next = 0;
  let active: [number, number, number, number][] = [];
  // Zeilen ab der unteren Kante, um ein halbes Intervall versetzt
  for (let y = b.y0 + interval / 2; y < b.y1; y += interval) {
    while (next < edges.length && edges[next][0] <= y) active.push(edges[next++]);
    active = active.filter((e) => e[1] > y);
    const xs = active.map((e) => e[2] + (y - e[0]) * e[3]).sort((p, q) => p - q);
    const runs: Run[] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] < 1e-4) continue;
      const last = runs[runs.length - 1];
      if (last && xs[i] - last[1] < 1e-4) last[1] = xs[i + 1];
      else runs.push([xs[i], xs[i + 1], s]);
    }
    out.push({ y, runs });
  }
  return out;
}

/**
 * Bildzeilen: Ausgabepunkte des geditherten Bildes je Zeile zu Läufen gleicher Leistung zusammenfassen.
 * In der Desktop-App rechnet das der Rust-Kern (src-tauri/core/src/raster.rs, scan_lines) nach denselben Regeln.
 */
async function imageLines(shape: ImageShape, world: Mat, toOut: Mat, L: ImageLayer): Promise<{ y: number; runs: Run[] }[] | null> {
  const { cols, rows } = outputGrid(shape, world, L.interval);
  const M = mul(toOut, world); // lokal (mm) → Ausgabe
  const IM = inv(M);
  const packed = await nativeScanLines(shape, L, cols, rows, M, IM);
  if (packed) return unpackLines(packed);
  // Browser (ohne Rust-Kern)
  const v = processImage(shape, L, cols, rows);
  return v && scanLines(v, shape.w, shape.h, L, cols, rows, M, IM);
}

/** Rasterzeilen aus dem Rust-Kern: je Zeile y, Anzahl der Läufe, dann x0, x1, s je Lauf */
function unpackLines(p: Float64Array): { y: number; runs: Run[] }[] {
  const out: { y: number; runs: Run[] }[] = [];
  for (let i = 0; i < p.length; ) {
    const y = p[i],
      n = p[i + 1];
    i += 2;
    const runs: Run[] = new Array(n);
    for (let k = 0; k < n; k++, i += 3) runs[k] = [p[i], p[i + 1], p[i + 2]];
    out.push({ y, runs });
  }
  return out;
}

/** Rasterzeilen aus dem verarbeiteten Bild v (cols × rows) der Größe w × h mm; M: lokal → Ausgabe, IM: Umkehrung */
export function scanLines(v: Uint8Array | Uint8ClampedArray, w: number, h: number, L: ImageLayer, cols: number, rows: number, M: Mat, IM: Mat): { y: number; runs: Run[] }[] {
  const b = emptyBox();
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const q = apply(M, x, y);
    addPt(b, q.x, q.y);
  }
  // Achsparallel: genau ein Abtastpunkt pro Ausgabepunkt; gedreht: Raster im Zeilenabstand
  const aligned = Math.abs(M[1]) < 1e-9 && Math.abs(M[2]) < 1e-9;
  const stepX = aligned ? (b.x1 - b.x0) / cols : L.interval;
  const stepY = aligned ? (b.y1 - b.y0) / rows : L.interval;
  const nx = Math.max(1, Math.round((b.x1 - b.x0) / stepX)),
    ny = Math.max(1, Math.round((b.y1 - b.y0) / stepY));
  const gray = isGrayMode(L.dither);
  const pmax = L.power / 100,
    pmin = Math.min(L.minPower, L.power) / 100;
  const out: { y: number; runs: Run[] }[] = [];
  for (let j = 0; j < ny; j++) {
    const y = b.y0 + (j + 0.5) * stepY;
    const runs: Run[] = [];
    let cur: Run | null = null;
    for (let k = 0; k < nx; k++) {
      const x = b.x0 + (k + 0.5) * stepX;
      const q = apply(IM, x, y);
      const c = Math.floor((q.x / w) * cols),
        r = Math.floor((q.y / h) * rows);
      let s = 0;
      if (c >= 0 && c < cols && r >= 0 && r < rows) {
        const val = v[r * cols + c];
        if (gray) s = val >= 255 ? 0 : Math.round((pmin + (pmax - pmin) * (1 - val / 255)) * 1000) / 1000;
        else s = val < 128 ? pmax : 0;
      }
      const xa = b.x0 + k * stepX,
        xb = xa + stepX;
      if (cur && cur[2] === s && Math.abs(cur[1] - xa) < 1e-9) cur[1] = xb;
      else {
        if (cur && cur[2] > 0) runs.push(cur);
        cur = [xa, xb, s];
      }
    }
    if (cur && cur[2] > 0) runs.push(cur);
    out.push({ y, runs });
  }
  return out;
}

/** Formen um den Ursprung drehen (Winkel in rad) */
function rotatePolys(polys: Poly[], a: number): Poly[] {
  if (!a) return polys;
  const c = Math.cos(a),
    s = Math.sin(a);
  return polys.map((p) => ({ ...p, pts: p.pts.map((q) => ({ x: q.x * c - q.y * s, y: q.x * s + q.y * c })) }));
}

// ---------- Job berechnen ----------

const FLIP = (h: number): Mat => [1, 0, 0, -1, 0, h];

/** Eine Bearbeitung eines Layers: der Layer selbst oder ein Sub-Layer */
type CutEntry = Omit<CutSettings, 'air' | 'look' | 'sub'>;

/** Bearbeitungen eines Layers in Ausgabereihenfolge: erst der Layer, dann seine eingeschalteten Sub-Layer */
const entriesOf = (L: Layer): CutEntry[] => [L, ...(L.sub ?? []).filter((s: SubLayer) => s.output)];

/** Bewegungen einer Bearbeitung; pass(p) setzt vor jedem Durchgang den Z-Versatz */
function emitEntry(mv: Moves, e: CutEntry, polys: Poly[], li: number, flip: { v: boolean }, pass: (p: number) => void, optimize: boolean) {
  const s = e.power / 100;
  const passes = Math.max(1, e.passes);
  if (e.mode === 'fill' && e.fillStyle === 'offset') {
    const rings = offsetFillRings(polys, Math.max(0.01, e.interval), { x: mv.lastX(), y: mv.lastY() });
    for (let p = 0; p < passes; p++) {
      pass(p);
      for (const r of rings) {
        mv.push(r.pts[0].x, r.pts[0].y, 0, 0, li);
        for (let i = 1; i < r.pts.length; i++) mv.push(r.pts[i].x, r.pts[i].y, e.speed, s, li);
        mv.push(r.pts[0].x, r.pts[0].y, e.speed, s, li);
      }
    }
    return;
  }
  if (e.mode === 'fill') {
    // Zeilen im gedrehten System berechnen und beim Ausgeben zurückdrehen; Kreuzschraffur = zweite Richtung um 90° versetzt
    const angles = [e.angle, ...(e.crossHatch ? [e.angle + 90] : [])].map((a) => (a * Math.PI) / 180);
    const sets = angles.map((a) => ({ a, lines: fillLines(rotatePolys(polys, -a), Math.max(0.01, e.interval), s) }));
    const ov = (Math.max(0, e.overscan) / 100) * (e.speed / 60);
    for (let p = 0; p < passes; p++) {
      pass(p);
      for (const st of sets) emitScanlines(mv, st.lines, { speed: e.speed, bidirectional: e.bidirectional, overscan: ov, layer: li, angle: st.a }, flip);
    }
    return;
  }
  const lead = e.lead.leadIn || e.lead.leadOut || e.lead.overcut > 0 ? e.lead : null;
  if (lead) markHoles(polys);
  let cuts = e.tabs.enabled ? withTabs(polys, e.tabs) : polys;
  if (e.perf.enabled) cuts = cuts.map((p) => perforate(p, e.perf));
  const ramp = e.ramp.enabled && e.ramp.length > 0 && e.minPower < e.power ? e.ramp : null;
  const sMin = Math.max(0, e.minPower) / 100;
  for (let p = 0; p < passes; p++) {
    pass(p);
    const order = optimize ? orderPolys(cuts, { x: mv.lastX(), y: mv.lastY() }) : cuts;
    for (let poly of order) {
      // Nicht in einem Steg beginnen, sonst fährt der Laser ihn zuerst ohne Leistung ab
      if (poly.off?.[0]) poly = startAt(poly, Math.max(0, poly.off.indexOf(0)));
      const path = cutPath(poly, lead);
      if (path.pts.length < 2) continue;
      mv.push(path.pts[0].x, path.pts[0].y, 0, 0, li);
      if (ramp) {
        const r = rampPath(path, s, sMin, ramp);
        for (let i = 1; i < r.pts.length; i++) mv.push(r.pts[i].x, r.pts[i].y, e.speed, r.s[i - 1], li);
      } else for (let i = 1; i < path.pts.length; i++) mv.push(path.pts[i].x, path.pts[i].y, e.speed, path.off[i - 1] ? 0 : s, li);
    }
  }
}

/** Schnittweg einer Form als Punktfolge: off[k] = 1 heißt, Strecke k (pts[k] → pts[k+1]) ohne Laser */
interface CutPath {
  pts: Pt[];
  off: number[];
}

/** Doppelter Flächeninhalt mit Vorzeichen (positiv = gegen den Uhrzeigersinn bei y nach oben) */
function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
  return a;
}

/** Formen, die in einer ungeraden Zahl anderer geschlossener Formen liegen, als Loch markieren */
function markHoles(polys: Poly[]) {
  const boxes = polys.map((p) => {
    const b = emptyBox();
    for (const q of p.pts) addPt(b, q.x, q.y);
    return b;
  });
  for (let i = 0; i < polys.length; i++) {
    if (!polys[i].closed) continue;
    const a = boxes[i];
    let depth = 0;
    for (let j = 0; j < polys.length; j++) {
      if (i === j || !polys[j].closed) continue;
      const c = boxes[j];
      if (a.x0 < c.x0 || a.y0 < c.y0 || a.x1 > c.x1 || a.y1 > c.y1) continue;
      if (a.x0 === c.x0 && a.y0 === c.y0 && a.x1 === c.x1 && a.y1 === c.y1 && i < j) continue;
      if (pointInPoly(polys[i].pts[0], polys[j].pts) || pointInPoly(midOf(a), polys[j].pts)) depth++;
    }
    polys[i].hole = depth % 2 === 1;
  }
}

/**
 * Perforation: entlang der Form abwechselnd on mm schneiden und off mm ohne Laser fahren.
 * Vorhandene Haltestege bleiben ohne Laser.
 */
export function perforate(p: Poly, P: PerfSettings): Poly {
  const on = Math.max(0.01, P.on),
    gap = Math.max(0, P.off);
  if (!gap) return p;
  const src = p.pts,
    n = src.length,
    segs = p.closed ? n : n - 1;
  const pts: Pt[] = [],
    off: number[] = [];
  let state = 0,
    rem = on;
  for (let i = 0; i < segs; i++) {
    const a = src[i],
      b = src[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const base = p.off?.[i] ?? 0;
    pts.push(a);
    let u = 0;
    for (;;) {
      if (rem >= l - u - 1e-9) {
        off.push(base || state);
        rem -= l - u;
        break;
      }
      u += rem;
      off.push(base || state);
      pts.push({ x: a.x + ((b.x - a.x) * u) / l, y: a.y + ((b.y - a.y) * u) / l });
      state ^= 1;
      rem = state ? gap : on;
    }
  }
  if (!p.closed) pts.push(src[n - 1]);
  return { pts, closed: p.closed, off: Uint8Array.from(off), fixed: p.fixed, hole: p.hole };
}

/**
 * Schnittweg einer Form mit Überschnitt, Anschnitt (Lead-In) und Auslauf (Lead-Out). Beides nur bei geschlossenen
 * Formen und immer auf der Abfallseite: bei Außenkonturen außen, bei Löchern innen. Strecken ohne Laser am Ende
 * (Haltesteg, Perforation) fallen weg.
 */
export function cutPath(p: Poly, lead: LeadSettings | null): CutPath {
  const n = p.pts.length;
  const pts = p.pts.slice();
  const off: number[] = [];
  for (let i = 0; i < n - 1; i++) off.push(p.off?.[i] ?? 0);
  if (p.closed) {
    pts.push(p.pts[0]);
    off.push(p.off?.[n - 1] ?? 0);
  }
  const trim = () => {
    while (off.length && off[off.length - 1]) (off.pop(), pts.pop());
  };
  if (!p.closed || !lead || n < 3) {
    trim();
    return { pts, off };
  }
  // Überschnitt: der Kontur über den Anfang hinaus folgen (höchstens eine Runde)
  let rest = lead.overcut;
  for (let i = 0; i < n && rest > 1e-9; i++) {
    const a = pts[i],
      b = pts[i + 1];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l >= rest) {
      pts.push({ x: a.x + ((b.x - a.x) * rest) / l, y: a.y + ((b.y - a.y) * rest) / l });
      off.push(off[i]);
      rest = 0;
    } else {
      pts.push(b);
      off.push(off[i]);
      rest -= l;
    }
  }
  trim();
  if (pts.length < 2) return { pts, off };
  const ccw = signedArea(p.pts) > 0;
  // Abfallseite: rechts der Fahrtrichtung bei gegen den Uhrzeigersinn umlaufenden Außenkonturen
  const side = (t: Pt): Pt => {
    const k = (ccw ? 1 : -1) * (p.hole ? -1 : 1);
    return { x: t.y * k, y: -t.x * k };
  };
  const dir = (a: Pt, b: Pt): Pt | null => {
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    return l > 1e-9 ? { x: (b.x - a.x) / l, y: (b.y - a.y) / l } : null;
  };
  const L = Math.max(0, lead.length);
  if (lead.leadIn && L > 0 && !off[0]) {
    let t: Pt | null = null;
    for (let i = 1; i < pts.length && !t; i++) t = dir(pts[0], pts[i]);
    if (t) {
      const q = leadPts(pts[0], t, side(t), L, lead, true);
      pts.unshift(...q);
      off.unshift(...q.map(() => 0));
    }
  }
  if (lead.leadOut && L > 0 && !off[off.length - 1]) {
    const e = pts[pts.length - 1];
    let t: Pt | null = null;
    for (let i = pts.length - 2; i >= 0 && !t; i--) t = dir(pts[i], e);
    if (t) {
      const q = leadPts(e, t, side(t), L, lead, false);
      pts.push(...q);
      off.push(...q.map(() => 0));
    }
  }
  return { pts, off };
}

/**
 * Punkte von Anschnitt (bis vor p) oder Auslauf (nach p). t = Fahrtrichtung der Kontur an p, w = Richtung zur
 * Abfallseite. Gerade: Länge L im Winkel zur Kontur. Bogen: tangential an die Kontur, Bogenwinkel = angle.
 */
function leadPts(p: Pt, t: Pt, w: Pt, L: number, lead: LeadSettings, isIn: boolean): Pt[] {
  const sg = isIn ? -1 : 1;
  if (!lead.arc) {
    const a = (Math.min(90, Math.max(0, lead.angle)) * Math.PI) / 180;
    return [{ x: p.x + w.x * L * Math.sin(a) + sg * t.x * L * Math.cos(a), y: p.y + w.y * L * Math.sin(a) + sg * t.y * L * Math.cos(a) }];
  }
  const th = (Math.min(180, Math.max(1, lead.angle)) * Math.PI) / 180;
  const r = L / th;
  const c = { x: p.x + w.x * r, y: p.y + w.y * r };
  const m = Math.max(4, Math.ceil(th / (Math.PI / 24)));
  const at = (phi: number): Pt => ({
    x: c.x + r * (-w.x * Math.cos(phi) + sg * t.x * Math.sin(phi)),
    y: c.y + r * (-w.y * Math.cos(phi) + sg * t.y * Math.sin(phi)),
  });
  const out: Pt[] = [];
  if (isIn) for (let k = m; k >= 1; k--) out.push(at((th * k) / m));
  else for (let k = 1; k <= m; k++) out.push(at((th * k) / m));
  return out;
}

/**
 * Leistungsrampe: an Ecken (Richtungswechsel ab R.angle) und auf Wunsch an Anfang und Ende sinkt die Leistung auf
 * sMin und steigt über R.length mm linear wieder auf s. Strecken in Reichweite einer Ecke werden dafür unterteilt.
 * Ergebnis: Punkte und Leistung je Strecke.
 */
export function rampPath(path: CutPath, s: number, sMin: number, R: RampSettings): { pts: Pt[]; s: number[] } {
  const { pts, off } = path;
  const m = pts.length;
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const total = cum[m - 1];
  const limit = Math.cos((Math.min(179, Math.max(1, R.angle)) * Math.PI) / 180);
  // Richtung der Strecke k (null bei Länge 0)
  const dir = (k: number): Pt | null => {
    const l = cum[k + 1] - cum[k];
    return l > 1e-9 ? { x: (pts[k + 1].x - pts[k].x) / l, y: (pts[k + 1].y - pts[k].y) / l } : null;
  };
  const corner = (a: Pt | null, b: Pt | null) => !!a && !!b && a.x * b.x + a.y * b.y <= limit;
  const ramps: number[] = [];
  if (R.ends) ramps.push(0);
  let prev: Pt | null = null;
  let first: Pt | null = null;
  for (let k = 0; k < m - 1; k++) {
    const d = dir(k);
    if (!d) continue;
    if (!first) first = d;
    if (corner(prev, d)) ramps.push(cum[k]);
    prev = d;
  }
  const loop = m > 2 && Math.hypot(pts[0].x - pts[m - 1].x, pts[0].y - pts[m - 1].y) < 1e-6;
  if (!R.ends && loop && corner(prev, first)) ramps.unshift(0), ramps.push(total);
  if (R.ends) ramps.push(total);
  const Lr = R.length;
  const near = (d: number) => {
    // Abstand zur nächsten Rampenstelle (ramps ist aufsteigend)
    let lo = 0,
      hi = ramps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ramps[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    let best = Infinity;
    if (lo < ramps.length) best = ramps[lo] - d;
    if (lo > 0) best = Math.min(best, d - ramps[lo - 1]);
    return best;
  };
  const power = (d: number) => sMin + (s - sMin) * Math.min(1, near(d) / Lr);
  const outPts: Pt[] = [pts[0]],
    outS: number[] = [];
  const step = Math.max(0.05, Lr / 8);
  for (let k = 0; k < m - 1; k++) {
    const a = pts[k],
      b = pts[k + 1],
      c0 = cum[k],
      c1 = cum[k + 1],
      l = c1 - c0;
    if (off[k] || !ramps.length || l < 1e-9 || Math.min(near(c0), near(c1), near((c0 + c1) / 2)) >= Lr) {
      outPts.push(b);
      outS.push(off[k] ? 0 : s);
      continue;
    }
    const n = Math.min(400, Math.max(1, Math.ceil(l / step)));
    for (let j = 1; j <= n; j++) {
      const u = j / n;
      outPts.push(j === n ? b : { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
      outS.push(power(c0 + l * (u - 0.5 / n)));
    }
  }
  return { pts: outPts, s: outS };
}

/** Aus dem Dokument einen Job berechnen. Texte werden mit ihren Schriftkonturen gelasert. */
export async function buildJob(inp: JobInput): Promise<Job> {
  const { doc, device } = inp;
  const layerOf = (i: number) => normalizeLayer(inp.layer(i));
  const warnings: string[] = [];
  let roots = inp.only ?? doc.objs;
  // Parts parked completely outside the work area are not lasered. Only with absolute coordinates: relative jobs
  // ignore the bed position, and with a rotary y is the circumference
  const parked = device.startFrom !== 'absolute' || rotaryOn(device) ? new Set<Obj>() : parkedObjs(roots, doc.bed, layerOf);
  if (parked.size) {
    roots = roots.filter((o) => !parked.has(o));
    warnings.push(tn('{n} Objekt liegt ganz außerhalb des Arbeitsbereichs (geparkt) und wird nicht gelasert.', '{n} Objekte liegen ganz außerhalb des Arbeitsbereichs (geparkt) und werden nicht gelasert.', parked.size));
  }
  const toBed = FLIP(doc.bed.h);

  // 1. Geometrie je Layer sammeln (Bettkoordinaten, y nach oben)
  interface Bucket {
    /** Konturen je Objekt (Kerf wird je Objekt gerechnet) */
    objs: Poly[][];
    /** Konturen je Bearbeitung (Layer, dann Sub-Layer) nach Kerf */
    sets: Poly[][];
    images: { shape: ImageShape; world: Mat }[];
  }
  const buckets = new Map<number, Bucket>();
  const bucket = (i: number) => {
    let b = buckets.get(i);
    if (!b) buckets.set(i, (b = { objs: [], sets: [], images: [] }));
    return b;
  };
  const bounds = emptyBox();
  let skippedOpen = 0;
  for (const [o, world] of laserLeaves(roots)) {
    if (o.reg) continue; // Passermarken nur drucken, nicht lasern
    const L = layerOf(o.layer);
    if (!L.output) continue;
    const s = o.shape;
    if (s.kind === 'image') {
      bucket(o.layer).images.push({ shape: s, world });
      const M = mul(toBed, world);
      for (const [x, y] of [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]]) {
        const q = apply(M, x, y);
        addPt(bounds, q.x, q.y);
      }
      continue;
    }
    let subs: SubPath[];
    if (s.kind === 'text') {
      const f = await loadFont(s.font, s.bold, s.italic);
      subs = textToSubs(s, f.font);
    } else subs = shapeSubs(s);
    const M = mul(toBed, world);
    const own: Poly[] = [];
    for (const sp of subs) {
      if (sp.nodes.length < 2) continue;
      const p = flatten(sp, M);
      if (p.pts.length < 2) continue;
      own.push(p);
    }
    if (own.length) bucket(o.layer).objs.push(own);
  }
  for (const [li, b] of buckets) {
    const ents = entriesOf(layerOf(li));
    const anyLine = ents.some((e) => e.mode === 'line');
    const firstFill = ents.findIndex((e) => e.mode === 'fill');
    b.sets = ents.map((e, k) => {
      const out: Poly[] = [];
      for (const own of b.objs) {
        let polys = own;
        if (e.mode === 'fill') {
          polys = own.filter((p) => p.closed);
          if (!anyLine && k === firstFill) skippedOpen += own.length - polys.length;
        }
        // Kerf je Objekt, damit sich benachbarte Objekte nicht zu einer Fläche verbinden
        if (e.kerf) polys = [...polys.filter((p) => !p.closed), ...kerfOffset(polys.filter((p) => p.closed), e.kerf)];
        for (const p of polys) {
          out.push(p);
          for (const q of p.pts) addPt(bounds, q.x, q.y);
        }
      }
      return out;
    });
  }
  if (skippedOpen) warnings.push(tn('{n} offene Linie auf Füll-Layern übersprungen (Füllen braucht geschlossene Formen).', '{n} offene Linien auf Füll-Layern übersprungen (Füllen braucht geschlossene Formen).', skippedOpen));

  // 2. Verschiebung nach „Starten ab“
  const jb = finite(bounds);
  if (jb && rotaryOn(device)) {
    const c = Math.PI * minObjectDiam(device.rotary);
    if (c > 0 && jb.y1 - jb.y0 > c + 0.01)
      warnings.push(t('Der Job ist {h} mm hoch, der Umfang des Objekts aber nur {c} mm: Er überlappt sich beim Drehen.', { h: (jb.y1 - jb.y0).toFixed(1), c: c.toFixed(1) }));
  }
  let offset: Pt = { x: 0, y: 0 };
  // Auch für die Vorschau: so ergibt sich dieselbe Reihenfolge wie beim Lasern (sie hängt vom Startpunkt ab)
  if (jb && device.startFrom !== 'absolute') {
    const a = anchorOf(jb, device.jobOrigin);
    const target = device.startFrom === 'current' && inp.position ? inp.position : { x: 0, y: 0 };
    offset = { x: target.x - a.x, y: target.y - a.y };
  }
  const toOut = mul([1, 0, 0, 1, offset.x, offset.y], toBed);
  if (offset.x || offset.y) {
    // Ohne Kerf teilen sich Layer und Sub-Layer dieselben Punkte: jeden nur einmal verschieben
    const moved = new Set<Pt>();
    for (const b of buckets.values())
      for (const set of b.sets)
        for (const p of set)
          for (const q of p.pts) {
            if (moved.has(q)) continue;
            moved.add(q);
            q.x += offset.x;
            q.y += offset.y;
          }
  }

  // 3. Bewegungen je Layer in Ausgabereihenfolge
  const start: Pt = device.startFrom === 'current' && inp.position ? inp.position : { x: 0, y: 0 };
  const mv = new Moves(start.x, start.y);
  const order = [...buckets.keys()].sort((a, b) => (layerOf(a).priority ?? a) - (layerOf(b).priority ?? b) || a - b);
  // Z-Versatz nur mit Z-Achse; ist Z die Drehachse, bleibt der Fokus, wo er ist
  const useZ = device.zAxis && !(rotaryOn(device) && device.rotary.axis === 'Z');
  let zSkipped = false;
  for (const li of order) {
    const L = layerOf(li);
    const bk = buckets.get(li)!;
    const flip = { v: false };
    mv.zCur = 0;
    // Bilder zuerst (gravieren), dann Vektoren
    if (bk.images.length) {
      const IL = inp.imgLayer(li);
      const ov = (IL.overscan / 100) * (IL.speed / 60);
      for (const im of bk.images) {
        const lines = await imageLines(im.shape, im.world, toOut, IL);
        if (!lines) {
          warnings.push(t('Bild „{name}“ ist noch nicht geladen und wurde übersprungen.', { name: im.shape.name ?? t('Bild') }));
          continue;
        }
        for (let p = 0; p < Math.max(1, IL.passes); p++) emitScanlines(mv, lines, { speed: IL.speed, bidirectional: IL.bidirectional, overscan: ov, layer: li }, flip);
      }
    }
    entriesOf(L).forEach((e, k) => {
      const polys = bk.sets[k];
      if (!polys?.length) return;
      if (!useZ && (e.zOffset || e.zStep)) zSkipped = true;
      // Z je Durchgang: erster Durchgang beim Z-Versatz, jeder weitere um zStep tiefer
      const pass = (p: number) => (mv.zCur = useZ ? e.zOffset + p * e.zStep : 0);
      emitEntry(mv, e, polys, li, flip, pass, device.optimize);
      mv.zCur = 0;
    });
  }
  if (zSkipped)
    warnings.push(
      device.zAxis
        ? t('Z-Versatz übersprungen: Die Z-Achse ist als Drehachse eingestellt.')
        : t('Z-Versatz übersprungen: Für dieses Gerät ist keine Z-Achse eingestellt (Geräteeinstellungen).'),
    );
  mv.zCur = 0;
  if (mv.n && device.returnHome) mv.push(start.x, start.y, 0, 0, -1);
  // Vorschau: dieselben Bahnen an ihrer Lage auf dem Bett zeigen
  if (inp.forPreview && (offset.x || offset.y)) {
    for (let i = 0; i < mv.n; i++) {
      mv.x[i] -= offset.x;
      mv.y[i] -= offset.y;
    }
    mv.x0 -= offset.x;
    mv.y0 -= offset.y;
    offset = { x: 0, y: 0 };
  }

  // 4. Ausdehnung und Kontur
  const ob = jb ? { x0: jb.x0 + offset.x, y0: jb.y0 + offset.y, x1: jb.x1 + offset.x, y1: jb.y1 + offset.y } : null;
  const travel = emptyBox();
  const hullPts: Pt[] = [];
  let px = mv.x0,
    py = mv.y0;
  for (let i = 0; i < mv.n; i++) {
    if (mv.f[i] > 0) {
      addPt(travel, px, py);
      addPt(travel, mv.x[i], mv.y[i]);
      if (mv.s[i] > 0) hullPts.push({ x: px, y: py }, { x: mv.x[i], y: mv.y[i] });
    }
    px = mv.x[i];
    py = mv.y[i];
  }
  const air = order.filter((li) => layerOf(li).air);
  return { moves: mv, bounds: ob, travel: finite(travel), hull: convexHull(dedupe(hullPts)), warnings, offset, air };
}

function dedupe(pts: Pt[]): Pt[] {
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const p of pts) {
    const k = `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    if (!seen.has(k)) (seen.add(k), out.push(p));
  }
  return out;
}

// ---------- Laufzeit ----------

export interface Estimate {
  /** Endzeit jeder Bewegung in Sekunden */
  t: Float64Array;
  total: number;
  cutLength: number;
  rapidLength: number;
}

/**
 * Laufzeitschätzung wie im Bahnplaner von GRBL/FluidNC: Übergangsgeschwindigkeit an Ecken
 * aus der Junction Deviation, Rückwärts- und Vorwärtsdurchlauf, Trapezprofil je Strecke.
 */
export function estimate(mv: Moves, d: Device): Estimate {
  const n = mv.n;
  const a = Math.max(1, d.accel);
  const rapid = Math.max(1, d.rapid) / 60;
  const len = new Float64Array(n),
    vmax = new Float64Array(n),
    vj = new Float64Array(n + 1);
  let px = mv.x0,
    py = mv.y0,
    ux = 0,
    uy = 0,
    cutLength = 0,
    rapidLength = 0;
  for (let i = 0; i < n; i++) {
    const dx = mv.x[i] - px,
      dy = mv.y[i] - py;
    const l = Math.hypot(dx, dy);
    len[i] = l;
    vmax[i] = mv.f[i] > 0 ? Math.min(mv.f[i] / 60, rapid) : rapid;
    if (mv.f[i] > 0 && mv.s[i] > 0) cutLength += l;
    else rapidLength += l;
    if (l > 1e-9) {
      const nx = dx / l,
        ny = dy / l;
      // Wechsel zwischen Eilgang und Vorschub: FluidNC plant beides, behandeln wie eine Ecke
      if (i === 0 || (ux === 0 && uy === 0)) vj[i] = 0;
      else {
        const cos = -(ux * nx + uy * ny);
        if (cos > 0.999999) vj[i] = 0;
        else if (cos < -0.999999) vj[i] = Infinity;
        else {
          const sh = Math.sqrt(0.5 * (1 - cos));
          vj[i] = Math.sqrt((a * d.junction * sh) / (1 - sh));
        }
      }
      ux = nx;
      uy = ny;
    } else vj[i] = Infinity;
    px = mv.x[i];
    py = mv.y[i];
  }
  // v[i] = Geschwindigkeit am Anfang von Strecke i
  const v = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) v[i] = Math.min(vj[i], vmax[i], i > 0 ? vmax[i - 1] : 0);
  v[n] = 0;
  for (let i = n - 1; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * a * len[i]));
  for (let i = 0; i < n; i++) v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] ** 2 + 2 * a * len[i]));
  const t = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const l = len[i];
    if (l > 1e-9) {
      const v0 = v[i],
        v1 = v[i + 1],
        vc = vmax[i];
      const d1 = (vc * vc - v0 * v0) / (2 * a),
        d2 = (vc * vc - v1 * v1) / (2 * a);
      if (d1 + d2 > l) {
        const vp = Math.sqrt(Math.max(0, (2 * a * l + v0 * v0 + v1 * v1) / 2));
        total += Math.max(0, (vp - v0) / a) + Math.max(0, (vp - v1) / a);
      } else total += (vc - v0) / a + (vc - v1) / a + (l - d1 - d2) / vc;
    }
    t[i] = total;
  }
  return { t, total, cutLength, rapidLength };
}

export function formatDuration(sec: number): string {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} h` : `${m}:${String(s).padStart(2, '0')} min`;
}

// ---------- G-Code ----------

/** S-Wert für Leistung 0 … 1; bei kleiner Skala (Smoothieware 0 … 1) mit mehr Nachkommastellen */
const sValue = (p: number, d: Device) => {
  const k = d.sMax > 100 ? 10 : 1000;
  return Math.round(p * d.sMax * k) / k;
};

const num = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

export interface GCode {
  lines: string[];
  /** Geschätzte Zeit (s), zu der die Zeile fertig ist */
  times: Float64Array;
  total: number;
}

/**
 * G-Code für FluidNC/GRBL im Lasermodus: M4 (Leistung folgt der Geschwindigkeit), S je Bewegung,
 * unveränderte Werte (G1, X, Y, F, S) werden weggelassen. Air Assist wird je Layer mit M8/M7 ein-
 * und mit M9 ausgeschaltet.
 */
export function writeGCode(job: Job, d: Device, est: Estimate, name = 'KizamuBeam'): GCode {
  const header = gcodeHeader(job, d, est, name);
  const r = rotaryMoves(job.moves, d, job.bounds, est.t);
  return gcodeLines(r.mv, d, { ...est, t: r.t! }, job.air, header);
}

/** Kopf des G-Codes: Kommentare, Einheiten, absolute Koordinaten, Laser im Lasermodus an */
function gcodeHeader(job: Job, d: Device, est: Estimate, name: string): string[] {
  const out: string[] = [];
  out.push(`; ${name}`);
  out.push(t('; Erzeugt von KizamuBeam am {date}', { date: new Date().toLocaleString(locale) }));
  out.push(t('; Geschätzte Dauer: {total}', { total: formatDuration(est.total) }));
  if (job.bounds) out.push(t('; Bereich: X {x0} … {x1}, Y {y0} … {y1} mm', { x0: num(job.bounds.x0), x1: num(job.bounds.x1), y0: num(job.bounds.y0), y1: num(job.bounds.y1) }));
  const fw = FIRMWARES[d.fw];
  out.push(t('; Gerät: {name} ({label})', { name: d.name, label: fw.label }));
  out.push(...rotaryComment(d));
  out.push('G21', 'G90', ...rotaryZero(d), ...fw.laserOn, ...jobOutputsOn(d), ...scriptLines(d.startScript));
  return out;
}

/** Beschreibung der Drehachse im Kopf des G-Codes */
function rotaryComment(d: Device): string[] {
  if (!rotaryOn(d)) return [];
  const r = d.rotary;
  return [
    r.kind === 'chuck'
      ? t('; Drehachse: Futter, Achse {axis}, {perRev} je Umdrehung, Objekt Ø {od} mm', { axis: r.axis, perRev: num(r.perRev), od: num(r.objectDiam) })
      : t('; Drehachse: Walzen Ø {rd} mm, Achse {axis}, {perRev} je Umdrehung', { axis: r.axis, perRev: num(r.perRev), rd: num(r.rollerDiam) }),
    ...(taperOn(r) ? [t('; Konisch: Ø {l} mm links, Ø {r} mm rechts', { l: num(r.taperLeft), r: num(r.taperRight) })] : []),
  ];
}

/** Eigene Drehachse: die aktuelle Stellung wird zur 0, von dort aus rechnet der Job */
const rotaryZero = (d: Device) => (separateAxis(d) ? [`G92 ${d.rotary.axis}0`] : []);

/** Zeilen eines Skripts aus den Geräteeinstellungen, ohne Leerzeilen */
export function scriptLines(s: string | undefined): string[] {
  return (s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Ende des Jobs: Laser aus, Ausgänge aus, dann das eigene End-Skript, dann Programmende der Steuerung (M2, M400) */
export function gcodeFooter(d: Device): string[] {
  const f = FIRMWARES[d.fw].footer;
  const end = [...jobOutputsOff(d), ...scriptLines(d.endScript)];
  const k = f.indexOf('M5');
  return k < 0 ? [...f, ...end] : [...f.slice(0, k + 1), ...end, ...f.slice(k + 1)];
}

/**
 * Bewegungen zu G-Code-Zeilen. Der Rust-Kern (src-tauri/core/src/gcode.rs) schreibt in der Desktop-App
 * dieselben Zeilen; Änderungen hier müssen dort nachgezogen werden (Vergleichstest: npm run test:core).
 */
/**
 * Z-Bewegungen zwischen den Bewegungen: relativ (G91 … G90), damit die Fokushöhe beim Start als Bezug gilt.
 * at = [Index der Bewegung, Zeilen davor], end = Zeilen zurück auf die Starthöhe vor dem Ende des Jobs.
 */
export function zInserts(mv: Moves, d: Device): { at: [number, string[]][]; end: string[] } {
  const at: [number, string[]][] = [];
  // Z-Versatz positiv = Fokus tiefer: ohne zFlip fährt der Kopf dafür nach unten (Z−)
  const k = d.zFlip ? 1 : -1;
  const move = (dz: number) => ['G91', `G0 Z${num(dz * k)}`, 'G90'];
  let z = 0;
  for (let i = 0; i < mv.n; i++) {
    const zi = mv.z[i];
    if (num(zi) === num(z)) continue;
    at.push([i, move(zi - z)]);
    z = zi;
  }
  return { at, end: num(z) === '0' ? [] : move(-z) };
}

export function gcodeLines(mv: Moves, d: Device, est: Estimate, airList: number[], header: string[]): GCode {
  const lines: string[] = [...header];
  const times: number[] = header.map(() => 0);
  const zs = zInserts(mv, d);
  let zk = 0;
  let g = -1,
    cx = mv.x0,
    cy = mv.y0,
    cf = -1,
    cs = -1,
    known = false;
  const airLayers = new Set(airList);
  const axis = outAxis(d);
  let air = false;
  for (let i = 0; i < mv.n; i++) {
    const x = mv.x[i],
      y = mv.y[i];
    // Z-Zeilen vor der Bewegung; danach G0/G1 wieder ausschreiben
    for (; zk < zs.at.length && zs.at[zk][0] === i; zk++) {
      for (const l of zs.at[zk][1]) {
        lines.push(l);
        times.push(i ? est.t[i - 1] : 0);
      }
      g = -1;
    }
    const wantAir = airLayers.has(mv.layer[i]);
    if (wantAir !== air) {
      air = wantAir;
      lines.push(air ? d.airCmd || 'M8' : 'M9');
      times.push(i ? est.t[i - 1] : 0);
    }
    const rapid = mv.f[i] === 0;
    const xs = num(x),
      ys = num(y);
    // Bewegungen ohne Ortswechsel (nach Rundung) fallen weg, ohne den modalen Zustand zu verändern
    if (known && xs === num(cx) && ys === num(cy)) continue;
    let l = '';
    if (rapid) {
      if (g !== 0) l += 'G0';
      g = 0;
    } else if (g !== 1) {
      l += 'G1';
      g = 1;
    }
    if (!known || xs !== num(cx)) l += `${l ? ' ' : ''}X${xs}`;
    if (!known || ys !== num(cy)) l += `${l ? ' ' : ''}${axis}${ys}`;
    known = true;
    if (!rapid) {
      const s = sValue(mv.s[i], d);
      if (s !== cs) l += ` S${s}`;
      cs = s;
      if (mv.f[i] !== cf) l += ` F${Math.round(mv.f[i])}`;
      cf = mv.f[i];
    }
    cx = x;
    cy = y;
    lines.push(l.trim());
    times.push(est.t[i]);
  }
  for (const l of [...(air ? ['M9'] : []), ...zs.end, ...gcodeFooter(d)]) {
    lines.push(l);
    times.push(est.total);
  }
  return { lines, times: Float64Array.from(times), total: est.total };
}

/**
 * G-Code für Start und Speichern. In der Desktop-App schreibt ihn der Rust-Kern und behält die Zeilen
 * (id), damit Millionen Rasterzeilen nicht als Text durch die Oberfläche müssen; im Browser stehen sie in lines.
 */
export interface PreparedGCode {
  id: number | null;
  lines: string[] | null;
  count: number;
  /** Geschätzte Zeit (s), zu der die Zeile fertig ist */
  times: Float64Array;
  total: number;
}

export async function prepareGCode(job: Job, d: Device, est: Estimate, name = 'KizamuBeam'): Promise<PreparedGCode> {
  const header = gcodeHeader(job, d, est, name);
  if (hasNative()) {
    try {
      const { mv, t } = rotaryMoves(job.moves, d, job.bounds, est.t);
      const zs = zInserts(mv, d);
      const params = JSON.stringify({ x0: mv.x0, y0: mv.y0, sMax: d.sMax, air: job.air, airCmd: d.airCmd || 'M8', header, footer: [...zs.end, ...gcodeFooter(d)], total: est.total, yAxis: outAxis(d), inserts: zs.at });
      const buf = await native<ArrayBuffer>('gcode_prepare', packMoves(mv, t!, params));
      const head = new Uint32Array(buf, 0, 2);
      return { id: head[0], lines: null, count: head[1], times: new Float64Array(buf, 8), total: est.total };
    } catch {
      /* ältere Desktop-App ohne Rust-Kern: weiter in TypeScript */
    }
  }
  const r = rotaryMoves(job.moves, d, job.bounds, est.t);
  const g = gcodeLines(r.mv, d, { ...est, t: r.t! }, job.air, header);
  return { id: null, lines: g.lines, count: g.lines.length, times: g.times, total: g.total };
}

/** Bewegungen für den Rust-Kern: u32 n, u32 JSON-Länge, JSON, Auffüllung auf 8 Byte, x, y, t (f64), f, s (f32), layer (i16) */
export function packMoves(mv: Moves, t: Float64Array, params: string): Uint8Array {
  const json = new TextEncoder().encode(params);
  const n = mv.n;
  const start = Math.ceil((8 + json.length) / 8) * 8;
  const buf = new ArrayBuffer(start + n * (8 * 3 + 4 * 2 + 2));
  const head = new DataView(buf);
  head.setUint32(0, n, true);
  head.setUint32(4, json.length, true);
  new Uint8Array(buf, 8, json.length).set(json);
  let off = start;
  const put = <T extends Float64Array | Float32Array | Int16Array>(Ctor: new (b: ArrayBuffer, o: number, l: number) => T, src: T) => {
    new Ctor(buf, off, n).set(src.subarray(0, n) as never);
    off += n * (src.BYTES_PER_ELEMENT as number);
  };
  put(Float64Array, mv.x);
  put(Float64Array, mv.y);
  put(Float64Array, t);
  put(Float32Array, mv.f);
  put(Float32Array, mv.s);
  put(Int16Array, mv.layer);
  return new Uint8Array(buf);
}

// ---------- Rahmen ----------

/** Rahmenfahrt um den Job: Rechteck oder Kontur (konvexe Hülle), wahlweise mit schwachem Laser */
export function frameGCode(job: Job, d: Device, contour: boolean): string[] | null {
  const b = job.bounds;
  if (!b) return null;
  let pts: Pt[] =
    contour && job.hull.length >= 3
      ? job.hull
      : [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }];
  pts = [...pts, pts[0]];
  const fw = FIRMWARES[d.fw];
  const s = d.frameLaser ? sValue(d.framePower / 100, d) : 0;
  const rot = rotaryOn(d);
  const raw = new Moves(job.moves.x0, job.moves.y0);
  raw.push(pts[0].x, pts[0].y, 0, 0, 0);
  for (let i = 1; i < pts.length; i++) raw.push(pts[i].x, pts[i].y, d.frameSpeed, 0, 0);
  // Mit Drehachse zurück zum Start, sonst beginnt der Job (oder der nächste Rahmen) an einer verdrehten Stelle
  if (rot) raw.push(raw.x0, raw.y0, 0, 0, 0);
  const mv = rotaryMoves(raw, d, b).mv;
  const axis = outAxis(d);
  const out = ['G21', 'G90', ...rotaryZero(d), ...(d.frameLaser ? fw.frameOn : [])];
  let cf = -1,
    first = true;
  for (let i = 0; i < mv.n; i++) {
    const xy = `X${num(mv.x[i])} ${axis}${num(mv.y[i])}`;
    if (mv.f[i] === 0) {
      out.push(`G0 ${xy}`);
      continue;
    }
    out.push(`G1 ${xy}${first ? ` S${s}` : ''}${mv.f[i] !== cf ? ` F${Math.round(mv.f[i])}` : ''}`);
    first = false;
    cf = mv.f[i];
  }
  out.push(...fw.footer.filter((l) => l !== 'M2'));
  return out;
}

/**
 * Laserpunkt zum Zielen (z. B. auf Passermarken): Laser mit sehr kleiner Leistung im Stand einschalten bzw. aus.
 * GRBL/grblHAL/FluidNC feuern im Laser-Modus nur im Modus G1 und mit M3 (konstante Leistung) auch ohne Bewegung,
 * Marlin feuert mit M3 sofort, Smoothieware hat dafür den Befehl „fire“.
 */
export function pointerGCode(d: Device, on: boolean, percent: number): string[] {
  const p = Math.max(0, Math.min(10, percent));
  // Ruida: Laser außerhalb eines Auftrags nie einschalten (die meisten CO2-Maschinen haben einen roten Zielpunkt)
  if (d.fw === 'ruida') return on ? [] : ['M5'];
  if (d.fw === 'smoothie') return on ? [`fire ${num(p)}`] : ['fire off'];
  if (!on) return ['M5'];
  const s = sValue(p / 100, d);
  if (d.fw === 'marlin') return [`M3 S${s}`];
  return ['G1 F1000', `M3 S${s}`];
}
