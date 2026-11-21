#!/usr/bin/env python3
"""Construit pwa/soundfonts/TimGM6mb.sf3 à partir de TimGM6mb.sf2.

Le but est d'obtenir la plus petite banque SF3 qui couvre tous les jeux
General MIDI et la batterie sans devenir inaudible. Le script :

  1. télécharge (ou réutilise) TimGM6mb.sf2 depuis le paquet Debian
     `timgm6mb-soundfont` et vérifie son empreinte ;
  2. applique éventuellement les transformations choisies au SF2
     (réduction des zones de clavier, rééchantillonnage, raccourcissement
     des queues de boucle, suppression des échantillons orphelins) ;
  3. assemble un SF3 : chaque échantillon est encodé en Ogg Vorbis, puis le
     chunk `smpl` est reconstruit et les en-têtes d'échantillon réécrits ;
  4. mesure les tailles brute et gzip, et peut rendre un MIDI de test.

La variante par défaut est `zones24-q2` : une zone de clavier toutes les
deux octaves, encodage Vorbis de qualité 2, sans rééchantillonnage. Les
tailles mesurées et les transformations appliquées sont décrites dans
THIRD-PARTY.md.

Pourquoi ne pas passer par Polyphone pour l'encodage : la version 2.5.1
(`polyphone -2 -c 0|1`) produit des flux Vorbis que FluidSynth décode en
silence ; l'encodage direct avec `oggenc` est fiable et donne un contrôle
exact de la qualité. (Attention : dans Polyphone 2.5.1, `-2` convertit en
SF3 et `-1` en SF2.) Polyphone reste utile pour ouvrir le résultat.

Usage :
  nix-shell -p python3Packages.numpy vorbis-tools fluidsynth --run \\
    "python3 tools/build-soundfont.py --all"

  # variante par défaut seulement (celle livrée dans la PWA)
  nix-shell -p python3Packages.numpy vorbis-tools --run \\
    "python3 tools/build-soundfont.py"

  # rendus d'écoute de toutes les variantes dans .tmp-sf/rendus/
  nix-shell -p python3Packages.numpy vorbis-tools fluidsynth --run \\
    "python3 tools/build-soundfont.py --all --render --render-source"

  # réutiliser un SF2 déjà téléchargé
  nix-shell -p python3Packages.numpy vorbis-tools --run \\
    "python3 tools/build-soundfont.py --source /chemin/TimGM6mb.sf2"

Les fichiers intermédiaires vont dans .tmp-sf/build/ (non versionné).

Rappels sur le format SF2 : dans l'en-tête d'échantillon, `dwStart`/`dwEnd`
sont des indices de points d'échantillonnage (mots de 16 bits) dans le chunk
`smpl`, et `dwStartloop`/`dwEndloop` sont eux aussi exprimés dans le même
repère (absolus dans le chunk). Dans un SF3, `dwStart`/`dwEnd` deviennent des
octets dans `smpl` et les points de boucle sont relatifs au flux décodé.
"""

import argparse
import gzip
import hashlib
import math
import pathlib
import struct
import subprocess
import sys
import tarfile
import urllib.request

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = ROOT / '.tmp-sf' / 'build'
DEFAULT_OUT = ROOT / 'pwa' / 'soundfonts' / 'TimGM6mb.sf3'

SOURCE_URL = (
    'http://deb.debian.org/debian/pool/main/t/timgm6mb-soundfont/'
    'timgm6mb-soundfont_1.3.orig.tar.gz'
)
SOURCE_SHA256 = 'af8f3a00e416dfb262bcaa904a1c84df04a51b72bbc1313aed012bc754bdf99b'
SF2_MEMBER = 'timgm6mb-soundfont_1.3/TimGM6mb.sf2'
SF2_SHA256 = 'c5378b62028c920cb11e4803327983fee2f2cdff5dc89c708e39da417e51c854'

# Générateurs SF2 utilisés ici.
GEN_KEYRANGE = 43
GEN_VELRANGE = 44
GEN_INSTRUMENT = 41
GEN_SAMPLE_ID = 53

# Type d'échantillon SF3 : mono 16 bits + indicateur Ogg Vorbis.
SAMPLE_TYPE_SF3 = 0x11

# Variantes mesurées. `quality` est la qualité Vorbis d'oggenc (-1 à 10),
# `zone_step` la tessiture (en demi-tons) couverte par zone conservée,
# `rate` la fréquence cible, `tail_ms` la queue gardée après le point de
# boucle.
VARIANTS = {
    # Conversion directe, sans autre transformation que la compression Ogg.
    'direct-q2': dict(zone_step=None, rate=None, tail_ms=None, quality=2),
    'direct-q1': dict(zone_step=None, rate=None, tail_ms=None, quality=1),
    'direct-q0': dict(zone_step=None, rate=None, tail_ms=None, quality=0),
    'direct-qm1': dict(zone_step=None, rate=None, tail_ms=None, quality=-1),
    # Réduction des zones de clavier (une zone toutes les N touches).
    'zones-q1': dict(zone_step=18, rate=None, tail_ms=None, quality=1),
    'zones24-q1': dict(zone_step=24, rate=None, tail_ms=None, quality=1),
    'zones24-q2': dict(zone_step=24, rate=None, tail_ms=None, quality=2),
    'zones36-q2': dict(zone_step=36, rate=None, tail_ms=None, quality=2),
    # Variantes avec rééchantillonnage à 22 050 Hz et queue de boucle courte :
    # mesurées, mais sans gain de taille (l'en-tête Vorbis de chaque flux
    # pèse ~3,4 ko, quel que soit le contenu).
    'zones24-22-q2': dict(zone_step=24, rate=22050, tail_ms=None, quality=2),
    'zones24-22-tail-q2': dict(zone_step=24, rate=22050, tail_ms=200, quality=2),
}


# Variante livrée dans la PWA (voir THIRD-PARTY.md).
DEFAULT_VARIANT = 'zones24-q2'


# ---------------------------------------------------------------------------
# Lecture / écriture RIFF

def _chunks(data, start, end, parent=None):
    """Itère les sous-chunks d'une zone RIFF (LIST comprises) en indiquant
    le type de la LIST parente."""
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


def _sub(cid, payload):
    return cid + struct.pack('<I', len(payload)) + payload + (
        b'\0' if len(payload) & 1 else b'')


def _list(kind, payload):
    return _sub(b'LIST', kind + payload)


def _name(text, size=20):
    return text.encode('latin1')[:size].ljust(size, b'\0')


def order_gens(gens, last_op):
    """Ordonne les générateurs d'une zone : keyRange d'abord, puis velRange,
    puis les autres par opcode croissant, et enfin le générateur terminal
    (instrument ou sampleID), comme l'exige la spécification SF2 8.1.2."""
    key = [g for g in gens if g[0] == GEN_KEYRANGE]
    vel = [g for g in gens if g[0] == GEN_VELRANGE]
    rest = sorted((g for g in gens
                   if g[0] not in (GEN_KEYRANGE, GEN_VELRANGE, last_op)),
                  key=lambda g: g[0])
    last = [g for g in gens if g[0] == last_op]
    return key + vel + rest + last


def pack_range(lo, hi):
    return (lo & 0xFF) | ((hi & 0xFF) << 8)


def unpack_range(value):
    return value & 0xFF, (value >> 8) & 0xFF


class SoundFont:
    """Vue modifiable d'un SF2 : presets, instruments, échantillons."""

    def __init__(self, path):
        self.path = path
        data = pathlib.Path(path).read_bytes()
        if data[:4] != b'RIFF' or data[8:12] != b'sfbk':
            raise ValueError(f'{path} : ce n’est pas un SF2 (RIFF sfbk)')
        riff_end = 8 + struct.unpack('<I', data[4:8])[0]
        self.info_raw = b''
        pdta = {}
        self.smpl = b''
        for cid, off, stop, parent in _chunks(data, 12, riff_end):
            if cid == b'LIST' and parent is None and data[off:off + 4] == b'INFO':
                self.info_raw = _list(b'INFO', data[off + 4:stop])
            elif parent == b'sdta' and cid == b'smpl':
                self.smpl = data[off:stop]
            elif parent == b'pdta':
                pdta[cid] = data[off:stop]
        self.pmod = pdta[b'pmod']

        def records(cid, size):
            raw = pdta[cid]
            return [raw[i * size:(i + 1) * size] for i in range(len(raw) // size)]

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
        self.imod = records(b'imod', 10)
        self.shdr = []
        for rec in records(b'shdr', 46):
            # Indices en points d'échantillonnage, fin incluse.
            start, end, loopstart, loopend, rate, orig, pitch, link, typ = \
                struct.unpack('<IIIIIBbHH', rec[20:46])
            self.shdr.append(dict(name=rec[:20].split(b'\0')[0].decode('latin1'),
                                  start=start, end=end, loopstart=loopstart,
                                  loopend=loopend, rate=rate, orig=orig,
                                  pitch=pitch, link=link, typ=typ))
        self.samples = []
        self._build_model()

    # -- modèle logique ----------------------------------------------------

    def _build_model(self):
        self.presets = []
        for pi in range(len(self.phdr) - 1):
            info = self.phdr[pi]
            pend = self.phdr[pi + 1]['pbag']
            zones = []
            for gi in range(info['pbag'], pend):
                gstart = self.pbag[gi][0]
                gend = self.pbag[gi + 1][0] if gi + 1 < len(self.pbag) else len(self.pgen)
                gens = self.pgen[gstart:gend]
                inst = next((v for op, v in gens if op == GEN_INSTRUMENT), None)
                zones.append(dict(gens=list(gens), inst=inst))
            self.presets.append(dict(name=info['name'], preset=info['preset'],
                                     bank=info['bank'], zones=zones))
        self.instruments = []
        for ii in range(len(self.inst) - 1):
            info = self.inst[ii]
            iend = self.inst[ii + 1]['ibag']
            zones = []
            for jj in range(info['ibag'], iend):
                gstart, mstart = self.ibag[jj]
                gend = self.ibag[jj + 1][0] if jj + 1 < len(self.ibag) else len(self.igen)
                mend = self.ibag[jj + 1][1] if jj + 1 < len(self.ibag) else len(self.imod)
                zones.append(dict(gens=list(self.igen[gstart:gend]),
                                  mods=list(self.imod[mstart:mend])))
            self.instruments.append(dict(name=info['name'], zones=zones))

    # -- sérialisation -----------------------------------------------------

    def commit_model(self):
        """Réécrit pbag/pgen/ibag/igen/imod à partir du modèle."""
        self.pbag, self.pgen = [], []
        for p in self.presets:
            p['pbag'] = len(self.pbag)
            for zone in p['zones']:
                gens = [(op, v) for op, v in zone['gens'] if op != GEN_INSTRUMENT]
                gens.append((GEN_INSTRUMENT, zone['inst']))
                gens = order_gens(gens, GEN_INSTRUMENT)
                self.pbag.append((len(self.pgen), 0))
                self.pgen.extend(gens)
        self.pbag.append((len(self.pgen), 0))
        self.phdr = [dict(name=p['name'], preset=p['preset'], bank=p['bank'],
                          pbag=p['pbag']) for p in self.presets]
        # Le dernier en-tête pointe sur l'enregistrement terminal du pbag.
        self.phdr.append(dict(name='EOP', preset=0, bank=0, pbag=len(self.pbag) - 1))

        self.ibag, self.igen, self.imod = [], [], []
        self.inst = []
        for i in self.instruments:
            self.inst.append(dict(name=i['name'], ibag=len(self.ibag)))
            for zone in i['zones']:
                gens = [(op, v) for op, v in zone['gens'] if op != GEN_SAMPLE_ID]
                sid = next(v for op, v in zone['gens'] if op == GEN_SAMPLE_ID)
                gens.append((GEN_SAMPLE_ID, sid))
                gens = order_gens(gens, GEN_SAMPLE_ID)
                self.ibag.append((len(self.igen), len(self.imod)))
                self.igen.extend(gens)
                self.imod.extend(zone['mods'])
        self.ibag.append((len(self.igen), len(self.imod)))
        self.inst.append(dict(name='EOI', ibag=len(self.ibag) - 1))
        # Enregistrement terminal du chunk IMOD.
        self.imod.append(b'\0' * 10)

    def write_sf2(self, path):
        """Écrit un SF2 (utile pour inspecter les transformations)."""
        pdta = b''
        phdr = b''
        for p in self.phdr:
            phdr += _name(p['name']) + struct.pack(
                '<HHHIII', p['preset'], p['bank'], p['pbag'], 0, 0, 0)
        pdta += _sub(b'phdr', phdr)
        pdta += _sub(b'pbag', b''.join(struct.pack('<HH', *b) for b in self.pbag))
        pdta += _sub(b'pmod', self.pmod)
        pdta += _sub(b'pgen', b''.join(struct.pack('<Hh', *g) for g in self.pgen))
        inst = b''
        for i in self.inst:
            inst += _name(i['name']) + struct.pack('<H', i['ibag'])
        pdta += _sub(b'inst', inst)
        pdta += _sub(b'ibag', b''.join(struct.pack('<HH', *b) for b in self.ibag))
        pdta += _sub(b'imod', b''.join(self.imod))
        pdta += _sub(b'igen', b''.join(struct.pack('<Hh', *g) for g in self.igen))

        shdr = b''
        cursor = 0
        for s in self.samples:
            n = len(s['pcm'])
            start = cursor
            end = cursor + n - 1
            loopstart = start + s['loopstart'] if s['looped'] else 0
            loopend = start + s['loopend'] if s['looped'] else 0
            shdr += _name(s['name']) + struct.pack(
                '<IIIIIBbHH', start, end, loopstart, loopend, s['rate'],
                s['orig'], s['pitch'], 0, 1)
            cursor += n
        shdr += _name('EOS') + struct.pack('<IIIIIBbHH', 0, 0, 0, 0, 0, 0, 0, 0, 0)
        pdta += _sub(b'shdr', shdr)

        smpl = b''.join(np.asarray(s['pcm'], dtype='<i2').tobytes()
                        for s in self.samples)
        body = self.info_raw
        body += _list(b'sdta', _sub(b'smpl', smpl))
        body += _list(b'pdta', pdta)
        data = b'RIFF' + struct.pack('<I', 4 + len(body)) + b'sfbk' + body
        pathlib.Path(path).write_bytes(data)
        return len(data)

    def write_sf3(self, path, quality):
        """Assemble un SF3 : flux Ogg Vorbis concaténés dans `smpl`."""
        smpl = bytearray()
        shdr = b''
        for index, s in enumerate(self.samples):
            ogg = encode_ogg(s['pcm'], s['rate'], quality, serial=index + 1)
            start = len(smpl)
            smpl.extend(ogg)
            if len(smpl) & 1:
                smpl.append(0)
            loopstart = s['loopstart'] if s['looped'] else 0
            loopend = s['loopend'] if s['looped'] else 0
            shdr += _name(s['name']) + struct.pack(
                '<IIIIIBbHH', start, start + len(ogg), loopstart, loopend,
                s['rate'], s['orig'], s['pitch'], 0, SAMPLE_TYPE_SF3)
        shdr += _name('EOS') + struct.pack('<IIIIIBbHH', 0, 0, 0, 0, 0, 0, 0, 0, 0)
        pdta = b''
        pdta += _sub(b'phdr', b''.join(
            _name(p['name']) + struct.pack('<HHHIII', p['preset'], p['bank'],
                                           p['pbag'], 0, 0, 0)
            for p in self.phdr))
        pdta += _sub(b'pbag', b''.join(struct.pack('<HH', *b) for b in self.pbag))
        pdta += _sub(b'pmod', self.pmod)
        pdta += _sub(b'pgen', b''.join(struct.pack('<Hh', *g) for g in self.pgen))
        pdta += _sub(b'inst', b''.join(_name(i['name']) + struct.pack('<H', i['ibag'])
                                       for i in self.inst))
        pdta += _sub(b'ibag', b''.join(struct.pack('<HH', *b) for b in self.ibag))
        pdta += _sub(b'imod', b''.join(self.imod))
        pdta += _sub(b'igen', b''.join(struct.pack('<Hh', *g) for g in self.igen))
        pdta += _sub(b'shdr', shdr)
        # L'INFO d'origine annonce la version 2.01 ; un SF3 porte 3.0.
        info = self.info_raw
        idx = info.find(b'ifil')
        if idx >= 0:
            info = info[:idx + 8] + struct.pack('<HH', 3, 0) + info[idx + 12:]
        body = info
        body += _list(b'sdta', _sub(b'smpl', bytes(smpl)))
        body += _list(b'pdta', pdta)
        data = b'RIFF' + struct.pack('<I', 4 + len(body)) + b'sfbk' + body
        pathlib.Path(path).write_bytes(data)
        return len(data)


# ---------------------------------------------------------------------------
# Transformations du modèle

def used_samples(sf):
    used = set()
    for preset in sf.presets:
        for zone in preset['zones']:
            for izone in sf.instruments[zone['inst']]['zones']:
                for op, v in izone['gens']:
                    if op == GEN_SAMPLE_ID:
                        used.add(v)
    return used


def reduce_key_zones(sf, step):
    """Réduit le nombre de zones de clavier par preset.

    Pour chaque preset (sauf la banque 128, où chaque touche est un timbre
    distinct), on garde au plus une zone toutes les `step` touches (par
    défaut 18 demi-tons, soit 1,5 octave) dans chaque couche de vélocité et
    chaque couche d'instrument, puis on élargit la tessiture des zones
    gardées pour couvrir le même ambitus. La hauteur reste juste : le moteur
    transpose depuis la note d'origine de l'échantillon.
    """
    new_presets = []
    new_instruments = []
    for preset in sf.presets:
        if preset['bank'] == 128:
            # Percussion : chaque zone couvre une seule touche avec son
            # propre timbre ; élargir la tessiture changerait les sons.
            new_presets.append(dict(name=preset['name'], preset=preset['preset'],
                                    bank=preset['bank'], zones=preset['zones']))
            continue

        flat = []
        for pz_index, pz in enumerate(preset['zones']):
            pgens = dict(pz['gens'])
            for iz in sf.instruments[pz['inst']]['zones']:
                igens = dict(iz['gens'])
                if GEN_SAMPLE_ID not in igens:
                    continue
                key_lo, key_hi = unpack_range(igens.get(GEN_KEYRANGE, pack_range(0, 127)))
                pkey = unpack_range(pgens.get(GEN_KEYRANGE, pack_range(0, 127)))
                vel_lo, vel_hi = unpack_range(igens.get(GEN_VELRANGE, pack_range(0, 127)))
                pvel = unpack_range(pgens.get(GEN_VELRANGE, pack_range(0, 127)))
                key_lo, key_hi = max(key_lo, pkey[0]), min(key_hi, pkey[1])
                vel_lo, vel_hi = max(vel_lo, pvel[0]), min(vel_hi, pvel[1])
                if key_lo > key_hi:
                    continue
                flat.append(dict(pz=pz, pz_index=pz_index, inst_pz=iz,
                                 key_lo=key_lo, key_hi=key_hi,
                                 vel_lo=vel_lo, vel_hi=vel_hi,
                                 gens=[g for g in iz['gens']
                                       if g[0] not in (GEN_KEYRANGE, GEN_VELRANGE)]))

        groups = {}
        for z in flat:
            groups.setdefault((z['pz_index'], z['vel_lo'], z['vel_hi']), []).append(z)

        zones = []
        for (pz_index, vel_lo, vel_hi), zs in groups.items():
            lo = min(z['key_lo'] for z in zs)
            hi = max(z['key_hi'] for z in zs)
            span = hi - lo + 1
            keep = max(1, int(round(span / step)))
            keep = min(keep, len(zs), span)
            centers = [(z['key_lo'] + z['key_hi']) / 2 for z in zs]
            chosen = []
            for i in range(keep):
                target = lo + (i + 0.5) * span / keep
                ranked = sorted((abs(centers[j] - target), j)
                                for j in range(len(zs)) if j not in chosen)
                chosen.append(ranked[0][1])
            # Frontières au milieu de deux zones gardées : chaque touche
            # revient ainsi à l'échantillon dont la zone est la plus proche.
            chosen.sort(key=lambda j: centers[j])
            if keep == 1:
                cells = [(lo, hi)]
            else:
                cuts = [lo]
                for a, b in zip(chosen, chosen[1:]):
                    cuts.append(int(round((centers[a] + centers[b]) / 2)))
                cuts.append(hi + 1)
                for i in range(1, len(cuts) - 1):
                    cuts[i] = min(max(cuts[i], cuts[i - 1] + 1),
                                  hi - (len(cuts) - 1 - i) + 1)
                cells = [(cuts[i], cuts[i + 1] - 1) for i in range(len(cuts) - 1)]
            pz = zs[0]['pz']
            base_gens = [(op, v) for op, v in pz['gens']
                         if op not in (GEN_KEYRANGE, GEN_VELRANGE, GEN_INSTRUMENT)]
            for cell, j in zip(cells, chosen):
                z = zs[j]
                new_instruments.append(dict(
                    name=sf.instruments[z['pz']['inst']]['name'],
                    zones=[dict(gens=z['gens'], mods=z['inst_pz']['mods'])]))
                gens = list(base_gens)
                gens.append((GEN_KEYRANGE, pack_range(*cell)))
                gens.append((GEN_VELRANGE, pack_range(vel_lo, vel_hi)))
                zones.append(dict(gens=gens, inst=len(new_instruments) - 1))

        new_presets.append(dict(name=preset['name'], preset=preset['preset'],
                                bank=preset['bank'], zones=zones))

    # Les presets percussifs gardent leurs instruments d'origine : on les
    # recopie à la suite des instruments reconstruits.
    referenced = {}
    for preset in new_presets:
        if preset['bank'] != 128:
            continue
        for zone in preset['zones']:
            referenced.setdefault(zone['inst'], dict(
                name=sf.instruments[zone['inst']]['name'],
                zones=sf.instruments[zone['inst']]['zones']))
    instruments = list(new_instruments)
    remap = {old: len(instruments) + k for k, old in enumerate(sorted(referenced))}
    for old in sorted(referenced):
        instruments.append(referenced[old])
    for preset in new_presets:
        if preset['bank'] == 128:
            for zone in preset['zones']:
                zone['inst'] = remap[zone['inst']]
    sf.presets = new_presets
    sf.instruments = instruments


# ---------------------------------------------------------------------------
# Échantillons

def _lowpass_taps(cutoff, half=16):
    n = np.arange(-half, half + 1)
    cutoff = min(max(cutoff, 0.001), 0.5)
    h = 2 * cutoff * np.sinc(2 * cutoff * n) * np.hanning(2 * half + 3)[1:-1]
    return h / h.sum()


def resample(x, sr_in, sr_out):
    """Rééchantillonne un signal mono (float) par filtrage polyphase pour
    les rapports simples, par interpolation spectrale sinon."""
    if sr_in == sr_out or len(x) == 0:
        return x
    ratio = sr_out / sr_in
    n_out = max(1, int(round(len(x) * ratio)))
    g = math.gcd(int(sr_in), int(sr_out))
    up, down = int(sr_out // g), int(sr_in // g)
    if up <= 8:
        h = _lowpass_taps(0.5 * min(1.0, ratio) * 0.98, half=16 * up)
        upsampled = np.zeros(len(x) * up)
        upsampled[::up] = x
        y = np.convolve(upsampled, h * up)
        y = y[(len(h) // 2):][::down][:n_out]
        if len(y) < n_out:
            y = np.concatenate([y, np.zeros(n_out - len(y))])
        return y
    # Rapport quelconque (44642 → 22050, 22321 → 22050…) : interpolation
    # spectrale. Les échantillons sont courts, l'artefact de bordure est
    # inaudible.
    spectrum = np.fft.rfft(x.astype(np.float64))
    bins = n_out // 2 + 1
    out = np.zeros(bins, dtype=np.complex128)
    n = min(bins, len(spectrum))
    out[:n] = spectrum[:n]
    if n > 8:
        taper = np.ones(n)
        ramp = max(4, n // 20)
        taper[-ramp:] = 0.5 * (1 + np.cos(np.linspace(0, np.pi, ramp)))
        out[:n] *= taper
    out *= n_out / len(x)
    return np.fft.irfft(out, n_out)


def process_samples(sf, rate=None, tail_ms=None):
    """Extrait, transforme et réindexe les échantillons utilisés.

    `sf.shdr` indique des indices de points d'échantillonnage dans `smpl`,
    fin incluse, et des points de boucle absolus dans le même repère.
    """
    needed = used_samples(sf)
    all_frames = np.frombuffer(
        sf.smpl[:len(sf.smpl) // 2 * 2], dtype='<i2')
    new_samples = []
    remap = {}
    stats = dict(resampled=0, trimmed_loop=0, frames_in=0, frames_out=0,
                 tail_ms_max_before=0.0, tail_ms_saved=0.0)
    for old in sorted(needed):
        s = sf.shdr[old]
        n = s['end'] - s['start'] + 1
        frames = all_frames[s['start']:s['start'] + n].astype(np.float64)
        stats['frames_in'] += len(frames)
        looped = s['loopend'] > s['loopstart']
        loopstart = s['loopstart'] - s['start'] if looped else 0
        loopend = s['loopend'] - s['start'] if looped else 0
        if looped and (loopstart < 0 or loopend >= len(frames)):
            looped, loopstart, loopend = False, 0, 0
        if looped:
            stats['tail_ms_max_before'] = max(
                stats['tail_ms_max_before'],
                (len(frames) - 1 - loopend) / s['rate'] * 1000)
            if tail_ms is not None:
                keep = loopend + max(1, int(s['rate'] * tail_ms / 1000)) + 1
                if keep < len(frames):
                    stats['tail_ms_saved'] += (len(frames) - keep) / s['rate'] * 1000
                    frames = frames[:keep]
                    stats['trimmed_loop'] += 1
        if rate is not None and s['rate'] > rate:
            ratio = rate / s['rate']
            frames = resample(frames, s['rate'], rate)
            if looped:
                loopstart = int(round(loopstart * ratio))
                loopend = int(round(loopend * ratio))
            s = dict(s, rate=rate)
            stats['resampled'] += 1
        if looped:
            loopstart = max(0, min(loopstart, len(frames) - 2))
            loopend = max(loopstart + 1, min(loopend, len(frames) - 1))
        pcm = np.clip(np.round(frames), -32768, 32767).astype('<i2')
        stats['frames_out'] += len(pcm)
        remap[old] = len(new_samples)
        new_samples.append(dict(name=s['name'], rate=s['rate'], pcm=pcm,
                                looped=looped, loopstart=loopstart,
                                loopend=loopend, orig=s['orig'],
                                pitch=s['pitch']))
    sf.samples = new_samples
    for preset in sf.presets:
        for zone in preset['zones']:
            for izone in sf.instruments[zone['inst']]['zones']:
                for k, (op, v) in enumerate(izone['gens']):
                    if op == GEN_SAMPLE_ID:
                        izone['gens'][k] = (op, remap[v])
    return stats


def encode_ogg(pcm, rate, quality, serial):
    """Encode un signal mono 16 bits en Ogg Vorbis via oggenc.

    `serial` fixe le numéro de série du flux Ogg, ce qui rend la
    construction reproductible (oggenc en tire un au hasard sinon)."""
    proc = subprocess.run(
        ['oggenc', '-Q', '-r', '-B', '16', '-C', '1', '-R', str(rate),
         '-q', str(quality), '-s', str(serial), '-o', '-', '-'],
        input=np.asarray(pcm, dtype='<i2').tobytes(),
        capture_output=True)
    if proc.returncode != 0 or not proc.stdout.startswith(b'OggS'):
        raise SystemExit(f'oggenc a échoué : {proc.stderr.decode(errors="replace")}')
    return proc.stdout


# ---------------------------------------------------------------------------
# MIDI de test et rendus

def _vlq(value):
    out = bytearray([value & 0x7F])
    value >>= 7
    while value:
        out.insert(0, 0x80 | (value & 0x7F))
        value >>= 7
    return bytes(out)


def write_test_midi(path, ppq=480):
    """Gamme diatonique de C3 à C6 au piano, puis en Choir Aahs, Flute et
    Strings, puis quelques coups de batterie (canal 10)."""
    scale = [60 + n for n in (0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21,
                              23, 24, 26, 28, 29, 31, 33, 35, 36)]
    events = []
    step, length = 240, 190
    tick = 0
    for channel, program in enumerate((0, 52, 73, 48)):
        events.append((tick, bytes([0xC0 | channel, program])))
        tick += step
        for pitch in scale:
            events.append((tick, bytes([0x90 | channel, pitch, 90])))
            events.append((tick + length, bytes([0x80 | channel, pitch, 0])))
            tick += step
        tick += step * 2
    events.append((tick, bytes([0xC9, 0])))
    tick += step
    for pitch in (36, 38, 42, 42, 38, 46, 45, 47, 50, 42, 38, 36, 49):
        events.append((tick, bytes([0x99, pitch, 110])))
        events.append((tick + 120, bytes([0x89, pitch, 0])))
        tick += step
    track = bytearray()
    last = 0
    for pos, data in sorted(events, key=lambda e: (e[0], e[1][0] & 0xF0)):
        track.extend(_vlq(pos - last))
        track.extend(data)
        last = pos
    track.extend(b'\x00\xff\x2f\x00')
    header = b'MThd' + struct.pack('>IHHH', 6, 0, 1, ppq)
    pathlib.Path(path).write_bytes(
        header + b'MTrk' + struct.pack('>I', len(track)) + bytes(track))


def render(sf_path, midi_path, out_dir, wav_dir, name=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    wav_dir.mkdir(parents=True, exist_ok=True)
    name = name or pathlib.Path(sf_path).stem
    wav = wav_dir / (name + '.wav')
    subprocess.run(['fluidsynth', '-ni', '-F', str(wav), '-r', '44100',
                    str(sf_path), str(midi_path)],
                   check=True, capture_output=True)
    ogg = out_dir / (name + '.ogg')
    subprocess.run(['oggenc', '-Q', '-q', '4', '-o', str(ogg), str(wav)],
                   check=True, capture_output=True)
    return ogg, wav


# ---------------------------------------------------------------------------
# Construction

def build(variant, source_sf2, out_path, work=WORK, keep_sf2=False):
    spec = VARIANTS[variant]
    out_path = pathlib.Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf = SoundFont(source_sf2)
    if spec['zone_step']:
        reduce_key_zones(sf, spec['zone_step'])
    keeps_data = spec['rate'] or spec['tail_ms']
    stats = process_samples(sf, rate=spec['rate'], tail_ms=spec['tail_ms'])
    sf.commit_model()
    if keep_sf2:
        sf.write_sf2(work / f'TimGM6mb-{variant}.sf2')
    size = sf.write_sf3(out_path, spec['quality'])
    if not keeps_data:
        stats = None
    return pathlib.Path(out_path), stats


def gzip_size(path):
    return len(gzip.compress(pathlib.Path(path).read_bytes(), 9))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def fetch_source(cache):
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not cache.exists():
        print(f'Téléchargement de {SOURCE_URL}')
        urllib.request.urlretrieve(SOURCE_URL, cache)
    digest = sha256_file(cache)
    if digest != SOURCE_SHA256:
        raise SystemExit(f'{cache} : sha256 {digest} != {SOURCE_SHA256}')
    with tarfile.open(cache, 'r:gz') as tar:
        with tar.extractfile(SF2_MEMBER) as src:
            data = src.read()
    if hashlib.sha256(data).hexdigest() != SF2_SHA256:
        raise SystemExit('TimGM6mb.sf2 : empreinte inattendue')
    sf2 = cache.parent / 'TimGM6mb.sf2'
    sf2.write_bytes(data)
    return sf2


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--variant', action='append', default=[],
                        help='variante à construire (répétable) ; défaut : ' + DEFAULT_VARIANT)
    parser.add_argument('--all', action='store_true', help='toutes les variantes')
    parser.add_argument('--out', type=pathlib.Path, default=DEFAULT_OUT,
                        help='chemin du SF3 produit pour la variante par défaut')
    parser.add_argument('--render', action='store_true',
                        help='produire les rendus .ogg de test dans .tmp-sf/rendus/')
    parser.add_argument('--render-source', action='store_true',
                        help='rendre aussi le SF2 d’origine, comme référence')
    parser.add_argument('--source', type=pathlib.Path,
                        help='TimGM6mb.sf2 déjà téléchargé')
    parser.add_argument('--keep-sf2', action='store_true',
                        help='conserver les SF2 intermédiaires (inspection)')
    parser.add_argument('--work', type=pathlib.Path, default=WORK)
    args = parser.parse_args(argv)
    work = args.work
    work.mkdir(parents=True, exist_ok=True)

    if args.source:
        source = args.source
        if sha256_file(source) != SF2_SHA256:
            raise SystemExit(f'{source} : empreinte inattendue')
    else:
        source = fetch_source(work / 'timgm6mb-soundfont_1.3.orig.tar.gz')

    variants = list(VARIANTS) if args.all else (args.variant or [DEFAULT_VARIANT])
    explicit_out = args.out != DEFAULT_OUT
    for name in variants:
        if name not in VARIANTS:
            raise SystemExit(f'variante inconnue : {name}')

    midi = None
    if args.render or args.render_source:
        midi = work / 'test.mid'
        write_test_midi(midi)
    if args.render_source:
        ogg, _ = render(source, midi, ROOT / '.tmp-sf' / 'rendus', work / 'wav',
                        name='TimGM6mb-original')
        print(f'référence SF2 : {ogg.relative_to(ROOT)}')

    rows = []
    for name in variants:
        if explicit_out:
            dest = args.out
        elif args.all or name != DEFAULT_VARIANT:
            dest = work / 'variantes' / f'TimGM6mb-{name}.sf3'
        else:
            dest = args.out
        sf3, stats = build(name, source, dest, work=work, keep_sf2=args.keep_sf2)
        raw = sf3.stat().st_size
        gz = gzip_size(sf3)
        rows.append((name, raw, gz, VARIANTS[name]))
        print(f'{name:16s} {raw/1e6:7.3f} Mo  gzip {gz/1e6:7.3f} Mo', end='')
        if stats:
            print(f'  ({stats["frames_out"]/stats["frames_in"]*100:.0f} % des '
                  f'échantillons, {stats["resampled"]} rééchantillonnés)')
        else:
            print()
        if args.render:
            ogg, _ = render(sf3, midi, ROOT / '.tmp-sf' / 'rendus', work / 'wav',
                            name=f'TimGM6mb-{name}')
            print(f'  rendu : {ogg.relative_to(ROOT)}')

    print()
    print('| variante | brute | gzip | zones | rééchantillonnage | queue | qualité |')
    print('|---|---|---|---|---|---|---|')
    for name, raw, gz, spec in rows:
        print(f'| {name} | {raw/1e6:.2f} Mo | {gz/1e6:.2f} Mo | '
              f'{spec["zone_step"] or "—"} | {spec["rate"] or "—"} | '
              f'{spec["tail_ms"] or "—"} | {spec["quality"]} |')
    return 0


if __name__ == '__main__':
    sys.exit(main())
