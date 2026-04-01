import { NextRequest, NextResponse } from 'next/server';

const RISK_FREE_RATE = 0.05;
const MAX_GEX_PER_CONTRACT = 50_000_000;

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function blackScholesGamma(S: number, K: number, T: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  try {
    const d1 = (Math.log(S / K) + (RISK_FREE_RATE + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    return normalPDF(d1) / (S * sigma * Math.sqrt(T));
  } catch { return 0; }
}

function capGex(raw: number): number {
  return Math.sign(raw) * Math.min(Math.abs(raw), MAX_GEX_PER_CONTRACT);
}

function dateToYMD(ts: number): string {
  return new Date(ts * 1000).toISOString().split('T')[0];
}

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string }> {
  const homeRes = await fetch('https://finance.yahoo.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  const cookie = homeRes.headers.get('set-cookie') ?? '';

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': cookie,
    },
  });
  const crumb = await crumbRes.text();
  if (!crumb || crumb.includes('<')) throw new Error('Failed to get Yahoo crumb');
  return { crumb, cookie };
}

async function fetchYahoo(url: string, cookie: string, crumb: string) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}crumb=${encodeURIComponent(crumb)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Cookie': cookie,
    },
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status}`);
  return res.json();
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const ticker = (searchParams.get('ticker') || 'SPY').toUpperCase();
  const maxExp = Math.min(parseInt(searchParams.get('maxExp') || '5'), 8);

  try {
    // 1. Crumb handshake
    const { crumb, cookie } = await getYahooCrumb();

    // 2. Spot price + expiration list
    const base   = await fetchYahoo(`https://query1.finance.yahoo.com/v7/finance/options/${ticker}`, cookie, crumb);
    const result = base?.optionChain?.result?.[0];
    if (!result) throw new Error('No options data from Yahoo Finance');

    const spot: number = result.quote?.regularMarketPrice;
    if (!spot) throw new Error('Could not get spot price');

    const allExpirations: number[] = result.expirationDates ?? [];
    if (!allExpirations.length) throw new Error('No expirations found');

    // 3. Select nearest N expirations — skip same-day (T < 1 day)
    const now          = Date.now() / 1000;
    const oneDaySecs   = 86400;
    const selectedExps = allExpirations
      .filter(ts => ts > now + oneDaySecs)   // strictly future, skip today
      .slice(0, maxExp);

    if (!selectedExps.length) throw new Error('No future expirations found');

    // 4. Fetch all expirations in parallel
    const chains = await Promise.all(
      selectedExps.map(ts =>
        fetchYahoo(
          `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${ts}`,
          cookie, crumb
        )
          .then(d => ({ ts, data: d?.optionChain?.result?.[0]?.options?.[0] ?? null }))
          .catch(() => ({ ts, data: null }))
      )
    );

    // 5. 92 strikes centered on spot — matches Skylit default
    const center = Math.round(spot);
    const half   = 46;
    const lo     = center - half;
    const hi     = center + half;
    const strikes: number[] = [];
    for (let k = lo; k <= hi; k++) strikes.push(k);

    const expirationDates = selectedExps.map(dateToYMD);
    const matrix: number[][] = strikes.map(() => new Array(expirationDates.length).fill(0));
    let maxValue = 0;
    let minValue = 0;

    // 6. Build GEX matrix
    for (let ei = 0; ei < chains.length; ei++) {
      const { ts, data } = chains[ei];
      if (!data) continue;

      // T in years — clamp to minimum 2 days to prevent near-zero blowup
      const T = Math.max((ts - now) / (365 * 24 * 3600), 2 / 365);

      const processContracts = (contracts: Record<string, unknown>[], isCall: boolean) => {
        for (const c of contracts) {
          const K  = c.strike as number;
          const si = K - lo;
          if (si < 0 || si >= strikes.length) continue;

          const oi = (c.openInterest as number) ?? 0;
          const iv = (c.impliedVolatility as number) ?? 0;
          if (oi === 0 || iv === 0) continue;

          // Cap IV at 2.0 (200%) — Yahoo sometimes returns garbage high IV
          const sigma = Math.min(iv, 2.0);

          const gamma  = blackScholesGamma(spot, K, T, sigma);
          const rawGex = gamma * oi * spot * spot * (isCall ? 1 : -1);
          const gex    = capGex(rawGex);

          matrix[si][ei] += gex;
          if (matrix[si][ei] > maxValue) maxValue = matrix[si][ei];
          if (matrix[si][ei] < minValue) minValue = matrix[si][ei];
        }
      };

      processContracts((data.calls ?? []) as Record<string, unknown>[], true);
      processContracts((data.puts  ?? []) as Record<string, unknown>[], false);
    }

    // 7. King node — highest absolute single cell
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

    // 8. Stats
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
