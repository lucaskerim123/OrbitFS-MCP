// Shared OrbitFS command-help widget logic. Host-agnostic: only touches
// window.OrbitFSBridge, never window.openai or the ExtApps App class directly.
if (!window.OrbitFSBridge) {
  window.OrbitFSBridge = {
    hostName: "none",
    ready: Promise.resolve(),
    async callTool() { throw new Error("This host does not support OrbitFS widget tools."); },
    async sendChatPrompt() { throw new Error("This host does not support chat follow-ups."); },
    async requestClose() {},
    getInitialView() { return null; },
    onViewUpdate() {},
  };
}

const COMMANDS=__ORBITFS_COMMANDS__;
const shell=document.getElementById('helpShell');
const groups=document.getElementById('commandGroups');
const summary=document.getElementById('helpSummary');
const search=document.getElementById('commandSearch');
function esc(value){return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function render(){const term=search.value.trim().toLowerCase();const filtered=COMMANDS.filter(item=>!term||`${item.command} ${item.usage} ${item.description} ${item.category}`.toLowerCase().includes(term));summary.textContent=`${filtered.length} of ${COMMANDS.length} verified commands`;const categories=[...new Set(filtered.map(item=>item.category))];groups.innerHTML=categories.map(category=>`<section class="group"><h2>${esc(category)}</h2><div class="command-list">${filtered.filter(item=>item.category===category).map(item=>`<article class="command"><div><code>${esc(item.command)}</code><span class="usage">${esc(item.usage)}</span></div><p>${esc(item.description)}</p></article>`).join('')}</div></section>`).join('')||'<div class="empty">No commands match that search.</div>'}
search.addEventListener('input',render);
minimizeHelp.addEventListener('click',()=>{const minimized=shell.classList.toggle('minimized');minimizeHelp.textContent=minimized?'[]':'_';minimizeHelp.title=minimized?'Restore':'Minimize'});
closeHelp.addEventListener('click',async()=>{shell.classList.add('hidden');closedNote.classList.add('show');try{await OrbitFSBridge.requestClose()}catch{}});
render();
