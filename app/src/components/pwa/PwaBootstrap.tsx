'use client'

import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}
const getClientSnapshot = () => false
const getServerSnapshot = () => true

/** Site-wide PWA bootstrap — server-rendered before React so install prompt is not missed. */
export default function PwaBootstrap() {
  const enableSw = process.env.NODE_ENV === 'production'
  // React 19.3 (bundled by Next.js 16) rejects script elements created by
  // post-hydration client renders. Keep the SSR/hydration script, then drop it.
  const shouldRenderScript = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  )

  if (!shouldRenderScript) return null

  return (
    <script
      id="pwa-bootstrap"
      dangerouslySetInnerHTML={{
        __html: `(function(){try{
if(window.__pwaBootstrapInitialized) return;
window.__pwaInstall=window.__pwaInstall||{prompt:null};
window.__serappInstall=window.__pwaInstall;
window.addEventListener('beforeinstallprompt',function(e){
  e.preventDefault();
  window.__pwaInstall.prompt=e;
  window.dispatchEvent(new Event('pwa-install-ready'));
});
window.addEventListener('appinstalled',function(){
  window.__pwaInstall.prompt=null;
  window.dispatchEvent(new Event('pwa-install-ready'));
});
window.__pwaBootstrapInitialized=true;
if(!('serviceWorker' in navigator)) return;
var enableSw=${enableSw ? 'true' : 'false'};
var host=location.hostname;
var isLocal=host==='localhost'||host==='127.0.0.1'||host==='[::1]'||host.endsWith('.local');
if(isLocal) enableSw=false;
navigator.serviceWorker.getRegistrations().then(function(regs){
  if(!enableSw){
    regs.forEach(function(reg){ reg.unregister().catch(function(){}); });
    if(window.caches){
      caches.keys().then(function(keys){
        keys.forEach(function(k){ caches.delete(k); });
      });
    }
    return;
  }
  var origin=location.origin;
  regs.forEach(function(reg){
    var scope=reg.scope||'';
    if(scope!==origin+'/'&&scope!==origin){
      reg.unregister().catch(function(){});
    }
  });
}).then(function(){
  if(!enableSw) return;
  return navigator.serviceWorker.register('/sw.js',{scope:'/'});
}).catch(function(){});
}catch(e){}})();`
      }}
    />
  )
}
