 var ns = (() => {
   'use strict';

   const popupURL = browser.extension.getURL("/ui/popup.html");
   let popupFor = tabId => `${popupURL}#tab${tabId}`;

   let ctxMenuId = "noscript-ctx-menu";

   async function toggleCtxMenuItem(show = ns.local.showCtxMenuItem) {
     if (!"contextMenus" in browser) return;
     let id = ctxMenuId;
     try {
         await browser.contextMenus.remove(id);
     } catch (e) {}

     if (show) {
       browser.contextMenus.create({
         id,
         title: "NoScript",
         contexts: ["all"]
       });
     }
   }

   async function init() {
     let policyData = (await Storage.get("sync", "policy")).policy;
     if (policyData && policyData.DEFAULT) {
       ns.policy = new Policy(policyData);
     } else {
       await include("/legacy/Legacy.js");
       ns.policy = await Legacy.createOrMigratePolicy();
       ns.savePolicy();
     }

     await include("/bg/defaults.js");
     await ns.defaults;
     await include(["/bg/RequestGuard.js", "/bg/RequestUtil.js"]);
     await RequestGuard.start();
     await XSS.start(); // we must start it anyway to initialize sub-objects
     if (!ns.sync.xss) {
       XSS.stop();
     }
     Commands.install();
   };

   var Commands = {
     openPageUI() {
       try {
         browser.browserAction.openPopup();
         return;
       } catch (e) {
         debug(e);
       }
       browser.windows.create({
         url: popupURL,
         width: 800,
         height: 600,
         type: "panel"
       });
     },

     togglePermissions() {},
     install() {


       if ("command" in browser) {
         // keyboard shortcuts
         browser.commands.onCommand.addListener(cmd => {
           if (cmd in Commands) {
             Commands[cmd]();
           }
         });
       }

       if ("contextMenus" in browser) {
         toggleCtxMenuItem();
         browser.contextMenus.onClicked.addListener((info, tab) => {
           if (info.menuItemId == ctxMenuId) {
             this.openPageUI();
           }
         });
       }

       // wiring main UI
       let ba = browser.browserAction;
       if ("setIcon" in ba) {
         //desktop
         ba.setPopup({
           popup: popupURL
         });
       } else {
         // mobile
         ba.onClicked.addListener(async tab => {
           try {
             await browser.tabs.remove(await browser.tabs.query({
               url: popupURL
             }));
           } catch (e) {}
           await browser.tabs.create({
             url: popupFor(tab.id)
           });
         });
       }
     }
   }

   var MessageHandler = {
     responders: {

       async updateSettings(settings, sender) {
         await Settings.update(settings);
         toggleCtxMenuItem();
       },
       async broadcastSettings({
         tabId = -1
       }) {
         let policy = ns.policy.dry(true);
         let seen = tabId !== -1 ? await ns.collectSeen(tabId) : null;
         let xssUserChoices = await XSS.getUserChoices();
         browser.runtime.sendMessage({
           type: "settings",
           policy,
           seen,
           xssUserChoices,
           local: ns.local,
           sync: ns.sync,
           unrestrictedTab: ns.unrestrictedTabs.has(tabId),
         });
       },

       exportSettings(m, sender, sendResponse) {
         sendResponse(Settings.export());
         return false;
       },

       async importSettings({
         data
       }) {
         return await Settings.import(data);
       },

       async openStandalonePopup() {
         let win = await browser.windows.getLastFocused();
         let [tab] = (await browser.tabs.query({
           lastFocusedWindow: true,
           active: true
         }));

         if (!tab || tab.id === -1) {
           log("No tab found to open the UI for");
           return;
         }
         browser.windows.create({
           url: popupFor(tab.id),
           width: 800,
           height: 600,
           top: win.top + 48,
           left: win.left + 48,
           type: "panel"
         });
       }
     },
     onMessage(m, sender, sendResponse) {
       let {
         type
       } = m;
       let {
         responders
       } = MessageHandler;


       if (type && (type = type.replace(/^NoScript\./, '')) in responders) {
         return responders[type](m, sender, sendResponse);
       } else {
         debug("Received unkown message", m, sender);
       }
       return false;
     },

     listen() {
       browser.runtime.onMessage.addListener(this.onMessage);
     },
   }



   return {
     running: false,
     policy: null,
     local: null,
     sync: null,
     unrestrictedTabs: new Set(),
     isEnforced(tabId = -1) {
       return this.policy.enforced && (tabId === -1 || !this.unrestrictedTabs.has(tabId));
     },

     start() {
       if (this.running) return;
       this.running = true;

       deferWebTraffic(init(), 
          async () => {

           await include("/bg/Settings.js");
           MessageHandler.listen();

           log("STARTED");

           this.devMode = (await browser.management.getSelf()).installType === "development";
           if (this.local.debug) {
             if (this.devMode) {
               include("/test/run.js");
             }
           } else {
             debug = () => {}; // suppress verbosity
           }
         });
     },

     stop() {
       if (!this.running) return;
       this.running = false;
       RequestGuard.stop();
       log("STOPPED");
     },

     async savePolicy() {
       if (this.policy) {
         await Storage.set("sync", {
           policy: this.policy.dry()
         });
         await browser.webRequest.handlerBehaviorChanged()
       }
       return this.policy;
     },



     async save(obj) {
       if (obj && obj.storage) {
         let toBeSaved = {
           [obj.storage]: obj
         };
         Storage.set(obj.storage, toBeSaved);
       }
       return obj;
     },

     async collectSeen(tabId) {

       try {
         let seen = Array.from(await browser.tabs.sendMessage(tabId, {
           type: "collect"
         }, {
           frameId: 0
         }));
         debug("Collected seen", seen);
         return seen;
       } catch (e) {
         // probably a page where content scripts cannot run, let's open the options instead
         error(e, "Cannot collect noscript activity data");
       }

       return null;
     },
   };
 })();

 ns.start();
