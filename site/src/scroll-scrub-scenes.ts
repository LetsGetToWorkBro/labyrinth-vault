import type {
  ScrollScrubScene,
  ScrollScrubTheme,
} from "./components/scroll-scrub";
/* Imported rather than linked to a URL. Vite fingerprints each file with a
 * hash of its contents, so the host can serve them immutable and forever, and
 * the site stops depending on somebody else's bucket staying up. */
import heroDesktop from "./assets/hero-desktop.mp4";
import heroMobile from "./assets/hero-mobile.mp4";
import heroPoster from "./assets/hero-poster.webp";
import heroPosterMobile from "./assets/hero-poster-mobile.webp";

export const scrollScrubTheme: ScrollScrubTheme = {
  accent: "#C7332E",
  background: "#07090B",
  ink: "#F1F3F4",
  muted: "#9EA5AC",
};

export const scrollScrubScenes: ScrollScrubScene[] = [
  {
    align: "left",
    body: "Turn an old iPhone into an air-gapped signing device for Bitcoin and Monero.",
    clip: heroDesktop,
    id: "vault-transformation",
    kicker: "LABYRINTH VAULT",
    label: "VAULT",
    linger: 0.18,
    mobileClip: heroMobile,
    mobileObjectPosition: "50% 42%",
    mobilePoster: heroPosterMobile,
    objectPosition: "50% 50%",
    poster: heroPoster,
    scroll: 8.5,
    tags: ["BITCOIN", "MONERO", "AIR-GAPPED"],
    title: "YOUR PHONE. YOUR KEYS. YOUR VAULT.",
  },
];
