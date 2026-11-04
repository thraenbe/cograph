package game;

/** Same method names as Player/Entity/Vec in an unrelated class: name-only linking would hit these. */
public class Hud {
    public void update() { }

    public void move(game.util.Vec d) { }

    public float len() { return 0f; }

    public void use(Player p) { }
}
