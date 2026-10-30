"""Re-say the words a film's voice got wrong, keeping her whole performance.

Two steps, each run by the film worker (src/lib/respeak.ts) with VOICEFIX_PYTHON:

  python scripts/voicefix.py separate <film.wav> <out_dir>
      Her voice and everything else (music, drone, transitions), with Demucs.
      Writes <out_dir>/vocals.wav and <out_dir>/music.wav.

  python scripts/voicefix.py patch <job.json>
      Each wrong word is replaced by the same word cut from a take of the line
      in her cloned voice: stretched to the length of the word she said (never
      more than 15 per cent, and a word that ends its sentence keeps its own
      length; a name is said at its own length, never squeezed, and her words
      after it wait for it as far as the next pause), given her pitch curve over that word and her loudness, matched
      to her tone, and set into her voice track at the quiet moments either
      side of it. Only those windows of the film's audio change. Prints a JSON
      report, with how bright and how rough each fix is against her own word
      in that place.

Needs numpy, scipy, soundfile, praat-parselmouth, torch, torchaudio and
demucs (scripts/voicefix-requirements.txt). Nothing here calls the network
except Demucs fetching its model once.
"""
import json
import os
import shutil
import sys

import numpy as np
import soundfile as sf


def separate(src, out_dir):
    import demucs.separate

    os.makedirs(out_dir, exist_ok=True)
    work = os.path.join(out_dir, "demucs")
    demucs.separate.main(["--two-stems", "vocals", "-n", "htdemucs_ft", "-o", work, src])
    stem = os.path.join(work, "htdemucs_ft", os.path.splitext(os.path.basename(src))[0])
    shutil.move(os.path.join(stem, "vocals.wav"), os.path.join(out_dir, "vocals.wav"))
    shutil.move(os.path.join(stem, "no_vocals.wav"), os.path.join(out_dir, "music.wav"))
    shutil.rmtree(work, ignore_errors=True)


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-12))


def frame_db(x, hop):
    k = len(x) // hop
    return 20 * np.log10(np.sqrt(np.mean(np.square(x[: k * hop].reshape(k, hop)), axis=1) + 1e-12) + 1e-9)


def edges(x, sr, a, b, final):
    """Cut points for a word: the quietest moment just before it starts, and the
    quietest moment just after it ends (or, ending a sentence, where it falls silent)."""
    hop = int(0.005 * sr)
    e = frame_db(x, hop)
    fr = lambda t: int(round(t * sr / hop))
    lo, hi = max(fr(a - 0.10), 0), min(fr(a + 0.02), len(e) - 1)
    s = lo + int(np.argmin(e[lo : hi + 1]))
    if final:
        peak = e[s : max(fr(b), s + 1)].max()
        t = fr(b)
        while t < min(fr(b + 0.25), len(e) - 6) and not np.all(e[t : t + 6] < peak - 35):
            t += 1
    else:
        lo, hi = max(fr(b - 0.03), 0), min(fr(b + 0.07), len(e) - 1)
        t = lo + int(np.argmin(e[lo : hi + 1]))
    return s * hop, max(t * hop, s * hop + hop)


def quiet_after(x, sr, start, need, word):
    """Where the first pause at least `need` samples long begins after `start`,
    within three seconds, or None: quiet is 30 dB under the word's own peak."""
    hop = int(0.005 * sr)
    e = frame_db(x[start : start + 3 * sr], hop)
    if not len(e):
        return None
    peak = frame_db(word, hop).max() if len(word) >= hop else e.max()
    quiet = e < peak - 30
    run, frames = 0, max(1, need // hop)
    for i, q in enumerate(quiet):
        run = run + 1 if q else 0
        if run >= frames:
            return start + (i - run + 1) * hop
    return None


def tone_taps(her, clone, sr):
    """Her average spectrum against the clone's, smoothed, at most 6 dB either way."""
    from scipy.signal import firwin2, welch

    f, ph = welch(her, sr, nperseg=4096)
    _, pc = welch(clone, sr, nperseg=4096)
    diff = 10 * np.log10(ph + 1e-14) - 10 * np.log10(pc + 1e-14)
    diff -= np.median(diff[(f > 300) & (f < 3000)])
    logf = np.log2(np.maximum(f, 20))
    gain = np.clip(np.array([diff[np.abs(logf - lf) < 1 / 6].mean() for lf in logf]), -6, 6)
    gain[f > min(15500, sr / 2 - 500)] = -30
    return firwin2(2047, f / (sr / 2), 10 ** (gain / 20))


def centroid(x, sr):
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    fr = np.fft.rfftfreq(len(x), 1 / sr)
    return float((spec * fr).sum() / (spec.sum() + 1e-12))


def harmonicity(x, sr):
    import parselmouth

    h = parselmouth.Sound(x, sampling_frequency=sr).to_harmonicity().values
    h = h[h > -100]
    return float(h.mean()) if len(h) else 0.0


# How a fix sounds against her own word in the same place, reported and never
# a reason to keep a wrong word: the client chose on 2 October 2026 that a
# place name is always said again. Her two Goregaons in one film were 0.92
# apart in brightness and equally clear.
def tone(out, herw, sr):
    b = centroid(out, sr) / max(centroid(herw, sr), 1e-6)
    drop = harmonicity(herw, sr) - harmonicity(out, sr)
    return round(b, 2), round(drop, 1)


def patch(job_path):
    import parselmouth
    from parselmouth.praat import call
    from scipy.signal import fftconvolve

    job = json.load(open(job_path, encoding="utf-8"))
    orig, sr = sf.read(job["orig"], always_2d=True)
    voc, _ = sf.read(job["vocals"], always_2d=True)
    mus, _ = sf.read(job["music"], always_2d=True)
    n = min(len(orig), len(voc), len(mus))
    orig, voc, mus = orig[:n], voc[:n], mus[:n]
    her = voc.mean(axis=1)

    takes = {}
    for fx in job["fixes"]:
        for tk in fx["takes"]:
            path = tk["wav"]
            if path not in takes:
                x, tsr = sf.read(path, always_2d=True)
                if tsr != sr:
                    raise SystemExit(f"take {path} is {tsr} Hz, the film is {sr} Hz")
                takes[path] = x.mean(axis=1)
    taps = tone_taps(her, np.concatenate(list(takes.values())), sr)
    d = (len(taps) - 1) // 2

    # Her own pitch over the whole film: what a reading inside one word is
    # measured against (a word alone can read mostly an octave up).
    whole = parselmouth.Sound(her, sampling_frequency=sr).to_pitch(0.01, 75, 600).selected_array["frequency"]
    her_mid = float(np.median(whole[whole > 0])) if np.any(whole > 0) else 0.0

    new_voc = voc.copy()
    windows, report = [], []
    for fx in job["fixes"]:
        h = fx["her"]
        final = bool(h["final"])
        hs, he = edges(her, sr, h["start"], h["end"], final)
        # Her word and every take's measured the same way, and the take nearest
        # her length kept: a word stretched to fit sounds stretched.
        def cut(tk):
            x = takes[tk["wav"]]
            ns, ne = edges(x, sr, tk["start"], tk["end"], final)
            return x[ns:ne].copy(), abs((he - hs) / max(ne - ns, 1) - 1)
        cands = [cut(tk) for tk in fx["takes"]]
        # A name keeps its own length: when the film's voice rushed it
        # ("Goregaon" in 0.40 s, 6 October 2026), fitting the take to her slot
        # kept the rush and lost the end ("Gorega"). It is said at least its
        # natural length, and her words after it wait for it (below).
        natural = bool(h.get("natural"))
        min_len = int(float(h.get("min", 0)) * sr)
        target = max(he - hs, min_len)
        if natural:
            full = [c for c in cands if len(c[0]) >= min_len * 0.95] or cands
            # The fullest take, within half again its slot: a hurried take is the one that drops a syllable.
            fits = [c for c in full if len(c[0]) <= target * 1.5] or full
            new, off = max(fits, key=lambda c: len(c[0]))
        else:
            new, off = min(cands, key=lambda c: c[1])
        herw = her[hs:he]

        snd = parselmouth.Sound(new, sampling_frequency=sr)
        manip = call(snd, "To Manipulation", 0.01, 75, 600)
        ratio = 1.0
        if natural:
            # Never squeezed: a name made shorter than the voice said it lost its end.
            ratio = float(min(max(target / len(new), 1.0), 1 + job.get("maxStretch", 0.15)))
        elif not final:
            ratio = float(min(max((he - hs) / len(new), 1 - job.get("maxStretch", 0.15)), 1 + job.get("maxStretch", 0.15)))
        if ratio != 1.0:
            dt = call("Create DurationTier", "d", 0, snd.duration)
            call(dt, "Add point", snd.duration / 2, ratio)
            call([manip, dt], "Replace duration tier")
        # Her pitch over the word itself, never the pause after it: a word
        # ending its sentence is measured out into the pause, where the voice
        # stem still carries music, and the reader took that music for her
        # pitch. Forced onto the clone, "crore" ended in a squeal at 570 Hz
        # sliding down, in two films running (10 October 2026). So only her
        # word's own span is read, readings far from her pitch over the film (a
        # note of music) are dropped, an octave up is halved, and with too few left the
        # clone keeps its own pitch, which is already her voice.
        ws, we = edges(her, sr, h["start"], h["end"], False)
        word = her[ws:we]
        hp = parselmouth.Sound(word, sampling_frequency=sr).to_pitch(0.01, 75, 600)
        hf, ht = hp.selected_array["frequency"], hp.xs()
        voiced = hf > 0
        if her_mid > 0:
            # An octave up is her voice read wrong: halved. Anything else far from her is not her.
            hf = np.where(voiced & (hf > her_mid * 1.7) & (hf < her_mid * 2.3), hf / 2, hf)
            voiced &= (hf > her_mid / 1.5) & (hf < her_mid * 1.5)
        if voiced.sum() >= 3 and len(word) > 0:
            pt = call("Create PitchTier", "p", 0, snd.duration)
            # Her word's time laid over the clone's word, not over its tail.
            span = snd.duration * min(len(word) / max(len(herw), 1), 1.0) if final else snd.duration
            for t, f0 in zip(ht[voiced], hf[voiced]):
                call(pt, "Add point", t * span / (len(word) / sr), float(f0))
            if final and span < snd.duration:
                # Past her word the line falls a little, as a sentence ends, never held flat.
                call(pt, "Add point", snd.duration, float(hf[voiced][-1]) * 0.9)
            call([manip, pt], "Replace pitch tier")
        out = call(manip, "Get resynthesis (overlap-add)").values[0]
        if final:
            # A word ending its sentence runs at its own length, into the pause, never onto her next word.
            room = int(max(h.get("room", 0), 0) * sr)
            he = max(he, hs + min(len(out), room if room else len(out)))
        # A name longer than her slot pushes her next words later, as far as
        # the next pause, which gives the time back: the music is its own
        # stem and does not move. With no pause near enough it is cut to fit.
        shift, pause = 0, None
        if natural and len(out) > he - hs:
            shift = len(out) - (he - hs)
            pause = quiet_after(her, sr, he, shift + int(0.06 * sr), herw)
            if pause is None:
                shift = 0
        if not shift:
            out = out[: he - hs] if len(out) >= he - hs else np.pad(out, (0, he - hs - len(out)))
        out = fftconvolve(out, taps, mode="full")[d : d + len(out)]
        live = out[np.abs(out) > np.abs(out).max() * 0.02] if np.any(out) else out
        out *= rms(herw) / rms(live)
        bright, rougher = tone(out, herw, sr)

        fade = int(0.008 * sr)
        if shift:
            # Her word out, the name in at its own length, then her words up to
            # the pause, each moved later by the same amount; the pause is that
            # much shorter.
            end = pause + shift
            w = np.ones(len(out))
            w[:fade] = np.linspace(0, 1, fade)
            for c in range(new_voc.shape[1]):
                moved = voc[he:pause, c].copy()
                head = voc[hs : hs + len(out), c] * (1 - w) + out * w
                new_voc[hs:end, c] = np.concatenate([head, moved])
            windows.append((max(hs - int(0.03 * sr), 0), min(end + int(0.03 * sr), n)))
            placed_end = hs + len(out)
        else:
            w = np.ones(he - hs)
            w[:fade] = np.linspace(0, 1, fade)
            w[-fade:] = np.linspace(1, 0, fade)
            for c in range(new_voc.shape[1]):
                new_voc[hs:he, c] = voc[hs:he, c] * (1 - w) + out * w
            windows.append((max(hs - int(0.03 * sr), 0), min(he + int(0.03 * sr), n)))
            placed_end = he
        report.append({"id": fx["id"], "placed": [hs / sr, placed_end / sr], "stretch": ratio, "off": round(off, 3), "final": final, "natural": natural, "shift": round(shift / sr, 3), "takes": len(fx["takes"]), "brightness": bright, "rougher": rougher})

    res = orig.copy()
    edge = int(0.015 * sr)
    for a, b in windows:
        r = np.ones(b - a)
        r[:edge] = np.linspace(0, 1, edge)
        r[-edge:] = np.linspace(1, 0, edge)
        res[a:b] = orig[a:b] * (1 - r[:, None]) + (mus[a:b] + new_voc[a:b]) * r[:, None]
    peak = np.abs(res).max()
    if peak > 0.99:
        res *= 0.99 / peak
    sf.write(job["out"], res, sr, subtype="PCM_16")
    json.dump({"ok": True, "fixes": report}, open(job["out"] + ".json", "w", encoding="utf-8"))
    print(json.dumps({"ok": True, "fixes": report}))


def lines(job_path):
    """Whole lines said again, for a film in Hindi or Marathi: in each line's
    stretch of the film's sound her voice (the Demucs stem) is taken out and
    the clone's take (already fitted to its length by the caller) put in, at
    the loudness her line had, with short fades. Everywhere else the film's
    sound is left exactly as it came."""
    from scipy.signal import resample_poly

    job = json.load(open(job_path, encoding="utf8"))
    mix, sr = sf.read(job["audio"], always_2d=True)
    voc, sr2 = sf.read(job["vocals"], always_2d=True)
    assert sr == sr2
    n_all = min(len(mix), len(voc))
    out = mix[:n_all].copy()
    voc = voc[:n_all]
    fade = int(0.03 * sr)
    report = []
    for sw in job["swaps"]:
        take, tsr = sf.read(sw["take"], always_2d=True)
        take = take.mean(axis=1)
        if tsr != sr:
            take = resample_poly(take, sr, tsr)
        s0 = max(0, int(sw["start"] * sr))
        a = max(0, int((sw["start"] - 0.05) * sr))
        b = min(n_all, max(int((sw["end"] + 0.08) * sr), s0 + len(take)))
        her = rms(voc[a:b].mean(axis=1)) if b > a else rms(take)
        take = take * (her / rms(take))
        # Her voice out of the window, faded in and out so nothing clicks.
        w = np.ones(b - a)
        f = min(fade, (b - a) // 4)
        if f:
            w[:f] = np.linspace(0, 1, f)
            w[-f:] = np.linspace(1, 0, f)
        out[a:b] -= voc[a:b] * w[:, None]
        n = min(len(take), n_all - s0)
        t = take[:n].copy()
        g = min(int(0.015 * sr), n // 4)
        if g:
            t[:g] *= np.linspace(0, 1, g)
            t[-g:] *= np.linspace(1, 0, g)
        out[s0 : s0 + n] += t[:, None]
        report.append({"start": sw["start"], "seconds": round(n / sr, 3), "level": round(float(her), 4)})
    # Words nobody wrote: her voice out, the music left.
    for m in job.get("mutes", []):
        a = max(0, int((m["start"] - 0.06) * sr))
        b = min(n_all, int((m["end"] + 0.08) * sr))
        if b <= a:
            continue
        w = np.ones(b - a)
        f = min(fade, (b - a) // 4)
        if f:
            w[:f] = np.linspace(0, 1, f)
            w[-f:] = np.linspace(1, 0, f)
        out[a:b] -= voc[a:b] * w[:, None]
    peak = float(np.max(np.abs(out)))
    if peak > 0.98:
        out = out * (0.98 / peak)
    sf.write(job["out"], out, sr)
    print(json.dumps({"ok": True, "swaps": report, "mutes": len(job.get("mutes", []))}))


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "separate":
        separate(sys.argv[2], sys.argv[3])
        print(json.dumps({"ok": True}))
    elif len(sys.argv) >= 3 and sys.argv[1] == "lines":
        lines(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == "patch":
        patch(sys.argv[2])
    else:
        raise SystemExit(__doc__)
