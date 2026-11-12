# game/io/Highscore.java::Highscore.save

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
game/io/Highscore.java::Highscore.save
  where: game/io/Highscore.java:16
  language: java
  class: Highscore

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

Signature: public boolean save(int points)
Body: lines 16-30
Javadoc: none
Static fields read (1):
- Constants.SAVE_URL  (String = "http://example.org/save.php")

## Callers within depth 2

1 function(s) within depth 2 call game/io/Highscore.java::Highscore.save:

depth 1:
- game/Player.java::Player.update  L18  ←0 →9

## Callees within depth 2 (with libraries)

10 function(s) within depth 2 are called by game/io/Highscore.java::Highscore.save:

depth 1:
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

## Impact

Changing game/io/Highscore.java::Highscore.save (1 function(s)) can affect 1 caller(s) in 1 file(s), up to 1 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Player.java  1 fn, 1 hop(s)

Entry points on these call chains (nothing calls them) (1):
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (1 of 1):
- game/Player.java::Player.update  L18  ←0 →9  1 hop(s)

## Call sites (10)

- L18  new URL(Constants.SAVE_URL)  [-> library::java.net.URL::<init>]
- L19  url.openConnection()  [-> library::java.net.URL::openConnection]
- L20  new DataOutputStream(conn.getOutputStream())  [-> library::java.io.DataOutputStream::<init>]
- L20  conn.getOutputStream()  [-> library::java.net.URLConnection::getOutputStream]
- L21  out.writeBytes("points=" + points)  [-> library::java.io.DataOutputStream::writeBytes]
- L22  out.close()  [-> library::java.io.DataOutputStream::close]
- L23  new FileWriter(file)  [-> library::java.io.FileWriter::<init>]
- L24  w.write(String.valueOf(points))  [-> library::java.io.FileWriter::write]
- L24  String.valueOf(points)  [-> library::java.lang.String::valueOf]
- L25  w.close()  [-> library::java.io.FileWriter::close]
