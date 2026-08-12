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

The originals totalled **30.3 MB**. The current set is **5.1 MB**, and nothing
visible was given up.

| | Was | Is |
| --- | --- | --- |
| favicon | 4.0 MB PNG, 2048x2048 | 653 B `.ico` at 16/32/48, plus a 24 KB apple-touch icon |
| og:image | 2.3 MB PNG, 2048x1360 | 75 KB JPEG at 1200x630, the size the spec asks for |
| drawer photo | 10.2 MB PNG, 3504x2336 | 131 KB grey WebP at 1920 wide |
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

## The budget, and what it counts

**Nobody downloads this directory.** The hero ships a desktop clip and a mobile
clip and fetches exactly one, chosen by media query, and the same goes for the
two posters. The budget used to add up every file and hold the sum under 6 MB,
which charged a phone for a 3.1 MB clip only a laptop ever asks for.

So there are two numbers now, and they answer different questions:

| | Now | Cap |
| --- | --- | --- |
| A phone's whole visit | 1.88 MB | |
| **A laptop's whole visit** | **3.71 MB** | **4.5 MB** |
| The repository total | 5.06 MB | 8 MB |
| Any single image | | 400 KB |

The strict cap is the laptop one, because it is the only figure somebody waits
for. The shape of it matters: **3.1 MB of that 3.71 MB is the desktop hero
clip, and it cannot be made smaller.** Only the already-encoded files were ever
committed, never the masters, so re-encoding is a second generation of loss
rather than a saving, and the short keyframe interval the scrubbing depends on
is most of what it costs. The real headroom for anything new is the megabyte
above it.

The either-or pairing is written down in the test rather than inferred from
filenames, so a new variant nobody adds to that table counts against the strict
budget by default. That is the safe direction to be wrong in.

## Every photograph here is painted in grey

`.drawer-section img` is `filter: grayscale(1)` and `.qr-language img` is
`grayscale(0.95)`, so the browser throws the color away before you see it.
The drawer photo was stored in color anyway, at 2400px, for a slot no wider
than about 790 CSS pixels. Stored as grey at 1920 it is **131 KB instead of
191 KB**, and identical on screen because the screen was never going to show
the difference. Do the same with anything new: convert to `L`, size it to
about twice its widest real slot, and let the CSS do what it was going to do.

## If you add media here

`test/site-claims.test.ts` fails the build if any image goes over 400 KB, if a
single visit goes over 4.5 MB, if the whole set goes over 8 MB, if the favicon
grows past 50 KB, or if anything loads media from a remote host again. If a new
asset genuinely needs to break one, change the limit in the same commit and say
why.
