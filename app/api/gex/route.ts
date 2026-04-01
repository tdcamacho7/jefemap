import { NextRequest, NextResponse } from 'next/server';

const RISK_FREE_RATE = 0.05;
const MAX_GEX_PER_CONTRACT = 50_000_000;
const STRIKE_RANGE = 0.20; // ±20% of spot

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function blackScholesGamma(S: number, K: number, T: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  try {
    const d1 = (Math.log(S / K) + (RISK_FREE_RATE + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    return normalPDF(d1) / (S * sigma * Math.sqrt(T));
  } catch {
    return 0;
  }
}

function capGex(raw: number): number {
  return Math.sign(raw) * Math.min(Math.abs(raw), MAX_GEX_PER_CONTRACT);
}

function dateToYMD(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toISOString().split('T')[0];
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchYahoo(url: string) {
  const res = await fetch(url, { headers: YAHOO_HEADERS, next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status} ${url}`);
  return res.json();
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const ticker  = (searchParams.get('ticker') || 'SPY').toUpperCase();
  const maxExp  = Math.min(parseInt(searchParams.get('maxExp') || '5'), 8);

  try {
    // 1. Get spot price + expiration list
    const base = await fetchYahoo(
      `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`
    );

    const result = base?.optionChain?.result?.[0];
    if (!result) throw new Error('No options data from Yahoo Finance');

    const spot: number = result.quote?.regularMarketPrice;
    if (!spot) throw new Error('Could not get spot price');

    const allExpirations: number[] = result.expirationDates ?? [];
    if (!allExpirations.length) throw new Error('No expirations found');

    // 2. Pick nearest N expirations
    const now = Date.now() / 1000;
    const selectedExps = allExpirations
      .filter(ts => ts >= now - 86400) // include today
      .slice(0, maxExp);

    // 3. Fetch all expirations in parallel
    const chains = await Promise.all(
      selectedExps.map(ts =>
        fetchYahoo(`https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${ts}`)
          .then(d => ({ ts, data: d?.optionChain?.result?.[0]?.options?.[0] ?? null }))
          .catch(() => ({ ts, data: null }))
      )
    );

    // 4. Build strike universe (±20% of spot, step $1)
    const lo = Math.floor(spot * (1 - STRIKE_RANGE));
    const hi = Math.ceil(spot  * (1 + STRIKE_RANGE));
    const strikes: number[] = [];
    for (let k = lo; k <= hi; k++) strikes.push(k);

    const expirationDates = selectedExps.map(dateToYMD);

    // 5. Build GEX matrix
    // matrix[strikeIndex][expIndex] = gex value
    const matrix: number[][] = strikes.map(() => new Array(expirationDates.length).fill(0));
    let maxValue = 0;
    let minValue = 0;

    for (let ei = 0; ei < chains.length; ei++) {
      const { ts, data } = chains[ei];
      if (!data) continue;

      const expDate = dateToYMD(ts);
      const T = Math.max((ts - now) / (365 * 24 * 3600), 1 / 365); // min 1 day

      const processContracts = (contracts: any[], isCall: boolean) => {
        for (const c of contracts) {
          const K: number = c.strike;
          if (K < lo || K > hi) continue;
          const si = K - lo; // index into strikes array (step 1)
          if (si < 0 || si >= strikes.length) continue;

          const oi: number    = c.openInterest ?? 0;
          const iv: number    = c.impliedVolatility ?? 0;
          if (oi === 0 || iv === 0) continue;

          const gamma  = blackScholesGamma(spot, K, T, iv);
          const rawGex = gamma * oi * spot * spot * (isCall ? 1 : -1);
          const gex    = capGex(rawGex);

          matrix[si][ei] += gex;

          if (matrix[si][ei] > maxValue) maxValue = matrix[si][ei];
          if (matrix[si][ei] < minValue) minValue = matrix[si][ei];
        }
      };

      processContracts(data.calls ?? [], true);
      processContracts(data.puts  ?? [], false);
    }

    // 6. Find king node (highest absolute single cell)
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

    // 7. Compute stats
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
      spotPrice:    spot,
      expirations:  expirationDates,
      strikes,
      values:       matrix,
      strikeTotals,
      kingStrike,
      kingExp,
      kingGex,
      maxValue,
      minValue,
      totalNetGex,
      posStrikes,
      negStrikes,
      regime:       totalNetGex >= 0 ? 'positive' : 'negative',
      timestamp:    new Date().toISOString(),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
