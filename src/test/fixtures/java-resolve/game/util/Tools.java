package game.util;

public final class Tools {
    public static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    public static float clamp(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

    public static String name(Object o) { return String.valueOf(o); }

    public static String name(String s) { return s.trim(); }
}
