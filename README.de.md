<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/kizamubeam-logo-dark.png">
    <img src="docs/brand/kizamubeam-logo.png" alt="KizamuBeam" width="520">
  </picture>
</p>

<p align="center">
  <b>Entwerfen, gravieren, schneiden. Freie Laser-Software für macOS, Windows und Linux.</b>
</p>

<p align="center">
  <a href="https://github.com/negurvulkan/kizamubeam/releases"><b>Herunterladen</b></a> ·
  <a href="https://negurvulkan.github.io/kizamubeam/">Website</a> ·
  <a href="docs/features.de.md">Alle Funktionen</a> ·
  <a href="https://discord.gg/SSr8VHh7EJ">Discord</a> ·
  <a href="README.md">English</a>
</p>

KizamuBeam bringt dich in einer App von der Idee zum fertigen Stück: direkt auf der Arbeitsfläche zeichnen und schreiben, Fotos in Gravuren verwandeln, Boxen, Zahnräder und Steckmodelle erzeugen, alles in 3D prüfen und den Auftrag direkt an den Laser schicken. Wer LightBurn kennt, findet sich sofort zurecht.

KizamuBeam ist Open Source (GPL-3.0), kostenlos und braucht weder Konto noch Lizenzschlüssel.

<p align="center">
  <img src="docs/screenshots/design-de.png" alt="KizamuBeam-Hauptfenster mit Untersetzern und einem Holzschild auf der Arbeitsfläche, rechts die Layer" width="900">
</p>

## Herunterladen

| System | Datei |
|---|---|
| **macOS** (Apple Silicon und Intel) | `KizamuBeam_…_universal.dmg` |
| **Windows** (64 Bit) | `KizamuBeam_…_x64-setup.exe` |
| **Linux** (64 Bit) | `KizamuBeam_…_amd64.AppImage`, `.deb` oder `.rpm` |

Die aktuelle Version gibt es auf der [Release-Seite](https://github.com/negurvulkan/kizamubeam/releases) und auf der [Website](https://negurvulkan.github.io/kizamubeam/#download). Aktuelle Version: **2.6.1** (stabil). Einmal installiert, hält sich KizamuBeam selbst aktuell (Hilfe → Nach Updates suchen).

> **Erster Start unter macOS:** Meldet macOS, dass die App nicht überprüft werden kann, unter Systemeinstellungen → Datenschutz & Sicherheit auf „Dennoch öffnen“ klicken.

## Was du damit machen kannst

### Direkt in der App gestalten
Linien, Kurven, Formen und Text in jeder Schrift, auch alle Google Fonts mit einem Klick. Formen kombinieren, versetzen, Knoten bearbeiten, Text an einem Pfad entlang laufen lassen, Ecken runden. Fangpunkte, Ausrichten, Arrays und automatisches Verschachteln halten Ordnung, und jedes Ergebnis bleibt eine saubere, bearbeitbare Kurve. Eine Bibliothek mit **400 mitgelieferten Motiven und Designelementen** hilft beim Einstieg.

### Eigene Vorlagen übernehmen
SVG, DXF, PDF und Illustrator-Dateien, LightBurn-Projekte (`.lbrn2`) und alle gängigen Bildformate öffnen. Fotos bekommen Rasterung, Zeitungsdruck- und Skizzen-Effekt, Hintergrund entfernen, Zuschneiden und Masken und lassen sich in Vektoren nachzeichnen, auch als Mittellinien für Gravuren mit einem Strich.

### Bauteile erzeugen statt zeichnen
Maße eingeben, fertige Teile bekommen: **Boxen mit Fingerzinken, Schubladen, Einsätze, Steckregale, Zahnräder, Zahnstangen, Riemenscheiben, Nocken und Deckelscharniere**. Verbindungen, Schlitze und Biegeschnitte lassen sich an jede Form setzen. 3D-Modelle (STL/OBJ) werden zu Schicht-, Rippen- oder Scheibenmodellen aus flachen Teilen. Später genügt ein Doppelklick auf ein Teil, um es zu ändern, und alles wird neu berechnet.

<p align="center">
  <img src="docs/screenshots/box-3d-de.png" alt="Werkzeugkasten mit Generatoren links, eine Box mit Fingerzinken und graviertem Fuchs zusammengesetzt in der 3D-Ansicht" width="900">
</p>

### Sehen, bevor es brennt
Die **3D-Ansicht** setzt die Teile so zusammen, wie sie später gebaut werden, mit Material, Maserung und Gravuren, und zeigt, ob etwas kollidiert. **Konstruktion prüfen** findet offene Formen, zu feine Details und Passungsprobleme vor dem Start. Die **Vorschau** spielt den Auftrag ab und schätzt die Laufzeit genau.

<p align="center">
  <img src="docs/screenshots/preview-de.png" alt="Auftragsvorschau mit Abspielregler, geschätzter Zeit und Schnittlänge" width="900">
</p>

### Den Laser steuern
Läuft mit **FluidNC, GRBL, grblHAL, Marlin, Smoothieware und Ruida (CO2)**, per USB oder WLAN. Ein Einrichtungsassistent erkennt die Steuerung, prüft ihre Einstellungen und fährt einen ersten Testauftrag. Rahmen fahren, starten, pausieren, Leistung und Tempo während des Laserns anpassen, an beliebiger Stelle im Auftrag einsteigen. Vor jedem Auftrag prüft KizamuBeam, ob alles auf das Bett passt. Drehachse (Rotary), motorisierte Z-Achse und Air Assist werden unterstützt.

### Die richtigen Einstellungen finden
Eine Material-Bibliothek speichert bewährte Einstellungen. Materialtest, Fokustest und Passungs-Kalibrierung helfen, sie zu finden, und ein Test lässt sich direkt aus einem Foto auswerten. Je Layer: mehrere Durchgänge, Sub-Layer, Haltestege, Schnittbreitenausgleich, Perforation, Anschnitt und Leistungsrampe.

### In Serie fertigen
Vorlagen mit Parametern, variabler Text und Seriennummern aus CSV, QR-Codes und Strichcodes, mehrseitige Projekte, Jigs für ganze Ladungen von Rohlingen, **Print and Cut** mit Passermarken und eine Kamera, um Motive direkt auf dem Werkstück zu platzieren.

### Nach deinem Geschmack
Andockbare Fenster und anpassbare Werkzeugleisten, helles und dunkles Design, Deutsch und Englisch. Der Werkzeugkasten sammelt alle Generatoren und Spezialwerkzeuge an einem Ort. Erweiterungen bringen Gerätevorlagen, Vorlagen, Materialien und Motive mit. Einstellungen, Geräte und Bibliotheken lassen sich als Datei sichern und übertragen oder über einen eigenen Ordner (iCloud, Dropbox, Nextcloud) zwischen Rechnern synchronisieren. KI-Agenten wie Claude Code oder Codex können über den eingebauten MCP-Server mit deinem Projekt arbeiten, mit der Berechtigungsstufe, die du wählst.

**→ [Die vollständige Funktionsliste](docs/features.de.md)**

## Selbst bauen

Du brauchst Node.js 20+ und Rust (stable), unter Linux zusätzlich die [Tauri-Voraussetzungen](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev      # Desktop-App mit Live-Neuladen
npm run tauri build    # Installer für dein System
```

Releases, Updates, Übersetzungen und der Aufbau des Codes stehen im [Entwickler-Handbuch](docs/development.de.md). Beiträge sind willkommen.

## Community

Fragen, Ideen oder etwas, das du mit KizamuBeam gemacht hast? Komm auf unseren [Discord-Server](https://discord.gg/SSr8VHh7EJ). Fehler und Wünsche meldest du am besten als [GitHub-Issue](https://github.com/negurvulkan/kizamubeam/issues).

## Lizenz

KizamuBeam ist freie Software unter der [GNU General Public License v3.0 oder neuer](LICENSE). Gebaut mit Tauri 2, TypeScript und Rust. „Kizamu“ (刻む) ist japanisch und heißt einritzen, gravieren, fein schneiden.

Copyright © 2026 [Hanjo Winter](https://github.com/negurvulkan). Entwickelt mit Unterstützung von [Claude Code](https://claude.com/claude-code).

## Marken

LightBurn ist eine Marke der LightBurn Software, LLC. KizamuBeam ist ein unabhängiges Projekt und steht in keiner Verbindung zu LightBurn Software; es wird von dort weder unterstützt noch empfohlen.
