import { NextRequest, NextResponse } from 'next/server';

const TOKEN = process.env.MARKETDATA_TOKEN || 'b1NVbFY5LU96TWlmVDRCVTRXYXFaOXVCTjh3LVFOLTMyQjhtRERHRTFjUT0';
const BASE  = 'https://api.marketdata.app/v1';
const STRIKE_RANGE = 0.15; // ±15% of spot

function toDateStr(exp: number | string): string {
  if (typeof exp === 'number') {
    return new Date(exp * 1000).toISOString().split('T')[0];
  }
  return String(exp).split('T')[0];
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const ticker = (searchParams.get('ticker') || 'SPY').toUpperCase();
  const maxExp = Math.min(parseInt(searchParams.get('maxExp') || '5'), 8);

  try {
    // ── 1. Spot price ──────────────────────────────────────────────────────
    const qRes  = await fetch(`${BASE}/stocks/quotes/${ticker}/?token=${TOKEN}`, { next: { revalidate: 0 } });
    const qData = await qRes.json();
    if (qData.s === 'error') throw new Error(qData.errmsg || 'Quote failed');
    const spot: number = qData.last?.[0] ?? qData.mid?.[0];
    if (!spot) throw new Error('Cannot determine spot price');

    // ── 2. Options chain with real gamma ───────────────────────────────────
    const oRes  = await fetch(
      `${BASE}/options/chain/${ticker}/?token=${TOKEN}&minOpenInterest=1`,
      { next: { revalidate: 0 } }
    );
    const oData = await oRes.json();
    if (oData.s === 'error') throw new Error(oData.errmsg || 'Options chain failed');

    const {
      side,
      strike:       strikeArr,
      expiration:   expArr,
      openInterest: oiArr,
      gamma:        gammaArr,
    } = oData as {
      side:         string[];
      strike:       number[];
      expiration:   (number | string)[];
      openInterest: number[];
      gamma:        number[];
    };

    const todayStr = new Date().toISOString().split('T')[0];

    // ── 3. Build expiration list — skip SAME-DAY (today) ──────────────────
    const expSet = new Set<string>();
    for (const raw of expArr) {
      const ds = toDateStr(raw);
      if (ds > todayStr) expSet.add(ds);    // strictly future only
    }
    const allExps = Array.from(expSet).sort();
    const expirationDates = allExps.slice(0, maxExp);
    if (expirationDates.length === 0) throw new Error('No future expirations found');

    // ── 4. Strike range ────────────────────────────────────────────────────
    const lo = spot * (1 - STRIKE_RANGE);
    const hi = spot * (1 + STRIKE_RANGE);

    const strikeSet = new Set<number>();
    for (let i = 0; i < strikeArr.length; i++) {
      const k   = Number(strikeArr[i]);
      const ds  = toDateStr(expArr[i]);
      if (k >= lo && k <= hi && expirationDates.includes(ds)) {
        strikeSet.add(k);
      }
    }
    const strikes = Array.from(strikeSet).sort((a, b) => a - b);
    if (strikes.length === 0) throw new Error('No strikes in range');

    // ── 5. Build GEX matrix ────────────────────────────────────────────────
    //
    //  Standard GEX formula (SpotGamma methodology):
    //    GEX = gamma × OI × spot² × 100
    //
    //  gamma   = actual market gamma from marketdata.app (per share, per $1 move)
    //  OI      = open interest in contracts
    //  spot²   = spot price squared (dollar exposure scaling)
    //  100     = shares per standard equity option contract
    //  sign    = +1 for calls, -1 for puts
    //
    const matrix: number[][] = Array.from(
      { length: strikes.length },
      () => Array(expirationDates.length).fill(0)
    );

    for (let i = 0; i < strikeArr.length; i++) {
      const k  = Number(strikeArr[i]);
      const g  = Number(gammaArr[i])        || 0;
      const oi = Number(oiArr[i])           || 0;
      const ds = toDateStr(expArr[i]);
      const isCall = side[i] === 'call';

      if (g === 0 || oi === 0) continue;
      if (k < lo || k > hi)   continue;

      const ei = expirationDates.indexOf(ds);
      if (ei === -1) continue;

      const si = strikes.indexOf(k);
      if (si === -1) continue;

      // Real GEX — using actual gamma, not Black-Scholes from IV
      const gex = g * oi * spot * spot * 100 * (isCall ? 1 : -1);
      matrix[si][ei] += gex;
    }

    // ── 6. King node (highest absolute single cell) ────────────────────────
    let kingStrike = strikes[0];
    let kingExp    = expirationDates[0];
    let kingGex    = 0;
    let kingAbs    = 0;

    for (let si = 0; si < strikes.length; si++) {
      for (let ei = 0; ei < expirationDates.length; ei++) {
        const abs = Math.abs(matrix[si][ei]);
        if (abs > kingAbs) {
          kingAbs    = abs;
          kingGex    = matrix[si][ei];
          kingStrike = strikes[si];
          kingExp    = expirationDates[ei];
        }
      }
    }

    // ── 7. Stats ───────────────────────────────────────────────────────────
    const strikeTotals: Record<number, number> = {};
    let totalNetGex = 0;
    let posStrikes  = 0;
    let negStrikes  = 0;

    for (let si = 0; si < strikes.length; si++) {
      const rowTotal = matrix[si].reduce((a, b) => a + b, 0);
      strikeTotals[strikes[si]] = rowTotal;
      totalNetGex += rowTotal;
      if (rowTotal > 0) posStrikes++;
      else if (rowTotal < 0) negStrikes++;
    }

    return NextResponse.json({
      ticker,
      spotPrice:   spot,
      expirations: expirationDates,
      strikes,
      values:      matrix,
      strikeTotals,
      kingStrike,
      kingExp,
      kingGex,
      maxValue:    0,   // page.tsx computes from actual values
      minValue:    0,
      totalNetGex,
      posStrikes,
      negStrikes,
      regime:      totalNetGex >= 0 ? 'positive' : 'negative',
      timestamp:   new Date().toISOString(),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
