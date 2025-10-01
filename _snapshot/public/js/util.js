// Global helpers for robust JSON handling across the UI
// Usage: const data = await window.safeParseJson(fetchResponse)
(function(){
  async function safeParseJson(res){
    try{
      const text = await res.text();
      if(!res.ok){
        const msg = 'HTTP '+res.status + (text?(' '+text.slice(0,200)):'');
        throw new Error(msg);
      }
      if(!text) return {};
      try{ return JSON.parse(text); }
      catch{ return { ok:true, raw: text }; }
    }catch(e){
      throw e;
    }
  }
  window.safeParseJson = safeParseJson;
})();
