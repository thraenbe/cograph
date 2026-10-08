#!/usr/bin/env python3
"""Render a demo take (uxtest/vscode/demo.spec.ts) into demo.mp4 + demo.gif.

The screencast only emits frames on change, so frames are laid on a constant 30 fps timeline (latest frame <= t),
and a cursor is drawn at the logged pointer position (the OS cursor is not in the capture).
Usage: demo-render.py <take dir> [--gif-width 960] [--gif-fps 10] [--crf 23] [--trim-start s] [--trim-end s]
"""
import argparse, json, os, shutil, subprocess, sys, tempfile
from bisect import bisect_right
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument('take')
ap.add_argument('--gif-width', type=int, default=960)
ap.add_argument('--gif-fps', type=int, default=10)
ap.add_argument('--gif-colors', type=int, default=128)
ap.add_argument('--crf', type=int, default=23)
ap.add_argument('--width', type=int, default=1440, help='mp4 width')
ap.add_argument('--trim-start', type=float, default=0.0)
ap.add_argument('--trim-end', type=float, default=0.0)
ap.add_argument('--out', default=None)
ap.add_argument('--crop169', action='store_true', help='centre-crop the frame to 16:9 (the window manager may clamp the window to 16:10)')
ap.add_argument('--gif-cut', nargs=2, type=float, metavar=('START', 'DUR'), default=None, help='GIF only: the highlight cut, seconds into the take')
ap.add_argument('--mp4-segments', default=None, help='edit list for the mp4, seconds into the take: "0.5-11,17.2-38,..." (cuts dead time)')
ap.add_argument('--gif-segments', default=None, help='edit list for the GIF hero (same form); overrides --gif-cut')
ap.add_argument('--pin-colors', default='255,150,0;79,167,78;229,83,75',
                help='colours that must survive the GIF palette (legend: modified orange, new green, deleted red); "" for none')
a = ap.parse_args()

take = json.load(open(os.path.join(a.take, 'take.json')))
frames = sorted(take['frames'], key=lambda f: f['t'])
ptr = sorted(take['pointer'], key=lambda p: p['t'])
vw = take['viewport']['w']
first = Image.open(os.path.join(a.take, 'frames', frames[0]['file']))
scale = first.width / vw                      # screencast px per CSS px
t0 = frames[0]['t'] + a.trim_start
t1 = frames[-1]['t'] - a.trim_end
ftimes = [f['t'] for f in frames]
ptimes = [p['t'] for p in ptr]

ARROW = [(0, 0), (0, 17), (4.5, 13), (7.5, 20), (10, 19), (7, 12.5), (12.5, 12.5)]
def cursor(draw, x, y, down, k):
    pts = [(x + px * k, y + py * k) for px, py in ARROW]
    if down:
        r = 13 * k
        draw.ellipse([x - r, y - r, x + r, y + r], outline=(255, 210, 80), width=max(2, int(2.5 * k)))
    draw.polygon(pts, fill=(255, 255, 255), outline=(0, 0, 0))

def pointer_at(t):
    i = bisect_right(ptimes, t) - 1
    if i < 0: return ptr[0]['x'], ptr[0]['y'], False
    if i >= len(ptr) - 1: return ptr[-1]['x'], ptr[-1]['y'], ptr[-1]['down']
    p, q = ptr[i], ptr[i + 1]
    k = 0 if q['t'] == p['t'] else (t - p['t']) / (q['t'] - p['t'])
    return p['x'] + (q['x'] - p['x']) * k, p['y'] + (q['y'] - p['y']) * k, p['down']

tmp = tempfile.mkdtemp(prefix='demo-render-')
FPS = 30
n = int((t1 - t0) * FPS)
cache = {}
for i in range(n):
    t = t0 + i / FPS
    j = max(0, bisect_right(ftimes, t) - 1)
    fn = frames[j]['file']
    if fn not in cache:
        cache.clear(); cache[fn] = Image.open(os.path.join(a.take, 'frames', fn)).convert('RGB')
    im = cache[fn].copy()
    x, y, down = pointer_at(t)
    cursor(ImageDraw.Draw(im), x * scale, y * scale, down, scale * 1.15)
    im.save(os.path.join(tmp, f'{i:05d}.png'), compress_level=1)

out = a.out or a.take
mp4 = os.path.join(out, 'demo.mp4'); gif = os.path.join(out, 'demo.gif'); pal = os.path.join(tmp, 'pal.png')
run = lambda *c: subprocess.run(c, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
crop = 'crop=iw:trunc(iw*9/16/2)*2:0:(ih-iw*9/16)/2,' if a.crop169 else ''
run('ffmpeg', '-y', '-framerate', str(FPS), '-i', os.path.join(tmp, '%05d.png'),
    '-vf', f'{crop}scale={a.width}:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', str(a.crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4)
vf = f'fps={a.gif_fps},scale={a.gif_width}:-1:flags=lanczos'
cut = ['-ss', str(a.gif_cut[0]), '-t', str(a.gif_cut[1])] if a.gif_cut else []
# Small, rare colours (the legend dots) lose the vote in palettegen and come out grey: build the palette with room
# to spare, then write those colours into the last entries so they are always available to paletteuse.
pins = [tuple(int(v) for v in c.split(',')) for c in a.pin_colors.split(';') if c.strip()]
run('ffmpeg', '-y', *cut, '-i', mp4, '-vf', f'{vf},palettegen=max_colors={a.gif_colors - len(pins)}:stats_mode=diff', pal)
if pins:
    pim = Image.open(pal).convert('RGB'); px = pim.load(); W = pim.width
    for k, c in enumerate(pins):
        i = a.gif_colors - len(pins) + k; px[i % W, i // W] = c
    pim.save(pal)
run('ffmpeg', '-y', *cut, '-i', mp4, '-i', pal, '-lavfi', f'{vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif)
def select(segs):
    parts = '+'.join(f'between(t,{a},{b})' for a, b in (tuple(map(float, x.split('-'))) for x in segs.split(',')))
    return f"select='{parts}',setpts=N/FRAME_RATE/TB"
if a.mp4_segments:   # re-cut the full mp4 into the edited one; the full take stays as demo-full.mp4
    full = os.path.join(out, 'demo-full.mp4'); os.replace(mp4, full)
    run('ffmpeg', '-y', '-i', full, '-vf', select(a.mp4_segments), '-c:v', 'libx264', '-preset', 'slow', '-crf', str(a.crf),
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4)
if a.gif_segments:
    src = os.path.join(out, 'demo-full.mp4') if a.mp4_segments else mp4
    vfs = f"fps={a.gif_fps},{select(a.gif_segments)},scale={a.gif_width}:-1:flags=lanczos"
    run('ffmpeg', '-y', '-i', src, '-vf', f'{vfs},palettegen=max_colors={a.gif_colors - len(pins)}:stats_mode=diff', pal)
    if pins:
        pim = Image.open(pal).convert('RGB'); px = pim.load(); W = pim.width
        for k, c in enumerate(pins):
            i = a.gif_colors - len(pins) + k; px[i % W, i // W] = c
        pim.save(pal)
    run('ffmpeg', '-y', '-i', src, '-i', pal, '-lavfi', f'[0:v]{vfs}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif)
shutil.rmtree(tmp)
probe = lambda p: float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True).stdout or 0)
mb = lambda p: os.path.getsize(p) / 1048576
print(json.dumps({'take_s': round(n / FPS, 1), 'source_frames': len(frames), 'mp4': mp4, 'mp4_s': round(probe(mp4), 1), 'mp4_MiB': round(mb(mp4), 2),
                  'gif': gif, 'gif_s': round(probe(gif), 1), 'gif_MiB': round(mb(gif), 2), 'gif_settings': {'width': a.gif_width, 'fps': a.gif_fps, 'colors': a.gif_colors}}))
