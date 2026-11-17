const $ = id => document.getElementById(id);
const dom = {
  mode: $('mode'), connection: $('connection'), feed: $('feed-status'), caption: $('run-caption'),
  update: $('latest-update'), performanceCaption: $('performance-caption'), metrics: $('metrics'),
  filters: $('filters'), mint: $('filter-mint'), creator: $('filter-creator'), kind: $('filter-type'), reset: $('clear-filters'),
  events: $('events'), count: $('activity-count'), feedFooter: $('feed-footer'), detail: $('coin-detail'),
  coinStatus: $('coin-status'), positions: $('positions'), positionCount: $('position-count'),
  submissions: $('submissions'), submissionCount: $('submission-count'),
};
const absent = 'Unavailable';
const activityLimit = 500;
const activities = new Map();
let snapshot;
let stream;
let selectedMint;
let selectedEvent;
let remoteCoin;
let coinRequest = 0;
let fetchVersion = 0;
let retry;
let renderPending = false;

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function quantity(value) {
  try {
    return value == null ? absent : BigInt(value).toLocaleString('en-US');
  } catch {
    return absent;
  }
}

function sol(value) {
  try {
    if (value == null) return absent;
    const number = BigInt(value);
    const magnitude = number < 0n ? -number : number;
    const whole = magnitude / 1_000_000_000n;
    const decimal = (magnitude % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
    return `${number < 0n ? '−' : ''}${whole}${decimal ? '.' + decimal : ''}`;
  } catch {
    return absent;
  }
}

function valueWithSol(value) {
  const formatted = sol(value);
  return formatted === absent ? formatted : formatted + ' SOL';
}

function timestamp(value, dense = false) {
  return Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      ...(dense ? {} : { month: 'short', day: 'numeric' }) }).format(new Date(value))
    : '—';
}

function updateTime(node, value, dense = false) {
  node.textContent = timestamp(value, dense);
  if (Number.isFinite(value) && value > 0) {
    try {
      node.dateTime = new Date(value).toISOString();
      node.title = node.dateTime;
    } catch {
      node.removeAttribute('datetime');
      node.removeAttribute('title');
    }
  } else {
    node.removeAttribute('datetime');
    node.removeAttribute('title');
  }
  return node;
}

function compact(value) {
  return value && value.length > 18 ? value.slice(0, 8) + '…' + value.slice(-6) : value;
}

function label(value) {
  return String(value ?? '').replaceAll('_', ' ');
}

function toneAmount(value) {
  const n = Number(value);
  return n < 0 ? 'red' : n > 0 ? 'green' : 'muted';
}

function badge(text, tone = 'muted', className = '') {
  const node = element('span', 'tag ' + className, text);
  node.dataset.tone = tone;
  return node;
}

function status(node, text, tone) {
  node.dataset.tone = tone;
  node.lastElementChild.textContent = text;
}

function setConnection(text, tone) { status(dom.connection, text, tone); }

function activityType(event) {
  const data = event.data ?? {};
  const side = data.side ? label(data.side) : 'trade';
  if (event.kind === 'trade' && event.source === 'market') return ['Market trade', 'amber', 'Observed market ' + side];
  if (event.kind === 'fill') return event.source === 'live'
    ? ['Confirmed live fill', 'green', 'Confirmed live ' + side]
    : ['Paper fill', 'violet', 'Paper ' + side];
  if (event.kind === 'decision') {
    if (data.result === 'eligible' || (event.source === 'live' && data.identity?.eligible === true)) return ['Entry approved', 'green', 'Entry approved'];
    if (data.result === 'rejected' || (event.source === 'live' && data.outcome)) return ['Entry skipped', 'red', 'Entry skipped'];
    return ['Decision', 'muted', 'Entry decision'];
  }
  if (event.kind === 'result' || event.kind === 'submission') {
    const action = data.status ?? event.state ?? data.state ?? data.result ?? 'unknown';
    if (action === 'failed' || action === 'missed') {
      return ['Failed submission', 'red', action === 'missed' ? 'Submission missed' : 'Submission failed'];
    }
    if (['signed', 'pending', 'ambiguous', 'acknowledged'].includes(action)) return ['Pending submission', 'amber', `Submission ${label(action)}`];
    if (action === 'filled' || action === 'confirmed') return ['Execution result', 'muted', 'Execution result'];
  }
  if (event.kind === 'attempt' || event.kind === 'intent') {
    return ['Pending submission', 'amber', event.kind === 'attempt' ? `${label(side)} attempt` : `${label(side)} intent`];
  }
  if (event.kind === 'position_partial') return ['Partial exit', 'violet', `${data.reason ?? 'Partial exit'} settled`];
  if (event.kind === 'position_closed') return ['Position closed', 'violet', 'Position closed'];
  if (event.kind === 'exit_trigger' || event.kind === 'exit_terminal') return ['Exit trigger', 'amber', `Exit trigger · ${label(data.reason ?? 'unknown')}`];
  if (event.kind === 'launch') return ['Launch', 'green', 'Token launch'];
  if (event.kind === 'migration') return ['Migration', 'amber', 'Venue migration'];
  if (event.kind === 'feed') return ['Feed status', data.healthy ? 'green' : 'amber', 'Feed status'];
  if (event.kind === 'quote') return ['Quote', 'muted', `Executable ${side} quote`];
  return [label(event.kind) || 'Event', 'muted', label(event.kind) || 'Recorded event'];
}

function creatorFor(event) {
  return event.creator ?? event.data?.creator ?? snapshot?.positions?.find(row => row.mint === event.mint)?.creator ??
    newest(event.mint, 'decision')?.creator ?? newest(event.mint, 'launch')?.data?.creator;
}

function newest(mint, kind) {
  if (!mint) return undefined;
  const rows = [...activities.values()];
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index].mint === mint && rows[index].kind === kind) return rows[index];
  }
}

function safeLink(input, type) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) return;
    const expected = type === 'mint'
      ? url.hostname === 'pump.fun' && /^\/coin\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(url.pathname)
      : ['explorer.solana.com', 'solscan.io'].includes(url.hostname) && /^\/tx\/[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(url.pathname);
    if (expected) return url.href;
  } catch {
    return;
  }
}

function links(container, items) {
  const mintLink = safeLink(items?.mint, 'mint');
  const txLink = safeLink(items?.explorer, 'explorer');
  if (!mintLink && !txLink) return;
  const group = element('div', 'coin-links');
  for (const [href, title] of [[mintLink, 'Pump.fun ↗'], [txLink, 'Transaction ↗']]) {
    if (!href) continue;
    const node = element('a', 'link-pill', title);
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    group.append(node);
  }
  container.append(group);
}

function referenceTime() {
  return snapshot?.run?.mode === 'replay' || snapshot?.run?.mode === 'demo'
    ? (snapshot.run.now ?? snapshot.observedAtMs)
    : Date.now();
}

function renderHeader() {
  if (!snapshot) return;
  const { run = {}, feed = {} } = snapshot;
  dom.mode.textContent = ({ replay: 'Replay mode', demo: 'Replay demo', paper: 'Paper mode',
    monitor: 'Record mode', live: 'Live ledger' })[run.mode] ?? 'Mode unavailable';
  const labels = [run.id, feed.provider ?? snapshot.provider].filter(Boolean);
  dom.caption.textContent = labels.join(' · ');
  updateTime(dom.update, snapshot.observedAtMs, true);
  const stale = feed.stale === true || (Number.isFinite(feed.lastAtMs) && referenceTime() - feed.lastAtMs > (feed.staleAfterMs ?? feed.staleMs ?? 15000));
  if (stale) status(dom.feed, 'Feed stale', 'amber');
  else if (feed.healthy === true) status(dom.feed, 'Feed healthy', 'green');
  else if (feed.healthy === false) status(dom.feed, 'Feed interrupted', 'amber');
  else status(dom.feed, 'Feed unknown', 'muted');
  const detail = [feed.reason, feed.lastAtMs ? 'Last receipt ' + timestamp(feed.lastAtMs) : null,
    feed.slot != null ? 'Slot ' + feed.slot : null].filter(Boolean);
  dom.feed.title = detail.join(' · ');
  dom.feedFooter.textContent = detail.join(' · ') || 'The dashboard displays persisted events.';
}

function renderPerformance() {
  const report = snapshot?.performance;
  if (!report) return;
  const { returns = {}, orders = {}, fees = {}, launches = {} } = report;
  dom.performanceCaption.textContent = snapshot.run?.mode === 'live'
    ? 'Finalized ledger settlements' : 'Modeled results from the run report';
  function metric(title, value, small, tone) {
    const box = element('div', 'metric');
    const amount = element('strong', '', value ?? '—');
    if (tone) amount.dataset.tone = tone;
    box.append(element('span', '', title), amount);
    if (small) box.append(element('small', '', small));
    return box;
  }
  const availableFees = [fees.venueLamports, fees.executionLamports, fees.failedLamports].filter(value => value != null);
  let feeCaption;
  try {
    if (availableFees.length) feeCaption = valueWithSol(availableFees.reduce((sum, fee) => sum + BigInt(fee), 0n)) + ' fees';
  } catch {
    feeCaption = undefined;
  }
  const entry = orders.entry?.filled;
  const exits = orders.exit?.filled;
  const failed = orders.exit?.failed;
  dom.metrics.replaceChildren(
    metric('Realized net', returns.realizedNetLamports == null ? '—' : sol(returns.realizedNetLamports), 'SOL', toneAmount(returns.realizedNetLamports)),
    metric('Net / eligible launch', returns.perEligibleLaunchLamports == null ? '—' : sol(returns.perEligibleLaunchLamports), 'SOL'),
    metric('Max drawdown', returns.maxDrawdownLamports == null ? '—' : sol(returns.maxDrawdownLamports), 'SOL'),
    metric('Entry fills', entry, launches.eligible != null ? `${launches.eligible} eligible launches` : undefined),
    metric('Exit fills / failed', exits == null && failed == null ? '—' : `${exits ?? 0} / ${failed ?? 0}`, feeCaption),
  );
}

function renderEvents() {
  const options = new Set(['Launch', 'Entry approved', 'Entry skipped', 'Market trade', 'Paper fill', 'Confirmed live fill',
    'Pending submission', 'Failed submission', 'Partial exit', 'Position closed', 'Exit trigger', 'Migration', 'Quote', 'Feed status']);
  const allEvents = [...activities.values()].reverse();
  for (const event of allEvents) options.add(activityType(event)[0]);
  const oldType = dom.kind.value;
  if (oldType) options.add(oldType);
  const existing = [...dom.kind.options].slice(1).map(option => option.value);
  const types = [...options].sort();
  if (types.join('|') !== existing.join('|')) {
    dom.kind.replaceChildren(new Option('All events', ''), ...types.map(option => new Option(option, option)));
    dom.kind.value = oldType;
  }
  const mint = dom.mint.value.trim().toLowerCase();
  const creator = dom.creator.value.trim().toLowerCase();
  const kind = dom.kind.value;
  dom.reset.disabled = !(mint || creator || kind);
  const selected = allEvents.filter(event => {
    if (kind && activityType(event)[0] !== kind) return false;
    if (mint && !String(event.mint ?? '').toLowerCase().includes(mint)) return false;
    if (creator) {
      const combined = [creatorFor(event), event.data?.alias, event.data?.identity?.alias,
        newest(event.mint, 'decision')?.data?.identity?.alias].filter(Boolean).join(' ').toLowerCase();
      if (!combined.includes(creator)) return false;
    }
    return true;
  });
  dom.count.textContent = String(selected.length);
  const scroll = dom.events.scrollTop;
  const focused = document.activeElement?.dataset?.eventId;
  let restore;
  const nodes = selected.map(event => {
    const [type, tone, title] = activityType(event);
    const row = element('div', 'activity-item');
    row.setAttribute('role', 'listitem');
    const button = element('button', 'activity-row');
    button.type = 'button';
    button.dataset.eventId = String(event.id);
    button.setAttribute('aria-pressed', String(selectedEvent?.id === event.id));
    if (button.dataset.eventId === focused) restore = button;
    const main = element('span', 'event-main');
    const data = event.data ?? {};
    const extra = [data.reason ?? data.outcome ?? data.identity?.reason, compact(event.mint), compact(creatorFor(event))].filter(Boolean).join(' · ');
    main.append(element('strong', '', title[0].toUpperCase() + title.slice(1)), element('small', '', extra || '—'));
    button.append(updateTime(element('time'), event.atMs, true), main, badge(type, tone, 'event-type'));
    button.addEventListener('click', () => choose(event.mint, event));
    row.append(button);
    return row;
  });
  dom.events.replaceChildren(...(nodes.length ? nodes : [element('p', 'empty', allEvents.length
    ? 'No recorded events match these filters.' : 'No events have been recorded for this run.')]));
  dom.events.scrollTop = scroll;
  restore?.focus({ preventScroll: true });
}

function choose(mint, event) {
  selectedMint = mint;
  selectedEvent = event;
  if (remoteCoin?.mint !== mint) remoteCoin = undefined;
  queueRender();
  const version = ++coinRequest;
  if (!mint) return;
  fetch('/api/coin?mint=' + encodeURIComponent(mint), { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(data => {
      if (version !== coinRequest || !data || data.mint !== selectedMint) return;
      remoteCoin = data;
      queueRender();
    })
    .catch(() => { /* recent ledger activity remains available */ });
}

function section(parent, title, chip) {
  const wrapper = element('section', 'detail-section');
  const heading = element('h3', '', title);
  if (chip) heading.append(chip);
  wrapper.append(heading);
  parent.append(wrapper);
  return wrapper;
}

function list(parent, items) {
  const node = element('dl', 'facts');
  for (const [key, value] of items) {
    node.append(element('dt', '', key), element('dd', '', value == null ? absent : String(value)));
  }
  parent.append(node);
}

function expandable(parent, caption, evidence, open = false) {
  if (evidence == null) return;
  const node = element('details');
  node.dataset.sectionKey = caption;
  node.open = open;
  node.append(element('summary', '', caption), element('pre', '', JSON.stringify(evidence, null, 2)));
  parent.append(node);
}

function renderDetail() {
  const existingOpen = new Set([...dom.detail.querySelectorAll('details[open]')].map(item => item.dataset.sectionKey));
  const scroll = dom.detail.scrollTop;
  dom.detail.replaceChildren();
  if (!selectedMint && !selectedEvent) {
    dom.coinStatus.hidden = true;
    dom.detail.append(element('p', 'empty', 'Select a mint from Activity or Open positions to inspect the decision evidence.'));
    return;
  }
  const latest = newest(selectedMint, 'decision') ?? remoteCoin?.decision;
  const decision = selectedEvent?.kind === 'decision' ? selectedEvent : latest;
  const market = newest(selectedMint, 'trade') ?? remoteCoin?.market;
  const launch = newest(selectedMint, 'launch');
  const position = snapshot?.positions?.find(row => row.mint === selectedMint);
  const creator = creatorFor(decision ?? selectedEvent ?? launch ?? { mint: selectedMint }) ?? remoteCoin?.creator;
  let linkSet = { ...remoteCoin?.links, ...launch?.links, ...position?.links };
  for (const data of [decision?.links, market?.links, selectedEvent?.links]) {
    if (data?.mint) linkSet.mint = data.mint;
    if (data?.explorer && (data === selectedEvent?.links || !linkSet.explorer)) linkSet.explorer = data.explorer;
  }
  dom.coinStatus.hidden = false;
  dom.coinStatus.textContent = position ? 'Open position' : selectedMint ? 'Recorded mint' : 'Recorded event';
  dom.detail.append(element('div', 'coin-id', selectedMint || activityType(selectedEvent)[2]));
  links(dom.detail, linkSet);
  if (creator) list(dom.detail, [['Creator', creator]]);
  if (selectedEvent && selectedEvent !== decision) {
    const [type, tone, title] = activityType(selectedEvent);
    const detail = section(dom.detail, title[0].toUpperCase() + title.slice(1), badge(type, tone));
    const selectedData = selectedEvent.data ?? {};
    list(detail, [['Recorded at', timestamp(selectedEvent.atMs)], ['Reason', selectedData.reason ?? selectedData.status],
      ['Signature', selectedEvent.signature], ['Operation', selectedEvent.operationId]]);
    const key = 'Recorded event data';
    expandable(detail, key, selectedData, existingOpen.has(key));
  }
  if (decision) {
    const data = decision.data ?? {};
    const risk = data.risk;
    const [type, tone] = activityType(decision);
    const detail = section(dom.detail, 'Entry evidence', badge(type, tone));
    detail.append(element('p', 'reason', data.reason ?? data.outcome ?? data.identity?.reason ?? absent));
    const riskAt = risk?.cutoffMs ?? data.decisionAtMs ?? decision.atMs;
    const ref = referenceTime();
    const riskStale = decision.riskStale === true || remoteCoin?.riskStale === true ||
      (Number.isFinite(riskAt) && ref != null && ref - riskAt > (snapshot?.performance?.settings?.maxStateAgeMs ?? 15000));
    list(detail, [
      ['Decision time', timestamp(data.decisionAtMs ?? decision.atMs)],
      ['Receipt time', timestamp(data.receiptMs)],
      ['Launch / decision slot', [data.launchSlot, data.decisionSlot].map(value => value ?? '—').join(' / ')],
      ['Creator check', data.identity?.reason],
      ['Risk snapshot', risk ? timestamp(riskAt) + (riskStale ? ' · Stale' : '') : absent],
      ['Rule version', risk?.ruleVersion],
      ['Round-trip loss', risk?.features?.roundTripLossBps == null ? absent : risk.features.roundTripLossBps + ' bps'],
      ['Early buyers', risk?.features?.distinctEarlyBuyers],
      ['Holder concentration', risk?.features?.holderConcentrationBps == null ? absent : risk.features.holderConcentrationBps + ' bps'],
      ['At-decision sell quote', valueWithSol(risk?.quote?.exitNetLamports)],
      ['Quote observed', risk?.quote?.quoteReceiptMs ? timestamp(risk.quote.quoteReceiptMs) : absent],
    ]);
    if (data.shadow) {
      const degree = data.shadow.scoreBps == null ? absent : data.shadow.scoreBps / 100 + '%';
      const shadow = section(dom.detail, 'Shadow model', badge('Shadow only', 'violet'));
      list(shadow, [['Score', degree], ['Model', data.shadow.version], ['Reason', data.shadow.reason],
        ['Would enter after checks', data.shadowWouldEnterAfterHardRules == null ? absent : data.shadowWouldEnterAfterHardRules ? 'Yes' : 'No']]);
    }
    const key = 'Full decision and risk evidence';
    expandable(detail, key, data, existingOpen.has(key));
  } else if (selectedMint) {
    const detail = section(dom.detail, 'Entry evidence');
    detail.append(element('p', 'muted-small', 'No recorded entry decision for this mint.'));
  }
  if (position) {
    const detail = section(dom.detail, 'Open position');
    list(detail, [
      ['Original tokens', quantity(position.originalTokens)],
      ['Remaining tokens', quantity(position.remainingTokens ?? position.tokens)],
      ['Realized net', valueWithSol(position.realizedLamports)],
      ['Estimated net liquidation', position.quoteStale ? absent : valueWithSol(position.liquidationLamports)],
      ['Sell quote time', position.quoteAtMs == null ? absent : timestamp(position.quoteAtMs) + (position.quoteStale ? ' · Stale' : '')],
    ]);
    detail.append(ladder(position));
    const policy = position.policy ?? position.exit?.policy;
    const progress = position.exit?.progress ?? position.exit;
    if (policy?.takeProfits?.length) {
      list(detail, policy.takeProfits.map(leg => {
        const saved = progress?.legs?.[leg.label];
        return [leg.label, `${level(leg)} · ${leg.sellPercent}% of original${saved?.soldTokens ? ' · sold ' + quantity(saved.soldTokens) : ''}`];
      }));
    }
  } else if (market) {
    const detail = section(dom.detail, 'Last observed market trade');
    const data = market.data ?? {};
    list(detail, [['Observed at', timestamp(market.atMs)], ['Slot', data.slot], ['Venue', data.venue], ['Side', data.side]]);
  }
  dom.detail.scrollTop = scroll;
}

function level(levelData) {
  if (!levelData) return absent;
  const unit = ({ net_pnl_percent: '% net P&L', net_pnl_sol: ' SOL net P&L',
    executable_sol_per_token: ' SOL / token' })[levelData.unit] ?? label(levelData.unit);
  return String(levelData.value ?? '—') + unit;
}

function ladder(position) {
  const node = element('div', 'ladder');
  const policy = position.policy ?? position.exit?.policy;
  const exit = position.exit?.progress ?? position.exit;
  const progress = exit?.legs ?? {};
  const labels = new Set([...policy?.takeProfits?.map(leg => leg.label) ?? [], ...Object.keys(progress).filter(value => /^TP\d+$/.test(value))]);
  for (const name of labels) {
    const setting = policy?.takeProfits?.find(leg => leg.label === name);
    const leg = progress[name];
    const state = (leg?.state ?? 'armed').replace('rounded_to_zero', 'below minimum');
    const tag = badge(name + ' · ' + label(state), state === 'filled' ? 'green' : state === 'pending' ? 'amber' : state === 'failed' ? 'red' : 'muted');
    tag.title = [name + ' at ' + level(setting), setting?.sellPercent && setting.sellPercent + '% of original',
      leg?.soldTokens != null ? 'Sold: ' + quantity(leg.soldTokens) + ' base units' : null].filter(Boolean).join(' · ');
    node.append(tag);
  }
  const trigger = exit?.terminal ?? position.trigger?.reason;
  const stop = badge(trigger === 'stop_loss' ? 'Stop · triggered' : 'Stop · ' + (policy?.stop ? level(policy.stop) : 'unavailable'),
    trigger === 'stop_loss' ? 'red' : 'muted');
  if (policy?.stop) stop.title = 'Stop at ' + level(policy.stop);
  node.append(stop);
  if (trigger === 'time_exit') node.append(badge('Time exit · triggered', 'amber'));
  return node;
}

function renderPositions() {
  const positions = snapshot?.positions ?? [];
  dom.positionCount.textContent = String(positions.length);
  const rows = positions.map(position => {
    const row = element('tr');
    const mint = element('td');
    const button = element('button', 'coin-button', compact(position.mint));
    button.type = 'button';
    button.title = position.mint;
    button.setAttribute('aria-label', 'Inspect mint ' + position.mint);
    button.addEventListener('click', () => choose(position.mint));
    mint.append(button);
    if (position.alias ?? position.creator) mint.append(element('small', 'cell-note', position.alias ?? compact(position.creator)));
    const sizes = element('td', '', `${quantity(position.originalTokens)} / ${quantity(position.remainingTokens ?? position.tokens)}`);
    const realized = element('td', '', valueWithSol(position.realizedLamports));
    if (position.realizedLamports != null) realized.dataset.tone = toneAmount(position.realizedLamports);
    const liquidation = element('td', '', position.quoteStale ? absent : valueWithSol(position.liquidationLamports));
    if (position.quoteStale || position.quoteAtMs != null) liquidation.append(element('small', 'cell-note',
      `${position.quoteStale ? 'Stale · ' : ''}${timestamp(position.quoteAtMs)}`));
    else if (position.liquidationLamports == null) liquidation.append(element('small', 'cell-note', 'No executable quote'));
    const exits = element('td');
    exits.append(ladder(position));
    row.append(mint, sizes, realized, liquidation, exits);
    return row;
  });
  if (!rows.length) {
    const row = element('tr');
    const cell = element('td');
    cell.colSpan = 5;
    cell.append(element('p', 'empty', 'No open positions.'));
    row.append(cell);
    rows.push(row);
  }
  dom.positions.replaceChildren(...rows);
}

function renderSubmissions() {
  const items = snapshot?.submissions ?? [];
  dom.submissionCount.textContent = String(items.length);
  dom.submissions.replaceChildren(...(items.length ? items.map(item => {
    const row = element('div', 'submission-row');
    const state = item.state ?? item.data?.state ?? item.data?.status ?? 'pending';
    const failed = ['failed', 'missed'].includes(state);
    row.append(badge(label(state), failed ? 'red' : 'amber'));
    const name = element('button', 'coin-button', compact(item.mint) || 'View event');
    name.type = 'button';
    name.addEventListener('click', () => choose(item.mint, item));
    row.append(name, element('span', 'submission-note', [item.side, item.source, item.data?.reason ?? item.data?.detail].filter(Boolean).join(' · ')),
      updateTime(element('time'), item.atMs, true));
    return row;
  }) : [element('p', 'empty', 'No pending or failed submissions.')]));
}

function queueRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderHeader();
    renderPerformance();
    renderEvents();
    renderDetail();
    renderPositions();
    renderSubmissions();
  });
}

function append(rows) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) if (row?.id != null && !activities.has(String(row.id))) activities.set(String(row.id), row);
  while (activities.size > activityLimit) activities.delete(activities.keys().next().value);
}

function reset(data) {
  if (snapshot?.run?.id !== data.run?.id) {
    selectedMint = undefined;
    selectedEvent = undefined;
    remoteCoin = undefined;
    coinRequest++;
  }
  snapshot = data;
  activities.clear();
  append(data.activity);
  queueRender();
}

function connect(cursor) {
  stream?.close();
  const connection = new EventSource('/api/events?after=' + encodeURIComponent(cursor ?? ''));
  stream = connection;
  function process(name, consumer) {
    connection.addEventListener(name, event => {
      if (stream !== connection) return;
      try { consumer(JSON.parse(event.data)); } catch { refresh(); }
    });
  }
  connection.onopen = () => {
    if (stream === connection) setConnection('Streaming', 'green');
  };
  connection.onerror = () => {
    if (stream !== connection) return;
    setConnection(connection.readyState === EventSource.CLOSED ? 'Reconnecting' : 'Connection interrupted', 'amber');
    if (connection.readyState === EventSource.CLOSED) retry = setTimeout(refresh, 1800);
  };
  process('activity', rows => { append(rows); queueRender(); });
  process('state', data => {
    if (data.run?.id && snapshot?.run?.id !== data.run.id) {
      refresh();
      return;
    }
    snapshot = { ...snapshot, ...data };
    queueRender();
  });
  process('reset', data => {
    if (data && Array.isArray(data.activity)) reset(data);
    else refresh();
  });
}

async function refresh() {
  const version = ++fetchVersion;
  clearTimeout(retry);
  stream?.close();
  stream = undefined;
  setConnection('Connecting', 'amber');
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!response.ok) throw new Error('Snapshot unavailable');
    const data = await response.json();
    if (version !== fetchVersion) return;
    reset(data);
    connect(data.cursor);
  } catch {
    if (version !== fetchVersion) return;
    setConnection('Snapshot unavailable', 'red');
    dom.caption.textContent = 'Waiting for the local ledger service';
    retry = setTimeout(refresh, 1800);
  }
}

dom.filters.addEventListener('submit', event => event.preventDefault());
dom.filters.addEventListener('input', renderEvents);
dom.kind.addEventListener('change', renderEvents);
dom.reset.addEventListener('click', () => { dom.filters.reset(); renderEvents(); dom.mint.focus(); });
setInterval(renderHeader, 1000);
refresh();
