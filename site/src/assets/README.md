# The site's media, and how it was made

These files are checked in rather than linked, and they are a fraction of the
size they arrived at. Both of those were deliberate, and the reasoning is here
so the next person adding a photograph does not undo it by accident.

## Why they live here

The site shipped loading every video and photograph from a generated-asset CDN,
on a path scoped to one user's account on a third-party service. Nothing was
wrong with it the day it shipped. But a marketing site whose hero is a link
into somebody else's bucket is a marketing site that goes blank on a day nobody
chose, and the failure is silent: the page still loads, the story is just gone.

Imported through Vite instead. Each file is fingerprinted with a hash of its
contents at build time, so the host can serve it immutable and forever, and a
changed file gets a new name rather than a stale cache.

## Why they are small

The originals totalled **30.3 MB**. The current set is **4.9 MB**, and nothing
visible was given up.

| | Was | Is |
| --- | --- | --- |
| favicon | 4.0 MB PNG, 2048x2048 | 653 B `.ico` at 16/32/48, plus a 26 KB apple-touch icon |
| og:image | 2.3 MB PNG, 2048x1360 | 84 KB JPEG at 1200x630, the size the spec asks for |
| drawer photo | 10.2 MB PNG, 3504x2336 | 191 KB WebP at 2400 wide |
| QR phones photo | 6.4 MB PNG, 3840x2160 | 58 KB WebP at 2400 wide |
| hero clip, desktop | 5.5 MB | 3.1 MB |
| hero clip, mobile | 2.1 MB | 1.3 MB |

The photographs were PNGs, which is a lossless format meant for screenshots and
line art. As a container for a photograph it stores every sensor grain exactly,
which is why one of them was ten megabytes. WebP at quality 80 is 55x smaller
here and indistinguishable on a screen.

The favicon is the one worth remembering: a 2048x2048 four-megabyte image that
every browser downloaded on every page load in order to draw a 32-pixel square.

## The commands

Images, via Pillow:

```
im.resize((2400, ...), LANCZOS).save(out, "WEBP", quality=80, method=6)
```

Video, via ffmpeg. The settings are not arbitrary and should not be casually
"optimized" further:

```sh
ffmpeg -i in.mp4 -an -c:v libx264 -preset slow -crf 25 \
       -g 8 -keyint_min 8 -sc_threshold 0 \
       -pix_fmt yuv420p -movflags +faststart out.mp4
```

- `-an` because the clips are silent and an audio track would be dead weight.
- `-g 8 -keyint_min 8 -sc_threshold 0` forces a keyframe every third of a
  second. **This is what makes scrubbing work.** The hero is driven by scroll
  position, seeking constantly, and a seek lands on the nearest keyframe; a
  long GOP would make it lurch. It costs bitrate on purpose.
- `-movflags +faststart` puts the index at the front so playback can begin
  before the file finishes downloading.

Measured against the originals at SSIM 0.996, which is visually lossless.

## If you add media here

`test/site-claims.test.ts` will fail the build if any image goes over 400 KB,
if the whole set goes over 6 MB, if the favicon grows past 50 KB, or if
anything in the site loads media from a remote host again. Those numbers are
generous for what this page is. If a new asset genuinely needs to break one,
change the limit in the same commit and say why.
