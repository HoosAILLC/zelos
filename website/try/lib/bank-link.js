/** The installed app's bank endpoint contract, with no bank-link flow in this demo. */
import {el, button} from './dom.js';
import {request} from './api.js';
export const bankApi = {status:() => request('/api/finance/plaid'), action:(action, body = {}) => request('/api/finance/plaid/' + action, {method:'POST', body})};
export function createBankPanel({onClose}) {
  return el('section', {class:'finance-panel money-bank-panel', 'aria-label':'Bank connections'}, [
    el('div', {class:'money-card-head'}, [el('h2', {text:'Bank connections · example only'}), button('Close bank connections', {class:'btn quiet', onClick:onClose})]),
    el('p', {class:'finance-note', text:'These accounts, balances and pending charges are fictional. This website cannot connect or sync a bank, collect credentials, or make payments.'}),
    el('p', {class:'finance-note', text:'In the installed app, optional Plaid linking brings in the transactions you authorize. You assign each account to Personal or a company. Cached balances show when Zelos retrieved them, and pending entries stay outside posted totals.'}),
    el('p', {class:'finance-note', text:'Close this panel to explore the sample account snapshots, then open Review suggestions to compare import evidence and try Undo.'}),
  ]);
}
