(function() {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  const state = {
    currentTab: 'sessions',
    selectedId: null,
    sessions: [],
    timer: null,
  };

  // ── Utils ──

  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function fmt(n) { return n != null ? Number(n).toLocaleString() : '--'; }
  function fmt$(n) { return n != null ? '$' + Number(n).toFixed(2) : '--'; }
  function rel(iso) {
    if (!iso) return '--';
    const d = Date.now() - new Date(iso).getTime();
    if (d < 0) return '--';
    const s = Math.floor(d/1000), m = Math.floor(s/60), h = Math.floor(m/60);
    if (s < 60) return 'just now';
    if (m < 60) return m + 'm ago';
    if (h < 24) return h + 'h ago';
    return Math.floor(h/24) + 'd ago';
  }
  function dur(ms) {
    if (ms == null) return '--';
    const v = Number(ms);
    return v < 1000 ? v + 'ms' : (v/1000).toFixed(1) + 's';
  }
  function gclr(g) {
    const m = { A:'#22c55e', B:'#84cc16', C:'#eab308', D:'#f97316', F:'#ef4444', pass:'#22c55e', fail:'#ef4444' };
    return m[String(g).toUpperCase()] || '#666';
  }
  function gmean(g) {
    const m = { A:'Clean — no issues', B:'Minor issues', C:'Inefficient', D:'Risky — problems', F:'Failed or errored' };
    return m[String(g).toUpperCase()] || '';
  }
  function trnc(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : (s || ''); }
  function spin() { const w = document.createElement('div'); w.className = 'spinner'; w.innerHTML = '<div></div>'; return w; }
  function loading(el) { el.innerHTML = ''; el.appendChild(spin()); }
  function err(el, msg) { el.innerHTML = '<div class="error-banner">' + esc(msg) + '</div>'; }
  async function api(p) { const r = await fetch(p); if (!r.ok) throw new Error(r.status); return r.json(); }

  // ── Init ──

  async function init() {
    try { await api('/api/stats'); $('#connection-status').textContent = '● connected'; $('#connection-status').style.color = '#22c55e'; }
    catch (_) { $('#connection-status').textContent = '● disconnected'; $('#connection-status').style.color = '#ef4444'; }

    $$('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    $('#session-search').addEventListener('input', renderSessions);
    $('#modal-close').addEventListener('click', closeModal);
    $('#server-modal').addEventListener('click', e => { if (e.target === $('#server-modal')) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    setInterval(() => { $('#footer-time').textContent = new Date().toLocaleString(); }, 30000);
    $('#footer-time').textContent = new Date().toLocaleString();

    await renderStats();
    await renderSessions();
    startRefresh();
  }

  function startRefresh() {
    clearInterval(state.timer);
    state.timer = setInterval(async () => {
      await renderStats();
      if (state.currentTab === 'sessions') await renderSessions();
    }, 10000);
  }

  // ── Tabs ──

  function switchTab(tab) {
    state.currentTab = tab;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $$('.tab-panel').forEach(p => {
      p.style.display = p.dataset.tabPanel === tab ? '' : 'none';
    });
    if (tab === 'sessions') renderSessions();
    if (tab === 'tool-health') renderHealth();
  }

  // ── Stats ──

  async function renderStats() {
    try {
      const s = await api('/api/stats');
      $('#stat-sessions').textContent = fmt(s.totalSessions);
      $('#stat-successful').textContent = fmt(s.completedSessions);
      $('#stat-failed').textContent = fmt(s.failedSessions);
      $('#stat-toolcalls').textContent = fmt(s.totalToolCalls);
      $('#stat-cost').textContent = fmt$(s.totalCost);
      $('#stat-tokens').textContent = fmt(s.totalTokens);
    } catch (_) {}
  }

  // ── Sessions ──

  async function renderSessions() {
    const tbody = $('#sessions-table-body');
    if (!tbody) return;
    loading(tbody);
    try {
      state.sessions = await api('/api/sessions');
    } catch (e) {
      err(tbody, 'Failed to load sessions');
      return;
    }
    const q = ($('#session-search').value || '').toLowerCase();
    const list = state.sessions.filter(s => !q || (s.taskDescription || '').toLowerCase().includes(q));

    if (!list.length) {
      $('#sessions-empty').style.display = '';
      $('#sessions-table-wrapper').style.display = 'none';
      return;
    }
    $('#sessions-empty').style.display = 'none';
    $('#sessions-table-wrapper').style.display = '';

    tbody.innerHTML = list.map(s => {
      const g = s.grade || '--';
      const gc = gclr(g);
      const sc = s.status === 'complete' ? '#22c55e' : s.status === 'running' ? '#3b82f6' : '#ef4444';
      return '<tr class="session-row' + (s.id === state.selectedId ? ' selected' : '') + '" data-id="' + s.id + '">' +
        '<td><span class="badge grade-badge" style="background:' + gc + '20;color:' + gc + '">' + esc(g) + '</span></td>' +
        '<td><span class="status-dot" style="background:' + sc + '" title="' + esc(s.status) + '"></span></td>' +
        '<td><span class="badge agent-badge">' + esc(s.agentType || '--') + '</span></td>' +
        '<td class="col-task">' + esc(trnc(s.taskDescription, 60)) + '</td>' +
        '<td class="col-num">' + fmt(s.totalTokens) + '</td>' +
        '<td class="col-num">' + fmt$(s.estimatedCost) + '</td>' +
        '<td class="col-num">' + rel(s.startedAt) + '</td>' +
        '</tr>';
    }).join('');

    $$('#sessions-table-body .session-row').forEach(row => {
      row.addEventListener('click', () => selectSession(row.dataset.id));
    });
  }

  // ── Detail ──

  async function selectSession(id) {
    state.selectedId = id;
    renderSessions();
    $('#detail-empty').style.display = 'none';
    $('#detail-content').style.display = '';

    loading($('#trace-timeline'));
    try {
      const s = await api('/api/sessions/' + id);
      renderDetail(s);
    } catch (e) {
      err($('#trace-timeline'), 'Failed to load session: ' + e.message);
    }
  }

  function renderDetail(s) {
    const g = s.grade || '--';
    const gc = gclr(g);

    $('#detail-title').textContent = s.taskDescription || 'Untitled session';
    $('#detail-grade-badge').textContent = 'Grade ' + g;
    $('#detail-grade-badge').style.background = gc + '20';
    $('#detail-grade-badge').style.color = gc;
    $('#detail-grade-meaning').textContent = gmean(g);
    $('#detail-grade-meaning').style.color = gc;

    const statusColor = s.status === 'complete' ? '#22c55e' : s.status === 'running' ? '#3b82f6' : '#ef4444';
    $('#detail-agent').textContent = s.agentType || '--';
    $('#detail-status').innerHTML = '<span style="color:' + statusColor + '">● ' + esc(s.status) + '</span>';
    $('#detail-input-tokens').textContent = fmt(s.inputTokens);
    $('#detail-output-tokens').textContent = fmt(s.outputTokens);
    $('#detail-total-tokens').textContent = fmt(s.totalTokens);
    $('#detail-cost').textContent = fmt$(s.estimatedCost);
    $('#detail-duration').textContent = s.startedAt && s.endedAt
      ? dur(new Date(s.endedAt) - new Date(s.startedAt))
      : '--';
    $('#detail-started').textContent = rel(s.startedAt);

    if (s.errorMessage) {
      $('#detail-error').style.display = '';
      $('#detail-error').textContent = s.errorMessage;
    } else {
      $('#detail-error').style.display = 'none';
    }

    renderTimeline(s.toolCalls || []);
    renderEntries($('#detail-decisions'), (s.decisions || []), d => esc(d.chosenAction || d.rationale || '--'));
    renderEntries($('#detail-audit'), (s.auditEntries || []), a => esc(a.eventType) + ' — ' + esc(a.outcome || '--'));
  }

  function renderTimeline(calls) {
    const el = $('#trace-timeline');
    if (!calls.length) { el.innerHTML = '<div class="empty-state"><span class="empty-icon">∅</span><p>No tool calls</p></div>'; return; }

    el.innerHTML = calls.map((c, i) => {
      const ok = c.status === 'success';
      const cls = ok ? 'step-success' : 'step-error';
      return '<div class="timeline-step" data-step="' + i + '">' +
        '<div class="step-marker ' + cls + '">' + (ok ? '✓' : '✗') + '</div>' +
        '<div class="step-card">' +
          '<div class="step-header">' +
            '<span class="step-tool">' + esc(c.toolName) + '</span>' +
            '<span class="step-server">' + esc(c.toolServer || '') + '</span>' +
            '<span class="step-duration">' + dur(c.durationMs) + '</span>' +
          '</div>' +
          (c.errorMessage ? '<div class="step-error-msg">' + esc(c.errorMessage) + '</div>' : '') +
          (c.outputSummary ? '<div class="step-summary">' + esc(c.outputSummary) + '</div>' : '') +
          '<div class="step-detail" style="display:none">' +
            '<pre>Input: ' + esc(JSON.stringify(c.input || {}, null, 2)) + '</pre>' +
            '<pre>Output: ' + esc(JSON.stringify(c.output || {}, null, 2)) + '</pre>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    $$('#trace-timeline .step-card').forEach(card => {
      card.addEventListener('click', function() {
        const detail = this.querySelector('.step-detail');
        detail.style.display = detail.style.display === 'none' ? '' : 'none';
      });
    });
  }

  function renderEntries(container, entries, renderFn) {
    if (!entries.length) { container.innerHTML = '<div class="empty-state" style="padding:16px"><span class="empty-icon">∅</span><p>None</p></div>'; return; }
    container.innerHTML = entries.map(e => '<div class="entry-row">' + renderFn(e) + '</div>').join('');
  }

  // ── Tool Health ──

  async function renderHealth() {
    const grid = $('#health-grid');
    const empty = $('#health-empty');
    loading(grid);
    try {
      const checks = await api('/api/tool-health');
      if (!checks.length) { grid.innerHTML = ''; empty.style.display = ''; return; }
      empty.style.display = 'none';

      grid.innerHTML = checks.map(c => {
        const gc = gclr(c.grade);
        const gateClr = c.gate === 'pass' ? '#22c55e' : '#ef4444';
        return '<div class="health-card" data-server="' + esc(c.toolServer) + '">' +
          '<div class="health-card-top">' +
            '<span class="health-server-name">' + esc(c.toolServer) + '</span>' +
            '<span class="badge grade-badge" style="background:' + gc + '20;color:' + gc + '">' + esc(c.grade) + '</span>' +
          '</div>' +
          '<div class="health-bar"><div class="health-bar-fill" style="width:' + c.healthScore + '%;background:' + gc + '"></div></div>' +
          '<div class="health-card-bot">' +
            '<span class="badge gate-badge" style="background:' + gateClr + '20;color:' + gateClr + '">' + esc(c.gate) + '</span>' +
            '<span class="health-tool-count">' + c.toolCount + ' tools</span>' +
            '<span class="health-time">' + rel(c.checkedAt) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');

      $$('#health-grid .health-card').forEach(card => {
        card.addEventListener('click', () => showHealthHistory(card.dataset.server));
      });
    } catch (e) {
      err(grid, 'Failed to load health data');
    }
  }

  async function showHealthHistory(server) {
    $('#modal-server-name').textContent = server;
    $('#modal-health-chart').innerHTML = '';
    loading($('#modal-health-stats'));
    $('#server-modal').classList.add('open');

    try {
      const history = await api('/api/tool-health/' + encodeURIComponent(server) + '/history');
      let html = '';
      for (const h of history) {
        const gc = gclr(h.grade);
        html += '<div class="history-row">' +
          '<span class="badge grade-badge" style="background:' + gc + '20;color:' + gc + '">' + esc(h.grade) + '</span>' +
          '<span>' + h.healthScore + '%</span>' +
          '<span class="badge gate-badge" style="background:' + (h.gate === 'pass' ? '#22c55e' : '#ef4444') + '20;color:' + (h.gate === 'pass' ? '#22c55e' : '#ef4444') + '">' + esc(h.gate) + '</span>' +
          '<span>' + h.toolCount + ' tools</span>' +
          '<span style="color:#6b6b70;font-size:11px">' + rel(h.checkedAt) + '</span>' +
        '</div>';
      }
      $('#modal-health-stats').innerHTML = html;
    } catch (e) {
      err($('#modal-health-stats'), 'Failed to load history');
    }
  }

  function closeModal() {
    $('#server-modal').classList.remove('open');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
