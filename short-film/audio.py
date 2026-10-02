"""从无到有 · GENESIS —— 30 秒配乐 / 音效（纯合成，无采样）

时间线与 film.html 严格对齐：
  0.8~8.5   心跳（逐渐加速）+ 升调 + 噪声上扬
  8.70~9.00 彻底静音（屏幕上只剩一个点）
  9.0       BANG：次声重击 + 黄铜低吼 + 爆裂 + 混响
  9~28      Dm → Bb → Gm → A → 静 → D 大调（皮卡第三度）
  19~23.5   变焦穿越：加速的鼓点 + 白噪声上扬
  24.8~27.6 只剩一个高音 + 三下很轻的心跳（呼应开场）
  28.0      标题：低音重击 + 长混响，29.5 起淡出
"""
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100
DUR = 30.0
N = int(SR * DUR)
rng = np.random.default_rng(2026)
T = np.arange(N) / SR


def mono():
    return np.zeros(N)


def add(buf, sig, t0, gain=1.0):
    i = int(t0 * SR)
    if i >= N:
        return
    seg = sig[: N - i]
    buf[i:i + len(seg)] += seg * gain


def env_ad(n, a, tau):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / tau)


def noise(n):
    return rng.standard_normal(n)


def lp(x, fc, order=2):
    return signal.sosfilt(signal.butter(order, min(fc, SR * 0.45), 'low', fs=SR, output='sos'), x)


def hp(x, fc, order=2):
    return signal.sosfilt(signal.butter(order, fc, 'high', fs=SR, output='sos'), x)


def sweep_noise(t0, t1, f0, f1, curve=1.0):
    """带通噪声，中心频率指数扫频"""
    n = int((t1 - t0) * SR)
    x = noise(n)
    out = np.zeros(n)
    blk = 1024
    zi = None
    for i in range(0, n, blk):
        u = (i / n) ** curve
        fc = f0 * (f1 / f0) ** u
        sos = signal.butter(2, [fc * 0.6, min(fc * 1.6, SR * 0.45)], 'band', fs=SR, output='sos')
        if zi is None:
            zi = np.zeros((sos.shape[0], 2))
        y, zi = signal.sosfilt(sos, x[i:i + blk], zi=zi)
        out[i:i + blk] = y
    return out


def reverb(x, rt=3.2, wet=1.0, damp=3500):
    n = int(rt * SR)
    t = np.arange(n) / SR
    irs = []
    for _ in range(2):
        ir = noise(n) * np.exp(-t / (rt / 6.9))
        ir = lp(ir, damp, 1)
        ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
        irs.append(ir / np.sqrt(np.sum(ir ** 2)))
    L = signal.fftconvolve(x, irs[0])[:N]
    Rr = signal.fftconvolve(x, irs[1])[:N]
    return np.stack([L, Rr], 1) * wet


def midi(m):
    return 440 * 2 ** ((m - 69) / 12)


# ============================================================
# 心跳 —— 与 film.html 同一个公式
# ============================================================
beats = []
tb, iv = 0.8, 1.05
while tb < 8.45:
    beats.append(tb)
    tb += iv
    iv = max(0.26, iv * 0.88)


def thud(gain=1.0, f0=110, f1=44, length=0.6):
    n = int(length * SR)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * env_ad(n, 0.003, 0.14)
    click = lp(noise(n), 900) * env_ad(n, 0.001, 0.012) * 0.5
    return (body + click) * gain


dry = mono()           # 不过混响的干声
wetbus = mono()        # 送混响

for k, b in enumerate(beats):
    g = 0.30 + 0.70 * (b / 8.5)
    add(dry, thud(g), b)
    add(wetbus, thud(g * 0.5), b)

# ---- 次声底噪（缓慢增强） ----
drone_env = np.clip((T - 1.0) / 7.5, 0, 1) ** 2 * (T < 8.70)
drone = (np.sin(2 * np.pi * 36.7 * T) * 0.5 + np.sin(2 * np.pi * 73.4 * T + 0.3) * 0.18
         + np.sin(2 * np.pi * 55.0 * T) * 0.2) * drone_env
dry += drone * 0.55

# ---- Shepard-Risset 升调（无限上升的错觉） ----
sh = mono()
t0, t1 = 2.5, 8.62
mask = (T >= t0) & (T < t1)
u = (T[mask] - t0) / (t1 - t0)
for j in range(7):
    f = 55 * 2 ** (u * 3.0 + j)
    ph = 2 * np.pi * np.cumsum(f) / SR
    amp = np.exp(-0.5 * (np.log2(f / 700) / 1.25) ** 2)
    sh[mask] += np.sin(ph) * amp
sh *= np.clip((T - t0) / 2.0, 0, 1) ** 1.5 * 0.16
dry += sh

# ---- 噪声上扬 ----
rn = sweep_noise(4.0, 8.62, 250, 9500, 1.4)
renv = (np.arange(len(rn)) / len(rn)) ** 2.2
add(dry, rn * renv, 4.0, 0.9)

# ---- 针尖般的高音（越来越尖） ----
mask = (T >= 5.5) & (T < 8.62)
u = (T[mask] - 5.5) / 3.12
ph = 2 * np.pi * np.cumsum(900 * 2 ** (u * 1.6)) / SR
tin = mono()
tin[mask] = np.sin(ph) * u ** 2 * 0.07
dry += tin

# ---- 静音门：8.62 淡出 → 9.00 才重新进入 ----
gate = np.ones(N)
gate[(T >= 8.62) & (T < 8.70)] = np.linspace(1, 0, ((T >= 8.62) & (T < 8.70)).sum())
gate[(T >= 8.70) & (T < 9.0)] = 0
dry *= gate
wetbus *= gate

# ============================================================
# BANG
# ============================================================
tb0 = 9.0
n = int(6 * SR)
t = np.arange(n) / SR
# 次声重击
f = 28 + 60 * np.exp(-t / 0.18)
boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ad(n, 0.002, 1.5)
# 爆裂
crack = hp(noise(n), 1500) * env_ad(n, 0.0005, 0.07) * 0.9
roar = lp(noise(n), 3500) * env_ad(n, 0.002, 0.9)
# 黄铜低吼（失谐锯齿 + 低通）
brass = np.zeros(n)
for m in (26, 38, 45, 50):
    for d in (-0.12, 0.0, 0.12):
        fr = midi(m + d)
        brass += signal.sawtooth(2 * np.pi * fr * t) / 3
brass = lp(brass, 700, 2) * env_ad(n, 0.01, 2.2) * 0.35
bang = boom * 1.25 + crack * 0.6 + roar * 0.7 + brass
add(dry, bang * 0.85, tb0)
add(wetbus, bang * 0.7, tb0)

# 冲击波 whoosh
wh = sweep_noise(0, 3.0, 5000, 160, 0.7)
wh *= np.exp(-np.arange(len(wh)) / SR / 1.1) * np.minimum(1, np.arange(len(wh)) / SR / 0.02)
add(wetbus, wh, tb0, 0.6)

# ============================================================
# 和弦铺底
# ============================================================
def pad_note(freq, dur, bright=1.0, det=(-7, 0, 7)):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for d in det:
        x += signal.sawtooth(2 * np.pi * freq * 2 ** (d / 1200) * t + rng.uniform(0, 6))
    x /= len(det)
    x = lp(x, min(freq * 6 * bright, 5200), 2) + 0.35 * np.sin(2 * np.pi * freq * t)
    return x


CH = [  # (start, end, [midi])
    (9.0, 13.0, [38, 45, 50, 53, 57, 62]),     # Dm
    (13.0, 17.0, [34, 41, 46, 50, 53, 58]),    # Bb
    (17.0, 21.0, [31, 43, 46, 50, 55, 58]),    # Gm
    (21.0, 24.8, [33, 45, 49, 52, 57, 61]),    # A
    (28.0, 30.0, [26, 38, 45, 50, 54, 57, 62, 66]),  # D 大调
]
pad = mono()
for (a, b, notes) in CH:
    dur = (b - a) + 2.2
    rel = 1.2 if a != 28.0 else 3.0
    for m in notes:
        s = pad_note(midi(m), dur, bright=1.0 + 0.5 * (a > 13))
        n = len(s)
        t = np.arange(n) / SR
        att = 1.6 if a != 9.0 else 0.9
        e = np.minimum(1, t / att) * np.minimum(1, np.maximum(0, (dur - t)) / rel)
        g = 0.050 * (1.0 if m > 40 else 1.4)
        if a == 9.0:
            g *= 1.15
        add(pad, s * e, a - (0.15 if a != 9.0 else 0), g)

# 9~14 的铺底在重击后渐入
pad *= np.where(T < 24.8, 1.0, 1.0)
pad[(T >= 24.8) & (T < 28.0)] = 0
# 最后一个和弦：从 28.0 起 0.5 秒内冲上来，29.4 起淡出
pad *= np.where(T >= 28.0, np.clip((T - 28.0) / 0.5, 0, 1), 1.0)
tailfade = np.clip((30.0 - T) / 0.8, 0, 1)
tailfade[T < 29.2] = 1

# ============================================================
# 琶音（星系成形之后）
# ============================================================
arp = mono()
prog = [
    (13.5, 17.0, [62, 65, 69, 74, 77, 74, 69, 65]),   # Dm 的延续
    (17.0, 21.0, [58, 62, 65, 70, 74, 70, 65, 62]),   # Bb
    (21.0, 24.65, [55, 58, 62, 67, 70, 67, 62, 58]),  # Gm
]
step = 0.25
tt = 13.5
idx = 0
while tt < 24.65:
    for (a, b, pat) in prog:
        if a <= tt < b:
            m = pat[idx % len(pat)] + (12 if tt > 19 else 0)
            fr = midi(m)
            n = int(0.9 * SR)
            t = np.arange(n) / SR
            note = (np.sin(2 * np.pi * fr * t) + 0.4 * np.sin(2 * np.pi * fr * 2 * t) * np.exp(-t / 0.15)
                    + 0.15 * np.sin(2 * np.pi * fr * 3.01 * t) * np.exp(-t / 0.08)) * env_ad(n, 0.003, 0.28)
            ramp = np.clip((tt - 13.5) / 5.0, 0, 1) ** 1.2
            add(arp, note, tt, 0.17 * (0.25 + 0.75 * ramp))
    tt += step
    idx += 1

# 低音鼓：每 2 秒一下 → 每 0.5 秒一下 → 变焦穿越时越来越密
drums = mono()
hits = []
x = 15.0
while x < 19.0:
    hits.append(x)
    x += 2.0
x = 19.0
iv = 0.5
while x < 24.6:
    hits.append(x)
    x += iv
    iv = max(0.17, iv * 0.93)
for h in hits:
    g = 0.5 + 0.5 * np.clip((h - 15) / 9, 0, 1)
    add(drums, thud(g * 1.1, 95, 38, 0.8), h)
    if h > 19:
        add(drums, hp(noise(int(0.2 * SR)), 2500) * env_ad(int(0.2 * SR), 0.001, 0.035) * 0.15, h)

# 变焦穿越噪声
wz = sweep_noise(18.8, 24.4, 200, 8500, 1.1)
ee = (np.arange(len(wz)) / len(wz))
wz *= np.sin(np.pi * np.clip(ee, 0, 1) ** 0.8) ** 1.2
add(wetbus, wz, 18.8, 0.7)

# 24.65 后的 "吸气"（所有高频撤走）
# ============================================================
# 24.8~27.6：只剩一个高音 + 三下很轻的心跳
# ============================================================
hush = mono()
mask = (T >= 24.7) & (T < 28.0)
u = np.clip((T[mask] - 24.7) / 1.2, 0, 1)
fe = u * np.clip((28.0 - T[mask]) / 0.4, 0, 1)
tone = (np.sin(2 * np.pi * midi(86) * T[mask]) * 0.5 + np.sin(2 * np.pi * midi(74) * T[mask]) * 0.5)
hush[mask] = tone * fe * 0.06 * (1 + 0.15 * np.sin(2 * np.pi * 5.5 * T[mask]))
fe_full = np.zeros(N)
fe_full[mask] = fe
low = np.sin(2 * np.pi * midi(26) * T) * 0.12 * fe_full
for h, g in [(25.2, 0.5), (26.2, 0.45), (27.1, 0.4)]:
    add(dry, thud(g, 100, 42, 0.7), h)
    add(wetbus, thud(g * 0.5, 100, 42, 0.7), h)

# ============================================================
# 28.0：标题
# ============================================================
n = int(7 * SR)
t = np.arange(n) / SR
f = 30 + 70 * np.exp(-t / 0.22)
b2 = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ad(n, 0.003, 2.4)
b2 += lp(noise(n), 2800) * env_ad(n, 0.002, 0.5) * 0.4
b2 += hp(noise(n), 2000) * env_ad(n, 0.0005, 0.05) * 0.35
shim = np.zeros(n)
for m in (74, 78, 81, 86, 90):
    shim += np.sin(2 * np.pi * midi(m) * t + rng.uniform(0, 6)) * np.minimum(1, t / 1.0) * 0.025
add(dry, b2 * 0.9, 28.0)
add(wetbus, b2 * 0.7, 28.0)
add(hush, shim, 28.0)

# 28.0 前 0.4 秒 "倒放" 吸气
n = int(0.4 * SR)
rev = lp(noise(n), 6000) * (np.arange(n) / n) ** 3
add(wetbus, rev, 27.6, 0.0)  # 保持静音：黑场需要安静

# ============================================================
# 混音
# ============================================================
dry_all = dry + arp * 0.8 + drums
st = np.stack([dry_all, dry_all], 1)

# 通道微分离：铺底左右失相
padL = pad
padR = np.roll(pad, int(0.012 * SR))
st[:, 0] += padL
st[:, 1] += padR
st[:, 0] += hush
st[:, 1] += np.roll(hush, int(0.018 * SR))

# 混响
rv = reverb(wetbus + arp * 0.9 + pad * 0.5 + hush * 1.2 + low * 0.5, rt=3.4, wet=0.55, damp=4500)
st += rv

# 28.0 之后的整体尾巴淡出
st *= tailfade[:, None]
# 开头 0.2 秒淡入防爆音
st *= np.clip(T / 0.2, 0, 1)[:, None]

# 软限幅 + 归一化
st = np.tanh(st * 1.35) / np.tanh(1.35)
st /= np.max(np.abs(st)) / 0.92
# 8.70~9.0 的静音再确认
st[(T >= 8.72) & (T < 9.0)] = 0
# 27.6~28.0 的静音：混响尾巴也一起压掉，形成真空
sil = (T >= 27.62) & (T < 28.0)
st[sil] *= np.linspace(1, 0, sil.sum())[:, None] ** 2

out = (st * 32767).astype(np.int16)
wavfile.write('genesis.wav', SR, out)
print('wrote genesis.wav', out.shape, 'peak', np.abs(st).max())
