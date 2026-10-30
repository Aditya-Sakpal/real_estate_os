"""
How well a presenter's lips follow her voice, scene by scene (`lipsync.ts`).

    python scripts/lipsync.py score <job.json>

The job names the film, the voice alone (Demucs's vocals of the sound the
film goes out with), the spans to score, and the folder of models
(`LIPSYNC_MODELS`): SyncNet's weights `syncnet_v2.model`, MediaPipe's
`face_landmarker.task` and `pose.task`. It prints one JSON line: per span,
the offset of the voice against the lips in frames (25 a second) and
SyncNet's confidence, or why it could not be scored.

The face is found in two steps, because a presenter in a full-body shot has
a face too small for the face model on the whole frame: the pose model finds
the head, the face model reads a square cut round it. The face is then cut
at 224 by 224, as SyncNet was trained, and scored against the voice's MFCCs
over a window of 15 frames either way. Confidence is the median distance
less the best: 5 or more is a mouth following its words, under 3 is not
(measured on the Palm Grove film of 17 October 2026: 1.6 before its first
scene was lip-synced, 5.4 after).
"""
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np

FFMPEG = os.environ.get("FFMPEG_PATH") or "ffmpeg"
FPS = 25
SHIFT = 15


def load(models):
    import mediapipe as mp
    import torch
    from mediapipe.tasks import python as mpt
    from mediapipe.tasks.python import vision

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lipsync"))
    from syncnet_model import S

    face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=os.path.join(models, "face_landmarker.task")),
        running_mode=vision.RunningMode.IMAGE, num_faces=1))
    pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=os.path.join(models, "pose.task")),
        running_mode=vision.RunningMode.IMAGE))
    net = S(num_layers_in_fc_layers=1024)
    state = torch.load(os.path.join(models, "syncnet_v2.model"), map_location="cpu", weights_only=True)
    own = net.state_dict()
    for k, v in state.items():
        own[k].copy_(v)
    net.eval()
    return mp, torch, face, pose, net


def frames(video, start, end, w, h):
    """The span's frames at 25 a second, one at a time, never all held at once."""
    p = subprocess.Popen([FFMPEG, "-v", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", video,
                          "-vf", f"fps={FPS},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         stdout=subprocess.PIPE)
    size = w * h * 3
    while True:
        b = p.stdout.read(size)
        if len(b) < size:
            break
        yield np.frombuffer(b, np.uint8).reshape(h, w, 3)
    p.wait()


def face_box(mp, face, pose, rgb):
    H, W = rgb.shape[:2]
    small = np.ascontiguousarray(cv2.resize(rgb, (W // 2, H // 2)))
    r = pose.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=small))
    if not r.pose_landmarks:
        return None
    q = r.pose_landmarks[0]
    cx = np.mean([q[k].x for k in range(11)]) * W
    cy = np.mean([q[k].y for k in range(11)]) * H
    side = max(64, abs(q[7].x - q[8].x) * W * 3.2)
    x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
    x1, y1 = int(min(W, cx + side / 2)), int(min(H, cy + side / 2))
    if x1 - x0 < 16 or y1 - y0 < 16:
        return None
    crop = np.ascontiguousarray(cv2.resize(rgb[y0:y1, x0:x1], (384, 384)))
    f = face.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop))
    if not f.face_landmarks:
        return None
    pts = f.face_landmarks[0]
    xs = np.array([a.x for a in pts]) * (x1 - x0) + x0
    ys = np.array([a.y for a in pts]) * (y1 - y0) + y0
    return (xs.min(), ys.min(), xs.max(), ys.max())


def mfcc_of(voice, start, end):
    import python_speech_features
    raw = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", voice,
                          "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], stdout=subprocess.PIPE, check=True).stdout
    audio = np.frombuffer(raw, np.int16)
    return audio, np.stack([np.array(c) for c in zip(*python_speech_features.mfcc(audio, 16000))])


def score(job):
    from scipy import signal
    mp, torch, face, pose, net = load(job["models"])
    w, h = job.get("w", 720), job.get("h", 1280)
    out = []
    for span in job["spans"]:
        a, b = float(span["start"]), float(span["end"])
        rgbs = list(frames(job["video"], a, b, w, h))
        boxes = [face_box(mp, face, pose, f) for f in rgbs]
        found = [x for x in boxes if x]
        if len(rgbs) < 12 or len(found) < 0.7 * len(boxes):
            out.append({"start": a, "end": b, "scored": False, "why": "no face" if rgbs else "no frames"})
            continue
        last, filled = found[0], []
        for x in boxes:
            last = x or last
            filled.append(last)
        arr = signal.medfilt(np.array(filled), [9, 1])
        crops = []
        for rgb, (x0, y0, x1, y1) in zip(rgbs, arr):
            cx, cy, s = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) * 0.75
            pad = cv2.copyMakeBorder(rgb, 400, 400, 400, 400, cv2.BORDER_CONSTANT, value=(110, 110, 110))
            c = pad[int(cy - s + 400):int(cy + s + 400), int(cx - s + 400):int(cx + s + 400)]
            crops.append(cv2.cvtColor(cv2.resize(c, (224, 224)), cv2.COLOR_RGB2BGR))
        del rgbs
        audio, mfcc = mfcc_of(job["voice"], a, b)
        n = min(len(crops), math.floor(len(audio) / 640)) - 5
        if n < 8:
            out.append({"start": a, "end": b, "scored": False, "why": "too short"})
            continue
        im = np.stack(crops, axis=3)[None].transpose(0, 3, 4, 1, 2)
        imtv = torch.from_numpy(im.astype(np.float32))
        cct = torch.from_numpy(mfcc[None, None].astype(np.float32))
        with torch.no_grad():
            im_feat = torch.cat([net.forward_lip(torch.cat([imtv[:, :, v:v + 5] for v in range(i, min(n, i + 20))], 0))
                                 for i in range(0, n, 20)], 0)
            cc_feat = torch.cat([net.forward_aud(torch.cat([cct[:, :, :, v * 4:v * 4 + 20] for v in range(i, min(n, i + 20))], 0))
                                 for i in range(0, n, 20)], 0)
        pad = torch.nn.functional.pad(cc_feat, (0, 0, SHIFT, SHIFT))
        dists = torch.stack([torch.nn.functional.pairwise_distance(im_feat[[i], :].repeat(2 * SHIFT + 1, 1), pad[i:i + 2 * SHIFT + 1, :])
                             for i in range(len(im_feat))], 1)
        mdist = dists.mean(1)
        best = int(torch.argmin(mdist))
        out.append({"start": a, "end": b, "scored": True, "offset": SHIFT - best,
                    "confidence": round(float(torch.median(mdist) - mdist[best]), 2),
                    "faceShare": round(len(found) / len(boxes), 2)})
    return out


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "score":
        print(json.dumps(score(json.load(open(sys.argv[2], encoding="utf-8")))))
    else:
        print("usage: lipsync.py score <job.json>", file=sys.stderr)
        sys.exit(2)
