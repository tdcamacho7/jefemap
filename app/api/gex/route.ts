import { NextRequest, NextResponse } from 'next/server';

const MD_TOKEN = process.env.MD_TOKEN!;
const MD_BASE  = 'https://api.marketdata.app/v1';

interface Contract {
  symbol:      string;
  side:        'call' | 'put';
  strike:      number;
  expiration:  string; // YYYY-MM-DD
  oi:          number;
  gamma:       number;
}

interface Cell {
  callGex: number;
  putGex:  number;
  netGex:  number;
}

function toDateStr(raw: number | string): string {
  if (typeof raw === 'number') {
    return new Date(raw * 1000).toISOString().split('T')[0];
  }
  return raw;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const ticker  = (searchParams.get('ticker') || 'SPY').toUpperCase();
  const maxExp  = parseInt(searchParams.get('maxExp') || '8');

  try {
    // 1. Live spot price
    const quoteRes  = await fetch(`${MD_BASE}/stocks/quotes/${ticker}/?token=${MD_TOKEN}`, { cache: 'no-store' });
    const quoteData = await quoteRes.json();
    const spotPrice: number = quoteData?.last?.[0] ?? quoteData?.mid?.[0] ?? 0;
    if (!spotPrice) return NextResponse.json({ error: 'Could not fetch spot price' }, { status: 500 });

    // 2. Full options chain with greeks
    const chainRes  = await fetch(
      `${MD_BASE}/options/chain/${ticker}/?token=${MD_TOKEN}&expiration=all&minOpenInterest=1`,
      { cache: 'no-store' }
    );
    const chainData = await chainRes.json();
    if (chainData?.s === 'error') return NextResponse.json({ error: chainData.errmsg }, { status: 500 });

    const n = chainData.optionSymbol?.length ?? 0;
    if (!n) return NextResponse.json({ error: 'No chain data' }, { status: 500 });

    // 3. Parse parallel arrays into contracts
    const today    = new Date().toISOString().split('T')[0];
    const strikeMin = spotPrice * 0.80;
    const strikeMax = spotPrice * 1.20;

    const rawContracts: Contract[] = [];
    for (let i = 0; i < n; i++) {
      const strike     = chainData.strike[i] as number;
      const expiration = toDateStr(chainData.expiration[i]);
      const oi         = (chainData.openInterest[i] as number) ?? 0;
      const gamma      = Math.abs((chainData.gamma[i] as number) ?? 0);
      const side       = chainData.side[i] as 'call' | 'put';

      if (!gamma || !oi)               continue;
      if (expiration < today)          continue; // exclude expired
      if (strike < strikeMin || strike > strikeMax) continue;

      rawContracts.push({ symbol: chainData.optionSymbol[i], side, strike, expiration, oi, gamma });
    }

    // 4. Get sorted unique expirations (limit to maxExp)
    const allExps = [...new Set(rawContracts.map(c => c.expiration))].sort().slice(0, maxExp);
    const expSet  = new Set(allExps);

    // 5. Get sorted unique strikes (descending)
    const allStrikes = [...new Set(rawContracts
      .filter(c => expSet.has(c.expiration))
      .map(c => c.strike)
    )].sort((a, b) => b - a);

    // 6. Build byStrike/byExp grid
    const grid: Record<number, Record<string, Cell>> = {};
    for (const strike of allStrikes) {
      grid[strike] = {};
      for (const exp of allExps) {
        grid[strike][exp] = { callGex: 0, putGex: 0, netGex: 0 };
      }
    }

    // 7. Accumulate GEX — cap each contract at $50M to kill outliers
    const GEX_CAP = 50_000_000;
    for (const c of rawContracts) {
      if (!expSet.has(c.expiration)) continue;
      if (!grid[c.strike])           continue;

      const rawGex  = c.gamma * c.oi * spotPrice * spotPrice;
      const capped  = Math.min(rawGex, GEX_CAP);

      if (c.side === 'call') {
        grid[c.strike][c.expiration].callGex += capped;
      } else {
        grid[c.strike][c.expiration].putGex  -= capped; // puts negative
      }
    }

    // 8. Compute net GEX and strike totals
    const strikeTotals: Record<number, number> = {};
    for (const strike of allStrikes) {
      let total = 0;
      for (const exp of allExps) {
        const cell = grid[strike][exp];
        cell.netGex = cell.callGex + cell.putGex;
        total += cell.netGex;
      }
      strikeTotals[strike] = total;
    }

    // 9. Build values matrix [strikeIndex][expIndex]
    const values: number[][] = allStrikes.map(strike =>
      allExps.map(exp => Math.round(grid[strike][exp].netGex))
    );

    // 10. King node, min/max, regime
    let kingStrike = allStrikes[0];
    let kingGex    = 0;
    for (const strike of allStrikes) {
      if (Math.abs(strikeTotals[strike]) > Math.abs(kingGex)) {
        kingGex    = strikeTotals[strike];
        kingStrike = strike;
      }
    }

    // King expiration = expiration with highest abs GEX for king strike
    let kingExp = allExps[0];
    let kingExpGex = 0;
    for (const exp of allExps) {
      const v = Math.abs(grid[kingStrike]?.[exp]?.netGex ?? 0);
      if (v > kingExpGex) { kingExpGex = v; kingExp = exp; }
    }

    const allValues  = values.flat().filter(v => v !== 0);
    const maxValue   = Math.max(...allValues.map(Math.abs), 1);
    const totalNetGex = Object.values(strikeTotals).reduce((a, b) => a + b, 0);
    const posStrikes  = allStrikes.filter(s => strikeTotals[s] > 0).length;
    const negStrikes  = allStrikes.filter(s => strikeTotals[s] < 0).length;
    const regime      = totalNetGex >= 0 ? 'positive' : 'negative';

    return NextResponse.json({
      ticker,
      spotPrice,
      expirations:  allExps,
      strikes:      allStrikes,
      values,
      strikeTotals,
      kingStrike,
      kingExp,
      kingGex,
      maxValue,
      totalNetGex,
      posStrikes,
      negStrikes,
      regime,
      timestamp: new Date().toISOString(),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
