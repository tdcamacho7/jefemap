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

function cellBg(val: number, maxVal: number, minVal: number, isKingCell: boolean): string {
  if (isKingCell) return 'rgba(245,200,66,0.85)';
  if (!val) return 'rgba(8,145,178,0.13)';
  const intensity = val > 0
    ? Math.pow(val / maxVal, 0.5)
    : Math.pow(Math.abs(val) / Math.abs(minVal), 0.5);
  if (val > 0) return `rgba(8,145,178,${(0.13 + intensity * 0.75).toFixed(3)})`;
  return `rgba(147,51,234,${(0.13 + intensity * 0.80).toFixed(3)})`;
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
    timerRef.current = setInterval(() => fetchGex(ticker, maxExp), 60000);
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

  const nearestStrike = data
    ? data.strikes.reduce((p,c) => Math.abs(c-data.spotPrice)<Math.abs(p-data.spotPrice)?c:p)
    : null;

  return (
    <div style={{background:'#080b12',minHeight:'100vh',color:'#e2e8f0',fontFamily:"'IBM Plex Mono',monospace"}}>

      <div style={{padding:'12px 20px',borderBottom:'1px solid #1e2a3a',display:'flex',alignItems:'center',gap:12}}>
        <span style={{fontSize:20,fontWeight:700}}>
          <span style={{color:'#f5c842'}}>JEFE</span><span style={{color:'#e2e8f0'}}>MAP</span>
        </span>
        <span style={{fontSize:10,color:'#4a5568',marginLeft:8}}>PROOF OF CONCEPT v0.1</span>
      </div>

      <div style={{padding:'14px 20px',display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',borderBottom:'1px solid #1e2a3a'}}>
        <input value={input} onChange={e=>setInput(e.target.value.toUpperCase())}
          onKeyDown={e=>e.key==='Enter'&&handleScan()} placeholder="Ticker"
          style={{background:'#111827',border:'1px solid #2d3748',borderRadius:6,padding:'7px 12px',color:'#e2e8f0',fontSize:13,width:90,fontFamily:'inherit'}}/>
        <select value={maxExp} onChange={e=>setMaxExp(+e.target.value)}
          style={{background:'#111827',border:'1px solid #2d3748',borderRadius:6,padding:'7px 10px',color:'#e2e8f0',fontSize:12,fontFamily:'inherit'}}>
          {[3,5,8,12].map(n=><option key={n} value={n}>{n} exp</option>)}
        </select>
        <button onClick={handleScan} disabled={loading}
          style={{background:'#f5c842',color:'#080b12',border:'none',borderRadius:6,padding:'7px 22px',fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>
          {loading?'LOADING…':'SCAN'}
        </button>
        <button onClick={()=>setTrackKing(t=>!t)}
          style={{
            background:trackKing?'rgba(245,200,66,0.15)':'#111827',
            border:`1px solid ${trackKing?'#f5c842':'#2d3748'}`,
            borderRadius:6,padding:'7px 14px',
            color:trackKing?'#f5c842':'#64748b',
            fontSize:12,fontWeight:trackKing?700:400,
            cursor:'pointer',fontFamily:'inherit',
          }}>
          👑 {trackKing?'TRACKING KING':'TRACK KING'}
        </button>
        {lastUpdate&&<span style={{fontSize:11,color:'#4a5568'}}><span style={{color:'#22c55e',marginRight:6}}>●</span>Live · {lastUpdate}</span>}
        {error&&<span style={{color:'#ef4444',fontSize:12}}>⚠ {error}</span>}
      </div>

      {data&&(
        <div style={{margin:'12px 20px',background:'rgba(245,200,66,0.06)',border:'1px solid rgba(245,200,66,0.3)',borderRadius:8,padding:'14px 18px'}}>
          <div style={{fontSize:10,color:'#a18a30',marginBottom:4,letterSpacing:2}}>👑 KING NODE · {data.ticker}</div>
          <div style={{fontSize:11,color:'#94a3b8',marginBottom:4}}>{data.ticker} @ {fmtPrice(data.spotPrice)}</div>
          <div style={{fontSize:40,fontWeight:700,color:'#f5c842',lineHeight:1,marginBottom:6}}>{data.kingStrike}</div>
          <div style={{display:'flex',gap:12,marginTop:4,fontSize:11,flexWrap:'wrap'}}>
            <span style={{background:'rgba(245,200,66,0.2)',color:'#f5c842',padding:'3px 10px',borderRadius:4,fontWeight:700,border:'1px solid rgba(245,200,66,0.4)'}}>
              🟡 YELLOW · {fmt(data.kingGex)}
            </span>
            <span style={{color:'#64748b'}}>📍 {(data.spotPrice-data.kingStrike).toFixed(2)} pts from price</span>
            <span style={{color:'#3b82f6'}}>📅 {fmtExp(data.kingExp)}</span>
          </div>
        </div>
      )}

      {data&&(
        <div style={{padding:'8px 20px',display:'flex',gap:8,flexWrap:'wrap'}}>
          {[
            {label:'Ticker',val:data.ticker},
            {label:'Spot',val:fmtPrice(data.spotPrice)},
            {label:'Expirations',val:data.expirations.length},
            {label:'Total Net GEX',val:fmt(data.totalNetGex)},
            {label:'Regime',val:data.regime==='positive'?'🟡 GEX Positive':'🟣 GEX Negative'},
            {label:'+ Strikes',val:data.posStrikes,color:'#22c55e'},
            {label:'- Strikes',val:data.negStrikes,color:'#ef4444'},
          ].map(({label,val,color})=>(
            <div key={label} style={{background:'#0f172a',border:'1px solid #1e2a3a',borderRadius:6,padding:'5px 12px',fontSize:11}}>
              <span style={{color:'#64748b'}}>{label}: </span>
              <span style={{color:color||'#e2e8f0',fontWeight:600}}>{String(val)}</span>
            </div>
          ))}
        </div>
      )}

      {data?(
        <div style={{padding:'8px 20px 40px',overflowX:'auto'}}>
          <div style={{fontSize:11,color:'#64748b',marginBottom:10,display:'flex',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
            <span>{data.ticker} GEX HEATMAP · SPOT: {fmtPrice(data.spotPrice)} · {data.strikes.length} STRIKES · {data.expirations.length} EXPIRATIONS</span>
            <span style={{display:'flex',gap:16}}>
              <span style={{color:'#f5c842'}}>👑 King Node</span>
              <span style={{color:'#0891b2'}}>■ Absorbs</span>
              <span style={{color:'#9333ea'}}>■ Amplifies</span>
              <span style={{color:'#38bdf8'}}>● Current Price</span>
            </span>
          </div>
          <table style={{borderCollapse:'collapse',width:'100%',fontSize:12}}>
            <thead>
              <tr>
                <th style={{textAlign:'left',padding:'6px 12px',color:'#64748b',fontWeight:400,minWidth:90,position:'sticky',left:0,background:'#080b12',zIndex:2}}>Strike</th>
                {data.expirations.map(exp=>(
                  <th key={exp} style={{textAlign:'right',padding:'6px 10px',color:exp===data.kingExp?'#f5c842':'#64748b',fontWeight:exp===data.kingExp?600:400,minWidth:120}}>
                    {fmtExp(exp)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.strikes.map((strike,si)=>{
                const isKing     = strike===data.kingStrike;
                const isNearSpot = strike===nearestStrike;
                return(
                  <tr key={strike} ref={isKing?kingRowRef:null} style={{borderTop:'1px solid #0a0f1a'}}>
                    <td style={{
                      padding:'4px 12px',
                      background:isNearSpot?'rgba(56,189,248,0.08)':'#080b12',
                      borderRight:'1px solid #1e2a3a',
                      position:'sticky',left:0,zIndex:1,
                    }}>
                      <span style={{color:isKing?'#f5c842':isNearSpot?'#38bdf8':'#94a3b8',fontWeight:isKing||isNearSpot?700:400,fontSize:isKing?13:12}}>
                        {isKing?'👑 ':''}{strike}{isNearSpot&&!isKing?' ←':''}
                      </span>
                    </td>
                    {data.expirations.map((exp,ei)=>{
                      const val=data.values[si]?.[ei]??0;
                      const isKingCell=isKing&&exp===data.kingExp;
                      return(
                        <td key={exp} style={{padding:'4px 10px',textAlign:'right',background:cellBg(val,data.maxValue,data.minValue,isKingCell)}}>
                          <span style={{
                            color:isKingCell?'#080b12':(val>0?'#a5f3fc':val<0?'#c084fc':'#2a4a5a'),
                            fontWeight:isKingCell?700:400,
                          }}>
                            {val!==0?fmt(val):'—'}
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
            ?<><div style={{width:40,height:40,border:'3px solid #1e2a3a',borderTop:'3px solid #f5c842',borderRadius:'50%',animation:'spin 1s linear infinite'}}/><span>Fetching {ticker} options chain…</span></>
            :<span style={{fontSize:14}}>Enter a ticker and hit SCAN</span>
          }
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box}body{margin:0}
        tr:hover td{filter:brightness(1.15)}
      `}</style>
    </div>
  );
}
