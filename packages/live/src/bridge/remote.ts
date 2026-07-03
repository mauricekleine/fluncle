// THE PHONE REMOTE — a CANON surface (DESIGN.md tokens, VOICE recovered-terminal
// register) the bridge serves on the LAN at http://<lan-ip>:4180/remote. Plain
// HTML/CSS/JS, no build step, no framework; it opens a WebSocket to the SAME /state
// stream the glass reads and sends ShowCommands back. It is the operator's one
// earned second tier for the two-machine rig (RFC §3): big NEXT / PREV, the current
// + next finding (Log ID + title), hold-to-engage blackout mirroring the glass,
// intensity, and channel health — in canon colours (Eclipse Gold the one accent, no
// traffic-light green; problems in Re-entry Red, everything else warm-neutral).
//
// Design law honoured: dark-only (Deep Field ground), Oxanium tabular for the Log
// ID coordinate and numerals, Starlight Cream ink, Stardust muted, the One Sun Rule
// (gold reserved for identity + the active edge). Every string is sentence-case,
// deadpan, in-fiction; no exclamation marks; no cosmos garnish inside the controls.

/** The remote page. Self-contained; connects to /state on its own origin. */
export const REMOTE_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#090a0b">
<title>The glass · remote</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --deep-field:#090a0b; --sleeve:#10100d; --tape:#171611;
    --cream:#f4ead7; --stardust:#b7ab95; --gold:#f5b800; --glow:#ffd057;
    --red:#ff6b57; --line:#d0b99029; --veil:#f5b8001a;
    --oxanium:"Oxanium",ui-sans-serif,system-ui,sans-serif;
    --sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--deep-field);color:var(--cream);
    font-family:var(--sans);-webkit-font-smoothing:antialiased;overscroll-behavior:none;
    user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
  body{display:flex;flex-direction:column;gap:14px;padding:max(18px,env(safe-area-inset-top)) 18px max(18px,env(safe-area-inset-bottom))}
  .plate{font-family:var(--oxanium);font-weight:800;letter-spacing:.14em;font-size:.7rem;color:var(--stardust);text-transform:uppercase}
  .masthead{display:flex;align-items:baseline;justify-content:space-between}
  .masthead .r{font-family:var(--oxanium);font-weight:600;letter-spacing:.06em;color:var(--stardust);font-size:.66rem;text-transform:uppercase}

  .card{background:var(--sleeve);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
  .label{font-family:var(--oxanium);font-weight:600;letter-spacing:.1em;font-size:.62rem;color:var(--stardust);text-transform:uppercase;margin-bottom:8px}
  .coord{font-family:var(--oxanium);font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.02em;color:var(--gold);font-size:1rem;line-height:1}
  .title{font-weight:800;color:var(--cream);font-size:1.5rem;line-height:1.12;letter-spacing:-.01em;margin-top:8px}
  .artist{color:var(--stardust);font-size:.95rem;line-height:1.2;margin-top:5px}
  .next .title{font-size:1.05rem;color:var(--stardust);font-weight:700}
  .next .coord{color:var(--glow);opacity:.85}

  .nav{display:grid;grid-template-columns:1fr 2fr;gap:12px}
  button{font-family:var(--sans);font-size:1rem;font-weight:700;color:var(--cream);
    background:var(--tape);border:1px solid var(--line);border-radius:12px;padding:20px 14px;
    touch-action:manipulation;cursor:pointer;transition:transform .06s ease,background .12s ease,border-color .12s ease}
  button:active{transform:translateY(1px)}
  button.primary{background:var(--gold);color:#151006;border-color:transparent}
  button.primary:active{background:var(--glow)}
  button:disabled{opacity:.4}
  .blackout{width:100%;background:var(--tape);border:1px solid var(--line);color:var(--cream);
    border-radius:12px;padding:18px;font-weight:700;position:relative;overflow:hidden}
  .blackout .fill{position:absolute;inset:0;background:var(--veil);width:0;transition:none;pointer-events:none}
  .blackout.armed{border-color:var(--gold)}
  .blackout.engaged{background:#000;color:var(--stardust);border-color:var(--gold)}
  .blackout span{position:relative}

  .intensity{display:flex;align-items:center;gap:14px}
  .intensity button{flex:0 0 auto;width:56px;padding:14px 0;font-size:1.3rem}
  .intensity .val{flex:1;text-align:center;font-family:var(--oxanium);font-weight:700;font-variant-numeric:tabular-nums;font-size:1.4rem;color:var(--cream)}

  .health{display:flex;flex-wrap:wrap;gap:10px}
  .chip{display:flex;align-items:center;gap:7px;font-family:var(--oxanium);font-weight:600;
    letter-spacing:.05em;font-size:.66rem;text-transform:uppercase;color:var(--stardust);
    background:var(--tape);border:1px solid var(--line);border-radius:999px;padding:7px 12px}
  .dot{width:8px;height:8px;border-radius:999px;background:var(--stardust)}
  .dot.ok{background:var(--glow)}
  .dot.warn{background:var(--stardust)}
  .dot.bad{background:var(--red)}
  .dot.armed{background:var(--gold);box-shadow:0 0 8px var(--gold)}
  .match{font-family:var(--oxanium);font-weight:600;font-variant-numeric:tabular-nums;
    letter-spacing:.03em;font-size:.7rem;color:var(--stardust);text-align:center}
  .match b{color:var(--glow)}

  .offline{position:fixed;inset:0;display:none;align-items:center;justify-content:center;
    flex-direction:column;gap:10px;background:rgba(9,10,11,.92);z-index:9;text-align:center;padding:24px}
  .offline.show{display:flex}
  .offline .h{font-family:var(--oxanium);font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--red);font-size:.9rem}
  .offline .s{color:var(--stardust);font-size:.85rem}
  .spacer{flex:1}
</style></head><body>
  <div class="masthead"><div class="plate">The glass</div><div class="r" id="src">remote</div></div>

  <div class="card" id="cur">
    <div class="label">On the decks</div>
    <div class="coord" id="cur-coord">—</div>
    <div class="title" id="cur-title">Quiet sector</div>
    <div class="artist" id="cur-artist"></div>
  </div>

  <div class="card next" id="nxt">
    <div class="label">Up next</div>
    <div class="coord" id="nxt-coord">—</div>
    <div class="title" id="nxt-title">End of the plan</div>
  </div>

  <div class="nav">
    <button id="prev">Previous</button>
    <button id="next" class="primary">Next finding</button>
  </div>

  <button class="blackout" id="black"><span class="fill"></span><span id="black-label">Hold to black out</span></button>

  <div class="card">
    <div class="label">Intensity</div>
    <div class="intensity">
      <button id="int-down">–</button>
      <div class="val" id="int-val">1.0</div>
      <button id="int-up">+</button>
    </div>
  </div>

  <div class="spacer"></div>
  <div class="match" id="match"></div>
  <div class="health">
    <div class="chip"><span class="dot" id="d-audio"></span><span id="l-audio">audio</span></div>
    <div class="chip"><span class="dot" id="d-matcher"></span><span id="l-matcher">matcher</span></div>
    <div class="chip"><span class="dot" id="d-prearm"></span>pre-arm</div>
  </div>

  <div class="offline" id="offline"><div class="h">Bridge offline</div><div class="s">Lost the bridge. Reconnecting.</div></div>

<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var ws=null, connected=false, plan=[];
  function send(cmd){ if(ws&&ws.readyState===1){ ws.send(JSON.stringify(cmd)); } }

  // ---- WebSocket to /state on this same origin ----
  function connect(){
    var proto = location.protocol==="https:"?"wss:":"ws:";
    ws = new WebSocket(proto+"//"+location.host+"/state");
    ws.onopen=function(){ connected=true; $("offline").classList.remove("show"); };
    ws.onclose=function(){ connected=false; $("offline").classList.add("show"); setTimeout(connect,1200); };
    ws.onerror=function(){ try{ws.close()}catch(e){} };
    ws.onmessage=function(ev){ try{ render(JSON.parse(ev.data)); }catch(e){} };
  }

  var SRC={fingerprint:"by ear",manual:"by hand",boot:"cold boot"};
  function render(s){
    // current + next identity
    var cur=s.current;
    $("cur-coord").textContent = cur? cur.logId : "—";
    $("cur-title").textContent = cur? cur.title : "Quiet sector";
    $("cur-artist").textContent = cur? (cur.artists||[]).join(", ") : "";
    var nx = s.pending;
    $("nxt-coord").textContent = nx? nx.logId : "—";
    $("nxt-title").textContent = nx? nx.title : "End of the plan";
    $("next").disabled = !nx;
    $("prev").disabled = s.plan.pointer<=0;
    $("src").textContent = "remote · "+(SRC[s.plan.source]||s.plan.source)+" · "+(s.plan.pointer+1)+"/"+s.plan.total;

    // intensity + blackout (reflect authoritative state)
    if(!intHold) $("int-val").textContent = Number(s.intensity).toFixed(1);
    if(!blackHold){
      var b=$("black"); b.classList.toggle("engaged", !!s.blackout);
      $("black-label").textContent = s.blackout? "Blacked out · tap to return" : "Hold to black out";
    }

    // channels — canon colours, no green
    dot("d-audio", s.channels.audio==="live"?"ok":s.channels.audio==="stale"?"warn":"bad");
    $("l-audio").textContent = "audio "+s.channels.audio;
    dot("d-matcher", s.channels.matcher==="ready"?"ok":"bad");
    $("l-matcher").textContent = s.channels.matcher==="ready"?"matcher ready":"matcher off";
    dot("d-prearm", s.prearmed?"armed":"");
    // match readout
    var m=s.match;
    $("match").innerHTML = m? ("match "+m.confidence.toFixed(2)+" → <b>"+m.logId+"</b>") : "";
  }
  function dot(id,cls){ var el=$(id); el.className="dot"+(cls?" "+cls:""); }

  // ---- controls ----
  $("next").onclick=function(){ send({cmd:"advance"}); };
  $("prev").onclick=function(){ send({cmd:"rewind"}); };

  // intensity — optimistic local echo, clamp 0.4..1.3 (mirrors the glass)
  var intVal=1.0, intHold=false, intT=null;
  function nudgeInt(d){ intHold=true; intVal=Math.min(1.3,Math.max(0.4,Math.round((intVal+d)*10)/10));
    $("int-val").textContent=intVal.toFixed(1); send({cmd:"intensity",value:intVal});
    clearTimeout(intT); intT=setTimeout(function(){intHold=false;},1500); }
  $("int-up").onclick=function(){ nudgeInt(0.1); };
  $("int-down").onclick=function(){ nudgeInt(-0.1); };

  // blackout — hold ~360ms to engage (mirrors the glass's guarded key); tap again returns
  var black=$("black"), fill=black.querySelector(".fill"), blackHold=false, holdTimer=null, engaged=false, raf=null, holdStart=0;
  function beginHold(e){ e.preventDefault();
    if(engaged){ engaged=false; blackHold=true; send({cmd:"blackout",on:false}); black.classList.remove("engaged"); $("black-label").textContent="Hold to black out"; setTimeout(function(){blackHold=false;},400); return; }
    black.classList.add("armed"); holdStart=Date.now();
    (function tick(){ var p=Math.min(1,(Date.now()-holdStart)/360); fill.style.width=(p*100)+"%"; if(p<1) raf=requestAnimationFrame(tick); })();
    holdTimer=setTimeout(function(){ engaged=true; blackHold=true; black.classList.remove("armed"); black.classList.add("engaged");
      $("black-label").textContent="Blacked out · tap to return"; send({cmd:"blackout",on:true}); fill.style.width="0"; setTimeout(function(){blackHold=false;},400); },360);
  }
  function endHold(){ if(holdTimer){ clearTimeout(holdTimer); holdTimer=null; } if(raf){ cancelAnimationFrame(raf); raf=null; } black.classList.remove("armed"); if(!engaged) fill.style.width="0"; }
  black.addEventListener("touchstart",beginHold,{passive:false});
  black.addEventListener("touchend",endHold);
  black.addEventListener("mousedown",beginHold);
  black.addEventListener("mouseup",endHold);
  black.addEventListener("mouseleave",endHold);

  connect();
})();
</script></body></html>`;
