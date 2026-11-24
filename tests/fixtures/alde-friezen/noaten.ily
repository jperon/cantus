% noaten.ily: noaten en tekst fan De âlde Friezen, dield troch
% partituer.ly (it blêd en de MIDI) en fideo.ly (de fideo).
% Tekst: Eeltsje Halbertsma / Jacobus van Loon (1876); melody: Heinrich
% Christian Schnoor. Setwurk: Erik Nijenhuis, 2026, CC0 1.0.
% Boarne fan de tekst: de ferzje Halbertsma/Van Loon op
% https://nl.wikipedia.org/wiki/Fries_volkslied ("De Alde Friezen, versie
% Halbertsma/Van Loon").

% --- muzyk ------------------------------------------------

kuplet = \fixed c' {    % absolút: sûnder teken tusken c' en b'
  \time 4/4             % ek by de werhelling: werom fan 3/8 nei 4/4
  \tempo 4 = 96         % allinne foar de MIDI (op it blêd ferburgen)
  \partial 4.
  d8 d8 d8 |
  g4. fis8 e d c b, |
  e4 d r8 b b b |
  b8[ a] c'[ a] g4 fis4 |  % troch en ús: de balke makket it melisma (autoBeamOff)
  g2 r8 g g b |
  a4. a8 a g fis e |
  g4 fis r8 a g fis |
  b8[ fis] g[ e] d4 fis8[ e] |
  \time 3/8              % de maat op "rom" is al de earste fan it refrein
  \tempo 4 = 48          % refrein: de achtste krijt de slach fan de kwart yn it kuplet
  d4 r8 | \break
}

refrein = \fixed c' {
  % refrein yn 3/8
  b8. a16 b8 |
  g a b |
  c'8. b16 c'8 |
  a4. |
  d'8. e'16 d'8 |
  d'8 c' b |
  a[ g] fis |
  <<
    { \voiceOne g4 r8 }
    \tag #'partituer
    \new CueVoice { \voiceTwo g16[ d e fis g a] }  % opsjonele fersiering
  >> \oneVoice |
  b8. a16 b8 |
  g a b |
  c'8. b16 c'8 |
  a4. |
  d'8. e'16 d'8 |
  d'8 c' b |
  a[ g] fis |
  g4 r8 |
}

% --- tekst ------------------------------------------------

kupletIen = \lyricmode {
  Frysk bloed tsjoch op! Wol no ris brû -- ze~en sie -- de,
  En bûn -- zje troch ús ie -- ren om!
  Flean op! Wy sjon -- ge~it bês -- te lân fan d'ier -- de.
  It Frys -- ke lân fol ea -- re~en rom.
}

kupletTwa = \lyricmode {
  Hoe ek fan oer -- macht, need en see be -- trut -- sen,
  Oer -- âl -- de, lea -- ve Frys -- ke grûn!
  Nea waard dy fês -- te, taai -- e bân fer -- brut -- sen,
  Dy't Frie -- zen oan har lân fer -- bûn.
}

kupletTrije = \lyricmode {
  Fan bûg -- jen frjemd, bleau by~'t âld folk yn ea -- re,
  Syn nam -- me~en taal, syn frij -- e sin;
  Syn wurd wie wet; rjocht, sljocht en trou syn lea -- re,
  En twang, fan wa ek, stie it tsjin.
}

kupletFjouwer = \lyricmode {
  Troch -- lof -- tich folk fan diz -- ze âl -- de nam -- me,
  Wês jim -- mer op dy âld -- ers great!
  Bliuw iv -- ich fan dy gri -- ze, he -- ge stam -- me.
  In grien, in krêf -- tich bloei -- end leat!
}

refreinTekst = \lyricmode {
  Klink dan en da -- ver -- je fier yn it rûn.
  Dyn âl -- de ea -- re, o Frys -- ke grûn!
  Klink dan en da -- ver -- je fier yn it rûn.
  Dyn âl -- de ea -- re, o Frys -- ke grûn!
}

% --- it gehiel --------------------------------------------

muzyk = {
  \key g \major
  \autoBeamOff  % fokale notaasje: losse flaggen per wurdlid
  \repeat volta 4 { \kuplet \refrein }  % oantal kûpletten
  \bar "|."
}
