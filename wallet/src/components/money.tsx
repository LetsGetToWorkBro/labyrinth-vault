/**
 * Amounts, rendered as an instrument reads them.
 *
 * The one idea in this file: an amount is not a string. The integer part is
 * the thing being read; the fraction is precision, and precision past what the
 * eye needs is reference material. So they are set differently — the whole
 * number bright and large, the significant fraction a step down, the tail of
 * the fraction dimmer still, and the ticker smaller again and never bold.
 *
 * `0.482731 BTC` set flat is six characters of equal importance and a person
 * reads it left to right, one digit at a time. Set as a readout, the eye lands
 * on `0.4827` and can go and find the rest if it wants to. No digit is
 * dropped, ever, at any size — see `splitAmount`. Dimming is not rounding.
 *
 * The fiat line sits *under* the crypto amount and is smaller, everywhere in
 * this application. That is a statement about what the product is: the number
 * of coins is the fact and the dollar figure is a convenience whose source is
 * a price feed that might be wrong. Wallets that put the dollar figure first
 * have decided their user is a speculator; this one has not.
 */

import { View } from 'react-native';
import { Body, Label, Mono, Small } from '../design/text';
import { assetColor, color, space, tabular, type } from '../design/tokens';
import { fiatCents, formatFiat, group, splitAmount } from '../core/units';
import type { Asset, Atoms } from '../core/model';
import { Text } from 'react-native';

export function Amount({
  atoms,
  asset,
  size = 'readout',
  tone = color.bone,
  ticker = true,
  align = 'left',
}: {
  atoms: Atoms;
  asset: Asset;
    size?: 'display' | 'readout' | 'strong' | undefined;
    tone?: string | undefined;
    ticker?: boolean | undefined;
    align?: 'left' | 'right' | 'center' | undefined;
}) {
  const parts = splitAmount(atoms, asset);
  const scale = size === 'display' ? type.display : size === 'readout' ? type.readout : type.strong;
  const tailScale = size === 'strong' ? 1 : 0.62;
  const bright = parts.fraction.slice(0, parts.significant);
  const tail = parts.fraction.slice(parts.significant);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
      }}
    >
      <Text style={[scale, tabular, { color: tone }]}>{group(parts.whole)}</Text>
      {parts.fraction ? (
        <>
          <Text style={[scale, tabular, { color: tone }]}>.</Text>
          <Text style={[scale, tabular, { color: tone }]}>{bright}</Text>
          {tail ? (
            <Text
              style={[
                scale,
                tabular,
                {
                  color: color.slate,
                  fontSize: scale.fontSize * (size === 'strong' ? 1 : 0.78),
                },
              ]}
            >
              {tail}
            </Text>
          ) : null}
        </>
      ) : null}
      {ticker ? (
        <Text
          style={[
            type.label,
            {
              color: tone === color.bone ? color.slate : tone,
              marginLeft: size === 'strong' ? 6 : 10,
              fontSize: Math.max(10.5, scale.fontSize * tailScale * 0.34),
            },
          ]}
        >
          {asset}
        </Text>
      ) : null}
    </View>
  );
}

export function FiatLine({
  atoms,
  asset,
  centsPerUnit,
  stale,
  align = 'left',
}: {
  atoms: Atoms;
  asset: Asset;
  centsPerUnit: number;
    stale?: boolean | undefined;
    align?: 'left' | 'right' | undefined;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
      <Body tone={color.ash}>{formatFiat(fiatCents(atoms, asset, centsPerUnit))}</Body>
      {stale ? <Label tone={color.dim}>LAST KNOWN</Label> : null}
    </View>
  );
}

/**
 * One asset in a list: name, holding, value, and a color that is doing the
 * least work on the row rather than the most.
 */
export function AssetLine({
  asset,
  balance,
  centsPerUnit,
}: {
  asset: Asset;
  balance: Atoms;
  centsPerUnit: number;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.gap, gap: space.gap }}>
      <View style={{ width: 3, height: 34, borderRadius: 2, backgroundColor: assetColor(asset) }} />
      <View style={{ flex: 1 }}>
        <Label tone={color.bone}>{asset === 'BTC' ? 'BITCOIN' : 'MONERO'}</Label>
        <Small tone={color.slate} style={{ marginTop: 4 }}>
          {formatFiat(centsPerUnit)} per {asset}
        </Small>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Amount atoms={balance} asset={asset} size="strong" ticker={false} />
        <Small tone={color.ash} style={{ marginTop: 4 }}>
          {formatFiat(fiatCents(balance, asset, centsPerUnit))}
        </Small>
      </View>
    </View>
  );
}

/**
 * An address, set to be compared against another screen.
 *
 * Grouped in fours, monospaced, wrapping. This is the layout the entire
 * security model ends at: a person reading a destination here and the same
 * destination on the vault, and agreeing they are the same. Anything that
 * makes that harder — a smaller size, a proportional face, a single unbroken
 * run of forty-two characters — is a security regression that looks like a
 * design decision.
 */
export function AddressBlock({
  address,
  tone = color.bone,
  size = 15,
}: {
  address: string;
    tone?: string | undefined;
    size?: number | undefined;
}) {
  const groups: string[] = [];
  for (let i = 0; i < address.length; i += 4) groups.push(address.slice(i, i + 4));

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 4 }}>
      {groups.map((chunk, index) => (
        <Mono key={index} tone={tone} size={size}>
          {chunk}
        </Mono>
      ))}
    </View>
  );
}
