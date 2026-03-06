import { useState, useMemo, useCallback, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── Constants ────────────────────────────────────────────────────────────────
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const BLOCK4_LABELS = ["12AM–4AM","4AM–8AM","8AM–12PM","12PM–4PM","4PM–8PM","8PM–12AM"];
const HOUR_LABELS = Array.from({length:24},(_,i)=>i===0?"12AM":i<12?`${i}AM`:i===12?"12PM":`${i-12}PM`);
const TARGET_WALLET = "0x428b3f163E831f4d57D9589Bf6e94c64Ce9C6b7a";
const STORAGE_KEY = "polymarket-hub-trades";
const WALLET_KEY  = "polymarket-hub-wallet";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toET(ts) { return new Date(new Date(ts*1000).toLocaleString("en-US",{timeZone:"America/New_York"})); }
function tsToETDate(ts) { const d=toET(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function tsToETHour(ts) { return toET(ts).getHours(); }
function pct(w,l) { const t=w+l; return t===0?null:((w/t)*100).toFixed(1); }
function pctNum(w,l) { const p=pct(w,l); return p===null?null:parseFloat(p); }
function wrColor(n) { if(n===null)return"#2a3050"; return n>=60?"#00ff9d":n>=50?"#f0c040":"#ff4d6d"; }
function getBlock4(h) { return Math.floor(h/4); }
function fmtMoney(n) { return (n>=0?"+":"")+`$${Math.abs(n).toFixed(2)}`; }

// ─── Persistent Storage Helpers ───────────────────────────────────────────────
async function storageSave(key, value) {
  try { await window.storage.set(key, JSON.stringify(value)); } catch(_) {}
}
async function storageLoad(key) {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; } catch(_) { return null; }
}
async function storageDel(key) {
  try { await window.storage.delete(key); } catch(_) {}
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function WRBar({win,lose,highlight}) {
  const num=pctNum(win,lose);
  if(num===null) return <span style={{color:"#2a3050",fontSize:13}}>—</span>;
  const color=wrColor(num);
  return (
    <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
      <div style={{flex:1,height:5,background:"#111520",borderRadius:2}}>
        <div style={{width:`${num}%`,height:"100%",background:color,opacity:highlight?1:0.75,borderRadius:2,transition:"width 0.5s ease"}}/>
      </div>
      <span style={{color,fontSize:12,fontWeight:"bold",minWidth:46,textAlign:"right"}}>{num.toFixed(1)}%</span>
      <span style={{fontSize:10,color:"#3a4060",minWidth:72}}>{win}W / {lose}L</span>
    </div>
  );
}

function StatCard({label,value,sub,color="#00ff9d",small}) {
  return (
    <div style={{background:"#0d0d1a",border:"1px solid #1a1e35",padding:"12px 14px",borderRadius:2}}>
      <div style={{fontSize:9,letterSpacing:3,color:"#3a4060",marginBottom:5,textTransform:"uppercase"}}>{label}</div>
      <div style={{fontSize:small?12:18,fontWeight:"bold",color,lineHeight:1.1}}>{value}</div>
      {sub&&<div style={{fontSize:10,color:"#3a4060",marginTop:4}}>{sub}</div>}
    </div>
  );
}

function NightAlert({nightNum,dayNum}) {
  if(nightNum===null||dayNum===null) return null;
  const edge=nightNum-dayNum;
  if(edge>=3) return <div style={{background:"#001a0e",border:"1px solid #00ff9d",padding:"6px 12px",fontSize:10,color:"#00ff9d",letterSpacing:1,marginBottom:12,borderRadius:2}}>★ NIGHT EDGE ACTIVE — Night outperforming day by {edge.toFixed(1)}pts</div>;
  if(edge<-2) return <div style={{background:"#1a0005",border:"1px solid #ff4d6d",padding:"6px 12px",fontSize:10,color:"#ff4d6d",letterSpacing:1,marginBottom:12,borderRadius:2}}>⚠ NIGHT EDGE OFFLINE — Day outperforming night by {Math.abs(edge).toFixed(1)}pts</div>;
  return null;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [trades, setTrades]             = useState([]);
  const [storageStatus, setStorageStatus] = useState("loading"); // loading|ready|saving|saved|error
  const [lastSaved, setLastSaved]       = useState(null);
  const [mainTab, setMainTab]           = useState("wr");
  const [walletAddr, setWalletAddr]     = useState(TARGET_WALLET);
  const [walletLabel, setWalletLabel]   = useState("");
  const [fetchStatus, setFetchStatus]   = useState("idle");
  const [fetchMsg, setFetchMsg]         = useState("");

  // WR state
  const [view, setView]                 = useState("4hr");
  const [wrSubTab, setWrSubTab]         = useState("dashboard");
  const [showRolling, setShowRolling]   = useState(false);

  // Manual/bulk
  const [manualDate, setManualDate]     = useState(()=>{ const d=toET(Math.floor(Date.now()/1000)); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; });
  const [manualHour, setManualHour]     = useState(0);
  const [manualResult, setManualResult] = useState("win");
  const [manualCount, setManualCount]   = useState(1);
  const [bulkText, setBulkText]         = useState("");
  const [bulkError, setBulkError]       = useState("");

  // PnL state
  const [pnlData, setPnlData]           = useState([]);
  const [openPos, setOpenPos]           = useState([]);
  const [pnlStatus, setPnlStatus]       = useState("idle");
  const [pnlMsg, setPnlMsg]             = useState("");
  const [pnlFilter, setPnlFilter]       = useState("Bitcoin Up or Down");
  const [pnlHours, setPnlHours]         = useState(48);

  // Backtest state
  const [btStartBal, setBtStartBal]     = useState(100);
  const [btSizingMode, setBtSizingMode] = useState("fixed");
  const [btFixedAmt, setBtFixedAmt]     = useState(10);
  const [btPct, setBtPct]               = useState(2);
  const [btMode, setBtMode]             = useState("block");
  const [btBlock, setBtBlock]           = useState(0);
  const [btDateFrom, setBtDateFrom]     = useState("2026-02-19");
  const [btDateTo, setBtDateTo]         = useState("2026-03-06");
  const [btCustomBlock, setBtCustomBlock] = useState(0);

  // ── Auto-load on mount ───────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setStorageStatus("loading");
      try {
        const savedWallet = await storageLoad(WALLET_KEY);
        if (savedWallet) setWalletAddr(savedWallet);

        const savedTrades = await storageLoad(STORAGE_KEY);
        if (savedTrades && Array.isArray(savedTrades) && savedTrades.length > 0) {
          setTrades(savedTrades);
          setLastSaved(new Date().toLocaleTimeString());
          setStorageStatus("ready");
        } else {
          setStorageStatus("ready");
        }
      } catch(_) {
        setStorageStatus("error");
      }
    })();
  }, []);

  // ── Auto-save whenever trades change ────────────────────────────────────────
  useEffect(() => {
    if (storageStatus === "loading") return; // don't save during initial load
    if (trades.length === 0) return;
    setStorageStatus("saving");
    const timeout = setTimeout(async () => {
      try {
        await storageSave(STORAGE_KEY, trades);
        await storageSave(WALLET_KEY, walletAddr);
        setLastSaved(new Date().toLocaleTimeString());
        setStorageStatus("saved");
        setTimeout(() => setStorageStatus("ready"), 2000);
      } catch(_) {
        setStorageStatus("error");
      }
    }, 800); // debounce 800ms
    return () => clearTimeout(timeout);
  }, [trades]);

  // ── Clear stored data ────────────────────────────────────────────────────────
  const clearStorage = async () => {
    await storageDel(STORAGE_KEY);
    await storageDel(WALLET_KEY);
    setTrades([]);
    setLastSaved(null);
    setStorageStatus("ready");
  };

  // ── Fetch WR ─────────────────────────────────────────────────────────────────
  const fetchWR = useCallback(async () => {
    const address = walletAddr.trim();
    if (!address.startsWith("0x")) { setFetchStatus("error"); setFetchMsg("Invalid address"); return; }
    setFetchStatus("loading"); setFetchMsg("Fetching...");
    try {
      let all=[], offset=0;
      while(true) {
        const url=`https://data-api.polymarket.com/closed-positions?user=${address.toLowerCase()}&sortBy=TIMESTAMP&sortDirection=ASC&limit=50&offset=${offset}`;
        const res=await fetch(url);
        if(!res.ok) throw new Error(`API ${res.status}`);
        const data=await res.json();
        if(!Array.isArray(data)||data.length===0) break;
        all=all.concat(data);
        setFetchMsg(`Loading... ${all.length} positions`);
        if(data.length<50) break;
        offset+=50;
      }
      const classified=[];
      let skipped=0;
      for(const t of all) {
        const p=parseFloat(t.realizedPnl);
        if(p===0){skipped++;continue;}
        classified.push({ id:crypto.randomUUID(), dateET:tsToETDate(t.timestamp), hourET:tsToETHour(t.timestamp), result:p>0?"win":"loss", avgPrice:parseFloat(t.avgPrice||0.5), size:parseFloat(t.size||0), realizedPnl:p });
      }
      setTrades(classified);
      setWalletLabel(address.slice(0,6)+"…"+address.slice(-4));
      setFetchStatus("success");
      setFetchMsg(`Loaded ${classified.length} trades (${skipped} zero-PnL skipped) — auto-saving...`);
    } catch(err) {
      if(err.message.includes("fetch")||err.message.includes("CORS")||err.message.includes("NetworkError")) {
        setFetchStatus("cors"); setFetchMsg("CORS blocked — use Bulk Import in LOG tab");
      } else {
        setFetchStatus("error"); setFetchMsg(`Error: ${err.message}`);
      }
    }
  }, [walletAddr]);

  // ── Fetch PnL ─────────────────────────────────────────────────────────────────
  const fetchPnL = useCallback(async () => {
    const address=walletAddr.trim();
    if(!address.startsWith("0x")) return;
    setPnlStatus("loading"); setPnlMsg("Fetching PnL data...");
    const cutoff=Math.floor(Date.now()/1000)-pnlHours*3600;
    try {
      let all=[], offset=0;
      while(true) {
        const url=`https://data-api.polymarket.com/closed-positions?user=${address.toLowerCase()}&sortBy=TIMESTAMP&sortDirection=DESC&limit=50&offset=${offset}`;
        const res=await fetch(url);
        const data=await res.json();
        if(!Array.isArray(data)||data.length===0) break;
        const inWindow=data.filter(p=>p.timestamp>=cutoff&&(pnlFilter===""||( p.title||"").toLowerCase().includes(pnlFilter.toLowerCase())));
        all=all.concat(inWindow);
        if(data[data.length-1]?.timestamp<cutoff) break;
        if(data.length<50) break;
        offset+=50;
      }
      setPnlData(all);
      try {
        const openRes=await fetch(`https://data-api.polymarket.com/positions?user=${address.toLowerCase()}&sizeThreshold=0.01`);
        const openData=await openRes.json();
        setOpenPos((Array.isArray(openData)?openData:[]).filter(p=>pnlFilter===""||( p.title||"").toLowerCase().includes(pnlFilter.toLowerCase())));
      } catch(_){setOpenPos([]);}
      setPnlStatus("success"); setPnlMsg(`${all.length} closed positions loaded`);
    } catch(err){ setPnlStatus("error"); setPnlMsg(`Error: ${err.message}`); }
  }, [walletAddr,pnlHours,pnlFilter]);

  // ── WR Stats ──────────────────────────────────────────────────────────────────
  const stats = useMemo(()=>{
    const byHour=Array.from({length:24},()=>({w:0,l:0,byDate:{}}));
    const byDate={};
    for(const t of trades) {
      const h=t.hourET,d=t.dateET,isW=t.result==="win";
      byHour[h].w+=isW?1:0; byHour[h].l+=isW?0:1;
      if(!byDate[d]) byDate[d]={w:0,l:0};
      byDate[d].w+=isW?1:0; byDate[d].l+=isW?0:1;
      if(!byHour[h].byDate[d]) byHour[h].byDate[d]={w:0,l:0};
      byHour[h].byDate[d].w+=isW?1:0; byHour[h].byDate[d].l+=isW?0:1;
    }
    const byBlock=Array.from({length:6},()=>({w:0,l:0}));
    for(let h=0;h<24;h++){byBlock[getBlock4(h)].w+=byHour[h].w;byBlock[getBlock4(h)].l+=byHour[h].l;}
    const night={w:0,l:0},day={w:0,l:0};
    for(let h=0;h<7;h++){night.w+=byHour[h].w;night.l+=byHour[h].l;}
    for(let h=7;h<24;h++){day.w+=byHour[h].w;day.l+=byHour[h].l;}
    const total={w:trades.filter(t=>t.result==="win").length,l:trades.filter(t=>t.result==="loss").length};
    const allDates=Object.keys(byDate).sort();
    const last7=allDates.slice(-7);
    const rolling7ByHour=Array.from({length:24},(_,h)=>{
      let w=0,l=0;
      for(const d of last7){const e=byHour[h].byDate[d];if(e){w+=e.w;l+=e.l;}}
      return {w,l};
    });
    return {byHour,byBlock,night,day,total,rolling7ByHour};
  },[trades]);

  const bestHour=useMemo(()=>{let best=null,bestP=-1;for(let h=0;h<24;h++){const{w,l}=stats.byHour[h];if(w+l<3)continue;const p=pctNum(w,l);if(p>bestP){bestP=p;best=h;}}return best;},[stats]);
  const bestBlock=useMemo(()=>{let best=null,bestP=-1;for(let b=0;b<6;b++){const{w,l}=stats.byBlock[b];if(w+l<3)continue;const p=pctNum(w,l);if(p>bestP){bestP=p;best=b;}}return best;},[stats]);

  // ── PnL Stats ─────────────────────────────────────────────────────────────────
  const pnlStats=useMemo(()=>{
    let realized=0;
    const byBlock=Array.from({length:6},()=>({pnl:0,count:0,w:0,l:0}));
    const night={pnl:0,w:0,l:0},day={pnl:0,w:0,l:0};
    for(const p of pnlData){
      const pnl=parseFloat(p.realizedPnl||0);realized+=pnl;
      const hour=tsToETHour(p.timestamp),b=getBlock4(hour);
      byBlock[b].pnl+=pnl;byBlock[b].count+=1;byBlock[b].w+=pnl>0?1:0;byBlock[b].l+=pnl<0?1:0;
      if(hour>=0&&hour<7){night.pnl+=pnl;night.w+=pnl>0?1:0;night.l+=pnl<0?1:0;}
      else{day.pnl+=pnl;day.w+=pnl>0?1:0;day.l+=pnl<0?1:0;}
    }
    let unrealized=0;
    for(const p of openPos){const size=parseFloat(p.size||0),avg=parseFloat(p.avgPrice||0),cur=parseFloat(p.curPrice||0);if(size>0&&avg>0&&cur>0)unrealized+=size*(cur-avg);}
    return{realized,unrealized,total:realized+unrealized,byBlock,night,day};
  },[pnlData,openPos]);

  // ── Backtest Engine ───────────────────────────────────────────────────────────
  const runBacktest = useCallback((filteredTrades) => {
    if(filteredTrades.length===0) return null;
    let balance=parseFloat(btStartBal)||100;
    const startBal=balance;
    const equity=[{i:0,bal:balance}];
    let wins=0,losses=0,peak=balance,maxDD=0;
    for(let i=0;i<filteredTrades.length;i++) {
      const t=filteredTrades[i];
      const avgPrice=t.avgPrice>0&&t.avgPrice<1?t.avgPrice:0.5;
      let stake=0;
      if(btSizingMode==="fixed") stake=parseFloat(btFixedAmt)||10;
      else if(btSizingMode==="pct") stake=balance*(parseFloat(btPct)||2)/100;
      else stake=t.size>0?t.size*avgPrice:(parseFloat(btFixedAmt)||10);
      stake=Math.min(stake,balance);
      if(t.result==="win") { balance+=stake*(1-avgPrice)/avgPrice; wins++; }
      else { balance-=stake; losses++; }
      balance=Math.max(0,balance);
      if(balance>peak) peak=balance;
      const dd=((peak-balance)/peak)*100;
      if(dd>maxDD) maxDD=dd;
      equity.push({i:i+1,bal:parseFloat(balance.toFixed(2))});
    }
    return{startBal,endBal:balance,roi:((balance-startBal)/startBal)*100,wins,losses,maxDD,equity,total:wins+losses};
  },[btStartBal,btSizingMode,btFixedAmt,btPct]);

  const btFilteredTrades=useMemo(()=>{
    if(btMode==="block") {
      if(btBlock===0) return trades.filter(t=>t.hourET>=0&&t.hourET<7);
      if(btBlock===7) return trades;
      return trades.filter(t=>getBlock4(t.hourET)===btBlock-1);
    } else if(btMode==="all") {
      return trades;
    } else {
      const inRange=trades.filter(t=>t.dateET>=btDateFrom&&t.dateET<=btDateTo);
      if(btCustomBlock===0) return inRange.filter(t=>t.hourET>=0&&t.hourET<7);
      if(btCustomBlock===7) return inRange;
      return inRange.filter(t=>getBlock4(t.hourET)===btCustomBlock-1);
    }
  },[trades,btMode,btBlock,btDateFrom,btDateTo,btCustomBlock]);

  const allBlocksResults=useMemo(()=>{
    if(btMode!=="all") return null;
    return [
      {label:"Night (12AM–7AM)",trades:trades.filter(t=>t.hourET>=0&&t.hourET<7)},
      ...BLOCK4_LABELS.map((l,b)=>({label:l,trades:trades.filter(t=>getBlock4(t.hourET)===b)})),
      {label:"All 24hr",trades},
    ].map(({label,trades:bt})=>({label,result:runBacktest(bt),tradeCount:bt.length}));
  },[trades,btMode,runBacktest]);

  const btResult=useMemo(()=>runBacktest(btFilteredTrades),[btFilteredTrades,runBacktest]);

  // ── Bulk import ───────────────────────────────────────────────────────────────
  const parseBulk = () => {
    setBulkError("");
    const lines=bulkText.trim().split("\n").filter(Boolean);
    const parsed=[];
    for(const line of lines) {
      const parts=line.split(/[\t,;]+/).map(s=>s.trim());
      if(parts.length<3){setBulkError(`Bad line: "${line}"`);return;}
      const hour=parseInt(parts[1]);
      if(isNaN(hour)||hour<0||hour>23){setBulkError(`Bad hour: "${line}"`);return;}
      const result=parts[2].toLowerCase().startsWith("w")?"win":parts[2].toLowerCase().startsWith("l")?"loss":null;
      if(!result){setBulkError(`Bad result: "${line}"`);return;}
      parsed.push({id:crypto.randomUUID(),dateET:parts[0],hourET:hour,result,avgPrice:parts.length>=4?parseFloat(parts[3])||0.5:0.5,size:parts.length>=5?parseFloat(parts[4])||0:0,realizedPnl:0});
    }
    setTrades(t=>[...t,...parsed]);
    setBulkText("");
  };

  // ── Styles ────────────────────────────────────────────────────────────────────
  const S={
    inp:{background:"#080810",border:"1px solid #1a1e35",color:"#c0c8e0",fontFamily:"'Courier New',monospace",fontSize:11,padding:"5px 8px",outline:"none",borderRadius:1},
    panel:{background:"#0a0a14",border:"1px solid #1a1e35",padding:"14px 16px",marginBottom:12,borderRadius:2},
    secT:{fontSize:9,letterSpacing:3,color:"#3a4060",textTransform:"uppercase",marginBottom:10,borderBottom:"1px solid #1a1e35",paddingBottom:5},
    row:(hl)=>({display:"flex",alignItems:"center",gap:10,padding:hl?"5px 8px":"4px 0",borderBottom:"1px solid #0d0d18",background:hl?"#001a0e":"transparent",margin:hl?"0 -8px":0}),
    lbl:(hl)=>({fontSize:11,color:hl?"#00ff9d":"#506080",minWidth:88}),
    btn:(v,d)=>({background:d?"#080810":v==="danger"?"transparent":v==="sec"?"#0d0d1a":"#001a0e",border:`1px solid ${d?"#1a1e35":v==="danger"?"#ff4d6d":v==="sec"?"#2a2e45":"#00ff9d"}`,color:d?"#2a3050":v==="danger"?"#ff4d6d":v==="sec"?"#506080":"#00ff9d",fontFamily:"'Courier New',monospace",fontSize:10,letterSpacing:2,padding:"6px 14px",cursor:d?"not-allowed":"pointer",borderRadius:1}),
    mainTab:(a)=>({background:"none",border:"none",color:a?"#00ff9d":"#3a4060",fontFamily:"'Courier New',monospace",fontSize:11,letterSpacing:2,padding:"10px 18px",cursor:"pointer",borderBottom:a?"2px solid #00ff9d":"2px solid transparent",textTransform:"uppercase"}),
    subTab:(a)=>({background:"none",border:"none",color:a?"#00ff9d":"#3a4060",fontFamily:"'Courier New',monospace",fontSize:9,letterSpacing:2,padding:"7px 14px",cursor:"pointer",borderBottom:a?"2px solid #00ff9d":"2px solid transparent",textTransform:"uppercase"}),
    seg:(a)=>({background:a?"#001a0e":"#0a0a14",border:`1px solid ${a?"#00ff9d":"#1a1e35"}`,color:a?"#00ff9d":"#3a4060",fontFamily:"'Courier New',monospace",fontSize:9,letterSpacing:1,padding:"5px 10px",cursor:"pointer",borderRadius:1}),
  };
  const statusColor={idle:"#3a4060",loading:"#f0c040",success:"#00ff9d",error:"#ff4d6d",cors:"#ff9d00"};
  const storageColors={loading:"#f0c040",ready:"#2a3050",saving:"#f0c040",saved:"#00ff9d",error:"#ff4d6d"};
  const storageLabels={loading:"⏳ LOADING...",ready:"",saving:"💾 SAVING...",saved:`✓ SAVED ${lastSaved||""}`,error:"⚠ STORAGE ERROR"};

  return (
    <div style={{fontFamily:"'Courier New',monospace",background:"#07070f",minHeight:"100vh",color:"#c0c8e0"}}>

      {/* Header */}
      <div style={{background:"#0a0a14",borderBottom:"1px solid #1a1e35",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:13,letterSpacing:4,color:"#00ff9d",fontWeight:"bold"}}>⬡ POLYMARKET HUB</div>
          <div style={{fontSize:9,color:"#3a4060",letterSpacing:2,marginTop:2}}>COPY-TRADE INTELLIGENCE DASHBOARD</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flex:1,minWidth:240,maxWidth:500}}>
          <input value={walletAddr} onChange={e=>setWalletAddr(e.target.value)} placeholder="0x wallet address..." style={{...S.inp,flex:1,padding:"7px 10px"}}/>
          <button onClick={fetchWR} disabled={fetchStatus==="loading"} style={S.btn("primary",fetchStatus==="loading")}>
            {fetchStatus==="loading"?"LOADING...":"FETCH"}
          </button>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
          {walletLabel&&<div style={{fontSize:10,color:"#3a4060"}}>{walletLabel} · {trades.length} trades</div>}
          {storageLabels[storageStatus]&&<div style={{fontSize:9,color:storageColors[storageStatus],letterSpacing:1}}>{storageLabels[storageStatus]}</div>}
        </div>
      </div>

      {/* Fetch status bar */}
      {fetchStatus!=="idle"&&(
        <div style={{background:"#0a0a14",borderBottom:"1px solid #1a1e35",padding:"6px 20px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:10,color:statusColor[fetchStatus],letterSpacing:1}}>
            {fetchStatus==="loading"?"⏳ ":fetchStatus==="success"?"✓ ":fetchStatus==="cors"?"⚠ ":"✕ "}{fetchMsg}
          </span>
          {fetchStatus!=="loading"&&<button onClick={()=>setFetchStatus("idle")} style={{background:"none",border:"none",color:"#3a4060",cursor:"pointer",fontSize:11,marginLeft:"auto"}}>✕</button>}
        </div>
      )}

      {/* Restored data banner */}
      {storageStatus==="ready"&&trades.length>0&&fetchStatus==="idle"&&lastSaved&&(
        <div style={{background:"#001208",borderBottom:"1px solid #003a1a",padding:"5px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:10,color:"#00aa60",letterSpacing:1}}>✓ {trades.length} TRADES RESTORED FROM STORAGE · Last saved {lastSaved}</span>
          <button onClick={()=>{if(window.confirm("Clear all stored trades?"))clearStorage();}} style={{background:"none",border:"none",color:"#3a4060",cursor:"pointer",fontSize:10,letterSpacing:1}}>CLEAR STORAGE</button>
        </div>
      )}

      {/* Main tabs */}
      <div style={{display:"flex",borderBottom:"1px solid #1a1e35",background:"#0a0a14"}}>
        {[["wr","WR TRACKER"],["pnl","PnL TRACKER"],["bt","BACKTEST"]].map(([k,l])=>(
          <button key={k} onClick={()=>setMainTab(k)} style={S.mainTab(mainTab===k)}>{l}</button>
        ))}
      </div>

      {/* ══ WR TRACKER ══ */}
      {mainTab==="wr"&&(
        <div>
          <div style={{display:"flex",borderBottom:"1px solid #1a1e35",background:"#080810",paddingLeft:8}}>
            {[["dashboard","DASHBOARD"],["log","LOG"],["history","HISTORY"]].map(([k,l])=>(
              <button key={k} onClick={()=>setWrSubTab(k)} style={S.subTab(wrSubTab===k)}>{l}</button>
            ))}
          </div>
          <div style={{padding:"16px 20px"}}>
            {wrSubTab==="dashboard"&&(
              <div>
                <NightAlert nightNum={pctNum(stats.night.w,stats.night.l)} dayNum={pctNum(stats.day.w,stats.day.l)}/>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:8,marginBottom:14}}>
                  <StatCard label="Total Trades" value={stats.total.w+stats.total.l} sub={`${stats.total.w}W / ${stats.total.l}L`}/>
                  <StatCard label="Overall WR" value={pct(stats.total.w,stats.total.l)?`${pct(stats.total.w,stats.total.l)}%`:"—"} color={wrColor(pctNum(stats.total.w,stats.total.l))}/>
                  <StatCard label="Night WR (12AM–7AM)" value={pct(stats.night.w,stats.night.l)?`${pct(stats.night.w,stats.night.l)}%`:"—"} sub={`${stats.night.w+stats.night.l} trades`} color={wrColor(pctNum(stats.night.w,stats.night.l))}/>
                  <StatCard label="Day WR (7AM–12AM)" value={pct(stats.day.w,stats.day.l)?`${pct(stats.day.w,stats.day.l)}%`:"—"} sub={`${stats.day.w+stats.day.l} trades`} color={wrColor(pctNum(stats.day.w,stats.day.l))}/>
                  <StatCard label="Best Hour" value={bestHour!==null?HOUR_LABELS[bestHour]:"—"} sub={bestHour!==null?`${pct(stats.byHour[bestHour].w,stats.byHour[bestHour].l)}% · ${stats.byHour[bestHour].w+stats.byHour[bestHour].l}t`:null} small/>
                  <StatCard label="Best 4HR Block" value={bestBlock!==null?BLOCK4_LABELS[bestBlock]:"—"} sub={bestBlock!==null?`${pct(stats.byBlock[bestBlock].w,stats.byBlock[bestBlock].l)}% WR`:null} small/>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12,alignItems:"center"}}>
                  {[["4hr","4HR BLOCKS"],["1hr","1HR CHUNKS"],["12hr","DAY/NIGHT"],["24hr","OVERALL"]].map(([k,l])=>(
                    <button key={k} onClick={()=>setView(k)} style={S.seg(view===k)}>{l}</button>
                  ))}
                  <button onClick={()=>setShowRolling(r=>!r)} style={{...S.seg(showRolling),marginLeft:"auto"}}>7D ROLLING {showRolling?"▲":"▼"}</button>
                </div>
                {view==="24hr"&&(<div style={S.panel}><div style={S.secT}>OVERALL WIN RATE</div><div style={S.row(false)}><div style={S.lbl(false)}>ALL TIME</div><WRBar win={stats.total.w} lose={stats.total.l} highlight/></div>{showRolling&&(()=>{const rw=stats.rolling7ByHour.reduce((a,h)=>a+h.w,0),rl=stats.rolling7ByHour.reduce((a,h)=>a+h.l,0);return <div style={S.row(false)}><div style={{...S.lbl(false),color:"#f0c040"}}>7D ROLLING</div><WRBar win={rw} lose={rl}/></div>;})()}</div>)}
                {view==="12hr"&&(()=>{const blocks=[{label:"NIGHT  12AM–7AM",s:stats.night},{label:"DAY  7AM–12AM",s:stats.day}];return(<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>{blocks.map(({label,s})=>{const total=s.w+s.l,p=total>0?((s.w/total)*100).toFixed(1):null,col=wrColor(p!==null?parseFloat(p):null);return(<div key={label} style={{background:"#0a0a14",border:"1px solid #1a1e35",padding:"16px"}}><div style={{fontSize:9,letterSpacing:2,color:"#3a4060",marginBottom:8}}>{label}</div><div style={{fontSize:32,fontWeight:"bold",color:col}}>{p!==null?`${p}%`:"—"}</div><div style={{fontSize:10,color:"#3a4060",marginTop:4}}>{s.w}W / {s.l}L · {total} trades</div></div>);})}</div>);})()}
                {view==="4hr"&&(<div style={S.panel}><div style={S.secT}>4HR BLOCKS (ET)</div>{BLOCK4_LABELS.map((label,b)=>(<div key={b} style={S.row(b===bestBlock)}><div style={S.lbl(b===bestBlock)}>{label}{b===bestBlock?" ★":""}</div><WRBar win={stats.byBlock[b].w} lose={stats.byBlock[b].l} highlight={b===bestBlock}/></div>))}{showRolling&&<><div style={{...S.secT,marginTop:14}}>7D ROLLING</div>{BLOCK4_LABELS.map((label,b)=>{const hrs=[b*4,b*4+1,b*4+2,b*4+3],rw=hrs.reduce((a,h)=>a+stats.rolling7ByHour[h].w,0),rl=hrs.reduce((a,h)=>a+stats.rolling7ByHour[h].l,0);return <div key={b} style={S.row(false)}><div style={{...S.lbl(false),color:"#f0c040"}}>{label}</div><WRBar win={rw} lose={rl}/></div>;})}</>}</div>)}
                {view==="1hr"&&(<div style={S.panel}><div style={S.secT}>HOURLY (ET)</div>{HOURS.map(h=>(<div key={h} style={S.row(h===bestHour)}><div style={S.lbl(h===bestHour)}>{HOUR_LABELS[h]}{h===bestHour?" ★":""}</div><WRBar win={stats.byHour[h].w} lose={stats.byHour[h].l} highlight={h===bestHour}/></div>))}{showRolling&&<><div style={{...S.secT,marginTop:14}}>7D ROLLING</div>{HOURS.map(h=>(<div key={h} style={S.row(false)}><div style={{...S.lbl(false),color:"#f0c040"}}>{HOUR_LABELS[h]}</div><WRBar win={stats.rolling7ByHour[h].w} lose={stats.rolling7ByHour[h].l}/></div>))}</>}</div>)}
              </div>
            )}
            {wrSubTab==="log"&&(
              <div>
                <div style={S.panel}>
                  <div style={S.secT}>MANUAL ENTRY</div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
                    {[["DATE","date",manualDate,e=>setManualDate(e.target.value)],["COUNT","number",manualCount,e=>setManualCount(Math.max(1,parseInt(e.target.value)||1))]].map(([lbl,type,val,fn])=>(<div key={lbl} style={{display:"flex",flexDirection:"column",gap:3}}><label style={{fontSize:9,letterSpacing:2,color:"#3a4060"}}>{lbl}</label><input type={type} value={val} onChange={fn} style={{...S.inp,width:type==="number"?55:undefined}}/></div>))}
                    <div style={{display:"flex",flexDirection:"column",gap:3}}><label style={{fontSize:9,letterSpacing:2,color:"#3a4060"}}>HOUR (ET)</label><select value={manualHour} onChange={e=>setManualHour(parseInt(e.target.value))} style={S.inp}>{HOURS.map(h=><option key={h} value={h}>{HOUR_LABELS[h]} ({String(h).padStart(2,"0")}:00)</option>)}</select></div>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}><label style={{fontSize:9,letterSpacing:2,color:"#3a4060"}}>RESULT</label><select value={manualResult} onChange={e=>setManualResult(e.target.value)} style={S.inp}><option value="win">WIN</option><option value="loss">LOSS</option></select></div>
                    <button onClick={()=>{const n=Array.from({length:manualCount},()=>({id:crypto.randomUUID(),dateET:manualDate,hourET:manualHour,result:manualResult,avgPrice:0.5,size:0,realizedPnl:0}));setTrades(t=>[...t,...n]);}} style={S.btn("primary",false)}>ADD</button>
                  </div>
                </div>
                <div style={S.panel}>
                  <div style={S.secT}>BULK IMPORT</div>
                  <div style={{fontSize:10,color:"#3a4060",marginBottom:6}}>Format: <span style={{color:"#506080"}}>YYYY-MM-DD, HOUR, win/loss[, avgPrice, size]</span></div>
                  <textarea value={bulkText} onChange={e=>setBulkText(e.target.value)} placeholder={"2026-03-03, 3, win, 0.6500, 0.0154\n2026-03-03, 4, loss, 0.5200, 0.0200"} style={{width:"100%",background:"#07070f",border:"1px solid #1a1e35",color:"#c0c8e0",fontFamily:"'Courier New',monospace",fontSize:11,padding:9,resize:"vertical",minHeight:90,outline:"none",boxSizing:"border-box",borderRadius:1}}/>
                  {bulkError&&<div style={{color:"#ff4d6d",fontSize:11,marginTop:5}}>⚠ {bulkError}</div>}
                  <div style={{marginTop:9,display:"flex",gap:9}}>
                    <button onClick={parseBulk} style={S.btn("primary",false)}>IMPORT</button>
                    <button onClick={()=>{if(window.confirm("Clear all trades and storage?"))clearStorage();}} style={S.btn("danger",false)}>CLEAR ALL</button>
                  </div>
                </div>
                <div style={{fontSize:10,color:"#3a4060"}}>{trades.length} trades loaded · Storage: <span style={{color:storageColors[storageStatus]}}>{storageStatus}</span></div>
              </div>
            )}
            {wrSubTab==="history"&&(
              <div style={S.panel}>
                <div style={S.secT}>TRADE HISTORY ({trades.length})</div>
                {trades.length===0&&<div style={{color:"#2a3050",fontSize:12,padding:"16px 0"}}>No trades loaded.</div>}
                <div style={{maxHeight:420,overflowY:"auto"}}>
                  {[...trades].sort((a,b)=>b.dateET.localeCompare(a.dateET)||b.hourET-a.hourET).map(t=>(
                    <div key={t.id} style={{display:"flex",gap:12,padding:"4px 0",borderBottom:"1px solid #0d0d18",fontSize:11,alignItems:"center"}}>
                      <span style={{color:"#3a4060"}}>{t.dateET}</span>
                      <span style={{color:"#506080",minWidth:45}}>{HOUR_LABELS[t.hourET]}</span>
                      <span style={{color:t.result==="win"?"#00ff9d":"#ff4d6d"}}>{t.result==="win"?"WIN":"LOSS"}</span>
                      <span style={{color:"#2a3050",fontSize:10}}>{t.avgPrice>0?`@${t.avgPrice.toFixed(3)}`:""}</span>
                      <button onClick={()=>setTrades(tr=>tr.filter(x=>x.id!==t.id))} style={{color:"#2a3050",background:"none",border:"none",cursor:"pointer",fontSize:10,marginLeft:"auto"}}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ PnL TRACKER ══ */}
      {mainTab==="pnl"&&(
        <div style={{padding:"16px 20px"}}>
          <div style={S.panel}>
            <div style={S.secT}>PnL SETTINGS</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
              <div style={{display:"flex",flexDirection:"column",gap:3,flex:1,minWidth:180}}><label style={{fontSize:9,letterSpacing:2,color:"#3a4060"}}>MARKET KEYWORD</label><input value={pnlFilter} onChange={e=>setPnlFilter(e.target.value)} style={{...S.inp,width:"100%"}} placeholder="e.g. Bitcoin Up or Down"/></div>
              <div style={{display:"flex",flexDirection:"column",gap:3}}><label style={{fontSize:9,letterSpacing:2,color:"#3a4060"}}>LOOKBACK</label><select value={pnlHours} onChange={e=>setPnlHours(parseInt(e.target.value))} style={S.inp}>{[24,48,72,168,336,720].map(h=><option key={h} value={h}>{h}h ({Math.round(h/24)}d)</option>)}</select></div>
              <button onClick={fetchPnL} disabled={pnlStatus==="loading"} style={S.btn("primary",pnlStatus==="loading")}>{pnlStatus==="loading"?"LOADING...":"FETCH PnL"}</button>
            </div>
            {pnlStatus!=="idle"&&<div style={{marginTop:8,fontSize:10,color:statusColor[pnlStatus]}}>{pnlMsg}</div>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:8,marginBottom:14}}>
            <StatCard label="Realized PnL" value={`${pnlStats.realized>=0?"+":""}$${pnlStats.realized.toFixed(4)}`} color={pnlStats.realized>=0?"#00ff9d":"#ff4d6d"}/>
            <StatCard label="Unrealized PnL" value={`${pnlStats.unrealized>=0?"+":""}$${pnlStats.unrealized.toFixed(4)}`} color={pnlStats.unrealized>=0?"#00ff9d":"#ff4d6d"}/>
            <StatCard label="Total PnL" value={`${pnlStats.total>=0?"+":""}$${pnlStats.total.toFixed(4)}`} color={pnlStats.total>=0?"#00ff9d":"#ff4d6d"}/>
            <StatCard label="Closed Positions" value={pnlData.length} sub={`in last ${pnlHours}h`}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
            {[{label:"NIGHT PnL (12AM–7AM)",d:pnlStats.night},{label:"DAY PnL (7AM–12AM)",d:pnlStats.day}].map(({label,d})=>{const total=d.w+d.l,wr=total>0?(100*d.w/total).toFixed(1):null,col=d.pnl>0?"#00ff9d":d.pnl<0?"#ff4d6d":"#3a4060";return(<div key={label} style={{background:"#0a0a14",border:"1px solid #1a1e35",padding:"14px 16px"}}><div style={{fontSize:9,letterSpacing:2,color:"#3a4060",marginBottom:6}}>{label}</div><div style={{fontSize:24,fontWeight:"bold",color:col}}>{d.pnl>=0?"+":""}${d.pnl.toFixed(4)}</div><div style={{fontSize:10,color:"#3a4060",marginTop:4}}>{total>0?`${d.w}W / ${d.l}L · ${wr}% WR`:"No data"}</div></div>);})}
          </div>
          <div style={S.panel}>
            <div style={S.secT}>PnL BY 4HR BLOCK</div>
            {BLOCK4_LABELS.map((label,b)=>{const d=pnlStats.byBlock[b],col=d.pnl>0?"#00ff9d":d.pnl<0?"#ff4d6d":"#3a4060",wr=d.w+d.l>0?(100*d.w/(d.w+d.l)).toFixed(1):null;return(<div key={b} style={{...S.row(false),padding:"6px 0"}}><div style={{...S.lbl(false),minWidth:100}}>{label}</div><span style={{color:col,fontWeight:"bold",minWidth:90,fontSize:12}}>{d.pnl>=0?"+":""}${d.pnl.toFixed(4)}</span><span style={{fontSize:10,color:"#3a4060"}}>{d.count>0?`${d.w}W/${d.l}L ${wr}% · ${d.count} trades`:"—"}</span></div>);})}
          </div>
          {openPos.length>0&&(<div style={S.panel}><div style={S.secT}>OPEN POSITIONS ({openPos.length})</div>{openPos.map((p,i)=>{const size=parseFloat(p.size||0),avg=parseFloat(p.avgPrice||0),cur=parseFloat(p.curPrice||0),unreal=size>0&&avg>0&&cur>0?size*(cur-avg):null,col=unreal===null?"#3a4060":unreal>=0?"#00ff9d":"#ff4d6d";return(<div key={i} style={{padding:"7px 0",borderBottom:"1px solid #0d0d18"}}><div style={{fontSize:11,color:"#c0c8e0",marginBottom:3}}>{(p.title||"").slice(0,62)}{(p.title||"").length>62?"…":""}</div><div style={{fontSize:10,color:"#506080",display:"flex",gap:16,flexWrap:"wrap"}}><span>{size.toFixed(2)} {p.outcome}</span><span>avg {avg.toFixed(3)}</span><span>cur {cur.toFixed(3)}</span>{unreal!==null&&<span style={{color:col,fontWeight:"bold"}}>{unreal>=0?"+":""}${unreal.toFixed(4)}</span>}</div></div>);})}</div>)}
          {pnlData.length===0&&pnlStatus!=="loading"&&(<div style={{textAlign:"center",padding:"40px 0",color:"#2a3050",fontSize:11,letterSpacing:2}}>SET FILTERS ABOVE AND CLICK FETCH PnL</div>)}
        </div>
      )}

      {/* ══ BACKTEST ══ */}
      {mainTab==="bt"&&(
        <div style={{padding:"16px 20px"}}>
          {trades.length===0?(
            <div style={{textAlign:"center",padding:"40px 0",color:"#2a3050",fontSize:11,letterSpacing:2}}>FETCH WALLET DATA FIRST (FETCH BUTTON IN HEADER)</div>
          ):(
            <div>
              <div style={S.panel}>
                <div style={S.secT}>BACKTEST SETTINGS</div>
                <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"flex-start"}}>
                  <div style={{display:"flex",flexDirection:"column",gap:3}}>
                    <label style={{fontSize:9,letterSpacing:2,color:"#3a4060"}}>STARTING BALANCE ($)</label>
                    <input type="number" value={btStartBal} onChange={e=>setBtStartBal(e.target.value)} style={{...S.inp,width:90}}/>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:3}}>
                    <label style={{fontSize:9,letterSpacing:2,color:"#3a4060"}}>POSITION SIZING</label>
                    <div style={{display:"flex",gap:4}}>{[["fixed","FIXED $"],["pct","% BAL"],["wallet","WALLET"]].map(([k,l])=><button key={k} onClick={()=>setBtSizingMode(k)} style={S.seg(btSizingMode===k)}>{l}</button>)}</div>
                    {btSizingMode==="fixed"&&<div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}><span style={{fontSize:10,color:"#3a4060"}}>$</span><input type="number" value={btFixedAmt} onChange={e=>setBtFixedAmt(e.target.value)} style={{...S.inp,width:70}}/><span style={{fontSize:10,color:"#3a4060"}}>per trade</span></div>}
                    {btSizingMode==="pct"&&<div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}><input type="number" value={btPct} onChange={e=>setBtPct(e.target.value)} style={{...S.inp,width:55}}/><span style={{fontSize:10,color:"#3a4060"}}>% of balance per trade</span></div>}
                    {btSizingMode==="wallet"&&<div style={{fontSize:10,color:"#3a4060",marginTop:4}}>Uses wallet's actual contract sizes</div>}
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:3,flex:1}}>
                    <label style={{fontSize:9,letterSpacing:2,color:"#3a4060"}}>TIME BLOCK MODE</label>
                    <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{[["block","SPECIFIC BLOCK"],["all","COMPARE ALL"],["custom","CUSTOM RANGE"]].map(([k,l])=><button key={k} onClick={()=>setBtMode(k)} style={S.seg(btMode===k)}>{l}</button>)}</div>
                    {btMode==="block"&&<select value={btBlock} onChange={e=>setBtBlock(parseInt(e.target.value))} style={{...S.inp,marginTop:4}}><option value={0}>Night (12AM–7AM)</option>{BLOCK4_LABELS.map((l,b)=><option key={b} value={b+1}>{l}</option>)}<option value={7}>All 24hr</option></select>}
                    {btMode==="custom"&&(
                      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4,alignItems:"center"}}>
                        <input type="date" value={btDateFrom} onChange={e=>setBtDateFrom(e.target.value)} style={S.inp}/>
                        <span style={{fontSize:10,color:"#3a4060"}}>to</span>
                        <input type="date" value={btDateTo} onChange={e=>setBtDateTo(e.target.value)} style={S.inp}/>
                        <select value={btCustomBlock} onChange={e=>setBtCustomBlock(parseInt(e.target.value))} style={S.inp}><option value={0}>Night (12AM–7AM)</option>{BLOCK4_LABELS.map((l,b)=><option key={b} value={b+1}>{l}</option>)}<option value={7}>All hours</option></select>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {btMode==="all"&&allBlocksResults&&(
                <div style={S.panel}>
                  <div style={S.secT}>ALL BLOCKS COMPARISON — ${parseFloat(btStartBal).toFixed(0)} START · {btSizingMode==="fixed"?`$${btFixedAmt}/trade`:btSizingMode==="pct"?`${btPct}% per trade`:"wallet sizing"}</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:8}}>
                    {allBlocksResults.map(({label,result,tradeCount})=>{
                      if(!result||tradeCount===0) return(<div key={label} style={{background:"#0d0d1a",border:"1px solid #1a1e35",padding:"12px",borderRadius:2}}><div style={{fontSize:9,letterSpacing:2,color:"#3a4060",marginBottom:6}}>{label}</div><div style={{fontSize:12,color:"#2a3050"}}>No trades</div></div>);
                      const roiCol=result.roi>=0?"#00ff9d":"#ff4d6d";
                      return(
                        <div key={label} style={{background:"#0d0d1a",border:"1px solid #1a1e35",padding:"12px",borderRadius:2}}>
                          <div style={{fontSize:9,letterSpacing:2,color:"#3a4060",marginBottom:4}}>{label}</div>
                          <div style={{fontSize:20,fontWeight:"bold",color:roiCol}}>{result.roi>=0?"+":""}{result.roi.toFixed(1)}%</div>
                          <div style={{fontSize:10,color:"#506080",marginTop:3}}>{fmtMoney(result.endBal-result.startBal)} · {tradeCount}t</div>
                          <div style={{fontSize:10,color:wrColor(pctNum(result.wins,result.losses)),marginTop:2}}>{pct(result.wins,result.losses)}% WR</div>
                          <div style={{fontSize:10,color:"#3a4060"}}>DD {result.maxDD.toFixed(1)}%</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {btMode!=="all"&&btResult&&(
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:8,marginBottom:14}}>
                    <StatCard label="Start Balance" value={`$${parseFloat(btStartBal).toFixed(2)}`} color="#506080"/>
                    <StatCard label="End Balance" value={`$${btResult.endBal.toFixed(2)}`} color={btResult.endBal>=parseFloat(btStartBal)?"#00ff9d":"#ff4d6d"}/>
                    <StatCard label="ROI" value={`${btResult.roi>=0?"+":""}${btResult.roi.toFixed(2)}%`} color={btResult.roi>=0?"#00ff9d":"#ff4d6d"}/>
                    <StatCard label="Win Rate" value={`${pct(btResult.wins,btResult.losses)||"—"}%`} color={wrColor(pctNum(btResult.wins,btResult.losses))} sub={`${btResult.wins}W / ${btResult.losses}L`}/>
                    <StatCard label="Max Drawdown" value={`${btResult.maxDD.toFixed(1)}%`} color={btResult.maxDD>20?"#ff4d6d":btResult.maxDD>10?"#f0c040":"#00ff9d"}/>
                    <StatCard label="Trades" value={btResult.total} sub="in selected block"/>
                  </div>
                  <div style={S.panel}>
                    <div style={S.secT}>EQUITY CURVE</div>
                    {btResult.equity.length>1?(
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={btResult.equity} margin={{top:5,right:10,left:0,bottom:5}}>
                          <XAxis dataKey="i" hide/>
                          <YAxis domain={["auto","auto"]} tick={{fill:"#3a4060",fontSize:10}} width={55} tickFormatter={v=>`$${v}`}/>
                          <Tooltip contentStyle={{background:"#0a0a14",border:"1px solid #1a1e35",fontFamily:"'Courier New',monospace",fontSize:10}} formatter={(v)=>[`$${v.toFixed(2)}`,"Balance"]} labelFormatter={i=>`Trade ${i}`}/>
                          <ReferenceLine y={parseFloat(btStartBal)} stroke="#2a3050" strokeDasharray="4 4"/>
                          <Line type="monotone" dataKey="bal" stroke={btResult.roi>=0?"#00ff9d":"#ff4d6d"} dot={false} strokeWidth={1.5}/>
                        </LineChart>
                      </ResponsiveContainer>
                    ):<div style={{color:"#2a3050",fontSize:12,padding:"20px 0",textAlign:"center"}}>Not enough data</div>}
                  </div>
                </div>
              )}
              {btMode!=="all"&&btFilteredTrades.length===0&&(<div style={{textAlign:"center",padding:"30px 0",color:"#2a3050",fontSize:11,letterSpacing:2}}>NO TRADES MATCH SELECTED BLOCK / DATE RANGE</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}