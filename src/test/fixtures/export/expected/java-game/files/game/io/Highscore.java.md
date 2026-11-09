# game/io/Highscore.java

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).

## Classes

### game/io/Highscore.java::Highscore  (class, lines 10-31)
Declaration: package game.io; public class Highscore
Methods: 2
Fields (2):
- L11 private static Highscore instance = new Highscore()
- L12 private final String file = "highscore.txt"
String literals naming a URL, an asset or a file (1):
- L12 asset "highscore.txt"

## Functions

game/io/Highscore.java: 2 function(s) in 1 file(s).
Languages: java 2.

Functions (id, line, ←callers →callees):
- game/io/Highscore.java::Highscore.getInstance  L14  ←2 →0
- game/io/Highscore.java::Highscore.save  L16  ←1 →10

### game/io/Highscore.java::Highscore.getInstance

Called by (2):
- game/Player.java::Player.constructor  L12  ←0 →2
- game/Player.java::Player.update  L18  ←0 →9

Calls (0):
none

### game/io/Highscore.java::Highscore.save

Called by (1):
- game/Player.java::Player.update  L18  ←0 →9

Calls (10):
- library::java.io.DataOutputStream::<init>  (library java.io.DataOutputStream)  ←1 →0
- library::java.io.DataOutputStream::close  (library java.io.DataOutputStream)  ←1 →0
- library::java.io.DataOutputStream::writeBytes  (library java.io.DataOutputStream)  ←1 →0
- library::java.io.FileWriter::<init>  (library java.io.FileWriter)  ←1 →0
- library::java.io.FileWriter::close  (library java.io.FileWriter)  ←1 →0
- library::java.io.FileWriter::write  (library java.io.FileWriter)  ←1 →0
- library::java.lang.String::valueOf  (library java.lang.String)  ←1 →0
- library::java.net.URL::<init>  (library java.net.URL)  ←1 →0
- library::java.net.URL::openConnection  (library java.net.URL)  ←1 →0
- library::java.net.URLConnection::getOutputStream  (library java.net.URLConnection)  ←1 →0
