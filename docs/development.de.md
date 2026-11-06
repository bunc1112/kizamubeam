# Entwickler-Handbuch

[English](development.md) · Deutsch · [Zurück zum README](../README.de.md)

## Bauen

Voraussetzungen: Node.js 20+, Rust (stable), unter Linux zusätzlich `libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `build-essential`, `libssl-dev`
(siehe https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev      # Desktop-App mit Live-Neuladen
npm run dev            # nur die Oberfläche im Browser: http://localhost:1420
npm run tauri build    # Installationspaket
```

Unter Windows baut `npm run tauri build` nur den NSIS-Installer (`.exe`, siehe `src-tauri/tauri.windows.conf.json`): Der MSI-Installer akzeptiert keine Vorabversionen wie `1.2.0-beta`. Das bleibt auch bei stabilen Versionen so: Ein zweiter Installer würde eine zweite, getrennte Installation anlegen können, und Beta-Versionen ließen sich dann nicht mehr bauen. Unter Linux entstehen AppImage und .deb; RPM akzeptiert keinen Bindestrich in der Version (siehe `src-tauri/tauri.linux.conf.json`), deshalb baut der Release-Workflow das .rpm nur für stabile Versionen wie `2.2.0`.

Releases: Ein auf GitHub veröffentlichter Release (Releases → Draft a new release → neuer Tag → Publish release) startet `.github/workflows/release.yml`. Der Workflow baut die Installer für macOS (universal, Apple Silicon und Intel), Windows (NSIS) und Linux (AppImage, .deb, bei stabilen Versionen auch .rpm) und hängt sie an diesen Release. Einen schon veröffentlichten Release baut Actions → Release → Run workflow. Die Builds sind noch nicht signiert, macOS und Windows zeigen beim ersten Start deshalb eine Warnung.

Updates: Hilfe → Nach Updates suchen findet einen neueren Release auf GitHub (Kanal Stabil oder Beta mit Vorabversionen; standardmäßig einmal am Tag beim Start), prüft seine Signatur und installiert ihn. Dafür braucht es ein Schlüsselpaar (`npx tauri signer generate -w ~/.tauri/kizamubeam.key`): den privaten Schlüssel als Repository-Secret `TAURI_SIGNING_PRIVATE_KEY` (sein Passwort als `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), den öffentlichen als Repository-Variable `TAURI_UPDATER_PUBKEY`. Builds ohne Schlüssel können sich nicht selbst aktualisieren. Unter Linux aktualisiert sich das AppImage.

Virtual Machine: Die virtuelle Lasermaschine ist ein eigenes Tauri-Programm im Ordner `vm/` (Oberfläche `vm/src/`, Rust `vm/src-tauri/`, Steuerung ohne Oberfläche in `vm/src-tauri/core/`, Crate `kizamubeam-vm-core`). Sie nutzt die Pakete aus dem Hauptordner. `npm run vm` startet sie mit Live-Neuladen (Port 1421, KizamuBeam nutzt 1420), `npm run vm:build` baut das Installationspaket, `npm run vm:headless` startet sie ohne Fenster (`-- --help` zeigt die Optionen), `npm run test:vm` prüft die Steuerung. Releases der VM haben eigene Tags `vm-v0.1.0` (Version aus `vm/src-tauri/tauri.conf.json`) und werden als Vorabversion veröffentlicht, damit sie auf GitHub nie als neuester Release gelten; sie baut `.github/workflows/vm-release.yml`, `release.yml` überspringt sie, und die Update-Funktion von KizamuBeam beachtet nur Tags, die mit `v` und einer Ziffer beginnen.

## Übersetzungen

Texte stehen im Code auf Deutsch in `t('…')` (Platzhalter in geschweiften Klammern, `t('{n} Bilder', { n })`; Einzahl/Mehrzahl mit `tn('{n} Bild', '{n} Bilder', n)`). Die deutsche Fassung ist zugleich der Schlüssel in den Sprachdateien `src/locales/<sprache>.json`. Fehlt eine Übersetzung, erscheint der deutsche Text. Hat derselbe deutsche Text zwei Bedeutungen, bekommt er einen Kontext nach `|`, z. B. `t('Verbindung|Gerät')`.

- `npm run i18n:check` listet fehlende, unbenutzte und falsch platzierte Einträge (bricht bei Fehlendem mit Fehler ab).
- `npm run i18n:check -- --write` trägt neue Texte mit leerem Wert ein und entfernt unbenutzte; danach nur noch die leeren Werte übersetzen.
- Neue Sprache: `src/locales/fr.json` anlegen (z. B. Kopie von `en.json` mit leeren Werten), in `src/i18n.ts` bei `LANGUAGES` und `DICTS` eintragen.
- Meldungen aus dem Rust-Teil sind deutsch und werden in `src/i18n.ts` (`tBackend`) übersetzt.

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/model.ts` | Datenmodell: Dokument, Objekte, Layer, Matrizen, Palette |
| `src/geom.ts` | Formen als Bézierpfade, Begrenzungsrahmen, Text-Layout, Treffertest, SVG-Pfade |
| `src/editor.ts` | Editor-Klasse: Zustand, Ansicht, Auswahl, Werkzeugwahl; bindet die Teile darunter ein |
| `src/editor/*.ts` | Teile des Editors: `document` (Undo, Autosave, Seiten), `pointer` (Mauseingaben), `keyboard`, `snapping` (Fangen), `nodes` (Knoten), `paths` (Pfad-Werkzeuge), `shapeops` (Umwandeln, Boolesche Operationen, Offset, Arrays), `joints`, `hinges`, `generators` (parametrische Bauteile), `nest` (Verschachteln), `check` (Konstruktion prüfen), `params` (Projekt-Parameter, Vorlagen), `series` (Serie aus Tabelle), `commands`, `objects`, `text` (QR, variabler Text, Text auf Pfad, Textrahmen), `imageops` (Bilder, Import, Nachzeichnen), `render` (Zeichnen der Arbeitsfläche) |
| `src/ui.ts` | Menü, Aktionen der Funktionsleisten, Eigenschaftenleiste, Layer-Fenster, Palette, Statusleiste, Texteingabe |
| `src/storageMigration.ts` | Übernimmt Einstellungen unter dem alten Namen (`laserwerk.*`) beim ersten Start nach `kizamubeam.*` |
| `src/dock.ts` | Andockbare Fenster: Reiter, Gruppen, freie Fenster, Größe, Ein-/Ausblenden, gespeicherte Anordnung |
| `src/apps.ts`, `src/appsPanel.ts` | Werkzeugkasten: Kacheln mit Gruppen, Erklärung und Suchwörtern, Suche; Fenster mit Filter und Gruppen |
| `src/toolbars.ts` | Anpassbare Funktionsleisten: Aktionen, Belegung, Symbolgröße, Anpassen-Dialog, Leisten ein-/ausblenden |
| `src/layerdialog.ts` | Layer-Einstellungen (Kerf, Haltestege, Füllen, Air Assist, Perforation, Anschnitt, Leistungsrampe, Z, Sub-Layer) |
| `src/fonts.ts` | Schriftdateien laden (Systemschriften über Rust, Ersatzschrift) und Text in Bézierpfade umwandeln (opentype.js) |
| `src/fontCatalog.ts`, `src/fontManager.ts`, `src-tauri/src/fonts.rs` | Font-Manager: Google-Fonts-Liste lesen und durchsuchen, Favoriten, fehlende Schriften in Projekten; Fenster „Schriften“; Schriften im App-Ordner laden, importieren und entfernen (`npm run test:fonts`) |
| `src/vartext.ts` | Variabler Text: Platzhalter, CSV einlesen, Weiterzählen |
| `src/params.ts`, `src/paramsPanel.ts` | Projekt-Parameter: Formeln, Platzhalter `{…}`, Umbenennen; Fenster „Parameter“ |
| `src/templates.ts`, `src/templateDialogs.ts`, `src-tauri/src/templates.rs` | Vorlagen: Format `.kzt`, Vorlagen-Ordner, Dialoge zum Speichern, Auswählen und Ausfüllen, Serie aus Tabelle |
| `src/builtinTemplates.ts` | Mitgelieferte Vorlagen (Schlüsselanhänger, Namensschild, beschriftete Box), im Code erzeugt |
| `src/packs.ts`, `src/packsDialog.ts`, `src-tauri/src/packs.rs` | Erweiterungen: `.kzp`-Format und Prüfung, Paket-Ordner, Fenster Erweiterungen |
| `src/assetFormat.ts`, `src/assetLibrary.ts`, `src/libraryPanel.ts`, `src/editor/library.ts`, `src-tauri/src/library.rs` | Bibliothek: Format `.kza` und Prüfung, Suche, Bibliotheks-Ordner, Fenster Bibliothek, Einträge speichern und einfügen |
| `src/builtinLibrary.ts`, `src/builtinFormat.ts`, `src/library/builtin.json`, `scripts/build-library.ts`, `scripts/library/` | Mitgelieferte Bibliothek: 400 Motive und Designelemente, kompakte Pfaddaten, Gruppen, Zeichen-Baukasten und Quellen |
| `src/catalog.ts`, `packs/`, `scripts/build-catalog.ts`, `scripts/sign-catalog.mjs` | Signierter Katalog der Erweiterungen, mit der Website veröffentlicht |
| `src/barcode.ts`, `src/qrDialog.ts` | QR-Codes (qrcode-generator, MIT) und Strichcodes als geschlossene Umrisse; Dialoge „QR-Code“ und „Variabler Text“ |
| `src/barcode1d.ts`, `src/barcodeDialog.ts` | Strichcodes: Code 128, EAN-13, EAN-8, UPC-A, Code 39, ITF als Strichbreiten; Dialog „Strichcode“ |
| `src/textpath.ts` | Text auf Pfad: Bogenlänge, Glyphen entlang der Kurve setzen |
| `src/clip.ts`, `src/curves.ts` | Clipper-Anbindung (Zerlegen, Kurvenrückführung, Buchstaben schweißen) und Bézier-Grundlagen |
| `src/ops.ts` | Boolesche Operationen und Offset (Clipper) |
| `src/pathtools.ts` | Pfad-Werkzeuge: Schließen, Auto-Join, Zerlegen, Startpunkt, Schnittpunkte und Trimmen (Bézier exakt geteilt). Tests: `npm run test:paths` |
| `src/corners.ts` | Eckenwerkzeug: einzelne Ecken runden, innen runden oder fasen. Tests: `npm run test:corners` |
| `src/snap.ts` | Fangen: Objektfang (Knoten, Mittelpunkt, Zentrum, Schnittpunkt, Linie) und Ausrichtungshilfen |
| `src/arrays.ts`, `src/arrayDialogs.ts` | Raster- und Kreisarray mit Dialogen und Live-Vorschau |
| `src/nest.ts`, `src/nestDialog.ts`, `src/editor/nest.ts` | Verschachteln: Rastersuche mit echten Konturen (Kern), Dialog, Teile zusammenfassen und Ergebnis anwenden |
| `src/check.ts`, `src/checkPanel.ts`, `src/editor/check.ts` | Konstruktion prüfen: die Prüfungen (Kern, ohne DOM), Fenster Prüfung, Befunde auswählen und Korrekturen anwenden |
| `src/hinges.ts`, `src/hingeDialog.ts` | Biegeschnitte (Living Hinges): Muster und Dialog |
| `src/generators/` | Parametrische Bauteile: gemeinsame Schnittstelle (`types.ts`: Parameterschema, Prüfung, Geometrie), Verzeichnis (`index.ts`), Dialog aus dem Schema, Bézier-Hilfen, Stirnrad (`gear.ts`), Zahnstange (`rack.ts`), Riemenscheibe (`pulley.ts`), Nocken (`cam.ts`), Zahnradpaar (`gearpair.ts`), gemeinsame Bohrungen (`bore.ts`), Box mit Fingerzinken (`box.ts`), Schublade (`drawer.ts`), Einsatz (`insert.ts`), Steckregal (`shelf.ts`), Scheibenkugel (`discsphere.ts`), Schichtmodell aus einem 3D-Modell (`stack.ts`), Rippenmodell (`ribs.ts`) |
| `src/model3d/` | 3D-Modelle: STL/OBJ lesen, verschweißen und kompakt speichern (`mesh.ts`), Modellspeicher mit automatischer Sicherung (`store.ts`), Querschnitte, Flächen und tiefster Punkt (`slice.ts`) |
| `src/view3d/` | 3D-Ansicht: Lage der Baugruppenteile im Raum (`poses.ts`), Platten und Prüfung auf Durchdringung (`solids.ts`), Zusammensetzen der mit dem Verbindungs-Werkzeug verbundenen Teile (`mates.ts`), Gravuren auf den Oberflächen (`engrave.ts`), Material-Aussehen und erzeugte Texturen (`looks.ts`, Auswahl `lookui.ts`), das Fenster (`panel.ts`) und die Darstellung mit three.js (MIT, `viewer.ts`, wird erst beim Öffnen des Fensters geladen) |
| `src/joints.ts`, `src/jointDialog.ts` | Verbindungen: Fingerzinken, Schlitz und Zapfen, Überblattung, Schnapp-, Haken-, Keil- und T-Slot-Verbindung, Deckelscharnier mit Stift. Tests: `npm run test:joints` |
| `src/images.ts` | Bilddaten (außerhalb von Undo, gesichert in IndexedDB), Bildverarbeitung und Dithering, Zwischenspeicher der Ergebnisse |
| `src/imagePresets.ts` | Bild-Presets (Anpassungen und Bildmodus) im lokalen Speicher |
| `src/trace.ts` | Bild nachzeichnen: Marching Squares, Vereinfachung, Kurveneinpassung |
| `src/centerline.ts` | Mittellinien nachzeichnen: Ausdünnen nach Zhang-Suen, Skelett-Graph, Seitenäste entfernen, Verbinden an Kreuzungen. Tests: `npm run test:centerline` |
| `src/importers.ts` | SVG- und DXF-Import |
| `src/pdfimport.ts` | PDF- und Illustrator-Import (`.ai`): eigener PDF-Leser (Querverweise, Objekt-Streams, Filter, Pfade, Bilder) |
| `src/pdffonts.ts` | Schriftprogramme aus PDF-Dateien (TrueType, CFF, Type 1) als Umrisse für den PDF-Import |
| `src/pdfcrypt.ts` | Entschlüsselung bearbeitungsgeschützter PDFs (MD5, RC4, AES, SHA-2) |
| `src/vecexport.ts` | DXF-, PDF- und Illustrator-Export (`.ai`) |
| `src/lbrn.ts` | Einlesen von LightBurn-Projekten (`.lbrn2`) |
| `src/fit.ts` | Kurvenrückführung: Linienzüge in Bézierpfade (Ecken erkennen, Schneider-Verfahren) |
| `src/gcode.ts` | Maschinenausgabe: Job aus dem Dokument (Linie, Füllen, Bilder, Reihenfolge), G-Code, Laufzeitschätzung, Rahmen, Start Here, Start-/End-Skripte, Geräteeinstellungen. Tests: `npm run test:gcode` |
| `src/camera.ts` | Kamera: Zugriff, Kalibriermodell (Homographie und radiale Verzeichnung, Levenberg-Marquardt), Entzerrung aufs Bett |
| `src/cameraui.ts` | Kamera-Reiter, Kamerabild auf der Arbeitsfläche, Kalibrier-Assistent mit Markierungen |
| `src/workpieces.ts`, `src/workpieceDialog.ts` | Auf Werkstücke übertragen: Werkstücke im Kamerabild trennen, Umrisse, Drehung per Formvergleich (Kern), Dialog mit Vorschau |
| `src/materials.ts`, `src/materialui.ts` | Material-Bibliothek, `.kzm`-Export/-Import, Einlesen von LightBurn-`.clb`, Reiter „Material“ |
| `src/fitcheck.ts`, `src/calibrate.ts`, `src/calibrateDialog.ts` | Passung von Steckverbindungen (Prüfung, Vorschläge für Generatoren und Verbindungs-Werkzeug), Passung kalibrieren: Testteile und Auswertung (Kern, ohne DOM) und der Dialog dazu |
| `src/slots.ts`, `src/slotDialog.ts` | Schlitze anpassen: Schlitze erkennen und verbreitern/verschmälern (Kern, ohne DOM) und der Dialog dazu |
| `src/materialtest.ts` | Materialtest: Raster mit gestuften Werten und eigenen Testlayern |
| `src/testphoto.ts`, `src/testphotoDialog.ts` | Materialtest per Foto auswerten: Raster über vier Ecken ausrichten, Zellen anklicken, Färbung messen (`npm run test:testphoto`) |
| `src/focustest.ts`, `src/focustestDialog.ts` | Fokustest: Rampe auf schrägem Material oder Z-Reihe mit einem Layer je Z-Versatz (`npm run test:focus`) |
| `src/printcut.ts`, `src/printcutDialog.ts` | Print and Cut: Passermarken, Ausrichten an 2–3 gemessenen Marken (starr, ähnlich, affin), Laserpunkt (`npm run test:printcut`) |
| `src/generators/jig.ts`, `src/generators/jigPanel.ts`, `src/jigUse.ts`, `src/jigFillDialog.ts` | Jig-Generator: Umrisse aus Auswahl, Bild oder Kamera, Aussparungen mit Spiel und Griffmulden, Anordnung, Nummern und Passermarken (`npm run test:jig`) |
| `src/objectsPanel.ts` | Objekte-Fenster: Seiten, Layer und Objekte als Baum |
| `src/history.ts`, `src/historyPanel.ts` | Rückgängig-Verlauf mit benannten Schritten, Verlaufsfenster |
| `src/agent.ts`, `src/agentedit.ts`, `src/agentmachine.ts`, `src/agentutil.ts`, `src/agentui.ts` | Werkzeuge für KI-Agenten (MCP) nach Stufen, Sicherheitsregeln der Maschinenstufe, Einstellungsdialog |
| `src/machine.ts` | Verbindung zur Maschine aus Sicht der Oberfläche: Zustand, Statusauswertung, Klartext für Alarme, Befehle an Rust |
| `src/laser.ts` | Fenster Laser, Verschieben und Konsole, Geräteeinstellungen, Vorschau |
| `src/fluidnc.ts`, `src/fluidncDialog.ts` | FluidNC und GRBL-Familie: Overrides, Dateien auf SD-Karte/Flash, Konfiguration mit Sicherungen, Ausgänge und Kühlmittel, Suche im Netz. Tests: `npm run test:fluidnc` |
| `src/setup.ts`, `src/setupWizard.ts` | Assistent „Laser einrichten“: Firmware erkennen, Einstellungen lesen und prüfen, Vorschläge, Testauftrag. Tests: `npm run test:setup` |
| `src/dom.ts` | DOM-Helfer und Zahlenfelder mit Formeln |
| `src/i18n.ts`, `src/locales/` | Mehrsprachigkeit: `t()`, Sprachwahl, englische Sprachdatei |
| `src/files.ts` | Öffnen/Speichern/Importieren (Tauri-Dialoge oder Browser), Ziehen und Einfügen, SVG-/DXF-/PDF-/AI-Export, bearbeitetes Bild speichern |
| `src-tauri/` | Rust-Hülle: native Dateidialoge, Dateien lesen/schreiben, Liste und Dateien der Systemschriften (fontdb) |
| `src-tauri/src/stream.rs` | G-Code-Übertragung mit Zeichenzählung, Statusabfrage, Halt/Reset (mit Tests: `cargo test`) |
| `src-tauri/src/machine.rs` | Seriell (serialport), Telnet (TCP) und WebSocket, Ereignisse an das Fenster |
| `src-tauri/src/ws.rs` | WebSocket zur Steuerung (tungstenite) als Byte-Strom für die Übertragung, mit Test gegen ein nachgebildetes FluidNC |
| `src/ruidaSettings.ts`, `src/ruidaDialog.ts` | Ruida-Steuerungen (CO2): Katalog der bekannten Speicheradressen mit Einheiten, Umrechnung, Sicherungen; Fenster „Ruida-Steuerung“. Tests: `npm run test:ruida` |
| `src-tauri/src/ruida.rs` | Ruida-Treiber: UDP (Ports 50200/40200) und USB, Schlüssel erkennen, Zustand abfragen und als GRBL-Statuszeile melden, Bewegen/Home/Ursprung, Auftrag senden, Einstellungen lesen/schreiben, `.rd` speichern (mit Tests gegen eine nachgebildete Steuerung, auch echtes UDP über 127.0.0.1) |
| `src-tauri/core/src/ruida.rs` | Ruida-Protokoll ohne Tauri: Verwürfeln, 7-Bit-Zahlen, Ecken-Umrechnung, G-Code-Teilmenge → RD-Auftrag, Pakete mit Prüfsumme und ACK/NAK-Sitzung. Tests: `cargo test -p kizamubeam-core`; `npm run test:core` prüft auch, dass KizamuBeams eigener Ruida-G-Code angenommen wird |
| `src-tauri/src/fluid.rs` | Weboberfläche von FluidNC über einfaches HTTP: Hochladen auf SD-Karte/Flash, Suche im lokalen Netz (mit Tests gegen eine nachgebildete Weboberfläche) |
| `src-tauri/src/agent.rs` | MCP-Server (Streamable HTTP auf 127.0.0.1, Token, Stufen) und stdio-Brücke `--mcp-stdio` |
| `src-tauri/core/` | Rechenkern ohne Oberfläche (`kizamubeam-core`): Bildverarbeitung und Dithering, Rasterzeilen der Bilder, G-Code schreiben. Rechnet wie `images.ts`/`gcode.ts`, die Desktop-App nutzt ihn, der Browser die TypeScript-Fassung. Vergleichstest: `npm run test:core` |
| `vm/` | KizamuBeam Virtual Machine: virtuelle Lasermaschine als eigenes Programm. `vm/src-tauri/core/src/machine.rs` Steuerung (GRBL/FluidNC, Planer, Echtzeit), `gcode.rs` Zeilen prüfen, `net.rs` Telnet-/WebSocket-Server, `vm/src/view.ts` Draufsicht mit Brennspuren, `vm/src/view3d.ts` 3D-Ansicht (three.js, Materialaussehen aus `src/view3d/looks.ts`), `vm/src/burn.ts` Werkstücke und Brandkarten, `vm/src/parts.ts` Erkennung ausgeschnittener Teile (im Worker, `parts.worker.ts`), `vm/src/ui.ts` Design und Aufbau der Seitenleiste (Sprache gemeinsam mit `src/i18n.ts`), `vm/src-tauri/core/src/camera.rs` HTTP-Kameraserver (MJPEG/Einzelbild; die Bilder rendert das Fenster mit `Bed3D.cameraImage`). Netzwerk-Kameras in KizamuBeam: `src-tauri/src/netcam.rs`. Tests: `npm run test:vm` (Brandkarten, Teile-Erkennung und Steuerung) |
| `src-tauri/src/native.rs` | Rechenkern für die Oberfläche: Graustufen der Bilder und fertiger G-Code bleiben in Rust |
| `src/native.ts` | Aufruf des Rechenkerns aus der Oberfläche |

Intern rechnet der Editor in mm mit y nach unten; angezeigt wird in Maschinenkoordinaten (Ursprung unten links).

## Logo

Die Logo-Dateien liegen in [`docs/brand/`](brand/): Logo mit Symbol, Wortmarke, Symbol farbig und einfarbig, Symbol über der Wortmarke, jeweils auch als `-dark` für dunkle Hintergründe, dazu das App-Icon (`kizamubeam-app-icon.png`, Vorlage für `npx tauri icon`).
