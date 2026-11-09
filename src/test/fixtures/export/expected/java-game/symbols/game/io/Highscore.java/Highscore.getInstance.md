# game/io/Highscore.java::Highscore.getInstance

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
game/io/Highscore.java::Highscore.getInstance
  where: game/io/Highscore.java:14
  language: java
  class: Highscore

Called by (2):
- game/Player.java::Player.constructor  L12  ←0 →2
- game/Player.java::Player.update  L18  ←0 →9

Calls: none in the graph.

Signature: public static Highscore getInstance()
Body: lines 14-14
Javadoc: none

## Callers within depth 2

2 function(s) within depth 2 call game/io/Highscore.java::Highscore.getInstance:

depth 1:
- game/Player.java::Player.constructor  L12  ←0 →2
- game/Player.java::Player.update  L18  ←0 →9

## Callees within depth 2 (with libraries)

game/io/Highscore.java::Highscore.getInstance calls nothing that the analysis resolved.

## Impact

Changing game/io/Highscore.java::Highscore.getInstance (1 function(s)) can affect 2 caller(s) in 1 file(s), up to 1 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Player.java  2 fn, 1 hop(s)

Entry points on these call chains (nothing calls them) (2):
- game/Player.java::Player.constructor  L12  ←0 →2
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (2 of 2):
- game/Player.java::Player.constructor  L12  ←0 →2  1 hop(s)
- game/Player.java::Player.update  L18  ←0 →9  1 hop(s)

## Call sites (0)

none
