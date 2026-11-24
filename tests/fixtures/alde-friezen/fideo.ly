% fideo.ly: De âlde Friezen foar de fideo (mei ly2video): alle fjouwer
% kûpletten útskreaun, elk mei it refrein, sadat it byld gelyk rint mei de
% MIDI. De opsjonele fersiering stiet der as twadde (lytse) stim by en
% klinkt ek mei.
% Noaten en tekst: noaten.ily.
\version "2.24.3"

% Skriuwt elk note-event mei syn momint nei fideo-events.tsv, sadat
% ly2video krekt wit wannear't elke noat klinkt. It bestân komt mei
% ly2video mei; de Makefile jout it sykpaad troch mei
% -I "$(ly2video --include-path)". It moat foar de \score komme.
\include "ly2video-events.ily"

\include "noaten.ily"

\header {
  % ûnder inoar: op 90 mm breed passe tekst en melody net neist inoar
  title       = "De âlde Friezen"
  subtitle    = \markup \normal-text \fontsize #-4
                "Tekst: Eeltsje Halbertsma / Jacobus van Loon (1876)"
  subsubtitle = \markup \normal-text \fontsize #-2
                "Melody: Heinrich Christian Schnoor"
  copyright   = \markup \fontsize #-2 \center-column {
    "Set troch Erik Nijenhuis, 2026."
    "Frij te brûken, te feroarjen en te dielen: CC0 1.0"
  }
  tagline = ##f   % gjin "Music engraving by LilyPond" ûnderoan
}

\paper {
  % telefoanformaat, 9:16
  paper-width  = 90\mm
  paper-height = 160\mm
  left-margin   = 5\mm
  right-margin  = 5\mm
  top-margin    = 5\mm
  bottom-margin = 5\mm

  print-page-number = ##f   % gjin sidenûmers yn de fideo
  property-defaults.fonts.serif = "Linux Libertine O"
}

\layout {
  % De tekstrigels bepale de horizontale ôfstân. Op dit smelle papier
  % rinne se oars bûten de side; in stap lytser hâldt se binnen de marzjes.
  \context {
    \Lyrics
    \override LyricText.font-size = #-1
  }
}

\score {
  <<
    \new Voice = "melody" {
      \unfoldRepeats { \muzyk }
    }
    \new Lyrics \lyricsto "melody" {
      \kupletIen \refreinTekst
      \kupletTwa \refreinTekst
      \kupletTrije \refreinTekst
      \kupletFjouwer \refreinTekst
    }
  >>
  \layout {
    \omit Score.BarNumber
    \omit Score.MetronomeMark
    \override Score.LyricHyphen.minimum-distance = #1.2
  }
  \midi { }
}
