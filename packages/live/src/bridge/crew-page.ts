// THE CREW WALL'S THREE PAGES — plain HTML/CSS/JS, no build step, no framework, exactly like
// `remote.ts`. All three are canon surfaces on DESIGN.md's tokens (Deep Field ground,
// Starlight Cream ink, Stardust muted, Eclipse Gold as the one accent, Re-entry Red for
// problems, Oxanium tabular for numerals and the brand plate).
//
//   * `CREW_HTML` — `/crew`, the page a stranger at the party opens off a QR. An ARRIVAL
//     surface: Fluncle introduces himself in plain first person and turns to the room, with
//     zero cosmos vocabulary (nobody scanning a code at a rave has read the lore yet).
//   * `CREW_WALL_HTML` — `/crew/wall`, the overlay OBS reads as a Browser Source. Its ground
//     is TRANSPARENT so it composites over the scene, and it degrades to showing nothing at
//     all rather than a broken box.
//   * `CREW_MODERATE_HTML` — `/crew/moderate`, the operator's approve/reject queue. Operator
//     tier (VOICE.md §5), so the terse ALL-CAPS status words are in register here and the
//     copy stays a tool's copy.
//
// Two standing rules across the three:
//   * Uploader text is rendered with `textContent`, never `innerHTML` — the label on a logo
//     was typed by a stranger on the room's WiFi.
//   * ONE ACTION, ONE LABEL (the Chrome Rule): putting a logo up is called **"Add your logo"**
//     on the wall card, the page title and the submit button alike. No fourth phrasing.

import { CREW_MAX_BYTES } from "../contract";

/** The size cap, stated the way a phone owner reads it, from the ONE constant that enforces it. */
const MAX_MB = Math.round(CREW_MAX_BYTES / 1_000_000);

/** The shared token block + reset all three pages open with. */
const TOKENS = `
  :root{
    --deep-field:#090a0b; --sleeve:#10100d; --tape:#171611;
    --cream:#f4ead7; --stardust:#b7ab95; --gold:#f5b800; --glow:#ffd057;
    --red:#ff6b57; --line:#d0b99029; --veil:#f5b8001a;
    --oxanium:"Oxanium",ui-sans-serif,system-ui,sans-serif;
    --sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
  }
  *{box-sizing:border-box}
  .plate{font-family:var(--oxanium);font-weight:800;letter-spacing:.14em;font-size:.7rem;
    color:var(--stardust);text-transform:uppercase}
`;

/** `/crew` — the upload page the room opens. */
export const CREW_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#090a0b">
<meta name="robots" content="noindex">
<title>Add your logo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
${TOKENS}
  html,body{margin:0;min-height:100%;background:var(--deep-field);color:var(--cream);
    font-family:var(--sans);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
  body{display:flex;flex-direction:column;gap:18px;
    padding:max(20px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom));max-width:34rem;margin:0 auto}
  h1{font-size:1.55rem;line-height:1.14;letter-spacing:-.01em;margin:0;font-weight:800}
  .lede{color:var(--stardust);font-size:.98rem;line-height:1.45;margin:0}
  .card{background:var(--sleeve);border:1px solid var(--line);border-radius:14px;padding:18px}
  .drop{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;
    border:1px dashed #d0b99055;border-radius:14px;padding:26px 18px;background:var(--tape);
    cursor:pointer;transition:border-color .12s ease,background .12s ease}
  /* The quiet control catches the Gold Veil on reach (DESIGN, the Ignition Rule). */
  .drop:hover,.drop:focus-within{border-color:var(--gold);background:var(--veil)}
  .drop input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
  .drop .big{font-weight:700;font-size:1.05rem}
  .drop .hint{color:var(--stardust);font-size:.82rem;line-height:1.4}
  .shot{display:none;margin:0 auto;max-width:100%;max-height:44vh;border-radius:10px;
    background:var(--tape);border:1px solid var(--line)}
  .shot.show{display:block}
  /* Labels are bold and small, never tracked-out eyebrows, and never in the brand face. */
  label.field{display:block;font-family:var(--sans);font-weight:700;font-size:.76rem;
    color:var(--stardust);margin-bottom:8px}
  input[type=text]{width:100%;font-family:var(--sans);font-size:1rem;color:var(--cream);
    background:var(--tape);border:1px solid var(--line);border-radius:10px;padding:14px}
  /* State the placeholder colour: the browser default on a dark input is low contrast. */
  input[type=text]::placeholder{color:var(--stardust);opacity:1}
  input[type=text]:focus-visible,.drop:focus-within{outline:2px solid var(--gold);outline-offset:2px}
  /* The sun is never dimmed. Before a file is picked the button sits in the OUTLINE register
     and IGNITES to the gold fill once there is something to send. */
  button{width:100%;font-family:var(--sans);font-size:1.05rem;font-weight:700;color:var(--cream);
    background:transparent;border:1px solid var(--line);border-radius:12px;padding:18px 14px;
    cursor:pointer;touch-action:manipulation;
    transition:transform .06s ease,background .12s ease,color .12s ease,border-color .12s ease}
  button.ready{background:var(--gold);color:#151006;border-color:transparent}
  button:active{transform:translateY(1px)}
  button.ready:active{background:var(--glow)}
  button:disabled{cursor:default}
  button:focus-visible{outline:2px solid var(--glow);outline-offset:2px}
  .said{font-size:.95rem;line-height:1.45;min-height:1.4em;margin:0}
  .said.ok{color:var(--glow)}
  .said.bad{color:var(--red)}
  .foot{color:var(--stardust);font-size:.78rem;line-height:1.45;margin:0}
  .foot.more{display:none}
  .foot.more.show{display:block}
  .foot a{color:var(--glow)}
  @media (prefers-reduced-motion: reduce){
    *{transition:none!important}
    button:active{transform:none}
  }
</style></head><body>
  <div class="plate">Fluncle live</div>
  <h1>Add your logo to the wall</h1>
  <p class="lede">I'm Fluncle, I'm on the decks tonight. The screen behind me is half yours: send a logo up, I'll have a look, and up it goes.</p>

  <div class="card">
    <label class="drop" id="drop">
      <input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span class="big" id="pick">Choose an image</span>
      <span class="hint">PNG, JPG, WebP or GIF. Up to ${MAX_MB} MB.</span>
    </label>
    <img class="shot" id="shot" alt="The image you picked">
  </div>

  <div class="card">
    <label class="field" for="who">Name or crew (optional)</label>
    <input type="text" id="who" maxlength="40" autocomplete="off" placeholder="So I know whose logo it is">
  </div>

  <button id="send" disabled>Add your logo</button>
  <p class="said" id="said" role="status" aria-live="polite"></p>
  <p class="foot more" id="more">More of what I play is at <a href="https://www.fluncle.com">fluncle.com</a>.</p>
  <p class="foot">Only the people on this WiFi can reach this page. Nothing here leaves the room.</p>

<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var file=$("file"), send=$("send"), said=$("said"), shot=$("shot"), pick=$("pick");

  var SAID={
    "empty":"Nothing came through. Pick an image and try again.",
    "too-big":"That one's over ${MAX_MB} MB. Shrink it and send it again.",
    "not-an-image":"That's not an image I can put on a screen. Try a PNG, JPG, WebP or GIF.",
    "wall-full":"The wall's full tonight. That's the lot.",
    "too-fast":"You're going quick. Give it a minute.",
    "off":"That didn't reach the wall. Have another go."
  };

  function say(text, kind){
    said.textContent=text;
    said.className="said"+(kind?" "+kind:"");
  }

  // The submit button's ready state is a class, not an opacity: see the Ignition Rule above.
  function ready(on){
    send.disabled=!on;
    send.classList.toggle("ready", on);
  }

  file.onchange=function(){
    var f=file.files && file.files[0];
    if(!f){ ready(false); shot.classList.remove("show"); pick.textContent="Choose an image"; return; }
    pick.textContent=f.name;
    shot.src=URL.createObjectURL(f);
    shot.classList.add("show");
    ready(true);
    // Announce it: the filename swap and the button waking up are both silent otherwise.
    say("Picked "+f.name+".");
  };

  send.onclick=function(){
    var f=file.files && file.files[0];
    if(!f){ say(SAID["empty"],"bad"); return; }
    ready(false);
    say("Sending it over.");
    var body=new FormData();
    body.append("logo", f);
    var who=$("who").value.trim();
    if(who){ body.append("label", who); }
    fetch("/crew/logo",{method:"POST",body:body}).then(function(res){
      return res.json().then(function(json){ return {status:res.status, json:json}; });
    }).then(function(out){
      if(out.status===200 && out.json && out.json.ok){
        say(out.json.pending
          ? "That's in. I'll have a look, then it goes up."
          : "That's up on the wall now.", "ok");
        file.value=""; shot.classList.remove("show"); pick.textContent="Choose an image";
        $("more").classList.add("show");
        return;
      }
      say(SAID[(out.json && out.json.reason) || "off"] || SAID["off"], "bad");
      ready(true);
    }).catch(function(){
      say(SAID["off"],"bad");
      ready(true);
    });
  };
})();
</script></body></html>`;

/** `/crew/wall` — the rotating overlay OBS composites over the scene. */
export const CREW_WALL_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>The crew wall</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
${TOKENS}
  /* TRANSPARENT ground: this page is a layer over the show, not a page. */
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;color:var(--cream);
    font-family:var(--sans)}
  #stage{position:fixed;width:var(--w,220px);height:var(--w,220px)}
  #stage.tl{top:5vh;left:4vw} #stage.tr{top:5vh;right:4vw}
  #stage.bl{bottom:5vh;left:4vw} #stage.br{bottom:5vh;right:4vw}
  .lay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    opacity:0;transition:opacity 900ms ease}
  .lay.on{opacity:var(--peak,.92)}
  /* width/height 100% + contain SCALES UP a small logo to fill the box; max-width alone
     leaves a 120px logo sitting at 120px on a 1080p wall.
     The drop-shadow here is a contrast device against UNCONTROLLED footage (the camera shot
     and the glass beneath it), not a depth cue on a pane: the shadow ban is about elevation,
     and legibility over an unknown ground is what governs a layer like this one. */
  .lay img{width:100%;height:100%;object-fit:contain;
    filter:drop-shadow(0 2px 18px rgba(0,0,0,.55))}
  /* The card scales with the canvas. Sized for a phone it survives the projector in the room
     but shrinks past scanning once the stream is watched on a phone, which is most of the
     audience. The room's screen is the primary path; when the stream is the audience that
     matters, raise it with the ?qr-size= parameter. */
  #qr{position:fixed;display:none;align-items:center;gap:clamp(12px,1.4vmin,22px);
    background:#090a0bd9;border:1px solid var(--line);border-radius:14px;
    padding:clamp(12px,1.2vmin,20px) clamp(16px,1.6vmin,26px) clamp(12px,1.2vmin,20px) clamp(12px,1.2vmin,20px)}
  #qr.on{display:flex}
  #qr.tl{top:5vh;left:4vw} #qr.tr{top:5vh;right:4vw}
  #qr.bl{bottom:5vh;left:4vw} #qr.br{bottom:5vh;right:4vw}
  #qr img{width:var(--qr,clamp(96px,16vmin,260px));height:var(--qr,clamp(96px,16vmin,260px));
    display:block;border-radius:6px}
  #qr .ask{font-weight:800;font-size:clamp(1rem,2.6vmin,2.2rem);line-height:1.2}
  #qr .where{font-family:var(--oxanium);font-weight:700;font-variant-numeric:tabular-nums;
    letter-spacing:.02em;color:var(--glow);font-size:clamp(.82rem,2vmin,1.8rem);margin-top:.4em}
  @media (prefers-reduced-motion: reduce){.lay{transition-duration:180ms}}
</style></head><body>
  <div id="stage"><div class="lay" id="a"><img alt=""></div><div class="lay" id="b"><img alt=""></div></div>
  <div id="qr"><img id="qr-img" alt=""><div><div class="ask">Add your logo</div><div class="where" id="qr-where"></div></div></div>

<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var q=new URLSearchParams(location.search);
  var stage=$("stage"), layers=[$("a"),$("b")], front=0;

  // ---- placement, tunable from the OBS source URL (no code edit to reposition) ----
  var corner=["tl","tr","bl","br"].indexOf(q.get("corner")||"br")>=0?(q.get("corner")||"br"):"br";
  stage.className=corner;
  stage.style.setProperty("--w",(parseInt(q.get("size"),10)||220)+"px");
  layers.forEach(function(l){ l.style.setProperty("--peak", String(Math.min(1,Math.max(.1,parseFloat(q.get("opacity"))||.92)))); });

  var qrOn=q.get("qr")!=="0";
  var qrCorner=["tl","tr","bl","br"].indexOf(q.get("qr-corner")||"bl")>=0?(q.get("qr-corner")||"bl"):"bl";
  var qrSize=parseInt(q.get("qr-size"),10);
  if(qrSize>0){ $("qr").style.setProperty("--qr", qrSize+"px"); }

  // ---- the roll: the bridge owns the order (one shuffle implementation) ----
  var roll={version:-1,order:[],logos:[],dwellMs:18000};
  var byId={}, step=0, showing=null, timer=null, misses=0;

  function urlFor(id){ var l=byId[id]; return l?l.url:null; }

  function paint(id){
    var url=urlFor(id);
    if(!url){ return; }
    var next=layers[1-front];
    var img=next.querySelector("img");
    img.onload=function(){
      misses=0;
      next.classList.add("on");
      layers[front].classList.remove("on");
      front=1-front;
    };
    // A logo that will not paint — deleted mid-show, or bytes that carry the right magic but
    // do not decode — must never freeze the wall, and must never spin it either: skip to the
    // next one, but only as many times as there are logos. Past that the wall holds what it
    // has until the next dwell tick or approval, instead of hammering a bad file forever.
    img.onerror=function(){
      misses++;
      if(misses<=roll.order.length){ advance(); }
    };
    img.src=url;
    showing=id;
  }

  function hide(){
    layers.forEach(function(l){ l.classList.remove("on"); });
    showing=null;
  }

  function advance(){
    if(roll.order.length===0){ hide(); return; }
    if(step>=roll.order.length){ step=0; load(); return; }   // exhausted: draw a fresh order
    paint(roll.order[step++]);
  }

  function load(){
    var url="/crew/roll"+(showing?("?last="+encodeURIComponent(showing)):"");
    return fetch(url,{cache:"no-store"}).then(function(r){ return r.json(); }).then(function(next){
      roll=next; byId={};
      (roll.logos||[]).forEach(function(l){ byId[l.id]=l; });
      step=0; misses=0;
      if(roll.order.length===0){ hide(); return; }
      advance();
    }).catch(function(){ /* keep showing what we have: the wall never goes to an error state */ });
  }

  // The dwell timer is independent of the fetch, so a slow or failed poll never stalls
  // the rotation — it just keeps walking the order it already holds.
  function tick(){
    var dwell=parseInt(q.get("dwell"),10)||roll.dwellMs||18000;
    clearTimeout(timer);
    timer=setTimeout(function(){ misses=0; advance(); tick(); }, dwell);
  }

  // Re-poll on a slow cadence so an approval reaches the wall without a reload. This asks
  // the CHEAP version endpoint, not /crew/roll — a roll draws a fresh shuffle server-side,
  // and throwing one away every six seconds all night is work for nothing.
  function watch(){
    setInterval(function(){
      fetch("/crew/version",{cache:"no-store"}).then(function(r){ return r.json(); }).then(function(next){
        if(next.version!==roll.version){ load(); }
      }).catch(function(){});
    }, 6000);
  }

  // The card appears only once the CODE ITSELF has loaded. /crew/qr.svg has its own failure
  // path (a URL too long to encode answers 404), and a broken-image glyph sitting on the
  // broadcast is worse than no card at all.
  if(qrOn){
    fetch("/crew/where",{cache:"no-store"}).then(function(r){ return r.json(); }).then(function(w){
      if(!w || !w.url){ return; }
      $("qr-where").textContent=w.short||w.url;
      var img=$("qr-img");
      img.onload=function(){ $("qr").className=qrCorner+" on"; };
      img.onerror=function(){ $("qr").className=qrCorner; };
      img.src="/crew/qr.svg";
    }).catch(function(){});
  }

  load().then(tick);
  watch();
})();
</script></body></html>`;

/** `/crew/moderate` — the operator's queue. Operator tier: a tool's copy, ALL-CAPS states. */
export const CREW_MODERATE_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#090a0b">
<meta name="robots" content="noindex">
<title>The crew wall · queue</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
${TOKENS}
  html,body{margin:0;min-height:100%;background:var(--deep-field);color:var(--cream);
    font-family:var(--sans);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
  body{display:flex;flex-direction:column;gap:14px;
    padding:max(18px,env(safe-area-inset-top)) 18px max(18px,env(safe-area-inset-bottom));max-width:40rem;margin:0 auto}
  .masthead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
  .counts{font-family:var(--oxanium);font-weight:700;font-variant-numeric:tabular-nums;
    letter-spacing:.05em;font-size:.68rem;color:var(--stardust);text-transform:uppercase}
  .label{font-family:var(--sans);font-weight:700;font-size:.76rem;color:var(--stardust);margin:6px 0 2px}
  .row{display:flex;align-items:center;gap:12px;background:var(--sleeve);
    border:1px solid var(--line);border-radius:12px;padding:10px}
  .row img{width:64px;height:64px;object-fit:contain;background:var(--tape);
    border-radius:8px;flex:0 0 auto}
  .row .who{flex:1;min-width:0}
  .row .who .name{font-weight:700;font-size:.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .who .when{font-family:var(--oxanium);font-weight:600;font-variant-numeric:tabular-nums;
    color:var(--stardust);font-size:.7rem;letter-spacing:.04em;margin-top:3px}
  .acts{display:flex;gap:8px;flex:0 0 auto}
  /* On a narrow phone the name is the thing you judge on, so let the buttons drop to their
     own line rather than squeezing it down to an ellipsis. */
  @media (max-width:26rem){
    .row{flex-wrap:wrap}
    .acts{flex:1 0 100%}
    .acts button{flex:1}
  }
  button{font-family:var(--sans);font-size:.88rem;font-weight:700;color:var(--cream);
    background:var(--tape);border:1px solid var(--line);border-radius:10px;padding:12px 14px;
    cursor:pointer;touch-action:manipulation}
  button.primary{background:var(--gold);color:#151006;border-color:transparent}
  button.drop{color:var(--red)}
  button.drop.armed{border-color:var(--red)}
  button:focus-visible{outline:2px solid var(--glow);outline-offset:2px}
  .empty{color:var(--stardust);font-size:.9rem;padding:14px 2px}
  .said{font-family:var(--oxanium);font-weight:600;letter-spacing:.05em;font-size:.68rem;
    color:var(--stardust);text-transform:uppercase;min-height:1.2em}
  .said.bad{color:var(--red)}
</style></head><body>
  <div class="masthead"><div class="plate">The crew wall</div><div class="counts" id="counts"></div></div>
  <div class="said" id="said" role="status" aria-live="polite"></div>
  <div class="label">Pending</div>
  <div id="pending"></div>
  <div class="label">On the wall</div>
  <div id="approved"></div>

<script>
(function(){
  var $=function(id){return document.getElementById(id)};

  function say(text,bad){ $("said").textContent=text||""; $("said").className="said"+(bad?" bad":""); }

  function stamp(ms){
    var d=new Date(ms);
    var pad=function(n){ return (n<10?"0":"")+n; };
    return pad(d.getHours())+":"+pad(d.getMinutes());
  }

  function row(logo, pending){
    var el=document.createElement("div");
    el.className="row";
    var img=document.createElement("img");
    img.src="/crew/logo/"+logo.id;
    img.alt="";
    var who=document.createElement("div");
    who.className="who";
    var name=document.createElement("div");
    name.className="name";
    // The label was typed by a stranger on the room's WiFi: textContent, never innerHTML.
    name.textContent=logo.label||"No name given";
    var when=document.createElement("div");
    when.className="when";
    when.textContent=(pending?"PENDING":"APPROVED")+" · "+stamp(logo.addedAt);
    who.appendChild(name); who.appendChild(when);
    var acts=document.createElement("div");
    acts.className="acts";
    if(pending){
      var yes=document.createElement("button");
      yes.className="primary"; yes.textContent="Approve";
      yes.onclick=function(){ act("approve", logo.id); };
      acts.appendChild(yes);
    }
    // Reject and Remove both delete for good, and mid-set they sit a thumb's width from
    // Approve — so they ARM on the first tap and act on the second.
    var no=document.createElement("button");
    var resting=pending?"Reject":"Remove";
    var armTimer=null;
    no.className="drop"; no.textContent=resting;
    no.onclick=function(){
      if(no.classList.contains("armed")){
        clearTimeout(armTimer);
        act("reject", logo.id);
        return;
      }
      no.classList.add("armed"); no.textContent="Sure?";
      armTimer=setTimeout(function(){ no.classList.remove("armed"); no.textContent=resting; }, 3000);
    };
    acts.appendChild(no);
    el.appendChild(img); el.appendChild(who); el.appendChild(acts);
    return el;
  }

  function fill(host, logos, pending, emptyText){
    host.textContent="";
    if(logos.length===0){
      var none=document.createElement("div");
      none.className="empty"; none.textContent=emptyText;
      host.appendChild(none);
      return;
    }
    logos.forEach(function(l){ host.appendChild(row(l, pending)); });
  }

  function draw(list){
    var pending=list.filter(function(l){ return l.state==="pending"; });
    var approved=list.filter(function(l){ return l.state==="approved"; });
    $("counts").textContent=pending.length+" pending · "+approved.length+" on the wall";
    fill($("pending"), pending, true, "Nothing waiting.");
    fill($("approved"), approved, false, "Nothing on the wall yet.");
  }

  // Rebuilding the lists replaces every button, which takes the keyboard's focus with it. So
  // redraw ONLY when the queue actually changed, and never while a control is held — the next
  // poll picks it up, and an approve/reject redraws itself immediately.
  var drawn="";
  function holdingAControl(){
    var active=document.activeElement;
    return !!active && ($("pending").contains(active) || $("approved").contains(active));
  }

  function load(force){
    return fetch("/crew/logos",{cache:"no-store"}).then(function(r){ return r.json(); })
      .then(function(json){
        var list=json.logos||[];
        var signature=list.map(function(l){ return l.id+":"+l.state; }).join(",");
        if(force || (signature!==drawn && !holdingAControl())){
          drawn=signature;
          draw(list);
        }
        say("");
      })
      .catch(function(){ say("Lost the bridge. Reconnecting.", true); });
  }

  function act(what, id){
    fetch("/crew/"+what,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({id:id})})
      .then(function(r){ return r.json(); })
      .then(function(json){ if(!json.ok){ say("That one's already gone.", true); } return load(true); })
      .catch(function(){ say("That didn't go through. Try again.", true); });
  }

  load(true);
  setInterval(load, 3000);
})();
</script></body></html>`;
