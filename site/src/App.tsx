import { ScrollScrub } from "./components/scroll-scrub";
import { scrollScrubScenes, scrollScrubTheme } from "./scroll-scrub-scenes";
import qrPhones from "./assets/qr-phones.webp";
import drawerPhone from "./assets/drawer.webp";
import ledgerLegible from "./assets/ledger-legible.webp";
import ledgerObscured from "./assets/ledger-obscured.webp";
import nothingToConnect from "./assets/nothing-to-connect.webp";
import verifyLoupe from "./assets/verify-loupe.webp";
import "./labyrinth.css";

const architecture = [
  ["WALLET", "Builds a transaction"],
  ["WALLET", "Shows the unsigned transaction as QR"],
  ["VAULT", "Scans it"],
  ["VAULT", "Reads the transaction independently"],
  ["HUMAN", "Checks amount, destination, fee, and change"],
  ["VAULT", "Signs after approval"],
  ["WALLET", "Receives the signed transaction"],
  ["WALLET", "Broadcasts"],
];

const sourceAreas = [
  "AIRGAP PROTOCOL",
  "KEY DERIVATION",
  "TRANSACTION READER",
  "FAIL-CLOSED RULES",
  "NO-NETWORK TEST",
  "INTEROPERABILITY",
];

function Mark() {
  return <span className="lab-mark" aria-hidden="true"><i /><i /><i /></span>;
}

function Nav() {
  return (
    <header className="lab-nav">
      <a className="lab-brand" href="#top" aria-label="Labyrinth home"><Mark /><span className="lab-wordmark">LABYRINTH</span></a>
      <nav aria-label="Primary navigation">
        <a href="#wallet">WALLET</a><a href="#vault">VAULT</a><a href="#security">SECURITY</a><a href="#source">DOCS</a><a href="#source">GITHUB</a>
      </nav>
      <a className="nav-action" href="#start"><span>GET STARTED</span></a>
    </header>
  );
}

function Phone({ mode = "vault", compact = false }: { mode?: "vault" | "wallet"; compact?: boolean }) {
  return (
    <div className={`device ${compact ? "device-compact" : ""}`} aria-label={`${mode === "vault" ? "Labyrinth Vault" : "Labyrinth Wallet"} interface`}>
      <div className="device-speaker" />
      <div className="device-screen">
        <div className="screen-top"><Mark /><span>{mode === "vault" ? "VAULT" : "WALLET"}</span></div>
        {mode === "vault" ? (
          <div className="vault-ui">
            <span className="ui-label">SEND</span><strong>0.482731 <small>BTC</small></strong>
            <span className="ui-label">TO</span><b>bc1q7x9...</b>
            <div className="ui-grid"><span>FEE<b>0.000142 BTC</b></span><span>CHANGE<b>0.317891 BTC</b></span></div>
            <div className="verified">VERIFIED</div>
          </div>
        ) : (
          <div className="wallet-ui">
            <span className="ui-label">TOTAL BALANCE</span><strong>1.284 <small>BTC</small></strong>
            <div className="asset-row"><span>BTC</span><b>0.842</b></div>
            <div className="asset-row"><span>XMR</span><b>26.41</b></div>
            <div className="wallet-actions"><span>SEND</span><span>RECEIVE</span><span>SWAP</span></div>
            <div className="vault-linked">VAULT CONNECTED BY QR</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LabyrinthSite() {
  return (
    <main id="top" className="lab-site">
      <Nav />
      <section className="hero-journey" aria-label="Phone to Vault transformation">
        <ScrollScrub scenes={scrollScrubScenes} theme={scrollScrubTheme} />
        <div className="hero-ctas"><a href="#vault">EXPLORE VAULT</a><a href="#wallet">EXPLORE WALLET</a></div>
        <p className="hero-truth">The Vault has no networking code. Not disabled. Absent.</p>
      </section>

      <section className="idea-section section-pad">
        <div className="idea-copy">
          <h2>WHAT IF<br />THE HARDWARE<br />IS ALREADY<br />IN YOUR DRAWER?</h2>
          <p>An old iPhone already has a screen, camera, secure hardware, battery, and storage. The missing piece is software designed around isolation.</p>
        </div>
        <div className="exploded-phone" aria-label="Exploded view of an iPhone">
          <div className="phone-layer glass"><span>SCREEN</span></div><div className="phone-layer camera"><span>CAMERA</span></div><div className="phone-layer secure"><span>SECURE HARDWARE</span></div><div className="phone-layer battery"><span>BATTERY</span></div><div className="phone-layer storage"><span>STORAGE</span></div>
        </div>
      </section>

      <section id="vault" className="halves-section">
        <article className="half vault-half"><div><span className="product-name">LABYRINTH VAULT</span><h2>OFFLINE</h2><p>Holds private keys. Reads transactions. Shows exactly what will be signed. Signs only after approval.</p></div><Phone mode="vault" compact /></article>
        <div className="qr-bridge" aria-label="QR communication between devices"><div className="qr-core" /><span>QR</span></div>
        <article className="half wallet-half"><div><span className="product-name">LABYRINTH WALLET</span><h2>ONLINE</h2><p>Watches the blockchain. Builds transactions. Tracks balances. Broadcasts signed transactions.</p></div><Phone mode="wallet" compact /></article>
      </section>

      <section className="architecture section-pad">
        <h2>TWO DEVICES.<br />ONE WALLET.<br /><span>ZERO PRIVATE-KEY EXPOSURE.</span></h2>
        <div className="architecture-track">
          {architecture.map(([actor, action], index) => <article key={action}><span>{String(index + 1).padStart(2, "0")}</span><b>{actor}</b><p>{action}.</p></article>)}
        </div>
      </section>

      <section id="security" className="screen-security section-pad">
        <div className="sacred-copy"><h2>SHOW IT<br />TO A PERSON.</h2><p>The online device might be compromised. The Vault independently reconstructs the transaction. Then the human verifies it.</p></div>
        <Phone mode="vault" />
        <p className="boundary">THE SCREEN IS THE SECURITY BOUNDARY.</p>
      </section>

      <section className="fail-section section-pad">
        <h2>WHEN IT CANNOT<br />TELL THE TRUTH,<br /><span>IT DOES NOT SIGN.</span></h2>
        <div className="failure-stack">
          <article><span>CHANGE OUTPUT<br />DOES NOT MATCH</span><b>CANNOT SIGN.</b></article>
          <article><span>FEE UNKNOWN</span><b>CANNOT SIGN.</b></article>
          <article><span>TRANSACTION<br />DIGEST MISMATCH</span><b>CANNOT SIGN.</b></article>
        </div>
      </section>

      <section className="airgap section-pad">
        <div>
          <h2>NOTHING<br />TO CONNECT.</h2>
          <p>The absence is inspectable. The Vault target contains no network code, and the app says so rather than claiming to read your radios. Seeing those would need the very frameworks it refuses to link.</p>
          <img className="section-photo" src={nothingToConnect} alt="An old iPhone on a dark surface with its SIM tray ejected beside it, next to a coiled cable plugged into nothing" width={1280} height={859} loading="lazy" decoding="async" />
        </div>
        <div className="airgap-facts">
          <div className="airgap-group">
            <h3>THIS BUILD, AS FACT</h3>
            <dl>
              <div><dt>NETWORK CODE IN BINARY</dt><dd>NONE</dd></div>
              <div><dt>NETWORK PERMISSION</dt><dd>NOT REQUESTED</dd></div>
              <div><dt>CLOUD CONTAINER</dt><dd>NONE</dd></div>
              <div><dt>ACCOUNT</dt><dd>NONE</dd></div>
            </dl>
          </div>
          <div className="airgap-group airgap-yours">
            <h3>YOURS TO KEEP TRUE</h3>
            <dl>
              <div><dt>WI-FI</dt><dd>CHECK IN SETTINGS</dd></div>
              <div><dt>BLUETOOTH</dt><dd>CHECK IN SETTINGS</dd></div>
              <div><dt>CELLULAR</dt><dd>CHECK IN SETTINGS</dd></div>
              <div><dt>SIM</dt><dd>THE TRAY, NOT A SETTING</dd></div>
            </dl>
          </div>
        </div>
      </section>

      <section className="qr-language section-pad">
        <img src={qrPhones} alt="Two ordinary phones exchanging QR fragments" width={2400} height={1350} loading="lazy" decoding="async" />
        <div className="qr-copy"><h2>THE AIR GAP<br />HAS A LANGUAGE.</h2><strong>QR.</strong><p>The two halves communicate one direction at a time. Nothing pairs. Nothing stays connected.</p></div>
      </section>

      <section id="wallet" className="wallet-section section-pad">
        <div className="wallet-copy"><span className="product-name">LABYRINTH WALLET</span><h2>THE WALLET<br />YOU USE<br />EVERY DAY.</h2><p>Watch the chain. Prepare transactions. Track your funds. Broadcast signed transactions. The Wallet never needs your private keys.</p></div>
        <Phone mode="wallet" />
      </section>

      <section className="swap-section section-pad">
        <div className="swap-title"><h2>SWAP WITHOUT<br />GIVING UP<br />YOUR KEYS.</h2><p>Third-party providers execute the exchange. Labyrinth Vault protects your signing authority.</p></div>
        <div className="swap-panel">
          <span>YOU SEND</span><strong>0.025 BTC</strong><i>↓</i><span>YOU RECEIVE</span><strong>≈ 0.742 XMR</strong>
          <div className="swap-route"><b>WALLET</b><b>PROVIDER</b><b>VAULT</b><b>CHAIN</b><b>XMR</b></div>
        </div>
      </section>

      <section className="chains-section section-pad">
        <h2>DIFFERENT CHAINS.<br />SAME PRINCIPLE.</h2>
        <div className="chain-worlds">
          <article>
            <img className="chain-photo" src={ledgerLegible} alt="A continuous-feed printout under hard light, its rows of characters legible" width={1400} height={939} loading="lazy" decoding="async" />
            <span>BTC</span><h3>BITCOIN</h3><p>Transparent transaction structure. Human-readable outputs. Offline signing.</p>
          </article>
          <article>
            <img className="chain-photo" src={ledgerObscured} alt="The same printout on the same desk under the same light, its rows faded past reading" width={1400} height={933} loading="lazy" decoding="async" />
            <span>XMR</span><h3>MONERO</h3><p>Private-by-default protocol. The same separation between online watch and offline authority.</p>
          </article>
        </div>
        <p className="offline-line">YOUR KEYS STAY OFFLINE.</p>
      </section>

      <section className="drawer-section">
        <img src={drawerPhone} alt="An old iPhone resting in a dark drawer" width={2400} height={1600} loading="lazy" decoding="async" />
        <div><h2>GIVE THE PHONE<br />IN YOUR DRAWER<br />A NEW JOB.</h2><ol><li>Pick it up.</li><li>Install Labyrinth.</li><li>Turn the radios off.</li><li>Check the build&rsquo;s half.</li><li>Generate keys.</li></ol><strong>LABYRINTH VAULT</strong></div>
      </section>

      <section className="manifesto section-pad">
        <h2>NO CLOUD.<br />NO ACCOUNT.<br />NO PRIVATE KEYS<br />ON THE ONLINE DEVICE.<br />NO NETWORK<br />IN THE VAULT.<br />NO BLIND SIGNING.<br />NO “TRUST US.”</h2>
        <div className="verify-call">VERIFY IT.</div>
        <p className="audit-warning">The software is early. It has not been independently audited. Do not put funds you cannot afford to lose into an unaudited system.</p>
      </section>

      <section id="source" className="source-section section-pad">
        <div><h2>DON’T TRUST.<br />VERIFY.</h2><p>Labyrinth is designed to be inspected, challenged, and improved.</p></div>
        <div className="source-grid">{sourceAreas.map((area) => <span key={area}>{area}</span>)}</div>
        <img className="source-photo" src={verifyLoupe} alt="A jeweller’s loupe resting on a printed sheet of hexadecimal, the characters under the glass magnified and sharp" width={1200} height={805} loading="lazy" decoding="async" />
        <a className="source-action" href="https://github.com/LetsGetToWorkBro/labyrinth-vault" target="_blank" rel="noreferrer"><span>VIEW SOURCE</span><b>↗</b></a>
      </section>

      <section className="philosophy section-pad"><p>THE ONLINE<br />DEVICE<br />CAN BE<br /><strong>COMPROMISED.</strong></p><p>SO DON’T<br /><strong>TRUST IT.</strong></p><p>SHOW THE<br />TRANSACTION<br /><strong>TO A PERSON.</strong></p><p>THEN<br /><strong>SIGN.</strong></p></section>

      <section className="comparison section-pad">
        <h2>THE WALLET WATCHES.<br />THE VAULT SIGNS.</h2>
        <div className="comparison-grid"><article><h3>LABYRINTH WALLET</h3><strong>ONLINE</strong><span>WATCHES CHAIN</span><span>BUILDS TRANSACTIONS</span><span>SWAPS</span><span>BROADCASTS</span></article><article><h3>LABYRINTH VAULT</h3><strong>OFFLINE</strong><span>HOLDS KEYS</span><span>READS TRANSACTIONS</span><span>VERIFIES</span><span>SIGNS</span></article></div>
      </section>

      <section id="start" className="start-section section-pad">
        <h2>TWO HALVES.<br />ONE SYSTEM.</h2>
        <div className="product-panels"><article><span>ONLINE</span><h3>LABYRINTH<br />WALLET</h3><p>Your everyday Bitcoin and Monero wallet.</p><a href="#wallet">EXPLORE WALLET</a></article><article><span>OFFLINE</span><h3>LABYRINTH<br />VAULT</h3><p>Turn an old iPhone into an offline signing device.</p><a href="#vault">EXPLORE VAULT</a></article></div>
      </section>

      <footer className="final-cta section-pad">
        <div className="final-phone"><Phone mode="vault" compact /></div>
        <h2>KEEP THE KEYS<br />OFFLINE.</h2><p>Labyrinth Wallet + Labyrinth Vault</p><a className="final-action" href="#top"><Mark /><span>EXPLORE LABYRINTH</span></a>
        <div className="footer-links"><a href="https://github.com/LetsGetToWorkBro/labyrinth-vault" target="_blank" rel="noreferrer">GITHUB</a><a href="https://github.com/LetsGetToWorkBro/labyrinth-vault/tree/main/docs" target="_blank" rel="noreferrer">DOCUMENTATION</a><a href="#security">SECURITY</a></div>
        <small>Early software. Not independently audited.</small>
      </footer>
    </main>
  );
}
