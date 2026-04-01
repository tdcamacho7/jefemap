cp -r ~/Desktop/jefemap/ ~/Desktop/jefemap-backup-$(date +%Y%m%d)/

Overwrite app/page.tsx with exactly this content:

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

interface GexData {
  ticker:       string;
  spotPrice:    number;
  expirations:  string[];
  strikes:      number[];
  values:       number[][];
  strikeTotals: Record<number, number>;
  kingStrike:   number;
  kingExp:      string;
  kingGex:      number;
  maxValue:     number;
  minValue:     number;
  totalNetGex:  number;
  posStrikes:   number;
  negStrikes:   number;
  regime:       'positive' | 'negative';
  timestamp:    string;
}

function fmt(val: number): string {
  const abs = Math.abs(val);
  let s: string;
  if      (abs >= 1e9) s = (abs/1e9).toFixed(1)+'B';
  else if (abs >= 1e6) s = (abs/1e6).toFixed(1)+'M';
  else if (abs >= 1e3) s = (abs/1e3).toFixed(1)+'K';
  else                 s = abs.toFixed(0);
  return (val < 0 ? '-$' : '$') + s;
}

function fmtPrice(p: number): string {
  return '$'+p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}

function fmtExp(exp: string): string {
  const d = new Date(exp+'T12:00:00');
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

function computeMinMax(values: number[][]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const row of values) {
    for (const v of row) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity)  min = 0;
  if (max === -Infinity) max = 0;
  return { min, max };
}

function cellBg(val: number, maxVal: number, minVal: number, isKingCell: boolean): string {
  if (isKingCell) return 'rgba(245,200,66,0.85)';
  if (val === 0)  return 'rgba(8,145,178,0.07)';
  if (val > 0) {
    const t = maxVal > 0 ? Math.pow(val / maxVal, 0.5) : 0;
    const alpha = 0.08 + t * 0.82;
    return `rgba(8,145,178,${alpha.toFixed(3)})`;
  } else {
    const t = minVal < 0 ? Math.pow(val / minVal, 0.5) : 0;
    const alpha = 0.08 + t * 0.82;
    return `rgba(147,51,234,${alpha.toFixed(3)})`;
  }
}

function cellTextColor(val: number, isKingCell: boolean): string {
  if (isKingCell) return '#080b12';
  if (val > 0)    return '#a5f3fc';
  if (val < 0)    return '#c084fc';
  return '#1e3a4a';
}

export default function Home() {
  const [ticker,     setTicker]     = useState('SPY');
  const [input,      setInput]      = useState('SPY');
  const [maxExp,     setMaxExp]     = useState(5);
  const [data,       setData]       = useState<GexData|null>(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string|null>(null);
  const [lastUpdate, setLastUpdate] = useState('');
  const [trackKing,  setTrackKing]  = useState(false);
  const timerRef   = useRef<ReturnType<typeof setInterval>|null>(null);
  const kingRowRef = useRef<HTMLTableRowElement|null>(null);

  const fetchGex = useCallback(async (tkr: string, exp: number) => {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`/api/gex?ticker=${tkr}&maxExp=${exp}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch(e: unknown) {
      setError(e instanceof Error ? e.message : 'Fetch failed');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchGex(ticker, maxExp);
    timerRef.current = setInterval(() => fetchGex(ticker, maxExp), 30000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [ticker, maxExp, fetchGex]);

  useEffect(() => {
    if (trackKing && kingRowRef.current) {
      kingRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [trackKing, data]);

  function handleScan() {
    const t = input.trim().toUpperCase();
    if (!t) return;
    if (timerRef.current) clearInterval(timerRef.current);
    setTicker(t);
  }

  const { min: visMin, max: visMax } = data
    ? computeMinMax(data.values)
    : { min: 0, max: 0 };

  const nearestStrike = data
    ? data.strikes.reduce((p,c) => Math.abs(c-data.spotPrice)<Math.abs(p-data.spotPrice)?c:p)
    : null;

  return (
    <div style={{background:'#0a0a0a',minHeight:'100vh',color:'#e2e8f0',fontFamily:"'IBM Plex Mono',monospace"}}>

      <div style={{padding:'12px 20px',borderBottom:'1px solid #27272a',display:'flex',alignItems:'center',gap:12}}>
        <span style={{fontSize:20,fontWeight:700}}>
          <span style={{color:'#f5c842'}}>JEFE</span><span style={{color:'#e2e8f0'}}>MAP</span>
        </span>
        <span style={{fontSize:10,color:'#52525b',marginLeft:8}}>PROOF OF CONCEPT v0.2</span>
      </div>

      <div style={{padding:'14px 20px',display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',borderBottom:'1px solid #27272a'}}>
        <input value={input} onChange={e=>setInput(e.target.value.toUpperCase())}
          onKeyDown={e=>e.key==='Enter'&&handleScan()} placeholder="Ticker"
          style={{background:'#18181b',border:'1px solid #3f3f46',borderRadius:6,padding:'7px 12px',color:'#e2e8f0',fontSize:13,width:90,fontFamily:'inherit'}}/>
        <select value={maxExp} onChange={e=>setMaxExp(+e.target.value)}
          style={{background:'#18181b',border:'1px solid #3f3f46',borderRadius:6,padding:'7px 10px',color:'#e2e8f0',fontSize:12,fontFamily:'inherit'}}>
          {[3,5,8,12].map(n=><option key={n} value={n}>{n} exp</option>)}
        </select>
        <button onClick={handleScan} disabled={loading}
          style={{background:'#f5c842',color:'#080b12',border:'none',borderRadius:6,padding:'7px 22px',fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>
          {loading?'LOADING…':'SCAN'}
        </button>
        <button onClick={()=>setTrackKing(t=>!t)}
          style={{
            background:trackKing?'rgba(245,200,66,0.15)':'#18181b',
            border:`1px solid ${trackKing?'#f5c842':'#3f3f46'}`,
            borderRadius:6,padding:'7px 14px',
            color:trackKing?'#f5c842':'#71717a',
            fontSize:12,fontWeight:trackKing?700:400,
            cursor:'pointer',fontFamily:'inherit',
          }}>
          👑 {trackKing?'TRACKING KING':'TRACK KING'}
        </button>
        {lastUpdate&&<span style={{fontSize:11,color:'#52525b'}}><span style={{color:'#22c55e',marginRight:6}}>●</span>Live · {lastUpdate}</span>}
        {error&&<span style={{color:'#ef4444',fontSize:12}}>⚠ {error}</span>}
      </div>

      {data&&(
        <div style={{margin:'12px 20px',background:'rgba(245,200,66,0.06)',border:'1px solid rgba(245,200,66,0.3)',borderRadius:8,padding:'14px 18px'}}>
          <div style={{fontSize:10,color:'#a18a30',marginBottom:4,letterSpacing:2}}>👑 KING NODE · {data.ticker}</div>
          <div style={{fontSize:11,color:'#94a3b8',marginBottom:4}}>{data.ticker} @ {fmtPrice(data.spotPrice)}</div>
          <div style={{fontSize:40,fontWeight:700,color:'#f5c842',lineHeight:1,marginBottom:6}}>{data.kingStrike}</div>
          <div style={{display:'flex',gap:12,marginTop:4,fontSize:11,flexWrap:'wrap'}}>
            <span style={{background:'rgba(245,200,66,0.2)',color:'#f5c842',padding:'3px 10px',borderRadius:4,fontWeight:700,border:'1px solid rgba(245,200,66,0.4)'}}>
              {fmt(data.kingGex)}
            </span>
            <span style={{color:'#64748b'}}>📍 {(data.spotPrice-data.kingStrike).toFixed(2)} pts from spot</span>
            <span style={{color:'#3b82f6'}}>📅 {fmtExp(data.kingExp)}</span>
            <span style={{color:'#52525b',fontSize:10}}>Color scale: {fmt(visMin)} → {fmt(visMax)}</span>
          </div>
        </div>
      )}

      {data&&(
        <div style={{padding:'8px 20px',display:'flex',gap:8,flexWrap:'wrap'}}>
          {[
            {label:'Spot',val:fmtPrice(data.spotPrice)},
            {label:'Net GEX',val:fmt(data.totalNetGex)},
            {label:'Regime',val:data.regime==='positive'?'🟡 Positive':'🟣 Negative'},
            {label:'+ Strikes',val:data.posStrikes,color:'#22c55e'},
            {label:'- Strikes',val:data.negStrikes,color:'#ef4444'},
          ].map(({label,val,color})=>(
            <div key={label} style={{background:'#111111',border:'1px solid #27272a',borderRadius:6,padding:'5px 12px',fontSize:11}}>
              <span style={{color:'#71717a'}}>{label}: </span>
              <span style={{color:color||'#e2e8f0',fontWeight:600}}>{String(val)}</span>
            </div>
          ))}
        </div>
      )}

      {data?(
        <div style={{padding:'8px 20px 40px',overflowX:'auto'}}>
          <table style={{borderCollapse:'collapse',fontSize:'10px',width:'100%',tableLayout:'auto'}}>
            <thead style={{position:'sticky',top:0,zIndex:30}}>
              <tr>
                <th style={{textAlign:'left',padding:'4px 8px',color:'rgba(255,255,255,0.85)',fontWeight:600,fontSize:'9px',minWidth:64,position:'sticky',left:0,background:'#0a0a0a',zIndex:40,borderBottom:'1px solid rgba(255,255,255,0.1)'}}>Strike</th>
                {data.expirations.map(exp=>(
                  <th key={exp} style={{textAlign:'center',padding:'4px 4px',color:exp===data.kingExp?'#f5c842':'rgba(255,255,255,0.85)',fontWeight:600,fontSize:'9px',minWidth:90,background:'#0a0a0a',borderBottom:'1px solid rgba(255,255,255,0.1)',whiteSpace:'nowrap'}}>
                    {fmtExp(exp)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...data.strikes].reverse().map((strike,revIdx)=>{
                const si = data.strikes.length - 1 - revIdx;
                const isKing     = strike===data.kingStrike;
                const isNearSpot = strike===nearestStrike;
                const spotRow    = isNearSpot && !isKing;
                return(
                  <tr key={strike} ref={isKing ? kingRowRef : null}>
                    <td style={{
                      position:'sticky',left:0,zIndex:10,
                      padding:'1px 8px',height:'18px',whiteSpace:'nowrap',
                      background: isKing ? '#ffffff' : spotRow ? '#18181b' : '#0a0a0a',
                      color: isKing ? '#000000' : spotRow ? '#ffffff' : 'rgba(255,255,255,0.8)',
                      fontWeight: isKing || spotRow ? 700 : 500,
                      fontSize:'11px',
                      clipPath: spotRow ? 'polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%)' : undefined,
                    }}>
                      {strike.toFixed(1)}
                    </td>
                    {data.expirations.map((exp,ei)=>{
                      const val=data.values[si]?.[ei]??0;
                      const isKingCell=isKing&&exp===data.kingExp;
                      return(
                        <td key={exp} style={{
                          padding:'1px 8px',height:'18px',textAlign:'right',
                          background: cellBg(val, visMax, visMin, isKingCell),
                          boxShadow: isKingCell ? 'inset 0 0 0 2px rgba(168,85,247,0.6)' : 'none',
                          whiteSpace:'nowrap',
                        }}>
                          <span style={{color:cellTextColor(val,isKingCell),fontWeight:isKingCell?700:400,fontSize:'10px'}}>
                            {val!==0 ? fmt(val) : '$0.00'}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ):(
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:400,gap:16,color:'#64748b'}}>
          {loading
            ?<><div style={{width:40,height:40,border:'3px solid #27272a',borderTop:'3px solid #f5c842',borderRadius:'50%',animation:'spin 1s linear infinite'}}/><span>Fetching {ticker} options chain…</span></>
            :<span style={{fontSize:14}}>Enter a ticker and hit SCAN</span>
          }
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box}body{margin:0}
        tr:hover td{filter:brightness(1.2)}
      `}</style>
    </div>
  );
}
