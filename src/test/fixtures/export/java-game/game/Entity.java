package game;

/** Something on the board. */
public abstract class Entity {
  protected int x;
  protected int y;

  public Entity(int x, int y) { this.x = x; this.y = y; }

  public void move(int dx) { x = clamp(x + dx); }

  public void move(int dx, int dy) { move(dx); y = clamp(y + dy); }

  int clamp(int v) { return Math.max(0, Math.min(v, Constants.WIDTH)); }

  public abstract void update();
}
