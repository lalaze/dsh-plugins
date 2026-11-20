window.__ModuleLoader__.load({id:`@deepseek-ai/dsh-client-ui-sidebar-browser`,factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`});let _deepseek_ai_dsh_client_store=require("@deepseek-ai/dsh-client-store");
var ElectronWebviewPresentation=class{createElement(reservation){const element=document.createElement(`webview`);element.setAttribute(`name`,reservation.lease);element.setAttribute(`partition`,reservation.partition);element.setAttribute(`src`,`about:blank#`+reservation.lease);return element}};
function createIframePage(options){return{kind:`iframe`,options}}
const inject=[`@deepseek-ai/dsh-api-workspace-controller`,`@deepseek-ai/dsh-client-ui-sidebar-right`,`@deepseek-ai/dsh-client-ui-session`];
function apply(ctx){const namespace=`sidebarBrowser`;ctx.calls.push(`apply`);const carrier=globalThis.dshDesktop;const desktop=carrier?.protocolVersion===1?carrier.browser:void 0;ctx.calls.push(desktop===void 0?`iframe`:`desktop`);if(desktop!==void 0)ctx.element=new ElectronWebviewPresentation().createElement({lease:`l1`,partition:`p1`})}
exports.apply=apply;exports.inject=inject;return module.exports}});
//# sourceMappingURL=client.js.map
