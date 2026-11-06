// Erweiterungen (Inhaltspakete, .kzp): Gerätevorlagen, Vorlagen, Materialien und Bibliotheks-Einträge, die sich ohne App-Update
// nachladen lassen. Ein Paket enthält nur Daten, keinen Code; alles wird beim Lesen gegen das Format geprüft und
// auf erlaubte Felder beschränkt. Gespeichert wird in der Desktop-App im Einstellungsordner (Rust: packs.rs),
// im Browser im lokalen Speicher. Die Prüflogik wird mit `npm run test:packs` getestet.
import { Device, Firmware, FIRMWARES, PRESETS } from './gcode';
import { library, MaterialEntry, sanitizeEntry } from './materials';
import { loadDoc } from './model';
import { normalizeTemplate, TemplateInfo } from './templates';
import type { ProjectParam } from './params';
import { compareVersions } from './updates';
import { AssetData, AssetError, parseAsset } from './assetFormat';
import { localText, t } from './i18n';

export { localText };
import { version as APP_VERSION } from '../package.json';

export const PACK_EXT = 'kzp';
export const PACK_FORMAT = 'kizamubeam-pack';
export const PACK_FORMAT_VERSION = 1;
/** Größte Paketdatei (Vorlagen können Bilder enthalten) */
export const PACK_MAX_BYTES = 20 * 1024 * 1024;

/** Text in mehreren Sprachen: „Text“ oder {"de": "…", "en": "…"} */
export type LocalText = string | Record<string, string>;

/** Gerätevorlage aus einem Paket: nur Felder, die keine Befehle an die Maschine enthalten */
export type PackDevice = Partial<Device> & { name: string; fw: Firmware };

export interface PackTemplate {
  info: TemplateInfo;
  /** Inhalt wie eine .kzt-Datei, Titel und Beschreibung schon in der Sprache der Oberfläche */
  json: string;
}

export interface Pack {
  id: string;
  version: string;
  minApp?: string;
  name: string;
  description?: string;
  author?: string;
  homepage?: string;
  devices: { preset: PackDevice; source?: string }[];
  templates: PackTemplate[];
  materials: MaterialEntry[];
  /** Einträge für die Bibliothek (Motive, Bilder, Designelemente); id = eigene Kennung im Paket */
  assets: (AssetData & { id: string })[];
}

export class PackError extends Error {}

const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numIn = (v: unknown, min: number, max: number) => (typeof v === 'number' && isFinite(v) && v >= min && v <= max ? v : undefined);

/**
 * Gerätevorlage prüfen. Erlaubt sind Name, Firmware, Arbeitsbereich und Werte für Verbindung und Zeitschätzung.
 * Start-/End-Skripte, Drehachse, Adressen und Grenzen für KI-Agenten fallen weg, weil sie Befehle oder
 * persönliche Einstellungen sind.
 */
export function sanitizeDevice(raw: unknown, where: string): { preset: PackDevice; source?: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = str(localText(r.name), 80);
  if (!name) throw new PackError(t('{where}: Name fehlt', { where }));
  const fw = r.fw as Firmware;
  if (typeof fw !== 'string' || !(fw in FIRMWARES)) throw new PackError(t('{where}: unbekannte Firmware „{fw}“', { where, fw: String(r.fw) }));
  const bedW = numIn(r.bedW, 10, 5000);
  const bedH = numIn(r.bedH, 10, 5000);
  if (bedW === undefined || bedH === undefined) throw new PackError(t('{where}: Arbeitsbereich (bedW, bedH) fehlt oder liegt nicht zwischen 10 und 5000 mm', { where }));
  const p: PackDevice = { name, fw, bedW, bedH };
  const baud = numIn(r.baud, 1200, 4_000_000);
  if (baud !== undefined) p.baud = Math.round(baud);
  const sMax = numIn(r.sMax, 1, 100_000);
  if (sMax !== undefined) p.sMax = sMax;
  const rapid = numIn(r.rapid, 100, 200_000);
  if (rapid !== undefined) p.rapid = rapid;
  const accel = numIn(r.accel, 10, 200_000);
  if (accel !== undefined) p.accel = accel;
  const junction = numIn(r.junction, 0.001, 1);
  if (junction !== undefined) p.junction = junction;
  if (r.conn === 'serial' || r.conn === 'tcp' || r.conn === 'ws' || r.conn === 'udp') p.conn = r.conn;
  if (r.ruidaOrigin === 'tr' || r.ruidaOrigin === 'tl' || r.ruidaOrigin === 'br' || r.ruidaOrigin === 'bl') p.ruidaOrigin = r.ruidaOrigin;
  const tcpPort = numIn(r.tcpPort, 1, 65535);
  if (tcpPort !== undefined) p.tcpPort = Math.round(tcpPort);
  const wsPort = numIn(r.wsPort, 1, 65535);
  if (wsPort !== undefined) p.wsPort = Math.round(wsPort);
  if (r.airCmd === 'M7' || r.airCmd === 'M8') p.airCmd = r.airCmd;
  if (r.limitSwitches === 'yes' || r.limitSwitches === 'no' || r.limitSwitches === 'unknown') p.limitSwitches = r.limitSwitches;
  if (typeof r.homeOnConnect === 'boolean') p.homeOnConnect = r.homeOnConnect;
  const source = str(r.source, 300);
  return source ? { preset: p, source } : { preset: p };
}

/** Vorlage prüfen: muss sich als Projekt laden lassen und Vorlagen-Angaben haben */
export function sanitizeTemplate(raw: unknown, where: string): PackTemplate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PackError(t('{where}: keine Vorlage', { where }));
  const d = structuredClone(raw) as Record<string, unknown>;
  const tpl = d.template as Record<string, unknown> | undefined;
  if (!tpl || typeof tpl !== 'object') throw new PackError(t('{where}: keine Vorlage (Eintrag „template“ fehlt)', { where }));
  // Titel und Beschreibung dürfen mehrsprachig sein; in der Vorlage selbst stehen sie als Text
  tpl.title = localText(tpl.title) || t('Vorlage');
  const desc = localText(tpl.description);
  if (desc) tpl.description = desc;
  else delete tpl.description;
  try {
    loadDoc(structuredClone(d));
  } catch (e) {
    throw new PackError(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const info = normalizeTemplate(tpl, Array.isArray(d.params) ? (d.params as ProjectParam[]) : []);
  return { info, json: JSON.stringify(d) };
}

/**
 * Paketdatei lesen und prüfen. Fehler im Aufbau (Format, Kennung, Version) und in einzelnen Einträgen
 * lehnen das ganze Paket ab, damit nichts halb installiert wird.
 */
export function parsePack(text: string, appVersion: string = APP_VERSION): Pack {
  if (text.length > PACK_MAX_BYTES) throw new PackError(t('Das Paket ist größer als {mb} MB', { mb: PACK_MAX_BYTES / 1024 / 1024 }));
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PackError(t('Keine KizamuBeam-Erweiterung (kein gültiges JSON)'));
  }
  if (!raw || typeof raw !== 'object' || raw.format !== PACK_FORMAT) throw new PackError(t('Keine KizamuBeam-Erweiterung'));
  const fv = Number(raw.formatVersion ?? 1);
  if (!Number.isInteger(fv) || fv < 1) throw new PackError(t('Ungültige Formatversion'));
  if (fv > PACK_FORMAT_VERSION) throw new PackError(t('Die Erweiterung braucht eine neuere Version von KizamuBeam'));
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID_RE.test(id) || id.length > 64) throw new PackError(t('Ungültige Kennung „{id}“ (Kleinbuchstaben, Ziffern, Bindestriche, mit Punkt getrennt, z. B. „de.beispiel.werkstatt“)', { id }));
  const version = typeof raw.version === 'string' ? raw.version : '';
  if (!VERSION_RE.test(version)) throw new PackError(t('Ungültige Version „{version}“ (z. B. 1.0.0)', { version }));
  let minApp: string | undefined;
  if (raw.minApp !== undefined) {
    if (typeof raw.minApp !== 'string' || !VERSION_RE.test(raw.minApp)) throw new PackError(t('Ungültige Angabe minApp'));
    minApp = raw.minApp;
    if (compareVersions(appVersion, minApp) < 0) throw new PackError(t('Die Erweiterung braucht KizamuBeam {version} oder neuer', { version: minApp }));
  }
  const name = str(localText(raw.name), 80);
  if (!name) throw new PackError(t('Name der Erweiterung fehlt'));
  const list = (k: string) => {
    const v = raw[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new PackError(t('„{key}“ muss eine Liste sein', { key: k }));
    return v;
  };
  const devices = list('devices').map((d, i) => sanitizeDevice(d, t('Gerätevorlage {n}', { n: i + 1 })));
  const templates = list('templates').map((d, i) => sanitizeTemplate(d, t('Vorlage {n}', { n: i + 1 })));
  const materials = list('materials').map((m, i) => {
    const e = sanitizeEntry(m);
    if (!e) throw new PackError(t('Material {n}: Einstellungen fehlen', { n: i + 1 }));
    // Stabile Kennung, damit ein Update des Pakets dieselben Einträge ersetzt
    const own = m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id.slice(0, 40) : String(i + 1);
    return { ...e, id: `pk:${id}:${own}`, pack: id };
  });
  if (new Set(materials.map((m) => m.id)).size !== materials.length) throw new PackError(t('Materialien mit doppelter Kennung'));
  const assets = list('assets').map((a, i) => {
    const where = t('Bibliotheks-Eintrag {n}', { n: i + 1 });
    try {
      const own = a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string' ? (a as { id: string }).id.trim().slice(0, 40) : '';
      return { ...parseAsset(a, where), id: own || String(i + 1) };
    } catch (e) {
      throw new PackError(e instanceof AssetError && e.message.startsWith(where) ? e.message : `${where}: ${(e as Error).message}`);
    }
  });
  if (new Set(assets.map((a) => a.id)).size !== assets.length) throw new PackError(t('Bibliotheks-Einträge mit doppelter Kennung'));
  if (!devices.length && !templates.length && !materials.length && !assets.length) throw new PackError(t('Die Erweiterung ist leer'));
  const pack: Pack = { id, version, name, devices, templates, materials, assets };
  if (minApp) pack.minApp = minApp;
  const description = str(localText(raw.description), 1000);
  if (description) pack.description = description;
  const author = str(raw.author, 120);
  if (author) pack.author = author;
  const homepage = str(raw.homepage, 300);
  if (/^https:\/\/[^\s]+$/.test(homepage)) pack.homepage = homepage;
  return pack;
}

/** Kurzbeschreibung des Inhalts, z. B. „3 Gerätevorlagen · 1 Vorlage“ */
export const packSummary = (p: Pack) => countSummary(p.devices.length, p.templates.length, p.materials.length, p.assets.length);

export function countSummary(devices: number, templates: number, materials: number, assets = 0): string {
  const parts: string[] = [];
  if (devices) parts.push(devices === 1 ? t('1 Gerätevorlage') : t('{n} Gerätevorlagen', { n: devices }));
  if (templates) parts.push(templates === 1 ? t('1 Vorlage') : t('{n} Vorlagen', { n: templates }));
  if (materials) parts.push(materials === 1 ? t('1 Material') : t('{n} Materialien', { n: materials }));
  if (assets) parts.push(assets === 1 ? t('1 Bibliotheks-Eintrag') : t('{n} Bibliotheks-Einträge', { n: assets }));
  return parts.join(' · ');
}

// ---------- Installierte Pakete ----------

export interface InstalledPack {
  file: string;
  pack: Pack;
}
export interface BrokenPack {
  file: string;
  error: string;
}

let installed: InstalledPack[] = [];
let broken: BrokenPack[] = [];
let ready: Promise<void> | null = null;
const listeners = new Set<() => void>();

export const installedPacks = () => installed;
export const brokenPacks = () => broken;
export const onPacksChanged = (f: () => void) => void listeners.add(f);
export const packFileName = (id: string) => `${id}.${PACK_EXT}`;

/** Gerätevorlagen: eingebaute zuerst, dann die aus Erweiterungen */
export function presetList(): { preset: PackDevice; source?: string; pack?: string }[] {
  return [...PRESETS.map((preset) => ({ preset })), ...installed.flatMap(({ pack }) => pack.devices.map((d) => ({ ...d, pack: pack.name })))];
}

/** Bibliotheks-Einträge aus Erweiterungen; key = „Paket-Kennung/Eintrag“ */
export function packAssets(): { asset: AssetData; key: string; pack: string }[] {
  return installed.flatMap(({ pack }) => pack.assets.map((asset) => ({ asset, key: `${pack.id}/${asset.id}`, pack: pack.name })));
}

/** Vorlagen aus Erweiterungen; key = „Paket-Kennung/Nummer“ */
export function packTemplates(): (PackTemplate & { key: string; pack: string })[] {
  return installed.flatMap(({ pack }) => pack.templates.map((tp, i) => ({ ...tp, key: `${pack.id}/${i + 1}`, pack: pack.name })));
}

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const hasPackFolder = isTauri;
const STORE_KEY = 'kizamubeam.packs';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import('@tauri-apps/api/core');
  return api.invoke<T>(cmd, args);
}
function store(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function setStore(s: Record<string, string>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    throw new Error(t('Der Speicher des Browsers ist voll.'));
  }
}

async function readAll(): Promise<[string, string][]> {
  if (isTauri()) return invoke<[string, string][]>('pack_list');
  return Object.entries(store()).sort(([a], [b]) => a.localeCompare(b));
}

/** Installierte Pakete (neu) lesen; kaputte oder zu neue Dateien landen in brokenPacks() */
export async function loadPacks(): Promise<void> {
  const ok: InstalledPack[] = [];
  const bad: BrokenPack[] = [];
  for (const [file, text] of await readAll()) {
    try {
      ok.push({ file, pack: parsePack(text) });
    } catch (e) {
      bad.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  ok.sort((a, b) => a.pack.name.localeCompare(b.pack.name));
  installed = ok;
  broken = bad;
  listeners.forEach((f) => f());
}

/** Beim ersten Aufruf laden; spätere Aufrufe warten nur darauf */
export function ensurePacks(): Promise<void> {
  ready ??= loadPacks().catch(() => {
    /* Ordner nicht lesbar: ohne Erweiterungen weiter */
  });
  return ready;
}

/** Was eine Installation bewirkt: neu, Update, gleiche oder ältere Version */
export function installKind(p: Pack): { kind: 'new' | 'update' | 'same' | 'downgrade'; old?: Pack } {
  const old = installed.find((x) => x.pack.id === p.id)?.pack;
  if (!old) return { kind: 'new' };
  const c = compareVersions(p.version, old.version);
  return { kind: c > 0 ? 'update' : c === 0 ? 'same' : 'downgrade', old };
}

/** Geprüftes Paket speichern (ersetzt eine installierte Version) und seine Materialien übernehmen */
export async function installPack(text: string): Promise<Pack> {
  const p = parsePack(text);
  const file = packFileName(p.id);
  if (isTauri()) await invoke<void>('pack_write', { file, contents: text });
  else {
    const s = store();
    s[file] = text;
    setStore(s);
  }
  library.syncPack(p.id, p.materials);
  await loadPacks();
  return p;
}

/** Paket entfernen; unveränderte Materialien daraus verschwinden aus der Bibliothek */
export async function removePack(file: string) {
  const id = installed.find((x) => x.file === file)?.pack.id;
  if (isTauri()) await invoke<void>('pack_delete', { file });
  else {
    const s = store();
    delete s[file];
    setStore(s);
  }
  if (id) library.syncPack(id, []);
  await loadPacks();
}

export async function openPackFolder() {
  if (isTauri()) await invoke<string>('pack_open_folder');
}
