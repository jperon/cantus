\version "2.24.0"
\header { title = "Petit essai" }

melody = \relative c' {
  \key g \major
  \time 4/4
  g4 a b c | d2 b2 | c4 b a g | a1 |
  \bar "|."
}

\score {
  <<
    \new Staff <<
      \new Voice = "mel" { \melody }
      \addlyrics { Ve -- ni Cre -- a -- tor spi -- ri -- tus }
    >>
  >>
  \layout { }
}
