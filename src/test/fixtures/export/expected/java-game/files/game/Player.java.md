# game/Player.java

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).

## Classes

### game/Player.java::Player  (class, lines 7-34)
Declaration: package game; public class Player extends Entity
Methods: 3
Fields (3):
- L8 private final List<Item> items = new ArrayList<Item>()
- L9 private Highscore score
- L10 private int points

## Functions

game/Player.java: 3 function(s) in 1 file(s).
Languages: java 3.

Functions (id, line, ←callers →callees):
- game/Player.java::Player.constructor  L12  ←0 →2
- game/Player.java::Player.update  L18  ←0 →9
- game/Player.java::Player.addPoints  L33  ←1 →0

### game/Player.java::Player.constructor

Called by (0):
none

Calls (2):
- game/Entity.java::Entity.constructor  L8  ←1 →0
- game/io/Highscore.java::Highscore.getInstance  L14  ←2 →0

### game/Player.java::Player.update

Called by (0):
none

Calls (9):
- library::java.lang.Runnable::run  (library java.lang.Runnable)  ←1 →0
- library::java.lang.Thread::start  (library java.lang.Thread)  ←1 →0
- library::java.util.List::forEach  (library java.util.List)  ←1 →0
- library::java.util.List::get  (library java.util.List)  ←1 →0
- library::java.util.List::size  (library java.util.List)  ←1 →0
- game/Entity.java::Entity.move:12  L12  ←1 →2
- game/Item.java::Item.use  L8  ←1 →1
- game/io/Highscore.java::Highscore.getInstance  L14  ←2 →0
- game/io/Highscore.java::Highscore.save  L16  ←1 →10

### game/Player.java::Player.addPoints

Called by (1):
- game/Item.java::Item.use  L8  ←1 →1

Calls (0):
none
