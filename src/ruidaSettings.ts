// Einstellungen von Ruida-Steuerungen: bekannte Speicheradressen, Gruppen, Einheiten und Umrechnung.
// Ohne DOM, damit es sich testen lässt (npm run test:ruida). Die Oberfläche dazu steht in ruidaDialog.ts.
//
// Adressen und englische Namen nach MeerK40t (MIT-Lizenz, meerk40t/ruida/emulator.py: mem_lookup), dort aus
// Mitschnitten von RDWorks/LightBurn mit RDC644x-Steuerungen gewonnen. Die Steuerung speichert Längen in µm,
// Geschwindigkeiten in µm/s und Beschleunigungen in µm/s² (der Arbeitsbereich 0x0026/0x0036 ist so bestätigt);
// bei allen anderen Werten ist die Einheit nicht gesichert, sie werden als Rohwert gezeigt und geschrieben.
import { t } from './i18n';

/** mm = µm gespeichert; mm/s, mm/s² entsprechend; raw = Zahl wie gespeichert; bits = Bitfeld; pos = vorzeichenbehaftet in µm */
export type RuidaUnit = 'mm' | 'mm/s' | 'mm/s²' | 'raw' | 'bits' | 'pos' | 'hex' | 'text';

export interface RuidaSetting {
  /** Adresse als 14-Bit-Zahl, wie sie in DA 00/DA 01 steht */
  addr: number;
  name: string;
  /** Englischer Name wie in RDWorks/MeerK40t, zum Wiederfinden */
  en: string;
  group: RuidaGroup;
  unit: RuidaUnit;
  /** Nur lesen (Zähler, Positionen, Kennungen) */
  readonly?: boolean;
}

export type RuidaGroup = 'axes' | 'laser' | 'machine' | 'user' | 'info';

export const RUIDA_GROUPS: { id: RuidaGroup; label: string; note: string }[] = [
  { id: 'axes', label: t('Achsen'), note: t('Herstellerparameter der Achsen X, Y, Z und U: Motor, Geschwindigkeiten, Fahrbereich, Referenzfahrt.') },
  { id: 'laser', label: t('Laser'), note: t('Herstellerparameter der Laserröhren 1 bis 6: Leistungsgrenzen und PWM-Frequenz.') },
  { id: 'machine', label: t('Maschine'), note: t('Herstellerparameter der Maschine: Eilgang, Referenzfahrt, Ränder, Steuerbits.') },
  { id: 'user', label: t('Benutzer'), note: t('Benutzerparameter: Ecken, Gravieren, Handrad und Tasten, Verzögerungen, Z/U-Achse, Ausblasen.') },
  { id: 'info', label: t('Zähler und Info'), note: t('Nur zum Lesen: Kennung, Firmware, Laufzeiten, Positionen.') },
];

const AXES = ['X', 'Y', 'Z', 'U'];

function axisSettings(): RuidaSetting[] {
  const out: RuidaSetting[] = [];
  AXES.forEach((axis, i) => {
    const b = 0x20 + i * 0x10;
    const n = i + 1;
    const add = (off: number, name: string, en: string, unit: RuidaUnit) => out.push({ addr: b + off, name, en: `${en} ${n}`, group: 'axes', unit });
    add(0x0, t('Achse {axis}: Steuerparameter (Bits)', { axis }), 'Axis Control Para', 'bits');
    add(0x1, t('Achse {axis}: Schrittweite (Präzision)', { axis }), 'Axis Precision', 'raw');
    add(0x3, t('Achse {axis}: Höchstgeschwindigkeit', { axis }), 'Axis Max Velocity', 'mm/s');
    add(0x4, t('Achse {axis}: Startgeschwindigkeit', { axis }), 'Axis Start Velocity', 'mm/s');
    add(0x5, t('Achse {axis}: Höchstbeschleunigung', { axis }), 'Axis Max Acc', 'mm/s²');
    add(0x6, t('Achse {axis}: Fahrbereich', { axis }), 'Axis Range', 'mm');
    add(0x7, t('Achse {axis}: Startgeschwindigkeit Tasten', { axis }), 'Axis Btn Start Velocity', 'mm/s');
    add(0x8, t('Achse {axis}: Beschleunigung Tasten', { axis }), 'Axis Btn Acc', 'mm/s²');
    add(0x9, t('Achse {axis}: Beschleunigung Not-Halt', { axis }), 'Axis Estp Acc', 'mm/s²');
    add(0xa, t('Achse {axis}: Versatz nach Referenzfahrt', { axis }), 'Axis Home Offset', 'mm');
    add(0xb, t('Achse {axis}: Umkehrspiel', { axis }), 'Axis Backlash', 'mm');
  });
  const home = (addr: number, axis: string, n: number) =>
    out.push({ addr, name: t('Achse {axis}: Geschwindigkeit Referenzfahrt', { axis }), en: `Axis Home Velocity ${n}`, group: 'axes', unit: 'mm/s' });
  home(0x00c8, 'X', 1);
  home(0x00c9, 'Y', 2);
  home(0x0140, 'Z', 3);
  home(0x0142, 'U', 4);
  out.push({ addr: 0x0141, name: t('Achse {axis}: Arbeitsgeschwindigkeit', { axis: 'Z' }), en: 'Axis Work Velocity 3', group: 'axes', unit: 'mm/s' });
  out.push({ addr: 0x0143, name: t('Achse {axis}: Arbeitsgeschwindigkeit', { axis: 'U' }), en: 'Axis Work Velocity 4', group: 'axes', unit: 'mm/s' });
  return out;
}

function laserSettings(): RuidaSetting[] {
  // Röhre: Min-Leistung, Max-Leistung, PWM-Frequenz, Bereitschaftsfrequenz, Bereitschaftspuls
  const tubes: [number, number, number, number, number][] = [
    [0x0012, 0x0013, 0x0011, 0x001a, 0x001b],
    [0x0018, 0x0019, 0x0017, 0x001c, 0x001d],
    [0x0063, 0x0064, 0x0065, 0x0066, 0x0067],
    [0x0068, 0x0069, 0x006a, 0x006b, 0x006c],
    [0x006d, 0x006e, 0x006f, 0x0070, 0x0071],
    [0x0072, 0x0073, 0x0074, 0x0075, 0x0076],
  ];
  const out: RuidaSetting[] = [];
  tubes.forEach(([mn, mx, fq, sf, sp], i) => {
    const n = i + 1;
    out.push(
      { addr: mn, name: t('Laser {n}: Min-Leistung', { n }), en: `Laser Min Power ${n}`, group: 'laser', unit: 'raw' },
      { addr: mx, name: t('Laser {n}: Max-Leistung', { n }), en: `Laser Max Power ${n}`, group: 'laser', unit: 'raw' },
      { addr: fq, name: t('Laser {n}: PWM-Frequenz', { n }), en: `Laser PWM Frequency ${n}`, group: 'laser', unit: 'raw' },
      { addr: sf, name: t('Laser {n}: Bereitschaftsfrequenz', { n }), en: `Laser Standby Frequency ${n}`, group: 'laser', unit: 'raw' },
      { addr: sp, name: t('Laser {n}: Bereitschaftspuls', { n }), en: `Laser Standby Pulse ${n}`, group: 'laser', unit: 'raw' },
    );
  });
  out.push(
    { addr: 0x0002, name: t('Laser-Info (Bits)'), en: 'Laser Info', group: 'laser', unit: 'bits' },
    { addr: 0x0016, name: t('Laser-Abschwächung'), en: 'Laser Attenuation', group: 'laser', unit: 'raw' },
    { addr: 0x014c, name: t('Laser-Rücksetzzeit'), en: 'Laser Reset Time', group: 'laser', unit: 'raw' },
    { addr: 0x014d, name: t('Laser-Startstrecke'), en: 'Laser Start Distance', group: 'laser', unit: 'mm' },
  );
  return out;
}

const MACHINE: [number, string, string, RuidaUnit][] = [
  [0x0003, t('Maschinendefinition (Bits)'), 'Machine Def', 'bits'],
  [0x0004, t('Ein-/Ausgänge freigeben (Bits)'), 'IOEnable', 'bits'],
  [0x0005, t('Eilganggeschwindigkeit (G0)'), 'G0 Velocity', 'mm/s'],
  [0x000b, t('Gravur-Punktgröße'), 'Eng Facula', 'raw'],
  [0x000c, t('Geschwindigkeit Referenzfahrt'), 'Home Velocity', 'mm/s'],
  [0x000e, t('Gravur-Zeilengeschwindigkeit'), 'Eng Vert Velocity', 'mm/s'],
  [0x0010, t('Systemsteuermodus (Bits)'), 'System Control Mode', 'bits'],
  [0x0060, t('Maschinentyp'), 'Machine Type', 'raw'],
  [0x001e, t('Automatischer Schriftabstand'), 'Auto Type Space', 'raw'],
  [0x001f, t('Dreifarbenlampe'), 'TriColor', 'raw'],
  [0x00ca, t('Rand 1'), 'Margin 1', 'mm'],
  [0x00cb, t('Rand 2'), 'Margin 2', 'mm'],
  [0x00cc, t('Rand 3'), 'Margin 3', 'mm'],
  [0x00cd, t('Rand 4'), 'Margin 4', 'mm'],
];

const USER: [number, string, string, RuidaUnit][] = [
  [0x0100, t('Systemeinstellungen (Bits)'), 'System Settings', 'bits'],
  [0x0101, t('Eckengeschwindigkeit'), 'Turn Velocity', 'mm/s'],
  [0x0102, t('Synchron-Beschleunigung'), 'Syn Acc', 'mm/s²'],
  [0x0103, t('Verzögerung nach Eilgang'), 'G0 Delay', 'raw'],
  [0x0104, t('Faktor Zeilenabstand'), 'Scan Step Factor', 'raw'],
  [0x0105, t('Benutzerparameter 5'), 'User Para 5', 'raw'],
  [0x0107, t('Vorschub: Verzögerung danach'), 'Feed Delay After', 'raw'],
  [0x0108, t('Tasten: schnelle Geschwindigkeit'), 'User Key Fast Velocity', 'mm/s'],
  [0x0109, t('Eckenbeschleunigung'), 'Turn Acc', 'mm/s²'],
  [0x010a, t('Eilgang-Beschleunigung'), 'G0 Acc', 'mm/s²'],
  [0x010b, t('Vorschub: Verzögerung davor'), 'Feed Delay Prior', 'raw'],
  [0x010c, t('Handbetrieb: Schrittweite'), 'Manual Distance', 'mm'],
  [0x010d, t('Abschaltverzögerung'), 'Shut Down Delay', 'raw'],
  [0x010e, t('Fokustiefe'), 'Focus Depth', 'mm'],
  [0x010f, t('Leerweg beim Gravieren'), 'Go Scale Blank', 'mm'],
  [0x0115, t('Parkposition X'), 'Dock Point X', 'mm'],
  [0x0116, t('Parkposition Y'), 'Dock Point Y', 'mm'],
  [0x0117, t('Array-Vorschubausgleich / Drehen-Ein-Verzögerung'), 'Array Feed Repay / Rotate On Delay', 'raw'],
  [0x0119, t('Drehen-Aus-Verzögerung'), 'Rotate Off Delay', 'raw'],
  [0x011a, t('Beschleunigungsfaktor'), 'Acc Ratio', 'raw'],
  [0x011b, t('Eckenfaktor'), 'Turn Ratio', 'raw'],
  [0x011c, t('Beschleunigungsfaktor Eilgang'), 'Acc G0 Ratio', 'raw'],
  [0x011f, t('Drehachse: Impulse je Umdrehung'), 'Rotate Pulse', 'raw'],
  [0x0121, t('Drehachse: Durchmesser'), 'Rotate D', 'raw'],
  [0x0122, t('Gravur-Punktgröße Wiederholung'), 'Eng Facula Replay', 'raw'],
  [0x0124, t('X: kleinste Gravurgeschwindigkeit'), 'X Min Eng Velocity', 'mm/s'],
  [0x0125, t('X: Gravurbeschleunigung'), 'X Eng Acc', 'mm/s²'],
  [0x0126, t('Benutzerparameter 1'), 'User Para 1', 'raw'],
  [0x0128, t('Z: Geschwindigkeit Referenzfahrt'), 'Z Home Velocity', 'mm/s'],
  [0x0129, t('Z: Arbeitsgeschwindigkeit'), 'Z Work Velocity', 'mm/s'],
  [0x012a, t('Z: Eilganggeschwindigkeit'), 'Z G0 Velocity', 'mm/s'],
  [0x012b, t('Gemeinsame Referenzstrecke'), 'Union Home Distance', 'mm'],
  [0x012c, t('U: Geschwindigkeit Referenzfahrt'), 'U Home Velocity', 'mm/s'],
  [0x012d, t('U: Arbeitsgeschwindigkeit'), 'U Work Velocity', 'mm/s'],
  [0x012e, t('Vorschubausgleich'), 'Feed Repay', 'mm'],
  [0x0131, t('Handbetrieb: schnell'), 'Manual Fast Speed', 'mm/s'],
  [0x0132, t('Handbetrieb: langsam'), 'Manual Slow Speed', 'mm/s'],
  [0x0134, t('Y: kleinste Gravurgeschwindigkeit'), 'Y Minimum Eng Velocity', 'mm/s'],
  [0x0135, t('Y: Gravurbeschleunigung'), 'Y Eng Acc', 'mm/s²'],
  [0x0137, t('Gravur-Beschleunigungsfaktor'), 'Eng Acc Ratio', 'raw'],
  [0x0138, t('Vorlaufzeit'), 'Sts Ahead Time', 'raw'],
  [0x0139, t('Wiederholverzögerung'), 'Repeat Delay', 'raw'],
  [0x013b, t('Benutzerparameter 3'), 'User Para 3', 'raw'],
  [0x013d, t('Benutzerparameter 2'), 'User Para 2', 'raw'],
  [0x013f, t('Benutzerparameter 4'), 'User Para 4', 'raw'],
  [0x0160, t('Absaugung: Einschaltverzögerung'), 'Inhale On Delay', 'raw'],
  [0x0161, t('Absaugung: Ausschaltverzögerung'), 'Inhale Off Delay', 'raw'],
  [0x0180, t('Sprache der Steuerung'), 'Card Language', 'raw'],
  [0x0188, t('Tasten: langsame Geschwindigkeit'), 'User Key Slow Velocity', 'mm/s'],
  [0x018c, t('Ausblasen: Einschaltverzögerung'), 'Blow On Delay', 'raw'],
  [0x018d, t('Ausblasen: Ausschaltverzögerung'), 'Blow Off Delay', 'raw'],
  [0x018f, t('Benutzerparameter 6 (Gebläse)'), 'User Para 6, Blower', 'raw'],
];

const INFO: [number, string, string, RuidaUnit][] = [
  [0x02fe, t('Kartenkennung'), 'Card ID', 'hex'],
  [0x02ff, t('Firmware-Version'), 'Mainboard Version', 'text'],
  [0x0200, t('Zustand (Bits)'), 'Machine Status', 'bits'],
  [0x0221, t('Position X'), 'Axis Preferred Position 1, Pos X', 'pos'],
  [0x0231, t('Position Y'), 'Axis Preferred Position 2, Pos Y', 'pos'],
  [0x0241, t('Position Z'), 'Axis Preferred Position 3, Pos Z', 'pos'],
  [0x0251, t('Position U'), 'Axis Preferred Position 4, Pos U', 'pos'],
  [0x0201, t('Eingeschaltet insgesamt (s)'), 'Total Open Time (s)', 'raw'],
  [0x0202, t('Gearbeitet insgesamt (s)'), 'Total Work Time (s)', 'raw'],
  [0x0203, t('Anzahl Aufträge'), 'Total Work Number', 'raw'],
  [0x0208, t('Dauer des letzten Auftrags'), 'Previous Work Time', 'raw'],
  [0x0211, t('Laserzeit insgesamt'), 'Total Laser Work Time', 'raw'],
  [0x0223, t('Fahrweg X insgesamt (m)'), 'X Total Travel (m)', 'raw'],
  [0x0233, t('Fahrweg Y insgesamt (m)'), 'Y Total Travel (m)', 'raw'],
  [0x0243, t('Fahrweg Z insgesamt (m)'), 'Z Total Travel (m)', 'raw'],
  [0x0253, t('Fahrweg U insgesamt (m)'), 'U Total Travel (m)', 'raw'],
  [0x0205, t('Dateien im Speicher'), 'Total Doc Number', 'raw'],
  [0x0206, t('Speicher gesamt'), 'Flash Space', 'raw'],
  [0x0207, t('Speicher frei'), 'Flash Space Free', 'raw'],
  [0x031c, t('Dateifehler'), 'File Fault', 'raw'],
  [0x0320, t('Länge der Datei'), 'File Total Length', 'raw'],
  [0x0321, t('Fortschritt der Datei'), 'File Progress Len', 'raw'],
  [0x0340, t('Stoppzeit'), 'Stop Time', 'raw'],
  [0x05c0, t('Laser-Lebensdauer'), 'Laser Life', 'raw'],
];

const fromTable = (rows: [number, string, string, RuidaUnit][], group: RuidaGroup, readonly = false): RuidaSetting[] =>
  rows.map(([addr, name, en, unit]) => ({ addr, name, en, group, unit, ...(readonly ? { readonly } : {}) }));

export const RUIDA_SETTINGS: RuidaSetting[] = [
  ...axisSettings(),
  ...laserSettings(),
  ...fromTable(MACHINE, 'machine'),
  ...fromTable(USER, 'user'),
  ...fromTable(INFO, 'info', true),
];

/** Höchster Wert, den die Steuerung annimmt (35 Bit) */
export const RUIDA_MAX = 2 ** 35 - 1;

/** Adresse als Text, z. B. 0x0026 */
export const addrText = (a: number) => `0x${a.toString(16).toUpperCase().padStart(4, '0')}`;

/** Adresse aus Text („0x26“, „38“) oder null */
export function parseAddr(s: string): number | null {
  const v = s.trim().toLowerCase();
  const n = /^0x[0-9a-f]+$/.test(v) ? parseInt(v, 16) : /^\d+$/.test(v) ? parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 0x3fff ? n : null;
}

/** Einheit der Anzeige; leer bei Rohwerten */
export const unitLabel = (u: RuidaUnit) => (u === 'mm' || u === 'pos' ? 'mm' : u === 'mm/s' || u === 'mm/s²' ? u : '');

/** Gespeicherter Wert → Text für die Anzeige bzw. das Eingabefeld */
export function display(s: Pick<RuidaSetting, 'unit'>, raw: number | null, text = ''): string {
  if (s.unit === 'text') return text;
  if (raw === null) return '';
  switch (s.unit) {
    case 'mm':
    case 'mm/s':
    case 'mm/s²':
      return String(Math.round(raw) / 1000);
    case 'pos':
      return String((raw | 0) / 1000);
    case 'hex':
      return `0x${raw.toString(16).toUpperCase().padStart(8, '0')}`;
    case 'bits':
      return `0x${raw.toString(16).toUpperCase()}`;
    default:
      return String(raw);
  }
}

/** Eingabe → gespeicherter Wert; null = ungültig. Bitfelder auch hexadezimal (0x…). */
export function parseInput(s: Pick<RuidaSetting, 'unit'>, input: string): number | null {
  const v = input.trim().replace(',', '.');
  if (!v) return null;
  let n: number;
  if (s.unit === 'mm' || s.unit === 'mm/s' || s.unit === 'mm/s²') {
    if (!/^\d+(\.\d+)?$/.test(v)) return null;
    n = Math.round(Number(v) * 1000);
  } else if (s.unit === 'raw' || s.unit === 'bits') {
    if (/^0x[0-9a-f]+$/i.test(v)) n = parseInt(v, 16);
    else if (/^\d+$/.test(v)) n = Number(v);
    else return null;
  } else return null;
  return Number.isSafeInteger(n) && n >= 0 && n <= RUIDA_MAX ? n : null;
}

/** Gesetzte Bits als Liste (0 … 34) */
export function bitList(raw: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < 35; b++) if (Math.floor(raw / 2 ** b) % 2 === 1) out.push(b);
  return out;
}

// ---------- Sicherungen ----------

/** Sicherung aller gelesenen Werte (als Datei und im Speicher der App) */
export interface RuidaBackup {
  format: 'kizamubeam-ruida-settings';
  version: 1;
  date: string;
  device: string;
  card: string;
  values: Record<string, number>;
}

export function makeBackup(device: string, card: string, values: Map<number, number>, date = new Date()): RuidaBackup {
  const v: Record<string, number> = {};
  for (const [a, x] of [...values].sort((p, q) => p[0] - q[0])) v[addrText(a)] = x;
  return { format: 'kizamubeam-ruida-settings', version: 1, date: date.toISOString(), device, card, values: v };
}

/** Sicherung aus einer Datei lesen; nur schreibbare, bekannte Adressen werden übernommen */
export function parseBackup(text: string): { backup: RuidaBackup; values: Map<number, number>; skipped: string[] } {
  const b = JSON.parse(text) as RuidaBackup;
  if (b?.format !== 'kizamubeam-ruida-settings' || typeof b.values !== 'object' || !b.values) throw new Error(t('Keine Sicherung von Ruida-Einstellungen'));
  const known = new Map(RUIDA_SETTINGS.filter((s) => !s.readonly).map((s) => [s.addr, s]));
  const values = new Map<number, number>();
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(b.values)) {
    const a = parseAddr(k);
    if (a === null || !known.has(a) || !Number.isSafeInteger(v) || v < 0 || v > RUIDA_MAX) skipped.push(k);
    else values.set(a, v);
  }
  return { backup: b, values, skipped };
}

/** Unterschiede einer Sicherung zum gelesenen Stand */
export function backupDiff(current: Map<number, number>, wanted: Map<number, number>): { addr: number; from: number | null; to: number }[] {
  return [...wanted].filter(([a, v]) => current.get(a) !== v).map(([addr, to]) => ({ addr, from: current.get(addr) ?? null, to }));
}
