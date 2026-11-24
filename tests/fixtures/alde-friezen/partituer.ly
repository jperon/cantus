% partituer.ly: De âlde Friezen kompleet: kûplet en refrein mei
% werhelling; de kûpletten ûnder inoar, it refrein ien kear.
% Tekst: Eeltsje Halbertsma / Jacobus van Loon (1876); melody: Heinrich
% Christian Schnoor. Beide frij fan rjochten. Stavering neffens
% Halbertsma/Van Loon (net dy fan 2015).
%
% De wurdlidden fan it earste kûplet komme út de Fryske ôfbrekpatroanen
% (fryskhyph, links=2, rjochts=2): brû-ze sie-de bûn-zje ie-ren. Foar de
% histoaryske stavering net blyn op de patroanen fertrouwe.
% "brûze en": -ze en en falle gear op ien achtste; de tilde set se mei in
% ferbiningsbôgje (‿) ûnder ien noat.
%
% Noaten en tekst steane yn noaten.ily (ek brûkt troch fideo.ly).
% Setwurk: Erik Nijenhuis, 2026, CC0 1.0.
% Bouwe: make (sjoch README.md).

\version "2.24.0"

\include "noaten.ily"

\score {
  <<
    \new Voice = "melody" { \muzyk }
    \new Lyrics \lyricsto "melody" {
      \set stanza = "1." \kupletIen \refreinTekst
    }
    \new Lyrics \lyricsto "melody" {
      \set stanza = "2." \kupletTwa
    }
    \new Lyrics \lyricsto "melody" {
      \set stanza = "3." \kupletTrije
    }
    \new Lyrics \lyricsto "melody" {
      \set stanza = "4." \kupletFjouwer
    }
  >>
  \layout {
    \omit Score.BarNumber
    \omit Score.MetronomeMark
    \override Score.LyricHyphen.minimum-distance = #1.2  % keppeltekens altyd sichtber
  }
}

% Allinne foar it lûd: werhellingen útskreaun, gjin papier.
\score {
  \unfoldRepeats \removeWithTag #'partituer { \muzyk }  % sûnder de opsjonele fersiering
  \midi { }  % de tempo's steane yn de muzyk
}
