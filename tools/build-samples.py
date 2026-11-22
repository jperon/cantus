#!/usr/bin/env python3
"""Extrait les échantillons General MIDI joués par le moteur audio natif.

Le moteur Web Audio de Cantus ne synthétise plus en JavaScript : il joue des
échantillons avec AudioBufferSourceNode. Ce script produit, à partir d'une
banque SoundFont 2 libre, un fichier Ogg Vorbis par programme GM et un manifeste
JSON décrivant les zones (tessiture, couche de vélocité, hauteur d'origine,
boucle, enveloppe de base, gain).

Source par défaut : MuseScore_General.sf2 0.2.0, licence MIT (voir
`THIRD-PARTY.md`), téléchargée depuis le miroir OSUOSL de MuseScore. Elle est
compatible avec la GPL-3.0-or-later du reste de Cantus, contrairement à
l'ancienne banque TimGM6mb (GPL-2.0-only).

Transformations appliquées (reproductibles) :

  - un échantillon toutes les `--key-step` touches (12 par défaut) par couche
    de vélocité, tessiture élargie pour couvrir le même ambitus ;
  - au plus deux couches de vélocité par programme (la plus large, puis
    celle qui couvre la vélocité 90) ;
  - batterie : une zone par touche, deux couches de vélocité au plus ;
  - échantillons non bouclés tronqués à `--max-seconds` (3 s) avec fondu de
    sortie de 50 ms ; échantillons bouclés limités à la boucle + 0,25 s ;
  - rééchantillonnage à `--rate` (32 000 Hz) par ffmpeg, points de boucle
    recalés sur un passage par zéro à ±5 ms ;
  - encodage Ogg Vorbis mono (`-q:a` `--quality`, 0 par défaut), contenu par
    programme concaténé : le manifeste donne l'offset de chaque zone ;
  - vérification que le décodage Ogg rend exactement le nombre d'échantillons
    attendu (sinon les offsets de boucle seraient faux).

Usage :

  nix-shell -p python3 ffmpeg --run "python3 tools/build-samples.py"
  nix-shell -p python3 ffmpeg --run "python3 tools/build-samples.py --source /chemin/MuseScore_General.sf2"
  python3 tools/build-samples.py --report      # statistiques sans écrire

Le résultat va dans `pwa/samples/` (manifeste + un .ogg par programme). Le
script est volontairement sans dépendance Python hors bibliothèque standard.
"""

import argparse
import array
import hashlib
import json
import math
import pathlib
import struct
import subprocess
import sys
import tempfile
import urllib.request
import wave

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / 'pwa' / 'samples'
WORK = ROOT / '.tmp-samples'

SOURCE_URL = (
    'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/'
    'MuseScore_General.sf2'
)
SOURCE_NAME = 'MuseScore_General.sf2'
SOURCE_VERSION = '0.2.0'
SOURCE_SHA256 = 'ee51d2c4b1525e70f19a45909c4fd7a2e26d91d115fa89dbf5a6bc413d8b9bf3'
SOURCE_LICENSE = 'MIT'

# Générateurs SF2 (numérotation de la spécification 2.01).
GEN_START_OFF = 0
GEN_END_OFF = 1
GEN_STARTLOOP_OFF = 2
GEN_ENDLOOP_OFF = 3
GEN_START_COARSE = 4
GEN_END_COARSE = 12
GEN_PAN = 17
GEN_DELAY_VOLENV = 33
GEN_ATTACK_VOLENV = 34
GEN_HOLD_VOLENV = 35
GEN_DECAY_VOLENV = 36
GEN_SUSTAIN_VOLENV = 37
GEN_RELEASE_VOLENV = 38
GEN_INSTRUMENT = 41
GEN_KEYRANGE = 43
GEN_VELRANGE = 44
GEN_STARTLOOP_COARSE = 45
GEN_ATTENUATION = 48
GEN_ENDLOOP_COARSE = 50
GEN_COARSETUNE = 51
GEN_FINETUNE = 52
GEN_SAMPLEID = 53
GEN_SAMPLEMODES = 54
GEN_SCALETUNE = 56
GEN_ROOTKEY = 58

# Générateurs dont les valeurs du preset et de l'instrument s'additionnent.
ADDITIVE_GENS = {
    GEN_START_OFF, GEN_END_OFF, GEN_STARTLOOP_OFF, GEN_ENDLOOP_OFF,
    GEN_START_COARSE, GEN_END_COARSE, GEN_PAN, GEN_DELAY_VOLENV,
    GEN_ATTACK_VOLENV, GEN_HOLD_VOLENV, GEN_DECAY_VOLENV,
    GEN_SUSTAIN_VOLENV, GEN_RELEASE_VOLENV, GEN_STARTLOOP_COARSE,
    GEN_ATTENUATION, GEN_ENDLOOP_COARSE, GEN_COARSETUNE, GEN_FINETUNE,
}

DRUM_BANK = 128
DEFAULT_KEY_STEP = 12
DEFAULT_RATE = 32000
DEFAULT_MAX_SECONDS = 3.0
DEFAULT_QUALITY = 0
TARGET_VELOCITIES = (90,)


# ---------------------------------------------------------------------------
# Lecture RIFF / SoundFont 2

def _chunks(data, start, end, parent=None):
    pos = start
    while pos + 8 <= end:
        cid = data[pos:pos + 4]
        size = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        body = pos + 8
        stop = min(body + size, end)
        if cid == b'LIST' and size >= 4:
            yield cid, body, stop, parent
            yield from _chunks(data, body + 4, stop, data[body:body + 4])
        else:
            yield cid, body, stop, parent
        pos = body + size + (size & 1)


def _range(value):
    return value & 0xFF, (value >> 8) & 0xFF


def _pack_range(lo, hi):
    return (lo & 0xFF) | ((hi & 0xFF) << 8)


class SoundFont:
    def __init__(self, path):
        data = pathlib.Path(path).read_bytes()
        if data[:4] != b'RIFF' or data[8:12] != b'sfbk':
            raise SystemExit(f'{path} : format SoundFont 2 (RIFF sfbk) attendu')
        riff_end = 8 + struct.unpack('<I', data[4:8])[0]
        pdta = {}
        smpl = b''
        for cid, off, stop, parent in _chunks(data, 12, riff_end):
            if parent == b'sdta' and cid == b'smpl':
                smpl = data[off:stop]
            elif parent == b'pdta':
                pdta[cid] = data[off:stop]
        if len(smpl) % 2:
            smpl = smpl[:-1]
        self.pcm = array.array('h')
        self.pcm.frombytes(smpl)
        if sys.byteorder != 'little':
            self.pcm.byteswap()

        def records(cid, size):
            raw = pdta[cid]
            return [raw[i * size:(i + 1) * size]
                    for i in range(len(raw) // size)]

        self.phdr = []
        for rec in records(b'phdr', 38):
            preset, bank, pbag = struct.unpack('<HHH', rec[20:26])
            self.phdr.append(dict(name=rec[:20].split(b'\0')[0].decode('latin1'),
                                  preset=preset, bank=bank, pbag=pbag))
        self.pbag = [struct.unpack('<HH', rec) for rec in records(b'pbag', 4)]
        self.pgen = [struct.unpack('<Hh', rec) for rec in records(b'pgen', 4)]
        self.inst = []
        for rec in records(b'inst', 22):
            self.inst.append(dict(name=rec[:20].split(b'\0')[0].decode('latin1'),
                                  ibag=struct.unpack('<H', rec[20:22])[0]))
        self.ibag = [struct.unpack('<HH', rec) for rec in records(b'ibag', 4)]
        self.igen = [struct.unpack('<Hh', rec) for rec in records(b'igen', 4)]
        self.shdr = []
        for rec in records(b'shdr', 46):
            start, end, loopstart, loopend, rate, orig, pitch, link, typ = \
                struct.unpack('<IIIIIBbHH', rec[20:46])
            self.shdr.append(dict(
                name=rec[:20].split(b'\0')[0].decode('latin1'),
                start=start, end=end, loopstart=loopstart, loopend=loopend,
                rate=rate, orig=orig, pitch=pitch, link=link, typ=typ))

    def preset_zones(self, index):
        info = self.phdr[index]
        end = self.phdr[index + 1]['pbag']
        zones = []
        for gi in range(info['pbag'], end):
            gstart = self.pbag[gi][0]
            gend = self.pbag[gi + 1][0] if gi + 1 < len(self.pbag) else len(self.pgen)
            gens = self.pgen[gstart:gend]
            inst = next((v for op, v in gens if op == GEN_INSTRUMENT), None)
            zones.append((dict(gens), inst))
        return zones

    def instrument_zones(self, index):
        info = self.inst[index]
        end = self.inst[index + 1]['ibag']
        zones = []
        for jj in range(info['ibag'], end):
            gstart = self.ibag[jj][0]
            gend = self.ibag[jj + 1][0] if jj + 1 < len(self.ibag) else len(self.igen)
            zones.append(dict(self.igen[gstart:gend]))
        return zones


def add_generators(base, extra):
    """Applique des générateurs à une table, en respectant leur sémantique.

    La plupart des générateurs numériques s'additionnent entre zone globale,
    zone de preset et zone d'instrument ; les intervalles et l'échantillon
    sont remplacés par la zone la plus spécifique.
    """
    merged = dict(base)
    for op, value in extra.items():
        if op == GEN_INSTRUMENT:
            continue
        if op in ADDITIVE_GENS:
            merged[op] = merged.get(op, 0) + value
        else:
            merged[op] = value
    return merged


def flatten_preset(sf, preset_index):
    """Zones jouables d'un preset, ranges preset ∩ instrument fusionnés.

    Les zones globales (sans instrument ou sans sampleID) s'appliquent aux
    zones suivantes, comme le prévoit la spécification SF2. Les ignorer
    supprimerait par exemple le relâchement de 0,85 s du preset Choir Aahs.
    """
    zones = []
    preset_global = {}
    for pg, inst_index in sf.preset_zones(preset_index):
        if inst_index is None:
            preset_global = add_generators(preset_global, pg)
            continue
        if inst_index >= len(sf.inst):
            continue
        preset_zone = add_generators(preset_global, pg)
        inst_global = {}
        for ig in sf.instrument_zones(inst_index):
            sid = ig.get(GEN_SAMPLEID)
            if sid is None:
                inst_global = add_generators(inst_global, ig)
                continue
            if sid >= len(sf.shdr) - 1:
                continue
            gens = add_generators(add_generators(preset_zone, inst_global), ig)
            # Intervalles : preset ∩ instrument, la zone globale de
            # l'instrument s'appliquant à toutes ses zones.
            pkey = _range(preset_zone.get(GEN_KEYRANGE, _pack_range(0, 127)))
            gkey = _range(inst_global.get(GEN_KEYRANGE, _pack_range(0, 127)))
            ikey = _range(ig.get(GEN_KEYRANGE, _pack_range(0, 127)))
            ikey = (max(gkey[0], ikey[0]), min(gkey[1], ikey[1]))
            pvel = _range(preset_zone.get(GEN_VELRANGE, _pack_range(0, 127)))
            gvel = _range(inst_global.get(GEN_VELRANGE, _pack_range(0, 127)))
            ivel = _range(ig.get(GEN_VELRANGE, _pack_range(0, 127)))
            ivel = (max(gvel[0], ivel[0]), min(gvel[1], ivel[1]))
            key_lo, key_hi = max(pkey[0], ikey[0]), min(pkey[1], ikey[1])
            vel_lo, vel_hi = max(pvel[0], ivel[0]), min(pvel[1], ivel[1])
            if key_lo > key_hi or vel_lo > vel_hi:
                continue
            zones.append(dict(
                sid=sid, key_lo=key_lo, key_hi=key_hi,
                vel_lo=vel_lo, vel_hi=vel_hi,
                gens=gens,
                inst=sf.inst[inst_index]['name']))
    return zones


def choose_velocity_layers(zones, targets=TARGET_VELOCITIES, max_layers=2):
    """Garde la couche de vélocité la plus large et les plus proches des cibles.

    Les banques récentes empilent plusieurs couches (piano mf/ff, caisse claire
    par paliers, etc.). On conserve au plus `max_layers` couches pour limiter
    le poids ; une couche plus étroite prime à l'exécution quand plusieurs
    couvrent la vélocité jouée.
    """
    layers = {}
    for zone in zones:
        layers.setdefault((zone['vel_lo'], zone['vel_hi']), []).append(zone)
    if len(layers) <= max_layers:
        return list(layers.values())
    ordered = sorted(layers, key=lambda key: (key[1] - key[0]), reverse=True)
    chosen = [ordered[0]]
    for target in targets:
        if len(chosen) >= max_layers:
            break
        candidates = [key for key in layers if key not in chosen]
        if not candidates:
            break
        best = min(candidates,
                   key=lambda key: abs((key[0] + key[1]) / 2 - target))
        chosen.append(best)
    return [layers[key] for key in chosen]


def select_key_cells(zones, step):
    """Réduit les zones d'une couche : une zone toutes les `step` touches.

    Les zones conservées reçoivent une cellule de tessiture contiguë (coupures
    au milieu de deux centres) pour que toute hauteur jouée trouve un
    échantillon.
    """
    if not zones:
        return []
    lo = min(zone['key_lo'] for zone in zones)
    hi = max(zone['key_hi'] for zone in zones)
    if step <= 0 or hi - lo + 1 <= step:
        return [dict(zones[0], key_lo=lo, key_hi=hi)]
    targets = list(range(lo, hi + 1, step))
    if targets[-1] != hi:
        targets.append(hi)
    chosen = []
    for target in targets:
        best = None
        for index, zone in enumerate(zones):
            if index in [z['index'] for z in chosen]:
                continue
            center = (zone['key_lo'] + zone['key_hi']) / 2
            if zone['key_lo'] <= target <= zone['key_hi']:
                distance = 0
                span = zone['key_hi'] - zone['key_lo']
            else:
                distance = min(abs(target - zone['key_lo']),
                               abs(target - zone['key_hi']))
                span = zone['key_hi'] - zone['key_lo']
            score = (distance, span)
            if best is None or score < best[0]:
                best = (score, index, zone)
        if best is not None:
            chosen.append(dict(best[2], index=best[1]))
    chosen.sort(key=lambda zone: (zone['key_lo'] + zone['key_hi']) / 2)
    # Une seule zone : elle couvre tout l'ambitus.
    if len(chosen) == 1:
        chosen[0]['key_lo'] = lo
        chosen[0]['key_hi'] = hi
        return chosen
    cuts = [lo]
    for a, b in zip(chosen, chosen[1:]):
        center_a = (a['key_lo'] + a['key_hi']) / 2
        center_b = (b['key_lo'] + b['key_hi']) / 2
        cuts.append(int(round((center_a + center_b) / 2)))
    cuts.append(hi + 1)
    # Coups croissants et au moins une touche par zone conservée.
    for i in range(1, len(cuts) - 1):
        cuts[i] = max(cuts[i], cuts[i - 1] + 1)
    for i in range(len(cuts) - 2, 0, -1):
        cuts[i] = min(cuts[i], cuts[i + 1] - 1)
    for index, zone in enumerate(chosen):
        zone['key_lo'] = cuts[index]
        zone['key_hi'] = cuts[index + 1] - 1
    return chosen


# ---------------------------------------------------------------------------
# Échantillons

def _frames_of(sf, sample_index, gens):
    """Données mono d'une zone, canaux gauche/droite moyennés si stéréo."""
    sample = sf.shdr[sample_index]
    start = sample['start'] + gens.get(GEN_START_OFF, 0) + \
        16384 * gens.get(GEN_START_COARSE, 0)
    end = sample['end'] + 1 + gens.get(GEN_END_OFF, 0) + \
        16384 * gens.get(GEN_END_COARSE, 0)
    start = max(0, min(start, len(sf.pcm)))
    end = max(start, min(end, len(sf.pcm)))
    frames = sf.pcm[start:end]
    # Paire stéréo : wSampleLink désigne l'autre canal ; on moyenne les deux
    # pour rester mono (les deux en-têtes partagent le même timbre).
    link = sample['link']
    if sample['typ'] in (2, 4) and 0 < link < len(sf.shdr) and link != sample_index:
        other = sf.shdr[link]
        ostart = other['start']
        oend = other['end'] + 1
        ostart = max(0, min(ostart, len(sf.pcm)))
        oend = max(ostart, min(oend, len(sf.pcm)))
        count = min(len(frames), oend - ostart)
        if count > 0:
            left = frames
            right = sf.pcm[ostart:ostart + count]
            mixed = array.array('h')
            mixed.extend(int(round((left[i] + right[i]) / 2))
                         for i in range(count))
            frames = mixed
    return frames, sample


def _tc_to_seconds(value):
    """Timecents SF2 -> secondes (borné pour rester jouable)."""
    value = max(-12000, min(value, 8000))
    return 2.0 ** (value / 1200.0)


def _snap_zero(frames, position, rate):
    """Recale un point de boucle sur un passage par zéro proche (±5 ms)."""
    window = max(4, int(rate * 0.005))
    lo = max(2, position - window)
    hi = min(len(frames) - 1, position + window)
    best = position
    best_score = None
    for i in range(lo, hi):
        a, b = frames[i - 1], frames[i]
        score = abs(int(a)) + abs(int(b)) if (a < 0 <= b or b < 0 <= a) else \
            abs(int(a)) + abs(int(b)) + 65536
        if best_score is None or score < best_score:
            best_score = score
            best = i
    return best


def extract_zone(sf, zone, target_rate, max_seconds):
    frames, sample = _frames_of(sf, zone['sid'], zone['gens'])
    gens = zone['gens']
    if not frames:
        return None
    native_rate = sample['rate'] or target_rate
    # Boucle : les points SF2 sont exprimés dans le repère absolu de `smpl`.
    loop_mode = gens.get(GEN_SAMPLEMODES, 0)
    looped = loop_mode in (1, 3)
    loop_start = loop_end = 0
    if looped:
        loop_start = sample['loopstart'] + gens.get(GEN_STARTLOOP_OFF, 0) + \
            16384 * gens.get(GEN_STARTLOOP_COARSE, 0) - (
                sample['start'] + gens.get(GEN_START_OFF, 0) + 16384 * gens.get(GEN_START_COARSE, 0))
        loop_end = sample['loopend'] + gens.get(GEN_ENDLOOP_OFF, 0) + \
            16384 * gens.get(GEN_ENDLOOP_COARSE, 0) + 1 - (
                sample['start'] + gens.get(GEN_START_OFF, 0) + 16384 * gens.get(GEN_START_COARSE, 0))
        looped = 0 <= loop_start < loop_end <= len(frames)
    if looped:
        # Le moteur boucle jusqu'au relâchement : la queue après la boucle est
        # inutile, on ne garde qu'une marge.
        keep = min(len(frames), loop_end + int(native_rate * 0.25))
        frames = frames[:keep]
    elif len(frames) > max_seconds * native_rate:
        keep = int(max_seconds * native_rate)
        # Fondu de 50 ms pour ne pas claquer en fin d'échantillon tronqué.
        fade = min(keep, int(native_rate * 0.05))
        frames = frames[:keep]
        for i in range(fade):
            frames[keep - fade + i] = int(frames[keep - fade + i] * (1 - i / fade))
    return dict(frames=frames, native_rate=native_rate, looped=looped,
                loop_start=loop_start, loop_end=loop_end,
                root=gens.get(GEN_ROOTKEY, sample['orig']),
                tune=gens.get(GEN_COARSETUNE, 0) * 100 + gens.get(GEN_FINETUNE, 0),
                gain=10 ** (-gens.get(GEN_ATTENUATION, 0) / 200.0),
                pan=max(-1.0, min(1.0, gens.get(GEN_PAN, 0) / 500.0)),
                attack=max(0.001, _tc_to_seconds(gens.get(GEN_ATTACK_VOLENV, -12000))),
                hold=max(0.0, _tc_to_seconds(gens.get(GEN_HOLD_VOLENV, -12000))),
                decay=max(0.001, _tc_to_seconds(gens.get(GEN_DECAY_VOLENV, -12000))),
                sustain=max(0.0, min(1.0, 1.0 - gens.get(GEN_SUSTAIN_VOLENV, 0) / 1000.0)),
                release=max(0.005, min(4.0, _tc_to_seconds(gens.get(GEN_RELEASE_VOLENV, -12000)))),
                key_lo=zone['key_lo'], key_hi=zone['key_hi'],
                vel_lo=zone['vel_lo'], vel_hi=zone['vel_hi'])


def _run_ffmpeg(args, input_bytes=None):
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y'] + args
    # L'environnement de développement de cette machine exporte un
    # LD_LIBRARY_PATH qui casse le ffmpeg du système ; le retirer est sans
    # effet ailleurs.
    import os
    env = dict(os.environ)
    env.pop('LD_LIBRARY_PATH', None)
    proc = subprocess.run(cmd, input=input_bytes, capture_output=True, env=env)
    if proc.returncode != 0:
        raise SystemExit(f'ffmpeg a échoué ({proc.returncode}) : '
                         f'{proc.stderr.decode(errors="replace")}')
    return proc.stdout


def resample(frames, src_rate, dst_rate):
    if src_rate == dst_rate:
        return frames
    raw = frames.tobytes()
    out = _run_ffmpeg([
        '-f', 's16le', '-ar', str(src_rate), '-ac', '1', '-i', 'pipe:0',
        '-ar', str(dst_rate), '-ac', '1', '-f', 's16le', 'pipe:1'], raw)
    result = array.array('h')
    result.frombytes(out[:len(out) // 2 * 2])
    if sys.byteorder != 'little':
        result.byteswap()
    return result


def _write_wav(path, frames, rate):
    pcm = frames.tobytes()
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm)


def encode_ogg(wav_path, ogg_path, quality):
    _run_ffmpeg([
        '-i', str(wav_path), '-map_metadata', '-1', '-fflags', '+bitexact',
        '-flags:a', '+bitexact', '-c:a', 'libvorbis', '-q:a', str(quality),
        '-ac', '1', str(ogg_path)])


def decode_ogg_frames(ogg_path, rate):
    out = _run_ffmpeg(['-i', str(ogg_path), '-f', 's16le', '-ac', '1',
                       '-ar', str(rate), 'pipe:1'])
    return len(out) // 2


# ---------------------------------------------------------------------------
# Construction

def preset_indices(sf):
    for index in range(len(sf.phdr) - 1):
        preset = sf.phdr[index]
        if preset['bank'] == 0 and 0 <= preset['preset'] <= 127:
            yield str(preset['preset']), index
    # Kit de percussion GM standard : banque 128, programme 0.
    for index in range(len(sf.phdr) - 1):
        preset = sf.phdr[index]
        if preset['bank'] == DRUM_BANK and preset['preset'] == 0:
            yield 'drums', index


def build_program(sf, key, preset_index, work, out_dir, target_rate,
                  key_step, max_seconds, quality):
    zones = flatten_preset(sf, preset_index)
    is_drums = key == 'drums'
    if is_drums:
        layers = choose_velocity_layers(zones)
    else:
        layers = choose_velocity_layers(zones)
    selected = []
    for layer in layers:
        if is_drums:
            # Chaque touche a son timbre : aucune réduction de tessiture.
            selected.extend(dict(zone) for zone in layer)
        else:
            # index stable dans la couche pour la sélection des cellules.
            indexed = [dict(zone, index=i) for i, zone in enumerate(layer)]
            selected.extend(select_key_cells(indexed, key_step))
    # Supprime les doublons exacts (même échantillon et même cellule).
    unique = []
    seen = set()
    for zone in selected:
        signature = (zone['sid'], zone['key_lo'], zone['key_hi'],
                     zone['vel_lo'], zone['vel_hi'])
        if signature in seen:
            continue
        seen.add(signature)
        unique.append(zone)
    if not unique:
        return None

    extracted = []
    for zone in unique:
        item = extract_zone(sf, zone, target_rate, max_seconds)
        if item is not None:
            extracted.append(item)
    if not extracted:
        return None

    rate = target_rate
    for item in extracted:
        src_rate = item['native_rate']
        dst_rate = min(rate, src_rate) if src_rate else rate
        # Un programme n'a qu'une fréquence : on rééchantillonne vers la
        # fréquence cible (ou la fréquence native si elle est plus basse).
        frames = resample(item['frames'], src_rate or rate, dst_rate) \
            if src_rate != dst_rate else item['frames']
        ratio = len(frames) / len(item['frames']) if item['frames'] else 1.0
        item['frames'] = frames
        item['rate'] = dst_rate
        if item['looped']:
            item['loop_start'] = int(round(item['loop_start'] * ratio))
            item['loop_end'] = int(round(item['loop_end'] * ratio))
            item['loop_start'] = _snap_zero(frames, item['loop_start'], dst_rate)
            item['loop_end'] = _snap_zero(frames, item['loop_end'], dst_rate)
            if not 0 <= item['loop_start'] < item['loop_end'] < len(frames):
                item['looped'] = False
    # Fréquence unique du fichier : la plus haute employée.
    file_rate = max(item['rate'] for item in extracted)
    for item in extracted:
        if item['rate'] != file_rate:
            ratio = file_rate / item['rate']
            item['frames'] = resample(item['frames'], item['rate'], file_rate)
            if item['looped']:
                item['loop_start'] = int(round(item['loop_start'] * ratio))
                item['loop_end'] = int(round(item['loop_end'] * ratio))
            item['rate'] = file_rate

    # Concatène les zones dans un seul flux : le manifeste donne les offsets.
    offset = 0
    zones_meta = []
    total = array.array('h')
    for item in extracted:
        frames = item['frames']
        zones_meta.append(dict(
            keyLo=item['key_lo'], keyHi=item['key_hi'],
            velLo=item['vel_lo'], velHi=item['vel_hi'],
            root=item['root'], tune=item['tune'],
            offset=offset, frames=len(frames),
            loop=bool(item['looped']),
            loopStart=offset + item['loop_start'],
            loopEnd=offset + item['loop_end'],
            gain=round(item['gain'], 4), pan=round(item['pan'], 3),
            attack=round(item['attack'], 4), hold=round(item['hold'], 4),
            decay=round(item['decay'], 4),
            sustain=round(item['sustain'], 4), release=round(item['release'], 4)))
        total.extend(frames)
        offset += len(frames)

    wav_path = work / f'{key}.wav'
    _write_wav(wav_path, total, file_rate)
    ogg_name = f'{"drums" if is_drums else "p%03d" % int(key)}.ogg'
    ogg_path = out_dir / ogg_name
    encode_ogg(wav_path, ogg_path, quality)
    decoded = decode_ogg_frames(ogg_path, file_rate)
    # ffmpeg/libvorbis peut ajouter ou retirer quelques dizaines
    # d'échantillons en fin de flux (bourrage du dernier bloc) ; les offsets,
    # calculés depuis le début, restent exacts, et une zone non bouclée est
    # jouée avec une durée explicite. Un écart plus grand signalerait un vrai
    # décalage.
    if abs(decoded - len(total)) > file_rate // 10:
        raise SystemExit(
            f'{ogg_name} : {decoded} échantillons décodés, {len(total)} attendus '
            '(les offsets du manifeste seraient faux)')
    if decoded != len(total):
        print(f'  note : {ogg_name} décodé avec {decoded - len(total)} '
              'échantillon(s) de bourrage final')
    return dict(file=ogg_name, rate=file_rate, zones=zones_meta,
                bytes=ogg_path.stat().st_size)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def fetch_source(cache):
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not cache.exists():
        print(f'Téléchargement de {SOURCE_URL}')
        urllib.request.urlretrieve(SOURCE_URL, cache)
    digest = sha256_file(cache)
    if digest != SOURCE_SHA256:
        raise SystemExit(f'{cache} : sha256 {digest} != {SOURCE_SHA256}')
    return cache


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', type=pathlib.Path,
                        help='MuseScore_General.sf2 déjà téléchargé')
    parser.add_argument('--out', type=pathlib.Path, default=DEFAULT_OUT)
    parser.add_argument('--rate', type=int, default=DEFAULT_RATE)
    parser.add_argument('--key-step', type=int, default=DEFAULT_KEY_STEP)
    parser.add_argument('--max-seconds', type=float, default=DEFAULT_MAX_SECONDS)
    parser.add_argument('--quality', type=int, default=DEFAULT_QUALITY)
    parser.add_argument('--report', action='store_true',
                        help='analyse seulement, sans écrire les fichiers')
    parser.add_argument('--work', type=pathlib.Path, default=WORK)
    args = parser.parse_args(argv)

    args.work.mkdir(parents=True, exist_ok=True)
    source = args.source if args.source else fetch_source(
        args.work / 'MuseScore_General.sf2')
    if sha256_file(source) != SOURCE_SHA256:
        raise SystemExit(f'{source} : empreinte inattendue')
    sf = SoundFont(source)
    out_dir = args.out
    if not args.report:
        out_dir.mkdir(parents=True, exist_ok=True)

    programs = {}
    raw_bytes = 0
    encoded_bytes = 0
    zone_count = 0
    for key, index in preset_indices(sf):
        title = sf.phdr[index]['name']
        if args.report:
            zones = flatten_preset(sf, index)
            layers = choose_velocity_layers(zones)
            selected = 0
            for layer in layers:
                if key == 'drums':
                    selected += len(layer)
                else:
                    selected += len(select_key_cells(
                        [dict(zone, index=i) for i, zone in enumerate(layer)],
                        args.key_step))
            zone_count += selected
            print(f'{key:>5s} {title:24s} {len(zones):4d} zones -> {selected:3d}')
            continue
        result = build_program(sf, key, index, args.work, out_dir,
                               args.rate, args.key_step, args.max_seconds,
                               args.quality)
        if result is None:
            continue
        programs[key] = result
        encoded_bytes += result['bytes']
        zone_count += len(result['zones'])
        raw_bytes += sum(zone['frames'] for zone in result['zones']) * 2
        print(f'{key:>5s} {title:24s} {len(result["zones"]):3d} zones, '
              f'{result["bytes"] / 1024:7.1f} ko')

    if args.report:
        print(f'\n{zone_count} zones retenues (toutes couches, sans écriture)')
        return 0

    manifest = dict(
        version=1,
        source=dict(
            name=SOURCE_NAME, version=SOURCE_VERSION, license=SOURCE_LICENSE,
            url=SOURCE_URL, sha256=SOURCE_SHA256),
        programs=programs)
    manifest_path = out_dir / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, separators=(',', ':')) + '\n')
    size = manifest_path.stat().st_size
    print(f'\n{len(programs)} programmes, {zone_count} zones')
    print(f'PCM source : {raw_bytes / 1e6:.2f} Mo, Ogg : '
          f'{encoded_bytes / 1e6:.2f} Mo, manifeste : {size / 1024:.1f} ko')
    print(f'-> {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
