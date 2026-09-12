// Endpoint signatures from the current app; transport is the browser-only demo adapter.
import {request, download} from './api.js';
function queryString(values = {}) {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(values)) if (key !== 'signal' && value !== undefined && value !== null && value !== '') params.set(key,String(value));
  return params.toString();
}
export const api = {
  webSettings: () => request('/api/web/settings'),
  saveWebSettings: body => request('/api/web/settings', {method:'POST',body}),
  shopping: () => request('/api/shopping'),
  saveShoppingSettings: body => request('/api/shopping/settings',{method:'POST',body}),
  shoppingStores: body => request('/api/shopping/stores',{method:'POST',body}),
  reviewShoppingList: body => request('/api/shopping/review',{method:'POST',body}),
  createShoppingList: body => request('/api/shopping/list',{method:'POST',body}),
  setShoppingItemState: body => request('/api/shopping/item',{method:'POST',body}),
  previewDocument: (body,{signal}={}) => request('/api/documents/preview',{method:'POST',body,signal}),
  commitDocument: body => request('/api/documents/commit',{method:'POST',body}),
  documentReceipts: () => request('/api/documents/receipts'),
  documentReview: id => request(`/api/documents/reviews/${encodeURIComponent(id)}`),
  generateHealthPlan: (body,{signal}={}) => request('/api/health-tracking/plan-preview',{method:'POST',body,signal}),
  saveHealthPlanPreview: body => request('/api/health-tracking/plan-save',{method:'POST',body}),
  booking: () => request('/api/booking'),
  saveBookingSettings: body => request('/api/booking/settings',{method:'POST',body}),
  bookingSlots: (options={}) => request(`/api/booking/slots?${queryString(options)}`),
  reserveBooking: body => request('/api/booking/reserve',{method:'POST',body}),
  cancelBooking: id => request('/api/booking/cancel',{method:'POST',body:{id}}),
  bookingCalendar: body => download('/api/booking/calendar',{method:'POST',body}),
  progress: (options={}) => request(`/api/progress?${queryString(options)}`,{signal:options.signal}),
  progressPdf: body => download('/api/progress/pdf',{method:'POST',body}),
  conversations: () => request('/api/conversations'),
  conversation: id => request(`/api/conversations/${encodeURIComponent(id)}`),
  jobs: () => request('/api/assistant/jobs'),
  assignJob: prompt => request('/api/assistant/jobs',{method:'POST',body:{prompt}}),
  cancelJob: id => request(`/api/assistant/jobs/${encodeURIComponent(id)}/cancel`,{method:'POST',body:{}}),
  jobReport: id => download(`/api/assistant/jobs/${encodeURIComponent(id)}/report.pdf`),
  finance: (options={}) => request(`/api/finance?${queryString(options)}`,{signal:options.signal}),
  addFinanceEntity: body => request('/api/finance/entities',{method:'POST',body}),
  saveFinanceAccount: body => request('/api/finance/accounts',{method:'POST',body}),
  importFinanceStatement: body => request('/api/finance/import',{method:'POST',body}),
  saveFinanceTransaction: body => request('/api/finance/transactions',{method:'POST',body}),
  saveFinanceInvoice: body => request('/api/finance/invoices',{method:'POST',body}),
  exportFinanceCsv: (options={}) => download(`/api/finance/export?${queryString(options)}`),
  healthTracking: () => request('/api/health-tracking'),
  saveHealthProfile: body => request('/api/health-tracking/profile',{method:'POST',body}),
  saveHealthWalking: body => request('/api/health-tracking/walking',{method:'POST',body}),
  importHealthWalking: body => request('/api/health-tracking/walking/import',{method:'POST',body}),
  saveHealthLab: body => request('/api/health-tracking/labs',{method:'POST',body}),
  saveHealthMetric: body => request('/api/health-tracking/metrics',{method:'POST',body}),
  saveHealthPlan: body => request('/api/health-tracking/plans',{method:'POST',body}),
  setHealthPlanEntryState: body => request('/api/health-tracking/plan-state',{method:'POST',body}),
  saveHealthGrocery: body => request('/api/health-tracking/groceries',{method:'POST',body}),
  deleteHealthRecord: body => request('/api/health-tracking/delete',{method:'POST',body}),
  mailMessages: ({ scope, accountId, q, cursor, limit, signal } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ scope, accountId, q, cursor, limit })) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    return request(`/api/mail/messages?${params}`, { signal });
  },
  mailMessage: (id, { signal } = {}) => request(`/api/mail/messages/${encodeURIComponent(id)}`, { signal }),
  setMailImportance: body => request('/api/mail/importance', { method: 'POST', body }),
  mailPreferences: () => request('/api/mail/preferences'),
  saveMailPreferences: body => request('/api/mail/preferences',{method:'POST',body}),
  forgetMailRule: id => request(`/api/mail/rules/${encodeURIComponent(id)}`,{method:'DELETE'}),
  itemEvidence: id => request(`/api/items/${encodeURIComponent(id)}/evidence`),
  correctItem: (id,body) => request(`/api/items/${encodeURIComponent(id)}/correction`,{method:'POST',body}),
  askRequest: id => request(`/api/ask/requests/${encodeURIComponent(id)}`),
  stopAnswer: id => request(`/api/ask/answers/${encodeURIComponent(id)}/stop`,{method:'POST',body:{}}),
  automaticBackup: () => request('/api/backups/automatic'),
  saveAutomaticBackup: body => request('/api/backups/automatic',{method:'POST',body}),
  runAutomaticBackup: () => request('/api/backups/automatic/run',{method:'POST',body:{}}),
  mailDraft: (id, { signal } = {}) => request(`/api/mail/drafts/${encodeURIComponent(id)}`, { signal }),
  draftMailReply: (body, { signal } = {}) => request('/api/mail/draft', { method: 'POST', body, signal }),
  saveMailReply: (body, { signal } = {}) => request('/api/mail/save', { method: 'POST', body, signal }),
  prepareMailReply: body => request('/api/mail/prepare', { method: 'POST', body }),
  sendMailReply: body => request('/api/mail/send', { method: 'POST', body }),
  mailDelivery: id => request(`/api/mail/delivery/${encodeURIComponent(id)}`),
  health: () => request('/api/health'),
  state: () => request('/api/state'),
  config: () => request('/api/config'),
  saveConfig: (patch) => request('/api/config', { method: 'PUT', body: patch }),
  sweep: (mode = 'auto') => request('/api/sweep', { method: 'POST', body: { mode } }),
  // `until` rides along only when the caller set one: the server treats an
  // absent field as "default to tomorrow morning", and sending null would ask
  // it to decide what null means instead.
  // `until` is three-valued on the wire and the distinction is load-bearing:
  // absent asks the server for its default (09:00 tomorrow), an explicit null
  // asks for a manual snooze with no deadline (how Undo restores a legacy
  // snooze exactly), and a string names the wake time. So the field is sent
  // whenever the caller stated one, even when what they stated is null.
  setItemState: (id, state, opts = {}) =>
    request(`/api/items/${encodeURIComponent(id)}/state`, {
      method: 'POST',
      body: 'until' in opts && opts.until !== undefined
        ? { state, until: opts.until }
        : { state },
    }),
  capture: (text) => request('/api/capture', { method: 'POST', body: { text } }),
  setSecret: (ref, value) => request('/api/secrets', { method: 'POST', body: { ref, value } }),
  deleteSecret: (ref) => request(`/api/secrets/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
  testModel: (spec) => request('/api/model/test', { method: 'POST', body: spec }),
  listModels: ({ protocol, baseUrl, keyRef }) => {
    const q = new URLSearchParams();
    if (protocol) q.set('protocol', protocol);
    if (baseUrl) q.set('baseUrl', baseUrl);
    if (keyRef) q.set('keyRef', keyRef);
    return request(`/api/model/list?${q.toString()}`);
  },
  presets: () => request('/api/model/presets'),
  probeLocal: () => request('/api/local/probe'),
  // POST, so the address rides in the body: a query string is kept by the
  // browser's history and sent as a Referer, and this call's whole input is
  // somebody's email address.
  guessMail: (email) => request('/api/mail/guess', { method: 'POST', body: { email } }),
  /* "Ask Claude to walk me through this": the message for one setup screen
     and the two links that open a chat with it typed in. POST for the same
     reason as guessMail — what rides along is what the app calls the
     provider, and the server answers with only what core/help.mjs allows in
     a message: the step, the provider's name, this computer's kind. */
  helpLinks: (args) => request('/api/help', { method: 'POST', body: args }),
  testMail: (account) => request('/api/mail/test', { method: 'POST', body: account }),
  testCalendar: (calendar) => request('/api/calendar/test', { method: 'POST', body: calendar }),

  /* "Sign in with Microsoft" and "Sign in with Google" — three calls from this
     page's point of view: start a sign-in, ask whether the person has finished
     in their browser, give up.

     There is deliberately no timing here. RFC 8628 §3.5 pins the poll interval
     and the `slow_down` back-off, core/sources/imap.mjs implements both under
     test, and the server runs that loop; a second implementation in the browser
     would be a second thing to get wrong about the one operation a vendor rate
     limit punishes. The page asks a question with no timing content and reads
     an answer.

     The device code never comes back here. Whoever holds it collects the tokens,
     so it stays in the server process — what this gets is the USER code, which
     is meant for a human to read aloud off a screen, and the address to type it
     at. Google's flow hands back an authorization URL for the browser instead;
     the code Google returns lands on the server's own loopback callback, and
     the page only ever learns that the flow is `connected`.

     `provider` defaults on the server to Microsoft, so a caller that sends what
     it always sent still gets what it always got. `clientId`, `clientSecret`
     and `email` ride along only when the caller set them — JSON.stringify
     drops an undefined field, so the wire body of an old call is unchanged.
     The one secret in here, Google's client secret, is typed by the user for
     their own Cloud project, goes once to the server on this machine, and is
     kept in the secret store under `oauth.google.clientSecret` from then on. */
  beginMailOAuth: ({ provider, keyRef, clientId, clientSecret, tenantId, email }) =>
    request('/api/mail/oauth', { method: 'POST', body: { provider, keyRef, clientId, clientSecret, tenantId, email } }),
  mailOAuthStatus: (id) => request(`/api/mail/oauth/${encodeURIComponent(id)}`),
  cancelMailOAuth: (id) =>
    request(`/api/mail/oauth/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateDraft: (id, patch, { signal } = {}) =>
    request(`/api/drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: patch, signal }),
  /**
   * The index, queried. The options are optional so the one-argument call
   * `api.search(q)` still means exactly what it always did — same URL, same
   * default of twenty rows decided by the server.
   *
   * The search view needs both of them. `limit` because a page with room for a
   * list wants more than the twenty a source list wants, and `signal` because a
   * query is superseded by the next keystroke: without a way to abandon the
   * request in flight, a slow answer to `sur` can land after the answer to
   * `survey` and overwrite it with the wrong results.
   */
  search: (q, { limit = null, signal = undefined, includeHistory = false } = {}) => {
    const query = `q=${encodeURIComponent(q)}${limit === null ? '' : `&limit=${encodeURIComponent(limit)}`}${includeHistory ? '&includeHistory=1' : ''}`;
    return request(`/api/search?${query}`, { signal });
  },

  /* AI access (SPEC-v2 §1). All four answer with the same whole-state payload —
     switch, scopes, effective scopes, tokens, access log and client hints — so
     the panel applies a change by keeping the response rather than by guessing
     what the server did with it. A minted token's `value` appears in the mint
     response and nowhere else, ever. */
  ai: () => request('/api/ai'),
  saveAi: (patch) => request('/api/ai', { method: 'PUT', body: patch }),
  mintAiToken: (label) => request('/api/ai/tokens', { method: 'POST', body: { label } }),
  revokeAiToken: (id) => request(`/api/ai/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

