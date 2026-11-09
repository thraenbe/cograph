package game.io;

import game.Constants;
import java.io.DataOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.net.URL;
import java.net.URLConnection;

public class Highscore {
  private static Highscore instance = new Highscore();
  private final String file = "highscore.txt";

  public static Highscore getInstance() { return instance; }

  public boolean save(int points) {
    try {
      URL url = new URL(Constants.SAVE_URL);
      URLConnection conn = url.openConnection();
      DataOutputStream out = new DataOutputStream(conn.getOutputStream());
      out.writeBytes("points=" + points);
      out.close();
      FileWriter w = new FileWriter(file);
      w.write(String.valueOf(points));
      w.close();
      return true;
    } catch (IOException e) {
      return false;
    }
  }
}
