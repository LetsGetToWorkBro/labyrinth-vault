# Design references

Two kinds of artefact, with different levels of authority:

**The interaction prototype** (`ui/` at the repository root) is the spec. It
runs from a `file://` URL with no network, and the behaviours that matter —
the scroll gate on the confirmation screen, hold-to-sign, out-of-order frame
acquisition, refusals with exactly one exit — are implemented, not mocked. The
iOS shell in `ios/` follows it.

**The boards** (`boards/`) are AI-generated concept art of the visual
direction, made during design. Display typography on them is accurate; body
paragraphs are generator filler and should not be read as copy. Where a board
and the prototype disagree, the prototype wins.

## The system in one paragraph

Near-black surface (#08080A), warm off-white ink (#EFEAE2), hairline rules
instead of cards, grotesk for the interface's voice and monospace for anything
cryptographic. Three state colours, each with one meaning: green only for a
verification that passed, amber only for attention in progress, red only on a
refusal. The labyrinth is a single right-angle involute used as motion — it
draws itself when things verify and stops dead when they do not — and as a
sub-5%-opacity watermark, never as an illustration. Motion is slow and
mechanical; success is quiet; refusal is a hard stop with exactly one button.
