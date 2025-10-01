const fs = require('fs');
const path = require('path');

let PROVIDERS=null;
function loadProviders(){
  if(PROVIDERS) return PROVIDERS;
  const p=path.join(__dirname,'consent-providers.json');
  PROVIDERS = JSON.parse(fs.readFileSync(p,'utf8'));
  return PROVIDERS;
}

function loadLearning(){
  const f=path.join(process.cwd(), '.archiver','learned-consent-rules.json');
  try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return {}; }
}
function saveLearning(store){
  const dir=path.join(process.cwd(), '.archiver');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'learned-consent-rules.json'), JSON.stringify(store,null,2));
}

function domainKey(url){
  try {
    const { hostname } = new URL(url);
    const parts=hostname.split('.').slice(-3); // crude eTLD+1 attempt
    return parts.slice(-2).join('.');
  } catch { return null; }
}

async function adaptiveConsent(page, targetUrl, opts={}){
  const providers = loadProviders();
  const learning = loadLearning();
  const key = domainKey(targetUrl);
  const learned = key && learning[key];

  const script = (providers, learned, key, options) => new Promise(resolve=>{
    const start=Date.now();
    const MAX_MS = options.maxMs || 20000;
    const LOOP_INTERVAL = 400;
    const HIGH_THRESHOLD = 30;

    const providerEntries = Object.entries(providers);
    const langPhrases = [
      // high priority phrases (add more languages)
      'accept all','allow all','allow all cookies','agree',
      'позволи всички','позволи всички бисквитки','приеми'
    ];

    function norm(t){ return (t||'').replace(/\u00A0/g,' ').trim().toLowerCase(); }

    function detectProvider(){
      // by script src or id presence
      const scripts=[...document.scripts].map(s=>s.src);
      for(const [name, sig] of providerEntries){
        if(sig.ids && sig.ids.some(id=>document.getElementById(id))) return name;
        if(sig.scripts && sig.scripts.some(dom=>scripts.some(src=>src.includes(dom)))) return name;
      }
      return null;
    }

    function phraseScore(text){
      const n=norm(text);
      let best=0;
      for(const p of langPhrases){
        if(n.includes(p)) {
          const ratio = p.length / Math.max(n.length, p.length);
            best = Math.max(best, 0.8 + ratio*0.2);
        }
      }
      return best;
    }

    function scoreCandidate(el, providerName){
      const txt = norm(el.textContent||'');
      if(!txt) return -Infinity;
      let s=0;
      const pScore=phraseScore(txt);
      if(pScore>=0.8) s+=40;
      else if(pScore>0) s+=25*pScore;

      if(/\b(accept|allow|agree|all|всички|приеми|позволи)\b/i.test(txt)) s+=15;
      if(/\b(decline|reject|necessary|strict|само строго)/i.test(txt)) s-=20;

      const r=el.getBoundingClientRect();
      if(r.width>=100 && r.width<=600 && r.height>=30 && r.height<=150) s+=10;
      if(providerName) s+=8;

      const cls=(el.className||'').toLowerCase();
      if(/accept|allow|agree|all|optin|consent/.test(cls)) s+=10;

      const style=getComputedStyle(el);
      if(style.visibility==='hidden' || style.opacity==='0') s-=25;

      return s;
    }

    function gatherButtons(container){
      return [...container.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], div')].filter(el=>{
        if(el.disabled) return false;
        const txt=norm(el.textContent||el.value||'');
        if(!txt) return false;
        if(txt.length>120) return false;
        return true;
      });
    }

    let success=false;
    let provider = detectProvider();
    const learnedSelector = learned && learned.method==='selector' && learned.selector;

    function tryLearned(){
      if(!learnedSelector) return false;
      const el=document.querySelector(learnedSelector);
      if(el){
        el.click();
        return true;
      }
      return false;
    }

    if(tryLearned()){
      success=true;
    }

    function loop(){
      if(success) return finalize('learned');
      if(Date.now()-start>MAX_MS) return finalize('timeout');

      if(!provider){
        provider = detectProvider();
      }

      // provider root containers or large overlays
      const roots=[];
      if(provider && providers[provider].ids){
        providers[provider].ids.forEach(id=>{
          const el=document.getElementById(id);
          if(el) roots.push(el);
        });
      }
      if(!roots.length){
        // fallback: large fixed overlays bottom 40%
        const vh=window.innerHeight;
        document.querySelectorAll('body *').forEach(el=>{
          const st=getComputedStyle(el);
          if(st.position!=='fixed') return;
          const r=el.getBoundingClientRect();
          if(r.height>100 && r.width>300 && r.top>vh*0.4) roots.push(el);
        });
      }

      let best={el:null,score:-Infinity};
      for(const root of roots){
        for(const btn of gatherButtons(root)){
          const sc=scoreCandidate(btn, provider);
          if(sc>best.score) best={el:btn,score:sc};
        }
      }
      if(!best.el && !roots.length){
        // scan entire doc as last resort
        for(const btn of gatherButtons(document)){
          const sc=scoreCandidate(btn, provider);
          if(sc>best.score) best={el:btn,score:sc};
        }
      }

      if(best.el && best.score>=HIGH_THRESHOLD){
        try{ best.el.click(); success=true; return finalize('clicked',{score:best.score,text:best.el.textContent.trim()}); }catch{}
      }

      setTimeout(loop, LOOP_INTERVAL);
    }

    function finalize(mode, meta){
      resolve({ success, provider, mode, meta });
    }

    loop();
  };

  const result = await page.evaluate(script, providers, learned, key, {maxMs: process.env.CONSENT_MAX_MS?parseInt(process.env.CONSENT_MAX_MS,10):20000});
  // Learning logic (simplified)
  if(result.success && key){
    const store = loadLearning();
    if(!store[key]) store[key]={ provider: result.provider||null, successCount:0 };
    store[key].successCount++;
    if(result.mode==='clicked' && result.meta){
      // attempt to derive a stable selector
      // (We could in evaluate() capture el path; for brevity assume meta.placeholderSelector)
    }
    saveLearning(store);
  }
  return result;
}

module.exports = { adaptiveConsent };
