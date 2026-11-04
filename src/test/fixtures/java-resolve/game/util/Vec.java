package game.util;

public class Vec {
    public float x, y;

    public Vec(float x, float y) { this.x = x; this.y = y; }

    public Vec() { this(0, 0); }

    public Vec add(Vec o) { return new Vec(x + o.x, y + o.y); }

    public float len() { return (float) Math.sqrt(x * x + y * y); }

    public static Vec zero() { return new Vec(); }
}
