/** Deterministic inbox display hint, not sender authentication or spam safety.
 * No I/O. Uncertain messages remain visible; a caller may apply user overrides. */
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit).normalize('NFKC').replace(/[’‘]/g, "'").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : '';
const answer = (important, category, reason) => ({ important, category, reason });
const AUTO_SENDER = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|donotreply|notifications?|notify|alerts?|updates?|mailer[._-]?daemon|bounces?)(?:[._+@-]|$)/i;
const MARKETING_SENDER = /^(?:marketing|promos?|promotions?|offers?|deals?|newsletters?|news|digest|campaigns?)(?:[._+@-]|$)/i;
const PROMOTION = /\b(?:save|get|take|enjoy)\s+(?:up to\s+|an?\s+extra\s+)?\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*%\s*(?:off|discount|cash\s?back|savings)|(?:[$£€]\s*\d+(?:\.\d+)?|\b\d+\s+(?:dollars?|euros?|pounds?))\s+off\b|\b(?:flash sale|clearance sale|black friday|cyber monday|(?:spring|summer|fall|winter|holiday|weekend) sale|sale (?:starts|ends|is live)|on sale now|exclusive offer|special offer|limited[ -]time (?:offer|deal|discount)|coupon|promo code|shop now|buy now|buy today|new arrivals|buy one get one|bogo|deals (?:just )?for you|start (?:your )?free trial|claim (?:your )?(?:offer|discount|deal)|shop (?:the|our) (?:sale|collection))\b/i;
const NEWSLETTER = /\b(?:newsletter|(?:daily|weekly|monthly|morning|evening) (?:\w+ ){0,2}(?:digest|roundup|round-up|briefing|recap)|news digest|top stories|this week in|what's new (?:at|with)|product (?:news|updates)|latest (?:news|offers))\b/i;
const SOCIAL = /\b(?:people you may know|suggested (?:friends|connections|follows)|(?:liked|reacted to|commented on|shared) your (?:post|photo|video)|new followers?|trending (?:posts|stories)|your profile views|viewed your profile|you have \d+ (?:new )?notifications?|posts? you (?:may have missed|might like))\b/i;
const ROUTINE = /\b(?:daily agenda|(?:daily|weekly|monthly) (?:activity|usage|workspace|account|performance) (?:report|summary|update)|(?:daily|weekly|monthly) (?:report|summary)|your (?:weekly|monthly) (?:stats|summary)|(?:build|workflow|deployment) (?:succeeded|successful)|preferences (?:saved|updated)|notification settings (?:saved|updated))\b/i;

function flagsOf(message) {
  let value = message?.flags;
  if (!Array.isArray(value)) { try { value = JSON.parse(text(message?.flags_json, 4000)); } catch { value = []; } }
  return Array.isArray(value) ? value.slice(0, 100).filter(flag => typeof flag === 'string').map(flag => flag.slice(0, 80).toLowerCase()) : [];
}

function authored(value) {
  // Ignore quoted history and forwarded promotions when classifying a reply.
  return value.split(/(?:^|\n)\s*(?:On .{0,300}wrote:|From:|Begin forwarded message:|[-_]{2,}\s*(?:Original|Forwarded) Message)/i)[0]
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n')
    .replace(/<[^>\n]{1,400}>/g, ' ');
}

function contentOf(message) {
  const body = typeof message?.body === 'string' && message.body.length ? message.body : message?.snippet;
  const prefix = authored(text(body, 8000));
  // Footer terms are only broadcast hints, never evidence of a bill or alert.
  const footer = text(message?.footer, 2000) || text(typeof body === 'string' ? body.slice(-2000) : '', 2000);
  const lead = prefix.split(/\n\s*(?:unsubscribe\b|manage (?:your )?(?:email |notification )?preferences\b|privacy policy\b|you (?:are receiving|received) this email because\b)/i)[0].slice(0, 2400).trim();
  return { lead, broadcast: /\b(?:unsubscribe|manage (?:your )?(?:email |notification )?preferences|view (?:this )?(?:email|message) in (?:your |a )?browser|you (?:are receiving|received) this email because)\b/i.test(`${prefix}\n${footer}`) };
}

function protectedSubject(subject) {
  if (/\b(?:security alert|suspicious (?:activity|login|sign[ -]?in)|unusual (?:activity|login|sign[ -]?in)|new (?:login|sign[ -]?in|device)|sign[ -]?in (?:attempt|notification)|login (?:attempt|notification)|password (?:reset|changed)|verification code|one[ -]time (?:code|password)|two[ -]factor|account (?:locked|suspended|compromised)|confirm your email)\b/i.test(subject)) return 'security';
  if (/^(?:(?:action required|reminder|notice|updated|important)\s*:\s*)?(?:(?:your|a new)\s+)?(?:invoice\b|receipt\b|(?:payment|charge|autopay) (?:receipt|confirmation|received|failed|declined|due|overdue|scheduled)|(?:credit card|bank|account|monthly) statement\b|bill (?:due|ready|available)|billing statement\b|order (?:confirmation|confirmed)|refund (?:issued|processed|confirmation))|\b(?:payment (?:failed|declined|could not be processed)|past[ -]due invoice|overdue (?:bill|payment))\b/i.test(subject)) return 'transactional';
  if (/\b(?:appointment (?:confirmation|confirmed|reminder|cancelled|canceled|rescheduled)|(?:your|upcoming) appointment|meeting invitation|invitation:|(?:accepted|declined|tentative):)\b/i.test(subject)) return 'appointment';
  if (/\b(?:signature (?:requested|required)|(?:please |review and |action required: )sign\b|document (?:ready for signature|completed|signed)|completed:.*(?:agreement|contract)|(?:docusign|adobe sign).*\b(?:review|sign|completed))\b/i.test(subject)) return 'document';
  if (/\b(?:out for delivery|package (?:delivered|shipped|arriving)|(?:your|order|shipment) (?:delivery|shipping) (?:update|confirmation)|delivery (?:update|attempt|scheduled|confirmation)|shipment (?:update|delivered)|order (?:shipped|delivered)|tracking (?:number|update)|undeliverable|mail delivery (?:failed|failure)|delivery status notification.*failure)\b/i.test(subject)) return 'delivery';
  if (/\b(?:(?:lab|laboratory|blood|test|medical) (?:results?|reports?)|results? (?:are |now )?available|new (?:message|results?) (?:from|in) (?:your )?(?:doctor|care team|patient portal)|prescription (?:ready|refill)|refill reminder)\b/i.test(subject)) return 'health';
  if (/\b(?:(?:build|workflow|deployment|service|backup) (?:failed|failure|down)|service outage|action required.*(?:failed|failure))\b/i.test(subject)) return 'service_alert';
  return '';
}

function protectedBody(lead) {
  if (/\b(?:we (?:noticed|detected) (?:a |an )?(?:new|unusual|suspicious)|your (?:verification|one[ -]time|security) code is|your password (?:was|has been) (?:reset|changed)|sign[ -]?in (?:from a new|was detected))\b/i.test(lead)) return 'security';
  if (/\b(?:your payment (?:was |has been )?(?:declined|received|failed)|payment (?:could not|couldn't) be processed|thank you for your (?:payment|purchase|order)|(?:amount|balance) due\s*:?\s*[$£€]?\s*\d[\d,.]*|invoice\s*#\s*[a-z0-9-]+|order\s*#\s*[a-z0-9-]+)\b/i.test(lead)) return 'transactional';
  if (/\b(?:your appointment (?:is |has been )?(?:confirmed|scheduled|cancelled|canceled|rescheduled)|this is a reminder of your appointment)\b/i.test(lead)) return 'appointment';
  if (/\b(?:sent you (?:a |an )?(?:document|agreement|contract) to sign|your signature is required|please review and sign the (?:document|agreement|contract))\b/i.test(lead)) return 'document';
  if (/\b(?:your (?:package|order|shipment) (?:is out for delivery|has been delivered|has shipped|was delivered)|delivery (?:was attempted|is scheduled))\b/i.test(lead)) return 'delivery';
  if (/\b(?:your (?:lab|blood|test) results (?:are|have been)|(?:your prescription|your refill) is ready|new message from your (?:doctor|care team))\b/i.test(lead)) return 'health';
  return '';
}

const PROTECTED_REASON = {
  security: 'Account access or security alert.', transactional: 'A bill, receipt, payment, or account statement.',
  appointment: 'An appointment or meeting invitation.', document: 'A document or signature request.',
  delivery: 'A delivery or shipment update.', health: 'Health results or a care notification.', service_alert: 'A service or workflow failure alert.',
};

function coldPitch(lead) {
  const offer = /\b(?:we help|I help|we can help|our (?:platform|services|solution)|(?:offer|offering|provide) (?:you |professional )?(?:SEO|web design|lead generation|marketing|appointment setting)|help (?:you|your (?:team|company|business)) (?:generate|increase|boost|grow|scale))\b/i.test(lead);
  const solicitation = /\b(?:book a demo|schedule a (?:demo|call)|(?:10|15|20|30)[ -]minute (?:call|chat)|interested in|worth a (?:chat|conversation)|open to a (?:call|chat)|quick call|grow your business|generate more leads)\b/i.test(lead);
  return offer && solicitation;
}

export function classifyMail(message, { hasOutboundThread = false, knownCorrespondent = false } = {}) {
  const flags = flagsOf(message), folder = text(message?.folder, 300).toLowerCase();
  if (/(?:^|[./\\])(?:spam|junk|junk e[ -]?mail)(?:$|[./\\])/.test(folder) || flags.some(flag => ['$junk', '\\junk', 'junk', 'spam', '$spam'].includes(flag))) return answer(false, 'spam', 'Stored in Spam or Junk.');
  if (/(?:^|[./\\])(?:trash|bin|deleted items|deleted messages)(?:$|[./\\])/.test(folder) || flags.includes('\\deleted')) return answer(false, 'trash', 'Stored in Trash or marked deleted.');
  if (flags.some(flag => ['\\flagged', '\\important', '$important', 'important', '\\starred', 'starred'].includes(flag))) return answer(true, 'flagged', 'Marked important or starred.');
  const sender = text(message?.from_email, 254).trim().toLowerCase();
  const rawSubject = text(message?.subject, 600).trim(), reply = /^(?:\s*[^\p{L}\p{N}]*)(?:re|aw|sv)\s*:/iu.test(rawSubject);
  const subject = rawSubject.replace(/^[^\p{L}\p{N}$£€]+/u, '').replace(/^(?:(?:re|aw|sv|fw|fwd)\s*:\s*)+/i, '').trim();
  const { lead, broadcast } = contentOf(message);
  const automated = AUTO_SENDER.test(sender), marketingSender = MARKETING_SENDER.test(sender);
  const promotion = PROMOTION.test(subject), newsletter = NEWSLETTER.test(subject), bodyPromotion = PROMOTION.test(lead);
  const protectedKind = protectedSubject(subject), bodyProtected = protectedBody(lead);
  // A real receipt can carry an upsell. A promotional subject cannot be rescued
  // merely by account/invoice words in the footer or an unrelated alert phrase.
  if (protectedKind && (!promotion || bodyProtected === protectedKind)) return answer(true, protectedKind, PROTECTED_REASON[protectedKind]);
  const pitch = coldPitch(lead);
  const humanReply = reply && (knownCorrespondent || hasOutboundThread) && !!lead && !automated && !marketingSender && !bodyPromotion && !pitch;
  if (humanReply || (hasOutboundThread && !promotion && !newsletter && !bodyPromotion)) return answer(true, 'conversation', 'Part of a personal or work conversation.');
  if (promotion) return answer(false, 'promotion', 'The subject advertises an offer, sale, or promotion.');
  if (bodyProtected && !newsletter) return answer(true, bodyProtected, PROTECTED_REASON[bodyProtected]);
  if (newsletter) return answer(false, 'newsletter', 'A newsletter or recurring digest.');
  const socialSender = /@(?:[^@.]+\.)?(?:linkedin\.com|facebookmail\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|pinterest\.com|redditmail\.com|nextdoor\.com)$/i.test(sender);
  if (SOCIAL.test(subject) && (socialSender || automated || marketingSender || broadcast)) return answer(false, 'social_digest', 'A routine social activity notification.');
  if (knownCorrespondent && !marketingSender && !automated && !bodyPromotion) return answer(true, 'conversation', 'A known personal or work correspondent.');
  if (!hasOutboundThread && !knownCorrespondent && pitch) return answer(false, 'cold_outreach', 'An unsolicited sales pitch or demo request.');
  if (bodyPromotion && (broadcast || marketingSender || automated)) return answer(false, 'promotion', 'A promotional offer in a broadcast message.');
  if (ROUTINE.test(subject) && (automated || marketingSender || broadcast)) return answer(false, 'routine_notification', 'A routine automated summary or confirmation.');
  if (marketingSender && (subject || lead)) return answer(false, 'newsletter', 'A broadcast from a marketing or newsletter address.');
  if (broadcast) return answer(false, 'newsletter', 'A broadcast message with subscription controls.');
  if (!subject && !lead) return answer(true, 'uncertain', 'Not enough information to safely filter this email.');
  return answer(true, 'conversation', 'Kept visible because no clear promotion or routine broadcast was identified.');
}
