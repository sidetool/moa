/** Original extensions signal completion through the Flutter WebView handler. */
export function mangayomiWebViewScript(scripts: readonly string[]) {
  return `(async()=>{
    const scripts=${JSON.stringify(scripts)};
    let resolveResponse; const response=new Promise(resolve=>{resolveResponse=resolve});
    const original=window.flutter_inappwebview;
    window.flutter_inappwebview={...original,callHandler:async(name,...args)=>{
      if(name==='setResponse'){resolveResponse(args[0]??null);return null;}
      if(original?.callHandler)return original.callHandler(name,...args);
      throw new Error('unsupported_webview_handler');
    }};
    try {
      for(const script of scripts) await (0,eval)(script);
      return scripts.some(script=>script.includes('setResponse')) ? await response : true;
    } finally {window.flutter_inappwebview=original;}
  })()`;
}
