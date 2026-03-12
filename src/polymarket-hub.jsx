import { useState, useMemo, useCallback, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── Constants ───────────────────────────────────────────────────────────────
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const BLOCK4_LABELS = ["12AM–4AM","4AM–8AM","8AM–12PM","12PM–4PM","4PM–8PM","8PM–12AM"];
const HOUR_LABELS = Array.from({length:24},(_,i)=>i===0?"12AM":i<12?`${i}AM`:i===12?"12PM":`${i-12}PM`);
const OVERLAY_COLORS = ["#00ff9d","#f0c040","#ff4d6d","#00aaff","#ff9d00","#cc44ff","#00ffff","#ff44aa"];

const TARGET_WALLET = "0x428b3f163E831f4d57D9589Bf6e94c64Ce9C6b7a";
const STORAGE_KEY = "polymarket-hub-trades";
const WALLET_KEY = "polymarket-hub-wallet";
const PROXY_BASE  = "https://polymarket-hub.vercel.app/api/positions";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function toET(ts) { return new Date(new Date(ts*1000).toLocaleString("en-US",{timeZone:"America/New_York"})); }
function tsToETDate(ts) { const d=toET(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function tsToETHour(ts) { return toET(ts).getHours(); }
function pct(w,l) { const t=w+l; return t===0?null:((w/t)*100).toFixed(1); }
function pctNum(w,l) { const p=pct(w,l); return p===null?null:parseFloat(p); }
function wrColor(n) { if(n===null)return"#505878"; return n>=60?"#00ff9d":n>=50?"#f0c040":"#ff4d6d"; }
function getBlock4(h) { return Math.floor(h/4); }
function fmtMoney(n) { return (n>=0?"+":"")+`$${Math.abs(n).toFixed(2)}`; }

// ─── Win/Loss classification from curPrice ───────────────────────────────────
// curPrice === 1 → trader's outcome resolved YES (win)
// curPrice === 0 → trader's outcome resolved NO (loss)
// Tightened thresholds: resolved 5-min markets go cleanly to 0 or 1
function classifyResult(curPrice) {
  const cp = parseFloat(curPrice);
  if (isNaN(cp)) return null; // can't classify
  if (cp >= 0.90) return "win";
  if (cp <= 0.10) return "loss";
  return null; // genuinely mid-price = market may not have resolved yet
}

// ─── True per-trade PnL from position fields ─────────────────────────────────
// costBasis = totalBought (shares) × avgPrice (price per share) = dollars spent
// redemption = totalBought × curPrice (1 for win, 0 for loss)
// truePnL = totalBought × (curPrice - avgPrice)
function calcTruePnl(totalBought, avgPrice, curPrice) {
  const shares = parseFloat(totalBought) || 0;
  const avg = parseFloat(avgPrice) || 0;
  const cur = parseFloat(curPrice) || 0;
  return shares * (cur - avg);
}

// ─── Cost basis in dollars (totalBought is shares, not dollars) ──────────────
function calcCostBasis(totalBought, avgPrice) {
  return (parseFloat(totalBought) || 0) * (parseFloat(avgPrice) || 0);
}

// ─── Normalise equity to 0-100 trade-progress X axis ────────────────────────
function normalizeEquity(equity) {
  if (!equity || equity.length < 2) return [];
  const last = equity.length - 1;
  return equity.map((pt, i) => ({
    x: parseFloat(((i / last) * 100).toFixed(2)),
    bal: pt.bal,
    date: pt.date,
    hour: pt.hour,
    i: pt.i,
  }));
}

// ─── Backtest Engine (pure functions) ────────────────────────────────────────

function buildTradeGroups(trades) {
  const sorted = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const groups = [];
  let i = 0;
  while (i < sorted.length) {
    const ts = sorted[i].timestamp || 0;
    const group = [];
    while (i < sorted.length && (sorted[i].timestamp || 0) === ts) {
      group.push(sorted[i]);
      i++;
    }
    groups.push(group);
  }
  return groups;
}

function applySlippage(avgPrice, slippagePct) {
  return Math.min(avgPrice + avgPrice * (slippagePct / 100), 0.9999);
}

function calcStake(trade, concurrentCount, config, currentBalance) {
  const { sizingMode, fixedAmt, pct, portfolioBalance, leaderPortfolioData, leaderBalance, multiplier } = config;
  let stake = 0;

  if (sizingMode === "fixed") {
    stake = parseFloat(fixedAmt) || 10;
  } else if (sizingMode === "percentage") {
    // FIX: use costBasis (dollars spent) not totalBought (shares)
    const leaderDollars = trade.costBasis || calcCostBasis(trade.totalBought, trade.avgPrice);
    stake = leaderDollars * (parseFloat(pct) || 50) / 100;
    if (stake <= 0) stake = 5;
  } else if (sizingMode === "portfolio") {
    const rawPortfolio = (leaderPortfolioData && leaderPortfolioData.map.get(trade.id)) || 1;
    const finalPortfolio = (leaderPortfolioData && leaderPortfolioData.finalValue) || rawPortfolio;
    const actualLeaderBalance = parseFloat(leaderBalance) || finalPortfolio;
    const scaleFactor = actualLeaderBalance / finalPortfolio;
    const scaledPortfolio = rawPortfolio * scaleFactor;
    // FIX: use costBasis (dollars) not totalBought (shares)
    const leaderDollars = trade.costBasis || calcCostBasis(trade.totalBought, trade.avgPrice);
    const fraction = leaderDollars / scaledPortfolio;
    stake = fraction * (parseFloat(portfolioBalance) || currentBalance) * (multiplier || 1);
    if (stake <= 0) stake = 5;
  }

  stake = stake / concurrentCount;
  stake = Math.min(stake, currentBalance);
  return stake;
}

function checkMarketCap(marketKey, currentExposure, stake, config) {
  const { marketCapEnabled, marketCapAmt } = config;
  if (!marketCapEnabled) return { skip: false, updatedExposure: currentExposure + stake };
  if (currentExposure >= marketCapAmt) return { skip: true, updatedExposure: currentExposure };
  return { skip: false, updatedExposure: currentExposure + stake };
}

function runBacktestPure(filteredTrades, config) {
  if (!filteredTrades || filteredTrades.length === 0) return null;

  const { startBal, slippagePct, marketCapEnabled, marketCapAmt, dailyLimitEnabled, dailyLimitAmt } = config;

  let balance = parseFloat(startBal) || 100;
  const startBalance = balance;
  const equity = [{ i: 0, bal: balance, date: "", hour: null }];
  let wins = 0, losses = 0, peak = balance, maxDD = 0;
  const marketExposure = {};
  const dailySpend = {};
  let tradeIndex = 0;
  const skipped = { marketCap: 0, dailyLimit: 0, insufficientBalance: 0 };

  const groups = buildTradeGroups(filteredTrades);

  for (const group of groups) {
    const concurrentCount = group.length;
    for (const t of group) {
      tradeIndex++;
      const marketKey = (t.title || "unknown").toLowerCase();
      const avgPrice = t.avgPrice > 0 && t.avgPrice < 1 ? t.avgPrice : 0.5;
      const effectivePrice = applySlippage(avgPrice, slippagePct);

      const currentExposure = marketExposure[marketKey] || 0;
      if (marketCapEnabled && currentExposure >= marketCapAmt) {
        skipped.marketCap++;
        equity.push({ i: tradeIndex, bal: parseFloat(balance.toFixed(2)), date: t.dateET || "", hour: t.hourET ?? null });
        continue;
      }

      const dateKey = t.dateET || "";
      if (dailyLimitEnabled) {
        const spent = dailySpend[dateKey] || 0;
        if (spent >= dailyLimitAmt) {
          skipped.dailyLimit++;
          equity.push({ i: tradeIndex, bal: parseFloat(balance.toFixed(2)), date: t.dateET || "", hour: t.hourET ?? null });
          continue;
        }
      }

      const stake = calcStake(t, concurrentCount, config, balance);

      if (stake <= 0 || balance <= 0) {
        skipped.insufficientBalance++;
        equity.push({ i: tradeIndex, bal: parseFloat(balance.toFixed(2)), date: t.dateET || "", hour: t.hourET ?? null });
        continue;
      }

      if (marketCapEnabled) {
        marketExposure[marketKey] = currentExposure + stake;
      }
      if (dailyLimitEnabled) {
        dailySpend[dateKey] = (dailySpend[dateKey] || 0) + stake;
      }

      if (t.result === "win") {
        balance += stake * (1 - effectivePrice) / effectivePrice;
        wins++;
      } else {
        balance -= stake;
        losses++;
      }

      balance = Math.max(0, balance);
      if (balance > peak) peak = balance;
      const dd = ((peak - balance) / peak) * 100;
      if (dd > maxDD) maxDD = dd;

      equity.push({ i: tradeIndex, bal: parseFloat(balance.toFixed(2)), date: t.dateET || "", hour: t.hourET ?? null });
    }
  }

  return {
    startBal: startBalance,
    endBal: balance,
    roi: ((balance - startBalance) / startBalance) * 100,
    wins,
    losses,
    maxDD,
    equity,
    total: wins + losses,
    skipped,
  };
}

// ─── Persistent Storage Helpers ──────────────────────────────────────────────
async function storageSave(key, value) {
  try { await window.storage.set(key, JSON.stringify(value)); } catch(_) {}
}
async function storageLoad(key) {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; } catch(_) { return null; }
}
async function storageDel(key) {
  try { await window.storage.delete(key); } catch(_) {}
}

// ─── Sub-components ──────────────────────────────────────────────────────────
function WRBar({win,lose,highlight}) {
  const num=pctNum(win,lose);
  if(num===null) return <span style={{color:"#505880",fontSize:15}}>—</span>;
  const color=wrColor(num);
  return (
    <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
      <div style={{flex:1,height:5,background:"#1a1a35",borderRadius:2}}>
        <div style={{width:`${num}%`,height:"100%",background:color,opacity:highlight?1:0.75,borderRadius:2,transition:"width 0.5s ease"}}/>
      </div>
      <span style={{color,fontSize:14,fontWeight:"bold",minWidth:46,textAlign:"right"}}>{num.toFixed(1)}%</span>
      <span style={{fontSize:12,color:"#c0cce0",minWidth:72}}>{win}W / {lose}L</span>
    </div>
  );
}

function StatCard({label,value,sub,color="#00ff9d",small}) {
  return (
    <div style={{background:"#111128",border:"1px solid #1e2040",padding:"12px 14px",borderRadius:2}}>
      <div style={{fontSize:11,letterSpacing:3,color:"#c0cce0",marginBottom:6,textTransform:"uppercase"}}>{label}</div>
      <div style={{fontSize:small?12:18,fontWeight:"bold",color,lineHeight:1.1}}>{value}</div>
      {sub&&<div style={{fontSize:12,color:"#b0bcd0",marginTop:4}}>{sub}</div>}
    </div>
  );
}

function NightAlert({nightNum,dayNum}) {
  if(nightNum===null||dayNum===null) return null;
  const edge=nightNum-dayNum;
  if(edge>=3) return <div style={{background:"#001f10",border:"1px solid #00ff9d",padding:"6px 12px",fontSize:12,color:"#00ff9d",letterSpacing:1,marginBottom:12,borderRadius:2}}>★ NIGHT EDGE ACTIVE — Night outperforming day by {edge.toFixed(1)}pts</div>;
  if(edge<-2) return <div style={{background:"#200008",border:"1px solid #ff4d6d",padding:"6px 12px",fontSize:12,color:"#ff4d6d",letterSpacing:1,marginBottom:12,borderRadius:2}}>⚠ NIGHT EDGE OFFLINE — Day outperforming night by {Math.abs(edge).toFixed(1)}pts</div>;
  return null;
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [trades, setTrades] = useState([]);
  const [storageStatus, setStorageStatus] = useState("loading");
  const [lastSaved, setLastSaved] = useState(null);
  const [mainTab, setMainTab] = useState("wr");
  const [walletAddr, setWalletAddr] = useState(TARGET_WALLET);
  const [walletLabel, setWalletLabel] = useState("");
  const [fetchStatus, setFetchStatus] = useState("idle");
  const [fetchMsg, setFetchMsg] = useState("");
  const [view, setView] = useState("4hr");
  const [wrSubTab, setWrSubTab] = useState("dashboard");
  const [showRolling, setShowRolling] = useState(false);
  const [manualDate, setManualDate] = useState(()=>{
    const d=toET(Math.floor(Date.now()/1000));
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  });
  const [manualHour, setManualHour] = useState(0);
  const [manualResult, setManualResult] = useState("win");
  const [manualCount, setManualCount] = useState(1);
  const [bulkText, setBulkText] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [pnlData, setPnlData] = useState([]);
  const [openPos, setOpenPos] = useState([]);
  const [pnlStatus, setPnlStatus] = useState("idle");
  const [pnlMsg, setPnlMsg] = useState("");
  const [pnlFilter, setPnlFilter] = useState("Bitcoin Up or Down");
  const [pnlHours, setPnlHours] = useState(48);

  // ── Backtest state ──────────────────────────────────────────────────────────
  const [btStartBal, setBtStartBal] = useState(100);
  const [btSizingMode, setBtSizingMode] = useState("fixed");
  const [btFixedAmt, setBtFixedAmt] = useState(10);
  const [btPct, setBtPct] = useState(50);
  const [btPortfolioBalance, setBtPortfolioBalance] = useState(100);
  const [btLeaderBalance, setBtLeaderBalance] = useState(1000);
  const [btMultiplier, setBtMultiplier] = useState(1);
  const [btMode, setBtMode] = useState("block");
  const [btBlock, setBtBlock] = useState(0);
  const [btDateFrom, setBtDateFrom] = useState("2026-02-19");
  const [btDateTo, setBtDateTo] = useState("2026-03-06");
  const [btCustomBlock, setBtCustomBlock] = useState(0);
  const [btHourlyExpanded, setBtHourlyExpanded] = useState(false);
  const [btSelectedHours, setBtSelectedHours] = useState([]);
  const [btMarketExpanded, setBtMarketExpanded] = useState(false);
  const [btSelectedMarkets, setBtSelectedMarkets] = useState([]);
  const [btMarketCap, setBtMarketCap] = useState("");
  const [btMarketCapEnabled, setBtMarketCapEnabled] = useState(false);
  const [btDailyLimit, setBtDailyLimit] = useState("");
  const [btDailyLimitEnabled, setBtDailyLimitEnabled] = useState(false);
  const [btSlippage, setBtSlippage] = useState(0);
  const [savedCurves, setSavedCurves] = useState([]);
  const [pendingCurve, setPendingCurve] = useState(null);
  const [pendingName, setPendingName] = useState("");

  // ── Auto-load on mount ──────────────────────────────────────────────────────
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
      } catch(_) { setStorageStatus("error"); }
    })();
  }, []);

  // ── Auto-save whenever trades change ───────────────────────────────────────
  useEffect(() => {
    if (storageStatus === "loading") return;
    if (trades.length === 0) return;
    setStorageStatus("saving");
    const timeout = setTimeout(async () => {
      try {
        await storageSave(STORAGE_KEY, trades);
        await storageSave(WALLET_KEY, walletAddr);
        setLastSaved(new Date().toLocaleTimeString());
        setStorageStatus("saved");
        setTimeout(() => setStorageStatus("ready"), 2000);
      } catch(_) { setStorageStatus("error"); }
    }, 800);
    return () => clearTimeout(timeout);
  }, [trades]);

  // ── Clear stored data ───────────────────────────────────────────────────────
  const clearStorage = async () => {
    await storageDel(STORAGE_KEY);
    await storageDel(WALLET_KEY);
    setTrades([]);
    setLastSaved(null);
    setStorageStatus("ready");
  };

  // ── Fetch WR ────────────────────────────────────────────────────────────────
  // FIX: Win/loss now classified by curPrice (1=win, 0=loss) instead of realizedPnl sign
  // FIX: truePnl calculated as totalBought × (curPrice − avgPrice)
  // FIX: costBasis calculated as totalBought × avgPrice (dollars, not shares)
  const fetchWR = useCallback(async () => {
    const address = walletAddr.trim();
    if (!address.startsWith("0x")) { setFetchStatus("error"); setFetchMsg("Invalid address"); return; }
    setFetchStatus("loading"); setFetchMsg("Fetching...");
    try {
      let all=[], offset=0;
      const seenAssets = new Set(); // deduplicate by asset ID
      while(true) {
        const url=`${PROXY_BASE}?wallet=${address.toLowerCase()}&offset=${offset}&type=closed`;
        const res=await fetch(url);
        if(!res.ok) throw new Error(`API ${res.status}`);
        const data=await res.json();
        if(!Array.isArray(data)||data.length===0) break;
        const pageSz = data.length;
        for (const d of data) {
          const key = d.asset || d.conditionId || JSON.stringify({t:d.title,o:d.outcome,ts:d.timestamp});
          if (!seenAssets.has(key)) { seenAssets.add(key); all.push(d); }
        }
        setFetchMsg(`Loading closed... ${all.length} unique positions`);
        offset += pageSz;
        if (offset >= 10000) break; // safety cap
      }
      const classified=[]; let skipped=0; let ambiguous=0;
      for(const t of all) {
        const curPrice = parseFloat(t.curPrice);
        const avgPrice = parseFloat(t.avgPrice || 0.5);
        const totalBought = parseFloat(t.totalBought || 0);

        // FIX #1: classify by curPrice, not realizedPnl
        const result = classifyResult(curPrice);
        if (result === null) {
          // Ambiguous mid-price on a "closed" position — could be API lag or unresolved
          // Fallback: use realizedPnl sign if available, otherwise skip
          const rawPnl = parseFloat(t.realizedPnl);
          if (rawPnl === 0) { skipped++; continue; }
          // If curPrice is NaN or mid-range but realizedPnl exists, use old logic as fallback
          const fallbackResult = rawPnl > 0 ? "win" : "loss";
          classified.push({
            id: crypto.randomUUID(),
            dateET: tsToETDate(t.timestamp),
            hourET: tsToETHour(t.timestamp),
            result: fallbackResult,
            avgPrice,
            size: parseFloat(t.size || 0),
            realizedPnl: rawPnl,
            truePnl: calcTruePnl(totalBought, avgPrice, curPrice),
            costBasis: calcCostBasis(totalBought, avgPrice),
            totalBought,
            curPrice,
            timestamp: t.timestamp,
            title: t.title || "",
            classifiedBy: "realizedPnl-fallback",
          });
          ambiguous++;
          continue;
        }

        classified.push({
          id: crypto.randomUUID(),
          dateET: tsToETDate(t.timestamp),
          hourET: tsToETHour(t.timestamp),
          result,
          avgPrice,
          size: parseFloat(t.size || 0),
          realizedPnl: parseFloat(t.realizedPnl || 0),
          truePnl: calcTruePnl(totalBought, avgPrice, curPrice),
          costBasis: calcCostBasis(totalBought, avgPrice),
          totalBought,
          curPrice,
          timestamp: t.timestamp,
          title: t.title || "",
          classifiedBy: "curPrice",
        });
      }

      // ── Fetch ALL open positions (paginated) and inject expired ones ──
      let expiredCount = 0;
      let openKept = 0; // truly live positions skipped
      try {
        let allOpen = [], openOffset = 0;
        const seenOpenAssets = new Set();
        while (true) {
          const openUrl = `${PROXY_BASE}?wallet=${address.toLowerCase()}&type=open&offset=${openOffset}`;
          setFetchMsg(`Loading open positions... ${allOpen.length} unique so far`);
          const openRes = await fetch(openUrl);
          if (!openRes.ok) break; // API may error at high offsets
          let openPage;
          try { openPage = await openRes.json(); } catch(_) { break; }
          if (!Array.isArray(openPage) || openPage.length === 0) break;
          const pageSz = openPage.length;
          for (const d of openPage) {
            const key = d.asset || d.conditionId || JSON.stringify({t:d.title,o:d.outcome});
            if (!seenOpenAssets.has(key)) { seenOpenAssets.add(key); allOpen.push(d); }
          }
          openOffset += pageSz;
          if (openOffset >= 10000) {
            setFetchMsg(`Open positions capped at ${allOpen.length} — safety limit`);
            break;
          }
        }
        setFetchMsg(`Processing ${allOpen.length} open positions...`);
        for (const op of allOpen) {
          const cur = parseFloat(op.curPrice || 0);
          const avg = parseFloat(op.avgPrice || 0.5);
          const totalB = parseFloat(op.totalBought || 0);
          // Expired/resolved: price converged to near 0 (loss) or near 1 (win)
          const isExpiredWin  = cur >= 0.90;
          const isExpiredLoss = cur <= 0.10;
          // Mid-price: only treat as expired loss if the market date in the title has passed
          // Title format: "Bitcoin Up or Down - March 9, 12:25AM-12:30AM ET"
          let titleExpired = false;
          const titleStr = op.title || "";
          const dateMatch = titleStr.match(/(\w+ \d+),\s*[\d:]+[AP]M/i);
          if (dateMatch) {
            try {
              const parsedDate = new Date(`${dateMatch[1]}, 2026`);
              const now = new Date();
              // If the market date is > 1 hour in the past, it's expired
              titleExpired = !isNaN(parsedDate) && (now - parsedDate) > 3600000;
            } catch(_) {}
          }
          const isAmbiguous = !isExpiredWin && !isExpiredLoss && cur > 0 && titleExpired;
          if (isExpiredWin || isExpiredLoss || isAmbiguous) {
            const result = isExpiredWin ? "win" : "loss";
            const effectiveCur = isExpiredWin ? 1 : 0;
            classified.push({
              id: crypto.randomUUID(),
              dateET: tsToETDate(op.timestamp || Math.floor(Date.now()/1000)),
              hourET: tsToETHour(op.timestamp || Math.floor(Date.now()/1000)),
              result,
              avgPrice: avg,
              size: parseFloat(op.size || 0),
              realizedPnl: 0,
              truePnl: calcTruePnl(totalB, avg, effectiveCur),
              costBasis: calcCostBasis(totalB, avg),
              totalBought: totalB,
              curPrice: cur,
              timestamp: op.timestamp || Math.floor(Date.now()/1000),
              title: op.title || "",
              expired: true,
              classifiedBy: "expired-curPrice",
            });
            expiredCount++;
          } else {
            openKept++;
          }
        }
      } catch(_) {}

      setTrades(classified);
      setWalletLabel(address.slice(0,6)+"…"+address.slice(-4));
      setFetchStatus("success");
      const expiredNote = expiredCount > 0 ? ` · ⚠ ${expiredCount} expired positions injected` : "";
      const ambiguousNote = ambiguous > 0 ? ` · ${ambiguous} PnL fallback` : "";
      const openNote = openKept > 0 ? ` · ${openKept} live positions skipped` : "";
      setFetchMsg(`Loaded ${classified.length} total (${classified.length - expiredCount} closed + ${expiredCount} expired${openNote}${ambiguousNote}) — auto-saving...`);
    } catch(err) {
      if(err.message.includes("fetch")||err.message.includes("CORS")||err.message.includes("NetworkError")) {
        setFetchStatus("cors"); setFetchMsg("CORS blocked — use Bulk Import in LOG tab");
      } else {
        setFetchStatus("error"); setFetchMsg(`Error: ${err.message}`);
      }
    }
  }, [walletAddr]);

  // ── Fetch PnL ───────────────────────────────────────────────────────────────
  // FIX: PnL tracker now uses truePnl = totalBought × (curPrice − avgPrice)
  const fetchPnL = useCallback(async () => {
    const address=walletAddr.trim();
    if(!address.startsWith("0x")) return;
    setPnlStatus("loading"); setPnlMsg("Fetching PnL data...");
    const cutoff=Math.floor(Date.now()/1000)-pnlHours*3600;
    try {
      let all=[], offset=0;
      while(true) {
        const url=`${PROXY_BASE}?wallet=${address.toLowerCase()}&offset=${offset}&type=closed&sort=DESC`;
        const res=await fetch(url); const data=await res.json();
        if(!Array.isArray(data)||data.length===0) break;
        const inWindow=data.filter(p=>p.timestamp>=cutoff&&(pnlFilter===""||( p.title||"").toLowerCase().includes(pnlFilter.toLowerCase())));
        all=all.concat(inWindow);
        if(data[data.length-1]?.timestamp<cutoff) break;
        if(data.length<50) break;
        offset+=50;
      }
      setPnlData(all);
      try {
        const openRes=await fetch(`${PROXY_BASE}?wallet=${address.toLowerCase()}&type=open`);
        const openData=await openRes.json();
        setOpenPos((Array.isArray(openData)?openData:[]).filter(p=>pnlFilter===""||( p.title||"").toLowerCase().includes(pnlFilter.toLowerCase())));
      } catch(_){setOpenPos([]);}
      setPnlStatus("success"); setPnlMsg(`${all.length} closed positions loaded`);
    } catch(err){ setPnlStatus("error"); setPnlMsg(`Error: ${err.message}`); }
  }, [walletAddr,pnlHours,pnlFilter]);

  // ── WR Stats ─────────────────────────────────────────────────────────────────
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

  // ── Expired trade count (for warning banners) ──────────────────────────────
  const expiredTradeCount = useMemo(()=>trades.filter(t=>t.expired).length,[trades]);

  // ── Market categories derived from trade titles ─────────────────────────────
  const marketCategories = useMemo(() => {
    const counts = {};
    for (const t of trades) {
      const raw = t.title || "";
      const dashIdx = raw.lastIndexOf(" - ");
      const category = dashIdx > 0 ? raw.slice(0, dashIdx).trim() : raw.trim();
      if (!category) continue;
      counts[category] = (counts[category] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [trades]);

  // ── PnL Stats ────────────────────────────────────────────────────────────────
  // FIX: Use truePnl formula instead of raw realizedPnl
  const pnlStats=useMemo(()=>{
    let realized=0;
    const byBlock=Array.from({length:6},()=>({pnl:0,count:0,w:0,l:0}));
    const night={pnl:0,w:0,l:0},day={pnl:0,w:0,l:0};
    for(const p of pnlData){
      // FIX #3: compute true PnL from fields instead of using raw realizedPnl
      const totalBought = parseFloat(p.totalBought || 0);
      const avgPrice = parseFloat(p.avgPrice || 0);
      const curPrice = parseFloat(p.curPrice || 0);
      const pnl = calcTruePnl(totalBought, avgPrice, curPrice);
      realized+=pnl;
      const hour=tsToETHour(p.timestamp),b=getBlock4(hour);
      byBlock[b].pnl+=pnl;byBlock[b].count+=1;byBlock[b].w+=pnl>0?1:0;byBlock[b].l+=pnl<0?1:0;
      if(hour>=0&&hour<7){night.pnl+=pnl;night.w+=pnl>0?1:0;night.l+=pnl<0?1:0;}
      else{day.pnl+=pnl;day.w+=pnl>0?1:0;day.l+=pnl<0?1:0;}
    }
    let unrealized=0;
    for(const p of openPos){
      const size=parseFloat(p.size||0),avg=parseFloat(p.avgPrice||0),cur=parseFloat(p.curPrice||0);
      if(size>0&&avg>0&&cur>0) unrealized+=size*(cur-avg);
    }
    return{realized,unrealized,total:realized+unrealized,byBlock,night,day};
  },[pnlData,openPos]);

  // ── Leader portfolio reconstruction ──────────────────────────────────────────
  const leaderPortfolioData = useMemo(() => {
    const sorted = [...trades].sort((a,b) => (a.timestamp||0)-(b.timestamp||0));
    let cumulativeBought = 0;
    const map = new Map();
    let finalValue = 1;
    for (const t of sorted) {
      // FIX: use costBasis (dollars) for portfolio reconstruction
      cumulativeBought += (t.costBasis || calcCostBasis(t.totalBought, t.avgPrice));
      const portfolioVal = Math.max(cumulativeBought - (t.truePnl < 0 ? Math.abs(t.truePnl) : 0), 1);
      map.set(t.id, portfolioVal);
      finalValue = portfolioVal;
    }
    return { map, finalValue };
  }, [trades]);

  // ── Backtest runner ───────────────────────────────────────────────────────
  const runBacktest = useCallback((filteredTrades) => {
    const config = {
      startBal: btStartBal,
      sizingMode: btSizingMode,
      fixedAmt: btFixedAmt,
      pct: btPct,
      portfolioBalance: btPortfolioBalance,
      multiplier: parseFloat(btMultiplier) || 1,
      slippagePct: parseFloat(btSlippage) || 0,
      marketCapEnabled: btMarketCapEnabled && parseFloat(btMarketCap) > 0,
      marketCapAmt: parseFloat(btMarketCap) || Infinity,
      dailyLimitEnabled: btDailyLimitEnabled && parseFloat(btDailyLimit) > 0,
      dailyLimitAmt: parseFloat(btDailyLimit) || Infinity,
      leaderPortfolioData,
      leaderBalance: btLeaderBalance,
    };
    return runBacktestPure(filteredTrades, config);
  }, [btStartBal, btSizingMode, btFixedAmt, btPct, btPortfolioBalance, btMultiplier, btSlippage,
      btMarketCapEnabled, btMarketCap, btDailyLimitEnabled, btDailyLimit,
      leaderPortfolioData, btLeaderBalance]);

  // ── Filter logic with hourly multi-select ────────────────────────────────
  const getMarketCategory = (title) => {
    const raw = title || "";
    const dashIdx = raw.lastIndexOf(" - ");
    return dashIdx > 0 ? raw.slice(0, dashIdx).trim() : raw.trim();
  };

  const btFilteredTrades=useMemo(()=>{
    let base = trades;
    if(btSelectedMarkets.length > 0) {
      base = base.filter(t => btSelectedMarkets.includes(getMarketCategory(t.title)));
    }
    if(btMode==="custom") {
      base = base.filter(t=>t.dateET>=btDateFrom&&t.dateET<=btDateTo);
    }
    if(btMode==="all") return base;
    if(btSelectedHours.length > 0) {
      return base.filter(t=>btSelectedHours.includes(t.hourET));
    }
    const blockVal = btMode==="block" ? btBlock : btCustomBlock;
    if(blockVal===0) return base.filter(t=>t.hourET>=0&&t.hourET<7);
    if(blockVal===7) return base;
    return base.filter(t=>getBlock4(t.hourET)===blockVal-1);
  },[trades,btMode,btBlock,btDateFrom,btDateTo,btCustomBlock,btSelectedHours,btSelectedMarkets]);

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
      const avgP = parts.length>=4?parseFloat(parts[3])||0.5:0.5;
      parsed.push({id:crypto.randomUUID(),dateET:parts[0],hourET:hour,result,avgPrice:avgP,size:parts.length>=5?parseFloat(parts[4])||0:0,realizedPnl:0,truePnl:0,costBasis:0,totalBought:0,curPrice:result==="win"?1:0});
    }
    setTrades(t=>[...t,...parsed]);
    setBulkText("");
  };

  // ── Inject JetBrains Mono font ───────────────────────────────────────────────
  useEffect(()=>{
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap';
    document.head.appendChild(link);
  },[]);

  // ── Styles ───────────────────────────────────────────────────────────────────
  const S={
    inp:{background:"#0a0a1a",border:"1px solid #1e2040",color:"#ffffff",fontFamily:"'JetBrains Mono',monospace",fontSize:13,padding:"5px 8px",outline:"none",borderRadius:1},
    panel:{background:"#0d0d1f",border:"1px solid #1e2040",padding:"14px 16px",marginBottom:12,borderRadius:2},
    secT:{fontSize:11,letterSpacing:3,color:"#c0cce0",textTransform:"uppercase",marginBottom:10,borderBottom:"1px solid #1e2040",paddingBottom:5},
    row:(hl)=>({display:"flex",alignItems:"center",gap:10,padding:hl?"5px 8px":"4px 0",borderBottom:"1px solid #131330",background:hl?"#002010":"transparent",margin:hl?"0 -8px":0}),
    lbl:(hl)=>({fontSize:13,color:hl?"#00ff9d":"#ffffff",minWidth:88,fontWeight:hl?"bold":"normal"}),
    btn:(v,d)=>({background:d?"#0d0d1f":v==="danger"?"transparent":v==="sec"?"#151530":"#001f10",border:`1px solid ${d?"#252845":v==="danger"?"#ff4d6d":v==="sec"?"#303060":"#00ff9d"}`,color:d?"#404468":v==="danger"?"#ff4d6d":v==="sec"?"#9090c0":"#00ff9d",fontFamily:"'JetBrains Mono',monospace",fontSize:12,letterSpacing:2,padding:"7px 16px",cursor:d?"not-allowed":"pointer",borderRadius:3,transition:"all 0.15s"}),
    mainTab:(a)=>({background:"none",border:"none",color:a?"#00ff9d":"#a0b0c8",fontFamily:"'JetBrains Mono',monospace",fontSize:13,letterSpacing:2,padding:"12px 20px",cursor:"pointer",borderBottom:a?"2px solid #00ff9d":"2px solid transparent",textTransform:"uppercase",transition:"color 0.15s"}),
    subTab:(a)=>({background:"none",border:"none",color:a?"#00ff9d":"#a0b0c8",fontFamily:"'JetBrains Mono',monospace",fontSize:11,letterSpacing:2,padding:"8px 16px",cursor:"pointer",borderBottom:a?"2px solid #00ff9d":"2px solid transparent",textTransform:"uppercase"}),
    seg:(a)=>({background:a?"#001f10":"#0d0d1f",border:`1px solid ${a?"#00ff9d":"#252845"}`,color:a?"#00ff9d":"#b0bcd0",fontFamily:"'JetBrains Mono',monospace",fontSize:11,letterSpacing:1,padding:"6px 12px",cursor:"pointer",borderRadius:3,transition:"all 0.15s"}),
    hourBtn:(a)=>({background:a?"#001f10":"#0a0a1a",border:`1px solid ${a?"#00ff9d":"#1e2040"}`,color:a?"#00ff9d":"#7080a0",fontFamily:"'JetBrains Mono',monospace",fontSize:11,padding:"4px 7px",cursor:"pointer",borderRadius:2,minWidth:44,transition:"all 0.1s"}),
  };

  const statusColor={idle:"#7080a0",loading:"#f0c040",success:"#00ff9d",error:"#ff4d6d",cors:"#ff9d00"};
  const storageColors={loading:"#f0c040",ready:"#505878",saving:"#f0c040",saved:"#00ff9d",error:"#ff4d6d"};
  const storageLabels={loading:"⏳ LOADING...",ready:"",saving:"💾 SAVING...",saved:`✓ SAVED ${lastSaved||""}`,error:"⚠ STORAGE ERROR"};

  const toggleHour = (h) => {
    setBtSelectedHours(prev => prev.includes(h) ? prev.filter(x=>x!==h) : [...prev, h]);
  };

  const EquityTooltip = ({active,payload}) => {
    if(!active||!payload||!payload[0]) return null;
    const d = payload[0].payload;
    const hourLabel = d.hour!==null && d.hour!==undefined ? HOUR_LABELS[d.hour] : "";
    return (
      <div style={{background:"#0d0d1f",border:"1px solid #1e2040",fontFamily:"'JetBrains Mono',monospace",fontSize:12,padding:"8px 12px"}}>
        <div style={{color:"#7080a0",marginBottom:3}}>Trade {d.i}</div>
        {d.date&&<div style={{color:"#c0cce0"}}>{d.date}{hourLabel?` · ${hourLabel} ET`:""}</div>}
        <div style={{color:"#00ff9d",fontWeight:"bold",marginTop:3}}>${(d.bal||0).toFixed(2)}</div>
      </div>
    );
  };

  // ── Computed: total truePnl from loaded trades (WR tab summary) ─────────────
  const totalTruePnl = useMemo(() => trades.reduce((sum, t) => sum + (t.truePnl || 0), 0), [trades]);

  // ── Edge Metrics ───────────────────────────────────────────────────────────
  const edgeMetrics = useMemo(() => {
    if (trades.length === 0) return null;
    const wins = trades.filter(t => t.result === "win");
    const losses = trades.filter(t => t.result === "loss");
    const totalW = wins.length;
    const totalL = losses.length;
    const totalT = totalW + totalL;
    if (totalT === 0) return null;

    const wr = totalW / totalT;
    const lr = totalL / totalT;

    // Average win/loss in dollars (truePnl)
    const avgWinPnl = totalW > 0 ? wins.reduce((s, t) => s + (t.truePnl || 0), 0) / totalW : 0;
    const avgLossPnl = totalL > 0 ? Math.abs(losses.reduce((s, t) => s + (t.truePnl || 0), 0) / totalL) : 0;

    // Average cost basis (dollars staked per trade)
    const avgStake = trades.reduce((s, t) => s + (t.costBasis || 0), 0) / totalT;

    // Total gains & losses
    const totalGains = wins.reduce((s, t) => s + (t.truePnl || 0), 0);
    const totalLosses = Math.abs(losses.reduce((s, t) => s + (t.truePnl || 0), 0));

    // EV per trade = (WR × avgWin) − (LR × avgLoss)
    const evPerTrade = (wr * avgWinPnl) - (lr * avgLossPnl);

    // Edge % = EV / avg stake (profit margin per dollar risked)
    const edgePct = avgStake > 0 ? (evPerTrade / avgStake) * 100 : 0;

    // Profit Factor = total gains / total losses
    const profitFactor = totalLosses > 0 ? totalGains / totalLosses : totalGains > 0 ? Infinity : 0;

    // Win/Loss ratio = avg win size / avg loss size
    const winLossRatio = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : avgWinPnl > 0 ? Infinity : 0;

    // Kelly % = WR − (LR / winLossRatio)  (fraction of bankroll to bet)
    const kellyPct = winLossRatio > 0 ? (wr - (lr / winLossRatio)) * 100 : 0;

    // Break-even WR = 1 / (1 + winLossRatio)
    const breakEvenWR = winLossRatio > 0 ? (1 / (1 + winLossRatio)) * 100 : 50;

    const netPnl = totalGains - totalLosses;

    // Night vs Day sub-edge
    const nightTrades = trades.filter(t => t.hourET >= 0 && t.hourET < 7);
    const dayTrades = trades.filter(t => t.hourET >= 7);
    const calcSubEdge = (subset) => {
      const sw = subset.filter(t => t.result === "win");
      const sl = subset.filter(t => t.result === "loss");
      const st = sw.length + sl.length;
      if (st === 0) return null;
      const swr = sw.length / st;
      const slr = sl.length / st;
      const savgW = sw.length > 0 ? sw.reduce((s, t) => s + (t.truePnl || 0), 0) / sw.length : 0;
      const savgL = sl.length > 0 ? Math.abs(sl.reduce((s, t) => s + (t.truePnl || 0), 0) / sl.length) : 0;
      const sev = (swr * savgW) - (slr * savgL);
      const savgStake = subset.reduce((s, t) => s + (t.costBasis || 0), 0) / st;
      const sedge = savgStake > 0 ? (sev / savgStake) * 100 : 0;
      const stotalG = sw.reduce((s, t) => s + (t.truePnl || 0), 0);
      const stotalL = Math.abs(sl.reduce((s, t) => s + (t.truePnl || 0), 0));
      const spf = stotalL > 0 ? stotalG / stotalL : stotalG > 0 ? Infinity : 0;
      return { wr: swr * 100, ev: sev, edgePct: sedge, pf: spf, trades: st, wins: sw.length, losses: sl.length, netPnl: stotalG - stotalL };
    };

    return {
      wr: wr * 100, lr: lr * 100,
      avgWinPnl, avgLossPnl, avgStake,
      totalGains, totalLosses, netPnl,
      evPerTrade, edgePct, profitFactor,
      winLossRatio, kellyPct, breakEvenWR,
      totalT, totalW, totalL,
      night: calcSubEdge(nightTrades),
      day: calcSubEdge(dayTrades),
    };
  }, [trades]);

  return (
    <div style={{fontFamily:"'JetBrains Mono',monospace",background:"#080818",minHeight:"100vh",color:"#ffffff"}}>

      {/* ── Header ── */}
      <div style={{background:"#0d0d1f",borderBottom:"1px solid #1e2040",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:15,letterSpacing:4,color:"#00ff9d",fontWeight:"bold"}}>⬡ POLYMARKET HUB</div>
          <div style={{fontSize:11,letterSpacing:2,marginTop:2,color:"#8090b0"}}>COPY-TRADE INTELLIGENCE DASHBOARD</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flex:1,minWidth:240,maxWidth:500}}>
          <input value={walletAddr} onChange={e=>setWalletAddr(e.target.value)} placeholder="0x wallet address..." style={{...S.inp,flex:1,padding:"7px 10px"}}/>
          <button onClick={fetchWR} disabled={fetchStatus==="loading"} style={S.btn("primary",fetchStatus==="loading")}>
            {fetchStatus==="loading"?"LOADING...":"FETCH"}
          </button>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
          {walletLabel&&<div style={{fontSize:12,color:"#b0bcd0"}}>{walletLabel} · {trades.length} trades</div>}
          {storageLabels[storageStatus]&&<div style={{fontSize:11,color:storageColors[storageStatus],letterSpacing:1}}>{storageLabels[storageStatus]}</div>}
        </div>
      </div>

      {/* ── Fetch status bar ── */}
      {fetchStatus!=="idle"&&(
        <div style={{background:"#0d0d1f",borderBottom:"1px solid #1e2040",padding:"6px 20px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:12,color:statusColor[fetchStatus],letterSpacing:1}}>
            {fetchStatus==="loading"?"⏳ ":fetchStatus==="success"?"✓ ":fetchStatus==="cors"?"⚠ ":"✕ "}{fetchMsg}
          </span>
          {fetchStatus!=="loading"&&<button onClick={()=>setFetchStatus("idle")} style={{background:"none",border:"none",color:"#7080a0",cursor:"pointer",fontSize:13,marginLeft:"auto"}}>✕</button>}
        </div>
      )}

      {/* ── Restored data banner ── */}
      {storageStatus==="ready"&&trades.length>0&&fetchStatus==="idle"&&lastSaved&&(
        <div style={{background:"#001510",borderBottom:"1px solid #005528",padding:"5px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:12,color:"#00cc70",letterSpacing:1}}>✓ {trades.length} TRADES RESTORED FROM STORAGE · Last saved {lastSaved}</span>
          <button onClick={()=>{if(window.confirm("Clear all stored trades?"))clearStorage();}} style={{background:"none",border:"none",color:"#7080a0",cursor:"pointer",fontSize:12,letterSpacing:1}}>CLEAR STORAGE</button>
        </div>
      )}

      {/* ── Main tabs ── */}
      <div style={{display:"flex",borderBottom:"1px solid #1e2040",background:"#0d0d1f"}}>
        {[["wr","WR TRACKER"],["pnl","PnL TRACKER"],["bt","BACKTEST"]].map(([k,l])=>(
          <button key={k} onClick={()=>setMainTab(k)} style={S.mainTab(mainTab===k)}>{l}</button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════
          WR TRACKER
      ══════════════════════════════════════════════════════════ */}
      {mainTab==="wr"&&(
        <div>
          <div style={{display:"flex",borderBottom:"1px solid #1e2040",background:"#0a0a1a",paddingLeft:8}}>
            {[["dashboard","DASHBOARD"],["log","LOG"],["history","HISTORY"]].map(([k,l])=>(
              <button key={k} onClick={()=>setWrSubTab(k)} style={S.subTab(wrSubTab===k)}>{l}</button>
            ))}
          </div>
          <div style={{padding:"16px 20px"}}>

            {wrSubTab==="dashboard"&&(
              <div>
                <NightAlert nightNum={pctNum(stats.night.w,stats.night.l)} dayNum={pctNum(stats.day.w,stats.day.l)}/>
                {expiredTradeCount>0&&<div style={{background:"#1a0800",border:"1px solid #ff9d00",padding:"6px 12px",fontSize:12,color:"#ff9d00",letterSpacing:1,marginBottom:12,borderRadius:2}}>⚠ {expiredTradeCount} expired/unclaimed position{expiredTradeCount!==1?"s":""} included as losses — WR may be lower than wallet claims</div>}

                {/* ── Classification method info banner ── */}
                {trades.length>0&&(()=>{
                  const byCurPrice = trades.filter(t=>t.classifiedBy==="curPrice").length;
                  const byFallback = trades.filter(t=>t.classifiedBy==="realizedPnl-fallback").length;
                  const byExpired = trades.filter(t=>t.classifiedBy==="expired-curPrice").length;
                  return (
                    <div style={{background:"#0d0d1f",border:"1px solid #1e2040",padding:"6px 12px",fontSize:11,color:"#7080a0",letterSpacing:1,marginBottom:12,borderRadius:2,display:"flex",gap:12,flexWrap:"wrap"}}>
                      <span>Classification: <span style={{color:"#00ff9d"}}>{byCurPrice} curPrice</span></span>
                      {byFallback>0&&<span style={{color:"#f0c040"}}>{byFallback} PnL fallback</span>}
                      {byExpired>0&&<span style={{color:"#ff9d00"}}>{byExpired} expired</span>}
                      {totalTruePnl!==0&&<span>Net PnL: <span style={{color:totalTruePnl>=0?"#00ff9d":"#ff4d6d"}}>{totalTruePnl>=0?"+":""}${totalTruePnl.toFixed(2)}</span></span>}
                    </div>
                  );
                })()}

                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:8,marginBottom:14}}>
                  <StatCard label="Total Trades" value={stats.total.w+stats.total.l} sub={`${stats.total.w}W / ${stats.total.l}L`}/>
                  <StatCard label="Overall WR" value={pct(stats.total.w,stats.total.l)?`${pct(stats.total.w,stats.total.l)}%`:"—"} color={wrColor(pctNum(stats.total.w,stats.total.l))}/>
                  <StatCard label="Night WR (12AM–7AM)" value={pct(stats.night.w,stats.night.l)?`${pct(stats.night.w,stats.night.l)}%`:"—"} sub={`${stats.night.w+stats.night.l} trades`} color={wrColor(pctNum(stats.night.w,stats.night.l))}/>
                  <StatCard label="Day WR (7AM–12AM)" value={pct(stats.day.w,stats.day.l)?`${pct(stats.day.w,stats.day.l)}%`:"—"} sub={`${stats.day.w+stats.day.l} trades`} color={wrColor(pctNum(stats.day.w,stats.day.l))}/>
                  <StatCard label="Best Hour" value={bestHour!==null?HOUR_LABELS[bestHour]:"—"} sub={bestHour!==null?`${pct(stats.byHour[bestHour].w,stats.byHour[bestHour].l)}% · ${stats.byHour[bestHour].w+stats.byHour[bestHour].l}t`:null} small/>
                  <StatCard label="Best 4HR Block" value={bestBlock!==null?BLOCK4_LABELS[bestBlock]:"—"} sub={bestBlock!==null?`${pct(stats.byBlock[bestBlock].w,stats.byBlock[bestBlock].l)}% WR`:null} small/>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12,alignItems:"center"}}>
                  {[["4hr","4HR BLOCKS"],["1hr","1HR CHUNKS"],["12hr","DAY/NIGHT"],["24hr","OVERALL"],["edge","EDGE"]].map(([k,l])=>(
                    <button key={k} onClick={()=>setView(k)} style={S.seg(view===k)}>{l}</button>
                  ))}
                  <button onClick={()=>setShowRolling(r=>!r)} style={{...S.seg(showRolling),marginLeft:"auto"}}>7D ROLLING {showRolling?"▲":"▼"}</button>
                </div>
                {view==="24hr"&&(
                  <div style={S.panel}>
                    <div style={S.secT}>OVERALL WIN RATE</div>
                    <div style={S.row(false)}><div style={S.lbl(false)}>ALL TIME</div><WRBar win={stats.total.w} lose={stats.total.l} highlight/></div>
                    {showRolling&&(()=>{const rw=stats.rolling7ByHour.reduce((a,h)=>a+h.w,0),rl=stats.rolling7ByHour.reduce((a,h)=>a+h.l,0);return <div style={S.row(false)}><div style={{...S.lbl(false),color:"#f0c040"}}>7D ROLLING</div><WRBar win={rw} lose={rl}/></div>;})()}
                  </div>
                )}
                {view==="12hr"&&(()=>{
                  const blocks=[{label:"NIGHT 12AM–7AM",s:stats.night},{label:"DAY 7AM–12AM",s:stats.day}];
                  return(
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                      {blocks.map(({label,s})=>{
                        const total=s.w+s.l,p=total>0?((s.w/total)*100).toFixed(1):null,col=wrColor(p!==null?parseFloat(p):null);
                        return(
                          <div key={label} style={{background:"#0d0d1f",border:"1px solid #1e2040",padding:"16px"}}>
                            <div style={{fontSize:11,letterSpacing:2,color:"#7080a0",marginBottom:8}}>{label}</div>
                            <div style={{fontSize:34,fontWeight:"bold",color:col}}>{p!==null?`${p}%`:"—"}</div>
                            <div style={{fontSize:12,color:"#b0bcd0",marginTop:4}}>{s.w}W / {s.l}L · {total} trades</div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
                {view==="4hr"&&(
                  <div style={S.panel}>
                    <div style={S.secT}>4HR BLOCKS (ET)</div>
                    {BLOCK4_LABELS.map((label,b)=>(
                      <div key={b} style={S.row(b===bestBlock)}>
                        <div style={S.lbl(b===bestBlock)}>{label}{b===bestBlock?" ★":""}</div>
                        <WRBar win={stats.byBlock[b].w} lose={stats.byBlock[b].l} highlight={b===bestBlock}/>
                      </div>
                    ))}
                    {showRolling&&<>
                      <div style={{...S.secT,marginTop:14}}>7D ROLLING</div>
                      {BLOCK4_LABELS.map((label,b)=>{
                        const hrs=[b*4,b*4+1,b*4+2,b*4+3],rw=hrs.reduce((a,h)=>a+stats.rolling7ByHour[h].w,0),rl=hrs.reduce((a,h)=>a+stats.rolling7ByHour[h].l,0);
                        return <div key={b} style={S.row(false)}><div style={{...S.lbl(false),color:"#f0c040"}}>{label}</div><WRBar win={rw} lose={rl}/></div>;
                      })}
                    </>}
                  </div>
                )}
                {view==="1hr"&&(
                  <div style={S.panel}>
                    <div style={S.secT}>HOURLY (ET)</div>
                    {HOURS.map(h=>(
                      <div key={h} style={S.row(h===bestHour)}>
                        <div style={S.lbl(h===bestHour)}>{HOUR_LABELS[h]}{h===bestHour?" ★":""}</div>
                        <WRBar win={stats.byHour[h].w} lose={stats.byHour[h].l} highlight={h===bestHour}/>
                      </div>
                    ))}
                    {showRolling&&<>
                      <div style={{...S.secT,marginTop:14}}>7D ROLLING</div>
                      {HOURS.map(h=>(
                        <div key={h} style={S.row(false)}>
                          <div style={{...S.lbl(false),color:"#f0c040"}}>{HOUR_LABELS[h]}</div>
                          <WRBar win={stats.rolling7ByHour[h].w} lose={stats.rolling7ByHour[h].l}/>
                        </div>
                      ))}
                    </>}
                  </div>
                )}

                {/* ── EDGE / PROFITABILITY METRICS ── */}
                {view==="edge"&&edgeMetrics&&(
                  <div>
                    {/* ── Hero metrics row ── */}
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:8,marginBottom:14}}>
                      <StatCard label="Edge %" value={`${edgeMetrics.edgePct>=0?"+":""}${edgeMetrics.edgePct.toFixed(2)}%`}
                        color={edgeMetrics.edgePct>=2?"#00ff9d":edgeMetrics.edgePct>=0?"#f0c040":"#ff4d6d"}
                        sub="profit per $ risked"/>
                      <StatCard label="EV / Trade" value={`${edgeMetrics.evPerTrade>=0?"+":""}$${edgeMetrics.evPerTrade.toFixed(2)}`}
                        color={edgeMetrics.evPerTrade>=0?"#00ff9d":"#ff4d6d"}
                        sub="expected $ per trade"/>
                      <StatCard label="Profit Factor" value={edgeMetrics.profitFactor===Infinity?"∞":edgeMetrics.profitFactor.toFixed(2)+"x"}
                        color={edgeMetrics.profitFactor>=1.5?"#00ff9d":edgeMetrics.profitFactor>=1?"#f0c040":"#ff4d6d"}
                        sub="gains ÷ losses"/>
                      <StatCard label="Win/Loss Ratio" value={edgeMetrics.winLossRatio===Infinity?"∞":edgeMetrics.winLossRatio.toFixed(2)}
                        color={edgeMetrics.winLossRatio>=1.2?"#00ff9d":edgeMetrics.winLossRatio>=1?"#f0c040":"#ff4d6d"}
                        sub="avg win $ ÷ avg loss $"/>
                      <StatCard label="Kelly %" value={`${edgeMetrics.kellyPct.toFixed(1)}%`}
                        color={edgeMetrics.kellyPct>=5?"#00ff9d":edgeMetrics.kellyPct>=1?"#f0c040":"#ff4d6d"}
                        sub="optimal bet fraction"/>
                      <StatCard label="Net PnL" value={`${edgeMetrics.netPnl>=0?"+":""}$${edgeMetrics.netPnl.toFixed(2)}`}
                        color={edgeMetrics.netPnl>=0?"#00ff9d":"#ff4d6d"}
                        sub={`${edgeMetrics.totalT} trades`}/>
                    </div>

                    {/* ── Detailed breakdown panel ── */}
                    <div style={S.panel}>
                      <div style={S.secT}>PROFIT EFFICIENCY BREAKDOWN</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                        <div>
                          <div style={{fontSize:11,letterSpacing:2,color:"#00ff9d",marginBottom:8}}>WINS ({edgeMetrics.totalW})</div>
                          <div style={{fontSize:24,fontWeight:"bold",color:"#00ff9d",marginBottom:4}}>+${edgeMetrics.totalGains.toFixed(2)}</div>
                          <div style={{fontSize:12,color:"#b0bcd0",marginBottom:2}}>Avg win: +${edgeMetrics.avgWinPnl.toFixed(2)}</div>
                          <div style={{fontSize:12,color:"#b0bcd0"}}>Avg stake: ${edgeMetrics.avgStake.toFixed(2)}</div>
                        </div>
                        <div>
                          <div style={{fontSize:11,letterSpacing:2,color:"#ff4d6d",marginBottom:8}}>LOSSES ({edgeMetrics.totalL})</div>
                          <div style={{fontSize:24,fontWeight:"bold",color:"#ff4d6d",marginBottom:4}}>-${edgeMetrics.totalLosses.toFixed(2)}</div>
                          <div style={{fontSize:12,color:"#b0bcd0",marginBottom:2}}>Avg loss: -${edgeMetrics.avgLossPnl.toFixed(2)}</div>
                          <div style={{fontSize:12,color:"#b0bcd0"}}>Break-even WR: {edgeMetrics.breakEvenWR.toFixed(1)}%</div>
                        </div>
                      </div>
                      {/* Visual edge indicator */}
                      <div style={{marginTop:14,paddingTop:10,borderTop:"1px solid #1e2040"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                          <span style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>WR vs BREAK-EVEN</span>
                          <span style={{fontSize:13,fontWeight:"bold",color:edgeMetrics.wr>edgeMetrics.breakEvenWR?"#00ff9d":"#ff4d6d"}}>
                            {edgeMetrics.wr.toFixed(1)}% vs {edgeMetrics.breakEvenWR.toFixed(1)}% needed
                            {edgeMetrics.wr>edgeMetrics.breakEvenWR?` → +${(edgeMetrics.wr-edgeMetrics.breakEvenWR).toFixed(1)}pt edge`:` → ${(edgeMetrics.wr-edgeMetrics.breakEvenWR).toFixed(1)}pt deficit`}
                          </span>
                        </div>
                        <div style={{height:8,background:"#1a1a35",borderRadius:4,position:"relative"}}>
                          <div style={{width:`${Math.min(edgeMetrics.wr,100)}%`,height:"100%",background:edgeMetrics.wr>edgeMetrics.breakEvenWR?"#00ff9d":"#ff4d6d",borderRadius:4,transition:"width 0.5s"}}/>
                          <div style={{position:"absolute",top:-3,left:`${Math.min(edgeMetrics.breakEvenWR,100)}%`,width:2,height:14,background:"#ffffff",borderRadius:1}}/>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#505878",marginTop:3}}>
                          <span>0%</span>
                          <span style={{color:"#ffffff"}}>↑ break-even ({edgeMetrics.breakEvenWR.toFixed(0)}%)</span>
                          <span>100%</span>
                        </div>
                      </div>
                    </div>

                    {/* ── Night vs Day Edge comparison ── */}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                      {[{label:"NIGHT EDGE (12AM–7AM)",d:edgeMetrics.night},{label:"DAY EDGE (7AM–12AM)",d:edgeMetrics.day}].map(({label,d})=>{
                        if(!d) return (
                          <div key={label} style={{background:"#0d0d1f",border:"1px solid #1e2040",padding:"14px 16px"}}>
                            <div style={{fontSize:11,letterSpacing:2,color:"#7080a0",marginBottom:6}}>{label}</div>
                            <div style={{fontSize:14,color:"#505880"}}>No data</div>
                          </div>
                        );
                        const edgeCol = d.edgePct>=2?"#00ff9d":d.edgePct>=0?"#f0c040":"#ff4d6d";
                        return(
                          <div key={label} style={{background:"#0d0d1f",border:"1px solid #1e2040",padding:"14px 16px"}}>
                            <div style={{fontSize:11,letterSpacing:2,color:"#c0cce0",marginBottom:6}}>{label}</div>
                            <div style={{fontSize:28,fontWeight:"bold",color:edgeCol}}>{d.edgePct>=0?"+":""}{d.edgePct.toFixed(2)}%</div>
                            <div style={{fontSize:12,color:"#b0bcd0",marginTop:4}}>EV {d.ev>=0?"+":""}${d.ev.toFixed(2)}/trade · PF {d.pf===Infinity?"∞":d.pf.toFixed(2)}x</div>
                            <div style={{fontSize:12,color:"#b0bcd0"}}>{d.wins}W/{d.losses}L · {d.wr.toFixed(1)}% WR · Net {d.netPnl>=0?"+":""}${d.netPnl.toFixed(2)}</div>
                          </div>
                        );
                      })}
                    </div>

                    {/* ── Formula reference ── */}
                    <div style={{background:"#0a0a1a",border:"1px solid #1e2040",padding:"10px 14px",borderRadius:2,fontSize:11,color:"#505878",letterSpacing:0.5,lineHeight:1.8}}>
                      <span style={{color:"#7080a0"}}>FORMULAS:</span>{" "}
                      Edge% = EV ÷ avg stake · EV = (WR × avgWin) − (LR × avgLoss) · Profit Factor = total gains ÷ total losses · Kelly% = WR − (LR ÷ W:L ratio) · Break-even WR = 1 ÷ (1 + W:L ratio)
                    </div>
                  </div>
                )}
                {view==="edge"&&!edgeMetrics&&(
                  <div style={{textAlign:"center",padding:"40px 0",color:"#505880",fontSize:13,letterSpacing:2}}>
                    FETCH WALLET DATA TO VIEW EDGE METRICS
                  </div>
                )}
              </div>
            )}

            {wrSubTab==="log"&&(
              <div>
                <div style={S.panel}>
                  <div style={S.secT}>MANUAL ENTRY</div>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
                    {[["DATE","date",manualDate,e=>setManualDate(e.target.value)],["COUNT","number",manualCount,e=>setManualCount(Math.max(1,parseInt(e.target.value)||1))]].map(([lbl,type,val,fn])=>(
                      <div key={lbl} style={{display:"flex",flexDirection:"column",gap:3}}>
                        <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>{lbl}</label>
                        <input type={type} value={val} onChange={fn} style={{...S.inp,width:type==="number"?55:undefined}}/>
                      </div>
                    ))}
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>HOUR (ET)</label>
                      <select value={manualHour} onChange={e=>setManualHour(parseInt(e.target.value))} style={S.inp}>
                        {HOURS.map(h=><option key={h} value={h}>{HOUR_LABELS[h]} ({String(h).padStart(2,"0")}:00)</option>)}
                      </select>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>RESULT</label>
                      <select value={manualResult} onChange={e=>setManualResult(e.target.value)} style={S.inp}>
                        <option value="win">WIN</option>
                        <option value="loss">LOSS</option>
                      </select>
                    </div>
                    <button onClick={()=>{const n=Array.from({length:manualCount},()=>({id:crypto.randomUUID(),dateET:manualDate,hourET:manualHour,result:manualResult,avgPrice:0.5,size:0,realizedPnl:0,truePnl:0,costBasis:0,totalBought:0,curPrice:manualResult==="win"?1:0}));setTrades(t=>[...t,...n]);}} style={S.btn("primary",false)}>ADD</button>
                  </div>
                </div>
                <div style={S.panel}>
                  <div style={S.secT}>BULK IMPORT</div>
                  <div style={{fontSize:12,color:"#9090b0",marginBottom:6}}>Format: <span style={{color:"#ffffff"}}>YYYY-MM-DD, HOUR, win/loss[, avgPrice, size]</span></div>
                  <textarea value={bulkText} onChange={e=>setBulkText(e.target.value)}
                    placeholder={"2026-03-03, 3, win, 0.6500, 0.0154\n2026-03-03, 4, loss, 0.5200, 0.0200"}
                    style={{width:"100%",background:"#080818",border:"1px solid #1e2040",color:"#ffffff",fontFamily:"'JetBrains Mono',monospace",fontSize:13,padding:9,resize:"vertical",minHeight:90,outline:"none",boxSizing:"border-box",borderRadius:1}}/>
                  {bulkError&&<div style={{color:"#ff4d6d",fontSize:13,marginTop:5}}>⚠ {bulkError}</div>}
                  <div style={{marginTop:9,display:"flex",gap:9}}>
                    <button onClick={parseBulk} style={S.btn("primary",false)}>IMPORT</button>
                    <button onClick={()=>{if(window.confirm("Clear all trades and storage?"))clearStorage();}} style={S.btn("danger",false)}>CLEAR ALL</button>
                  </div>
                </div>
                <div style={{fontSize:12,color:"#b0bcd0"}}>{trades.length} trades loaded · Storage: <span style={{color:storageColors[storageStatus]}}>{storageStatus}</span></div>
              </div>
            )}

            {wrSubTab==="history"&&(
              <div style={S.panel}>
                <div style={S.secT}>TRADE HISTORY ({trades.length})</div>
                {trades.length===0&&<div style={{color:"#505880",fontSize:14,padding:"16px 0"}}>No trades loaded.</div>}
                <div style={{maxHeight:420,overflowY:"auto"}}>
                  {[...trades].sort((a,b)=>b.dateET.localeCompare(a.dateET)||b.hourET-a.hourET).map(t=>(
                    <div key={t.id} style={{display:"flex",gap:12,padding:"4px 0",borderBottom:"1px solid #131330",fontSize:13,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{color:"#7080a0"}}>{t.dateET}</span>
                      <span style={{color:"#ffffff",minWidth:45}}>{HOUR_LABELS[t.hourET]}</span>
                      <span style={{color:t.result==="win"?"#00ff9d":"#ff4d6d"}}>{t.result==="win"?"WIN":"LOSS"}</span>
                      <span style={{color:"#505880",fontSize:12}}>{t.avgPrice>0?`@${t.avgPrice.toFixed(3)}`:""}</span>
                      {t.truePnl!==undefined&&t.truePnl!==0&&<span style={{color:t.truePnl>=0?"#00ff9d":"#ff4d6d",fontSize:11}}>{t.truePnl>=0?"+":""}${t.truePnl.toFixed(2)}</span>}
                      {t.classifiedBy&&t.classifiedBy!=="curPrice"&&<span style={{color:"#f0c040",fontSize:10,letterSpacing:1}}>{t.classifiedBy==="realizedPnl-fallback"?"FALLBACK":"EXPIRED"}</span>}
                      {t.expired&&<span style={{color:"#ff9d00",fontSize:10,letterSpacing:1}}>EXPIRED</span>}
                      <button onClick={()=>setTrades(tr=>tr.filter(x=>x.id!==t.id))} style={{color:"#505880",background:"none",border:"none",cursor:"pointer",fontSize:12,marginLeft:"auto"}}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          PnL TRACKER
      ══════════════════════════════════════════════════════════ */}
      {mainTab==="pnl"&&(
        <div style={{padding:"16px 20px"}}>
          <div style={S.panel}>
            <div style={S.secT}>PnL SETTINGS</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
              <div style={{display:"flex",flexDirection:"column",gap:3,flex:1,minWidth:180}}>
                <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>MARKET KEYWORD</label>
                <input value={pnlFilter} onChange={e=>setPnlFilter(e.target.value)} style={{...S.inp,width:"100%"}} placeholder="e.g. Bitcoin Up or Down"/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:3}}>
                <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>LOOKBACK</label>
                <select value={pnlHours} onChange={e=>setPnlHours(parseInt(e.target.value))} style={S.inp}>
                  {[24,48,72,168,336,720].map(h=><option key={h} value={h}>{h}h ({Math.round(h/24)}d)</option>)}
                </select>
              </div>
              <button onClick={fetchPnL} disabled={pnlStatus==="loading"} style={S.btn("primary",pnlStatus==="loading")}>
                {pnlStatus==="loading"?"LOADING...":"FETCH PnL"}
              </button>
            </div>
            {pnlStatus!=="idle"&&<div style={{marginTop:8,fontSize:12,color:statusColor[pnlStatus]}}>{pnlMsg}</div>}
            {pnlStatus==="success"&&<div style={{marginTop:4,fontSize:10,color:"#505878",letterSpacing:1}}>PnL = totalBought × (curPrice − avgPrice) per position</div>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:8,marginBottom:14}}>
            <StatCard label="Realized PnL" value={`${pnlStats.realized>=0?"+":""}$${pnlStats.realized.toFixed(2)}`} color={pnlStats.realized>=0?"#00ff9d":"#ff4d6d"}/>
            <StatCard label="Unrealized PnL" value={`${pnlStats.unrealized>=0?"+":""}$${pnlStats.unrealized.toFixed(2)}`} color={pnlStats.unrealized>=0?"#00ff9d":"#ff4d6d"}/>
            <StatCard label="Total PnL" value={`${pnlStats.total>=0?"+":""}$${pnlStats.total.toFixed(2)}`} color={pnlStats.total>=0?"#00ff9d":"#ff4d6d"}/>
            <StatCard label="Closed Positions" value={pnlData.length} sub={`in last ${pnlHours}h`}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
            {[{label:"NIGHT PnL (12AM–7AM)",d:pnlStats.night},{label:"DAY PnL (7AM–12AM)",d:pnlStats.day}].map(({label,d})=>{
              const total=d.w+d.l,wr=total>0?(100*d.w/total).toFixed(1):null,col=d.pnl>0?"#00ff9d":d.pnl<0?"#ff4d6d":"#7080a0";
              return(
                <div key={label} style={{background:"#0d0d1f",border:"1px solid #1e2040",padding:"14px 16px"}}>
                  <div style={{fontSize:11,letterSpacing:2,color:"#c0cce0",marginBottom:6}}>{label}</div>
                  <div style={{fontSize:26,fontWeight:"bold",color:col}}>{d.pnl>=0?"+":""}${d.pnl.toFixed(2)}</div>
                  <div style={{fontSize:12,color:"#b0bcd0",marginTop:4}}>{total>0?`${d.w}W / ${d.l}L · ${wr}% WR`:"No data"}</div>
                </div>
              );
            })}
          </div>
          <div style={S.panel}>
            <div style={S.secT}>PnL BY 4HR BLOCK</div>
            {BLOCK4_LABELS.map((label,b)=>{
              const d=pnlStats.byBlock[b],col=d.pnl>0?"#00ff9d":d.pnl<0?"#ff4d6d":"#7080a0",wr=d.w+d.l>0?(100*d.w/(d.w+d.l)).toFixed(1):null;
              return(
                <div key={b} style={{...S.row(false),padding:"6px 0"}}>
                  <div style={{...S.lbl(false),minWidth:100}}>{label}</div>
                  <span style={{color:col,fontWeight:"bold",minWidth:90,fontSize:14}}>{d.pnl>=0?"+":""}${d.pnl.toFixed(2)}</span>
                  <span style={{fontSize:12,color:"#b0bcd0"}}>{d.count>0?`${d.w}W/${d.l}L ${wr}% · ${d.count} trades`:"—"}</span>
                </div>
              );
            })}
          </div>
          {openPos.length>0&&(
            <div style={S.panel}>
              <div style={S.secT}>OPEN POSITIONS ({openPos.length})</div>
              {openPos.map((p,i)=>{
                const size=parseFloat(p.size||0),avg=parseFloat(p.avgPrice||0),cur=parseFloat(p.curPrice||0);
                const unreal=size>0&&avg>0&&cur>0?size*(cur-avg):null,col=unreal===null?"#7080a0":unreal>=0?"#00ff9d":"#ff4d6d";
                return(
                  <div key={i} style={{padding:"7px 0",borderBottom:"1px solid #131330"}}>
                    <div style={{fontSize:13,color:"#ffffff",marginBottom:3}}>{(p.title||"").slice(0,62)}{(p.title||"").length>62?"…":""}</div>
                    <div style={{fontSize:12,color:"#ffffff",display:"flex",gap:16,flexWrap:"wrap"}}>
                      <span>{size.toFixed(2)} {p.outcome}</span>
                      <span>avg {avg.toFixed(3)}</span>
                      <span>cur {cur.toFixed(3)}</span>
                      {unreal!==null&&<span style={{color:col,fontWeight:"bold"}}>{unreal>=0?"+":""}${unreal.toFixed(2)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {pnlData.length===0&&pnlStatus!=="loading"&&(
            <div style={{textAlign:"center",padding:"40px 0",color:"#505880",fontSize:13,letterSpacing:2}}>SET FILTERS ABOVE AND CLICK FETCH PnL</div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          BACKTEST
      ══════════════════════════════════════════════════════════ */}
      {mainTab==="bt"&&(
        <div style={{padding:"16px 20px"}}>
          {trades.length===0?(
            <div style={{textAlign:"center",padding:"40px 0",color:"#505880",fontSize:13,letterSpacing:2}}>FETCH WALLET DATA FIRST (FETCH BUTTON IN HEADER)</div>
          ):(
            <div>

              {/* ── 2-COLUMN LAYOUT ── */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12,alignItems:"start"}}>

                {/* ── LEFT: COPY TRADE SETTINGS + POSITION SIZING ── */}
                <div style={S.panel}>
                  <div style={S.secT}>SETTINGS & SIZING</div>

                  <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-start",marginBottom:12,paddingBottom:10,borderBottom:"1px solid #1e2040"}}>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>START BAL ($)</label>
                      <input type="number" value={btStartBal} onChange={e=>setBtStartBal(e.target.value)} style={{...S.inp,width:80}}/>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>SLIPPAGE (%)</label>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <input type="number" value={btSlippage} onChange={e=>setBtSlippage(e.target.value)} min="0" max="10" step="0.1" style={{...S.inp,width:55}}/>
                        <span style={{fontSize:11,color:"#7080a0"}}>%</span>
                      </div>
                      {parseFloat(btSlippage)>0&&<div style={{fontSize:10,color:"#f0c040"}}>$0.65→${(0.65*(1+parseFloat(btSlippage)/100)).toFixed(4)}</div>}
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>MAX $ / MARKET</label>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <input type="checkbox" checked={btMarketCapEnabled} onChange={e=>setBtMarketCapEnabled(e.target.checked)} style={{accentColor:"#00ff9d"}}/>
                        <input type="number" value={btMarketCap} onChange={e=>setBtMarketCap(e.target.value)} disabled={!btMarketCapEnabled}
                          placeholder="e.g. 50" style={{...S.inp,width:65,opacity:btMarketCapEnabled?1:0.4}}/>
                      </div>
                      {btMarketCapEnabled&&<div style={{fontSize:10,color:"#b0bcd0"}}>YES+NO share cap</div>}
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>MAX $ / DAY (ET)</label>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <input type="checkbox" checked={btDailyLimitEnabled} onChange={e=>setBtDailyLimitEnabled(e.target.checked)} style={{accentColor:"#00ff9d"}}/>
                        <input type="number" value={btDailyLimit} onChange={e=>setBtDailyLimit(e.target.value)} disabled={!btDailyLimitEnabled}
                          placeholder="e.g. 100" style={{...S.inp,width:65,opacity:btDailyLimitEnabled?1:0.4}}/>
                      </div>
                      {btDailyLimitEnabled&&<div style={{fontSize:10,color:"#b0bcd0"}}>resets each ET day</div>}
                    </div>
                  </div>

                  <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>
                    {[["fixed","FIXED $"],["percentage","PCT"],["portfolio","PORTFOLIO"]].map(([k,l])=>(
                      <button key={k} onClick={()=>setBtSizingMode(k)} style={S.seg(btSizingMode===k)}>{l}</button>
                    ))}
                  </div>
                  {btSizingMode==="fixed"&&(
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:12,color:"#b0bcd0"}}>$</span>
                      <input type="number" value={btFixedAmt} onChange={e=>setBtFixedAmt(e.target.value)} style={{...S.inp,width:80}}/>
                      <span style={{fontSize:11,color:"#7080a0"}}>USDC / trade</span>
                    </div>
                  )}
                  {btSizingMode==="percentage"&&(
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <input type="number" value={btPct} onChange={e=>setBtPct(e.target.value)} min="1" max="500" style={{...S.inp,width:65}}/>
                        <span style={{fontSize:11,color:"#b0bcd0"}}>% of leader's cost basis ($)</span>
                      </div>
                      <div style={{fontSize:11,color:"#7080a0"}}>leader $100 cost → you stake ${btPct}</div>
                    </div>
                  )}
                  {btSizingMode==="portfolio"&&(
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                        <div style={{display:"flex",flexDirection:"column",gap:3}}>
                          <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>MY BALANCE ($)</label>
                          <input type="number" value={btPortfolioBalance} onChange={e=>setBtPortfolioBalance(e.target.value)} style={{...S.inp,width:80}}/>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",gap:3}}>
                          <label style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>LEADER BAL ($)</label>
                          <input type="number" value={btLeaderBalance} onChange={e=>setBtLeaderBalance(e.target.value)} style={{...S.inp,width:80}}/>
                        </div>
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:4}}>
                        <span style={{fontSize:11,letterSpacing:2,color:"#7080a0"}}>MULTIPLIER</span>
                        <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
                          {[0.25,0.5,1,2,3].map(m=>(
                            <button key={m} onClick={()=>setBtMultiplier(m)}
                              style={{...S.seg(parseFloat(btMultiplier)===m),fontSize:11,padding:"3px 8px"}}>
                              {m}x
                            </button>
                          ))}
                          <input type="number" value={btMultiplier} onChange={e=>setBtMultiplier(e.target.value)}
                            min="0.01" step="0.01" style={{...S.inp,width:55,marginLeft:2}}/>
                        </div>
                      </div>
                      <div style={{fontSize:10,color:"#7080a0"}}>stake = (leader cost $ / leader portfolio) × my bal × mult</div>
                    </div>
                  )}
                </div>

                {/* ── RIGHT: TIME BLOCK MODE ── */}
                <div style={S.panel}>
                  <div style={S.secT}>TIME BLOCK MODE</div>

                  {/* ── Market Filter ── */}
                  <div style={{marginBottom:10}}>
                    <button onClick={()=>setBtMarketExpanded(x=>!x)}
                      style={{...S.seg(btSelectedMarkets.length>0),fontSize:11,display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                      MARKET FILTER {btMarketExpanded?"▲":"▼"}
                      {btSelectedMarkets.length>0
                        ? <span style={{color:"#00ff9d",marginLeft:4}}>{btSelectedMarkets.length} selected</span>
                        : <span style={{color:"#7080a0",marginLeft:4}}>ALL</span>}
                    </button>
                    {btMarketExpanded&&(
                      <div style={{background:"#080818",border:"1px solid #1e2040",borderRadius:2,padding:"8px",maxHeight:220,overflowY:"auto"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,paddingBottom:6,borderBottom:"1px solid #1e2040"}}>
                          <span style={{fontSize:11,color:"#7080a0",letterSpacing:1}}>ALL MARKETS ({trades.length} trades)</span>
                          <button onClick={()=>setBtSelectedMarkets([])}
                            style={{...S.btn("sec",false),fontSize:10,padding:"2px 8px",opacity:btSelectedMarkets.length===0?1:0.5}}>
                            ALL
                          </button>
                        </div>
                        {marketCategories.map(({name,count})=>{
                          const active = btSelectedMarkets.includes(name);
                          return(
                            <div key={name}
                              onClick={()=>setBtSelectedMarkets(prev=>
                                prev.includes(name) ? prev.filter(x=>x!==name) : [...prev, name]
                              )}
                              style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                                padding:"4px 6px",borderRadius:2,cursor:"pointer",marginBottom:2,
                                background:active?"#001f10":"transparent",
                                border:`1px solid ${active?"#00ff9d":"transparent"}`}}>
                              <span style={{fontSize:12,color:active?"#00ff9d":"#c0cce0",flex:1,marginRight:8}}>{name}</span>
                              <span style={{fontSize:11,color:"#7080a0",whiteSpace:"nowrap"}}>{count}t</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>
                    {[["block","SPECIFIC"],["all","COMPARE ALL"],["custom","CUSTOM"]].map(([k,l])=>(
                      <button key={k} onClick={()=>{setBtMode(k);setBtSelectedHours([]);}} style={S.seg(btMode===k)}>{l}</button>
                    ))}
                  </div>

                  {(btMode==="block"||btMode==="custom")&&(
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {btMode==="custom"&&(
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                          <input type="date" value={btDateFrom} onChange={e=>setBtDateFrom(e.target.value)} style={{...S.inp,colorScheme:"dark"}}/>
                          <span style={{fontSize:12,color:"#b0bcd0"}}>to</span>
                          <input type="date" value={btDateTo} onChange={e=>setBtDateTo(e.target.value)} style={{...S.inp,colorScheme:"dark"}}/>
                        </div>
                      )}
                      {btSelectedHours.length===0&&(
                        <select
                          value={btMode==="block"?btBlock:btCustomBlock}
                          onChange={e=>{btMode==="block"?setBtBlock(parseInt(e.target.value)):setBtCustomBlock(parseInt(e.target.value));}}
                          style={{...S.inp,maxWidth:220}}>
                          <option value={0}>Night (12AM–7AM)</option>
                          {BLOCK4_LABELS.map((l,b)=><option key={b} value={b+1}>{l}</option>)}
                          <option value={7}>All hours</option>
                        </select>
                      )}
                      <div>
                        <button onClick={()=>setBtHourlyExpanded(x=>!x)} style={{...S.seg(btSelectedHours.length>0),fontSize:11,display:"flex",alignItems:"center",gap:6}}>
                          HOURLY SELECT {btHourlyExpanded?"▲":"▼"}
                          {btSelectedHours.length>0&&<span style={{color:"#00ff9d",marginLeft:4}}>{btSelectedHours.length} selected</span>}
                        </button>
                        {btHourlyExpanded&&(
                          <div style={{marginTop:8}}>
                            <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
                              {HOURS.map(h=>(
                                <button key={h} onClick={()=>toggleHour(h)} style={S.hourBtn(btSelectedHours.includes(h))}>
                                  {HOUR_LABELS[h]}
                                </button>
                              ))}
                            </div>
                            <div style={{display:"flex",gap:5}}>
                              <button onClick={()=>setBtSelectedHours([...HOURS])} style={{...S.btn("sec",false),fontSize:11,padding:"3px 8px"}}>ALL</button>
                              <button onClick={()=>setBtSelectedHours([])} style={{...S.btn("sec",false),fontSize:11,padding:"3px 8px"}}>NONE</button>
                              <button onClick={()=>setBtSelectedHours(HOURS.filter(h=>h>=0&&h<7))} style={{...S.btn("sec",false),fontSize:11,padding:"3px 8px"}}>NIGHT</button>
                              <button onClick={()=>setBtSelectedHours(HOURS.filter(h=>h>=7))} style={{...S.btn("sec",false),fontSize:11,padding:"3px 8px"}}>DAY</button>
                            </div>
                            {btSelectedHours.length>0&&(
                              <div style={{fontSize:11,color:"#00ff9d",marginTop:5}}>
                                {[...btSelectedHours].sort((a,b)=>a-b).map(h=>HOUR_LABELS[h]).join(", ")}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

              </div>{/* end 2-col grid */}

              {/* ── COMPARE ALL RESULTS ── */}
              {btMode==="all"&&allBlocksResults&&(
                <div style={S.panel}>
                  <div style={S.secT}>ALL BLOCKS COMPARISON — ${parseFloat(btStartBal).toFixed(0)} START · {btSizingMode==="fixed"?`$${btFixedAmt}/trade`:btSizingMode==="percentage"?`${btPct}% of leader cost`:"portfolio-weighted"}</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:8}}>
                    {allBlocksResults.map(({label,result,tradeCount})=>{
                      if(!result||tradeCount===0) return(
                        <div key={label} style={{background:"#111128",border:"1px solid #1e2040",padding:"12px",borderRadius:2}}>
                          <div style={{fontSize:11,letterSpacing:2,color:"#c0cce0",marginBottom:6}}>{label}</div>
                          <div style={{fontSize:14,color:"#505880"}}>No trades</div>
                        </div>
                      );
                      const roiCol=result.roi>=0?"#00ff9d":"#ff4d6d";
                      return(
                        <div key={label} style={{background:"#111128",border:"1px solid #1e2040",padding:"12px",borderRadius:2}}>
                          <div style={{fontSize:11,letterSpacing:2,color:"#7080a0",marginBottom:4}}>{label}</div>
                          <div style={{fontSize:22,fontWeight:"bold",color:roiCol}}>{result.roi>=0?"+":""}{result.roi.toFixed(1)}%</div>
                          <div style={{fontSize:12,color:"#ffffff",marginTop:3}}>{fmtMoney(result.endBal-result.startBal)} · {tradeCount}t</div>
                          <div style={{fontSize:12,color:wrColor(pctNum(result.wins,result.losses)),marginTop:2}}>{pct(result.wins,result.losses)}% WR</div>
                          <div style={{fontSize:12,color:"#b0bcd0"}}>DD {result.maxDD.toFixed(1)}%</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── SINGLE BLOCK RESULT ── */}
              {btMode!=="all"&&btResult&&(
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:8,marginBottom:14}}>
                    <StatCard label="Start Balance" value={`$${parseFloat(btStartBal).toFixed(2)}`} color="#aabbd0"/>
                    <StatCard label="End Balance" value={`$${btResult.endBal.toFixed(2)}`} color={btResult.endBal>=parseFloat(btStartBal)?"#00ff9d":"#ff4d6d"}/>
                    <StatCard label="ROI" value={`${btResult.roi>=0?"+":""}${btResult.roi.toFixed(2)}%`} color={btResult.roi>=0?"#00ff9d":"#ff4d6d"}/>
                    <StatCard label="Win Rate" value={`${pct(btResult.wins,btResult.losses)||"—"}%`} color={wrColor(pctNum(btResult.wins,btResult.losses))} sub={`${btResult.wins}W / ${btResult.losses}L`}/>
                    <StatCard label="Max Drawdown" value={`${btResult.maxDD.toFixed(1)}%`} color={btResult.maxDD>20?"#ff4d6d":btResult.maxDD>10?"#f0c040":"#00ff9d"}/>
                    <StatCard label="Trades" value={btResult.total} sub="in selected block"/>
                  </div>
                  <div style={S.panel}>
                    {/* ── Equity curve header + overlay controls ── */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,flexWrap:"wrap",gap:6}}>
                      <div style={S.secT}>EQUITY CURVE {savedCurves.length>0&&<span style={{color:"#7080a0",fontSize:10}}>+{savedCurves.length} saved</span>}</div>
                      <div style={{display:"flex",gap:6}}>
                        {btResult&&btResult.equity.length>1&&(()=>{
                          const nextColor = OVERLAY_COLORS[savedCurves.length % OVERLAY_COLORS.length];
                          const mktLabel = btSelectedMarkets.length>0 ? btSelectedMarkets.slice(0,2).join(", ")+(btSelectedMarkets.length>2?` +${btSelectedMarkets.length-2}`:"") : "All Markets";
                          const blockLabel = btSelectedHours.length>0
                            ? `${btSelectedHours.length}hr`
                            : btMode==="custom" ? `${btDateFrom}→${btDateTo}`
                            : btBlock===0 ? "Night" : btBlock===7 ? "All hrs" : BLOCK4_LABELS[btBlock-1];
                          const label = `${blockLabel} · ${mktLabel}`;
                          return(
                            <button onClick={()=>{
                              setPendingCurve({
                                color: nextColor,
                                equity: normalizeEquity(btResult.equity),
                                roi: btResult.roi,
                                wins: btResult.wins,
                                losses: btResult.losses,
                                maxDD: btResult.maxDD,
                                startBal: btResult.startBal,
                                endBal: btResult.endBal,
                              });
                              setPendingName(label);
                            }} style={{...S.btn("sec",false),fontSize:10,padding:"3px 10px",borderColor:nextColor,color:nextColor}}>
                              + ADD TO OVERLAY
                            </button>
                          );
                        })()}
                        {savedCurves.length>0&&(
                          <button onClick={()=>setSavedCurves([])} style={{...S.btn("danger",false),fontSize:10,padding:"3px 10px"}}>
                            CLEAR
                          </button>
                        )}
                      </div>
                    </div>

                    {btResult.equity.length>1?(()=>{
                      const currentNorm = normalizeEquity(btResult.equity);
                      const POINTS = 200;
                      const merged = Array.from({length: POINTS+1}, (_,i) => {
                        const x = parseFloat(((i/POINTS)*100).toFixed(2));
                        const row = {x};
                        const ci = Math.round((i/POINTS)*(currentNorm.length-1));
                        row["live"] = currentNorm[Math.min(ci, currentNorm.length-1)]?.bal ?? null;
                        savedCurves.forEach((curve, ci2) => {
                          const si = Math.round((i/POINTS)*(curve.equity.length-1));
                          row[`saved_${ci2}`] = curve.equity[Math.min(si, curve.equity.length-1)]?.bal ?? null;
                        });
                        return row;
                      });

                      return(
                        <div>
                          <ResponsiveContainer width="100%" height={220}>
                            <LineChart data={merged} margin={{top:5,right:10,left:0,bottom:5}}>
                              <XAxis dataKey="x" hide/>
                              <YAxis domain={["auto","auto"]} tick={{fill:"#7080a0",fontSize:12}} width={55} tickFormatter={v=>`$${v}`}/>
                              <Tooltip
                                content={({active,payload})=>{
                                  if(!active||!payload||!payload.length) return null;
                                  return(
                                    <div style={{background:"#0d0d1f",border:"1px solid #1e2040",fontFamily:"'JetBrains Mono',monospace",fontSize:12,padding:"8px 12px"}}>
                                      {payload.map((p,i)=>(
                                        <div key={i} style={{color:p.stroke||p.color,marginBottom:2}}>
                                          <span style={{color:"#7080a0",marginRight:6}}>{p.name==="live"?"CURRENT":savedCurves[parseInt(p.name.replace("saved_",""))]?.label}</span>
                                          ${(p.value||0).toFixed(2)}
                                        </div>
                                      ))}
                                    </div>
                                  );
                                }}
                              />
                              <ReferenceLine y={parseFloat(btStartBal)} stroke="#505878" strokeDasharray="4 4"/>
                              <Line type="monotone" dataKey="live" name="live"
                                stroke="#ffffff" dot={false} strokeWidth={1.5} strokeOpacity={0.9}/>
                              {savedCurves.map((curve,i)=>(
                                <Line key={i} type="monotone" dataKey={`saved_${i}`} name={`saved_${i}`}
                                  stroke={curve.color} dot={false} strokeWidth={1.5} strokeOpacity={0.85}/>
                              ))}
                            </LineChart>
                          </ResponsiveContainer>

                          {savedCurves.length>0&&(()=>{
                            const allCurves = [
                              { label:"CURRENT", color:"#ffffff", roi:btResult.roi, wins:btResult.wins,
                                losses:btResult.losses, maxDD:btResult.maxDD, isCurrent:true },
                              ...savedCurves.map(c=>({...c, isCurrent:false}))
                            ];
                            const bestROI   = Math.max(...allCurves.map(c=>c.roi));
                            const bestWR    = Math.max(...allCurves.map(c=>c.wins+c.losses>0?c.wins/(c.wins+c.losses):0));
                            const bestDD    = Math.min(...allCurves.map(c=>c.maxDD));
                            const bestRisk  = Math.max(...allCurves.map(c=>c.maxDD>0?c.roi/c.maxDD:-Infinity));
                            return(
                              <div style={{marginTop:10,paddingTop:8,borderTop:"1px solid #1e2040"}}>
                                <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:10}}>
                                  {allCurves.map((curve,i)=>(
                                    <div key={i} style={{display:"flex",alignItems:"center",gap:5,fontSize:11}}>
                                      <div style={{width:16,height:2,background:curve.color,borderRadius:1}}/>
                                      <span style={{color:curve.color==="ffffff"?"#ffffff":"#c0cce0",maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{curve.label}</span>
                                      {!curve.isCurrent&&<button onClick={()=>setSavedCurves(prev=>prev.filter((_,j)=>j!==i-1))}
                                        style={{background:"none",border:"none",color:"#505880",cursor:"pointer",fontSize:11,padding:0}}>✕</button>}
                                    </div>
                                  ))}
                                </div>
                                <div style={{overflowX:"auto"}}>
                                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}>
                                    <thead>
                                      <tr style={{borderBottom:"1px solid #1e2040"}}>
                                        <th style={{textAlign:"left",padding:"4px 8px",fontSize:10,letterSpacing:2,color:"#7080a0",fontWeight:"normal"}}>CURVE</th>
                                        <th style={{textAlign:"right",padding:"4px 8px",fontSize:10,letterSpacing:2,color:"#7080a0",fontWeight:"normal"}}>ROI</th>
                                        <th style={{textAlign:"right",padding:"4px 8px",fontSize:10,letterSpacing:2,color:"#7080a0",fontWeight:"normal"}}>WIN%</th>
                                        <th style={{textAlign:"right",padding:"4px 8px",fontSize:10,letterSpacing:2,color:"#7080a0",fontWeight:"normal"}}>MAX DD</th>
                                        <th style={{textAlign:"right",padding:"4px 8px",fontSize:10,letterSpacing:2,color:"#7080a0",fontWeight:"normal",whiteSpace:"nowrap"}}>RISK SCORE</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {allCurves.map((curve,i)=>{
                                        const wr = curve.wins+curve.losses>0 ? curve.wins/(curve.wins+curve.losses)*100 : 0;
                                        const riskScore = curve.maxDD>0 ? curve.roi/curve.maxDD : 0;
                                        const isBestROI   = Math.abs(curve.roi - bestROI) < 0.001;
                                        const isBestWR    = Math.abs(wr/100 - bestWR) < 0.001;
                                        const isBestDD    = Math.abs(curve.maxDD - bestDD) < 0.001;
                                        const isBestRisk  = Math.abs(riskScore - bestRisk) < 0.001;
                                        const rowBg = i%2===0?"#0a0a1a":"#0d0d1f";
                                        return(
                                          <tr key={i} style={{background:rowBg,borderBottom:"1px solid #131330"}}>
                                            <td style={{padding:"5px 8px"}}>
                                              <div style={{display:"flex",alignItems:"center",gap:6}}>
                                                <div style={{width:10,height:10,borderRadius:"50%",background:curve.color,flexShrink:0}}/>
                                                <span style={{color:"#c0cce0",maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{curve.label}</span>
                                              </div>
                                            </td>
                                            <td style={{textAlign:"right",padding:"5px 8px",color:isBestROI?"#00ff9d":curve.roi>=0?"#a0c8a0":"#ff4d6d",fontWeight:isBestROI?"bold":"normal"}}>
                                              {curve.roi>=0?"+":""}{curve.roi.toFixed(1)}%{isBestROI?" ★":""}
                                            </td>
                                            <td style={{textAlign:"right",padding:"5px 8px",color:isBestWR?"#00ff9d":wr>=50?"#a0c8a0":"#ff4d6d",fontWeight:isBestWR?"bold":"normal"}}>
                                              {wr.toFixed(1)}%{isBestWR?" ★":""}
                                            </td>
                                            <td style={{textAlign:"right",padding:"5px 8px",color:isBestDD?"#00ff9d":curve.maxDD<20?"#a0c8a0":"#ff4d6d",fontWeight:isBestDD?"bold":"normal"}}>
                                              {curve.maxDD.toFixed(1)}%{isBestDD?" ★":""}
                                            </td>
                                            <td style={{textAlign:"right",padding:"5px 8px",color:isBestRisk?"#00ff9d":riskScore>0?"#a0c8a0":"#ff4d6d",fontWeight:isBestRisk?"bold":"normal"}}>
                                              {riskScore.toFixed(2)}{isBestRisk?" ★":""}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                  <div style={{fontSize:10,color:"#505878",marginTop:5,letterSpacing:1}}>
                                    RISK SCORE = ROI ÷ MAX DRAWDOWN · ★ = best in column
                                  </div>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })():<div style={{color:"#505880",fontSize:14,padding:"20px 0",textAlign:"center"}}>Not enough data</div>}
                  </div>
                </div>
              )}

              {/* ── EXPIRED POSITIONS BANNER ── */}
              {expiredTradeCount>0&&btMode!=="all"&&(
                <div style={{background:"#1a0800",border:"1px solid #ff9d00",padding:"7px 14px",fontSize:12,color:"#ff9d00",letterSpacing:1,marginBottom:12,borderRadius:2}}>
                  ⚠ {expiredTradeCount} expired/unclaimed position{expiredTradeCount!==1?"s":""} included as losses in this backtest
                </div>
              )}

              {/* ── SKIP WARNING BANNER ── */}
              {btMode!=="all"&&btResult&&(()=>{
                const s = btResult.skipped;
                const total = s.marketCap + s.dailyLimit + s.insufficientBalance;
                if(total===0) return null;
                const parts = [
                  s.marketCap>0 && `${s.marketCap} market cap`,
                  s.dailyLimit>0 && `${s.dailyLimit} daily limit`,
                  s.insufficientBalance>0 && `${s.insufficientBalance} insufficient balance`,
                ].filter(Boolean).join(" · ");
                return(
                  <div style={{background:"#1a1000",border:"1px solid #f0c040",padding:"7px 14px",fontSize:12,color:"#f0c040",letterSpacing:1,marginBottom:12,borderRadius:2}}>
                    ⚠ {total} trade{total!==1?"s":""} skipped — {parts}
                  </div>
                );
              })()}

              {btMode!=="all"&&btFilteredTrades.length===0&&(
                <div style={{textAlign:"center",padding:"30px 0",color:"#505880",fontSize:13,letterSpacing:2}}>NO TRADES MATCH SELECTED BLOCK / DATE RANGE</div>
              )}

            </div>
          )}
        </div>
      )}


      {/* ── Overlay Naming Modal ── */}
      {pendingCurve&&(
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",
          display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}
          onClick={(e)=>{if(e.target===e.currentTarget){setPendingCurve(null);setPendingName("");}}}>
          <div style={{background:"#0d0d1f",border:`1px solid ${pendingCurve.color}`,borderRadius:4,
            padding:"20px 24px",minWidth:340,fontFamily:"'JetBrains Mono',monospace"}}>
            <div style={{fontSize:11,letterSpacing:3,color:"#c0cce0",marginBottom:14,textTransform:"uppercase"}}>
              Name This Overlay
            </div>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>
              {["Night","4AM–8AM","8AM–12PM","12PM–4PM","4PM–8PM","All Hours","Bitcoin","Custom"].map(p=>(
                <button key={p} onClick={()=>setPendingName(p)}
                  style={{...S.seg(pendingName===p),fontSize:10,padding:"3px 8px"}}>
                  {p}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={pendingName}
              onChange={e=>setPendingName(e.target.value)}
              onKeyDown={e=>{
                if(e.key==="Enter"&&pendingName.trim()){
                  setSavedCurves(prev=>[...prev,{...pendingCurve,label:pendingName.trim()}]);
                  setPendingCurve(null);setPendingName("");
                }
                if(e.key==="Escape"){setPendingCurve(null);setPendingName("");}
              }}
              placeholder="e.g. Night · Bitcoin"
              style={{...S.inp,width:"100%",boxSizing:"border-box",marginBottom:14,fontSize:13,padding:"8px 10px"}}
            />
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
              <div style={{width:24,height:3,background:pendingCurve.color,borderRadius:2}}/>
              <span style={{fontSize:11,color:"#7080a0"}}>
                ROI {pendingCurve.roi>=0?"+":""}{pendingCurve.roi.toFixed(1)}% · DD {pendingCurve.maxDD.toFixed(1)}%
              </span>
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>{setPendingCurve(null);setPendingName("");}}
                style={S.btn("sec",false)}>CANCEL</button>
              <button
                disabled={!pendingName.trim()}
                onClick={()=>{
                  setSavedCurves(prev=>[...prev,{...pendingCurve,label:pendingName.trim()}]);
                  setPendingCurve(null);setPendingName("");
                }}
                style={{...S.btn("primary",!pendingName.trim()),minWidth:80}}>
                SAVE
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}