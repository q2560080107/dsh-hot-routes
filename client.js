window.__ModuleLoader__.load({id:`dsh-hot-routes`,factory:require=>{var module={exports:{}};var exports=module.exports;
/** 「Agent 路由热刷新器」浏览器半区：插件启动后在 GUI 右下角弹一次提示（按版本去重）。 */
const VERSION='1.0.4';
const KEY='dsh-hot-routes:notified-version';
function toast(text){
  try{
    const el=document.createElement('div');
    el.textContent=text;
    el.setAttribute('role','status');
    el.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483000;background:#1d4ed8;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:380px;cursor:pointer';
    el.onclick=()=>el.remove();
    document.body.appendChild(el);
    setTimeout(()=>{try{el.remove()}catch(e){}},9000);
  }catch(e){}
}
function apply(ctx){
  try{
    let seen='';
    try{seen=window.localStorage.getItem(KEY)||''}catch(e){}
    if(seen!==VERSION){
      try{window.localStorage.setItem(KEY,VERSION)}catch(e){}
      const show=()=>toast('✅ dsh-hot-routes '+VERSION+' 已启用：保存子智能体模型设置后，运行中的会话立即热生效');
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show,{once:true});
      else show();
    }
    try{ctx.effect(()=>()=>{})}catch(e){}
  }catch(e){}
}
exports.apply=apply;
exports.inject=[];
return module.exports}});
