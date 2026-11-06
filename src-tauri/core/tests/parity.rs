//! Vergleich mit der TypeScript-Fassung: `npm run test:core` erzeugt tests/fixtures/parity.json aus
//! src/images.ts und src/gcode.ts und startet danach diese Tests.

use kizamubeam_core::{gcode, raster, ruida};
use serde_json::Value;

fn fixtures() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/parity.json");
    let s = std::fs::read_to_string(p).expect("Vergleichsdaten fehlen: npm run test:core aufrufen");
    serde_json::from_str(&s).unwrap()
}

fn f32s(v: &Value) -> Vec<f32> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect()
}
fn f64s(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}
fn u8s(v: &Value) -> Vec<u8> {
    v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect()
}
fn mat(v: &Value) -> raster::Mat {
    f64s(v).try_into().unwrap()
}

/// Größte Abweichung zweier Graustufenfelder
fn max_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

#[test]
fn resample_matches() {
    let f = fixtures();
    let src = f32s(&f["src"]["v"]);
    let (w, h) = (f["src"]["w"].as_u64().unwrap() as usize, f["src"]["h"].as_u64().unwrap() as usize);
    assert_eq!(raster::resample(&src, w, h, 40, 30), f32s(&f["down"]));
    assert_eq!(raster::resample(&src, w, h, 150, 110), f32s(&f["up"]));
}

#[test]
fn adjust_matches() {
    let f = fixtures();
    let adj: raster::Adjust = serde_json::from_value(f["adjust"].clone()).unwrap();
    // Math.pow (JavaScript) und powf (Rust) dürfen in der letzten Stelle abweichen
    let mut g = f32s(&f["down"]);
    raster::apply_adjust(&mut g, 40, 30, &adj, false);
    assert!(max_diff(&g, &f32s(&f["adjusted"])) < 1e-3);
    let mut g = f32s(&f["up"]);
    raster::apply_adjust(&mut g, 150, 110, &raster::Adjust { sharpen: 0.0, ..adj }, true);
    assert!(max_diff(&g, &f32s(&f["adjustedNeg"])) < 1e-3);
}

#[test]
fn dither_matches() {
    let f = fixtures();
    // gleiche Eingabe wie in TypeScript, damit sich kleine Rundungsunterschiede nicht fortpflanzen
    let g = f32s(&f["adjusted"]);
    for (mode, want) in f["dithered"].as_object().unwrap() {
        let o = raster::DitherOptions { mode, threshold: 140.0, cell_px: 3.5, angle: 30.0 };
        assert_eq!(raster::dither(&g, 40, 30, &o), u8s(want), "Verfahren {mode}");
    }
}

#[test]
fn scan_lines_match() {
    let f = fixtures();
    for (i, c) in f["scans"].as_array().unwrap().iter().enumerate() {
        let l: raster::ImageLayer = serde_json::from_value(c["layer"].clone()).unwrap();
        let lines = raster::scan_lines(&u8s(&c["v"]), 40, 30, 20.0, 15.0, &mat(&c["m"]), &mat(&c["im"]), &l);
        let want = c["lines"].as_array().unwrap();
        assert_eq!(lines.len(), want.len(), "Fall {i}: Zeilenzahl");
        for (a, b) in lines.iter().zip(want) {
            assert_eq!(a.y, b["y"].as_f64().unwrap(), "Fall {i}");
            let runs: Vec<Vec<f64>> = b["runs"].as_array().unwrap().iter().map(f64s).collect();
            assert_eq!(a.runs.iter().map(|r| r.to_vec()).collect::<Vec<_>>(), runs, "Fall {i}, y = {}", a.y);
        }
    }
}

#[test]
fn gcode_matches() {
    let f = fixtures();
    for c in f["gcode"].as_array().unwrap() {
        let m = &c["moves"];
        let (x, y, t) = (f64s(&m["x"]), f64s(&m["y"]), f64s(&m["t"]));
        let (s, fe) = (f32s(&m["s"]), f32s(&m["f"]));
        let layer: Vec<i16> = m["layer"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap() as i16).collect();
        let p: gcode::Params = serde_json::from_value(c["params"].clone()).unwrap();
        let mv = gcode::Moves { x0: p.x0, y0: p.y0, x: &x, y: &y, s: &s, f: &fe, layer: &layer, t: &t };
        let (lines, times) = gcode::write(&mv, &p);
        let want: Vec<String> = c["lines"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        for (i, (a, b)) in lines.iter().zip(&want).enumerate() {
            assert_eq!(a, b, "Zeile {i}");
        }
        assert_eq!(lines.len(), want.len());
        assert_eq!(times, f64s(&c["times"]));
    }
}

#[test]
fn packed_gcode_matches() {
    // Binärdaten genau so, wie packMoves (gcode.ts) sie an den Rust-Kern schickt
    let f = fixtures();
    for c in f["gcode"].as_array().unwrap() {
        let (lines, times) = gcode::write_packed(&u8s(&c["packed"])).unwrap();
        let want: Vec<&str> = c["lines"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(lines, want);
        assert_eq!(times, f64s(&c["times"]));
    }
}

/// G-Code, den KizamuBeam für ein Ruida-Gerät schreibt, muss der Ruida-Kern ganz annehmen
#[test]
fn ruida_accepts_kizamubeam_gcode() {
    let f = fixtures();
    for c in f["ruida"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let lines: Vec<String> = c["lines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap().to_string()).collect();
        let o: ruida::Options = serde_json::from_value(c["options"].clone()).unwrap();
        let r = ruida::parse_gcode(&lines, &o, (0.0, 0.0)).and_then(|mv| {
            assert!(!mv.is_empty(), "{name}: keine Bewegungen");
            ruida::encode_job(&mv, &o, Some((0.0, 0.0)))
        });
        if c["reject"].as_bool().unwrap_or(false) {
            assert!(r.is_err(), "{name}: sollte abgelehnt werden");
            continue;
        }
        let job = r.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(job.data.last(), Some(&0xD7), "{name}: Dateiende");
        let cuts = job.starts.iter().filter(|&&s| matches!(job.data[s as usize], 0xA8..=0xAB)).count();
        if name.starts_with("frame") && !name.contains("laser") {
            assert_eq!(cuts, 0, "{name}: Rahmen ohne Laser schneidet nicht");
        } else {
            assert!(cuts > 0, "{name}: keine Schnitte");
        }
    }
}
