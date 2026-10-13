/**
 * IS6912 participant behavioural telemetry (client).
 *
 * Design rules:
 *  - two page clocks: performance.now() (monotonic since page load) and an epoch
 *    estimate for cross-page ordering; the frozen script execution clock is only copied,
 *    never used for page dwell;
 *  - one page stream id per page load. Every event id is `client_<stream>-<seq36>`, so a
 *    restored queue keeps its original ids and clocks and the server can reject any id
 *    that does not match the stream and sequence it declares;
 *  - batches are grouped by their original stream, capped at 50 events and 24 KiB, and
 *    sent one at a time;
 *  - ids the server rejects are terminal and leave the queue, so a poisoned event can
 *    never block the rest;
 *  - only allowlisted types and allowlisted structured fields leave the browser: logical
 *    control ids, control types, numeric latencies and plan/payload constants. No invite
 *    value, no typed text, no key codes, no answers;
 *  - rendering ticks are never events; a coarse 15 s heartbeat bounds the last observed
 *    dwell instead;
 *  - nothing here is awaited inside the timed execution path.
 */
(function (root) {
  'use strict';

  var VERSION = '2026-10-12-telemetry-v01';
  var ENDPOINT = '/api/events';
  var MAX_QUEUE = 400;
  var MAX_BATCH_EVENTS = 50;
  var MAX_BATCH_BYTES = 24 * 1024;
  var FLUSH_INTERVAL = 5000;
  var FLUSH_DEBOUNCE = 400;
  var SAVE_THROTTLE = 1000;
  var HEARTBEAT_INTERVAL = 15000;
  var MAX_ATTEMPTS = 6;
  var MAX_BACKOFF = 15000;
  var SCROLL_THROTTLE = 1000;
  var RESIZE_THROTTLE = 500;
  var AUTO_SCROLL_WINDOW = 300;
  var STORAGE_PREFIX = 'is6912-telemetry:';
  var SCROLL_AREAS = { 'source-panel': 'source', 'plan-panel': 'plan', 'trace-panel': 'trace', plan: 'plan', trace: 'trace' };
  var attachedTrials = new WeakSet();

  function randomId() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID().replace(/-/g, '');
    return 's' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  }
  function logicalId(element) {
    if (!element || !element.getAttribute) return 'unknown';
    var candidate = element.getAttribute('data-tl') || element.id || element.getAttribute('name') || element.tagName.toLowerCase();
    return /^[A-Za-z0-9_-]{1,48}$/.test(candidate) ? candidate : 'unknown';
  }
  function controlType(element) {
    if (!element || !element.tagName) return 'other';
    var tag = element.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'button') return element.type === 'submit' ? 'submit' : 'button';
    if (tag === 'input') {
      var type = (element.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit') return 'submit';
      if (type === 'button') return 'button';
      return 'text';
    }
    return 'other';
  }

  function createTelemetry(options) {
    var settings = options || {};
    var endpoint = settings.endpoint || ENDPOINT;
    var pageStartMs = performance.now();
    var epochOffsetMs = Date.now() - pageStartMs;
    var streamId = settings.streamId || randomId();
    var seq = 0;

    var sessionId = null;
    var storageKey = null;
    var storageOk = true;
    var restored = false;
    var queue = [];
    var flushing = false;
    var attempts = 0;
    var backoffMs = 1000;
    var intervalTimer = null;
    var heartbeatTimer = null;
    var debounceTimer = null;
    var retryTimer = null;
    var saveTimer = null;
    var saveDirty = false;
    var lastClickMs = null;
    var lastInteractionMs = pageStartMs;
    var ackHighWater = {};
    var firstFocusAt = Object.create(null);
    var pendingLoss = Object.create(null);
    var autoScroll = Object.create(null);

    var counters = { accepted: 0, rejected: 0, dropped: 0, retries: 0, networkLost: 0, storageLost: 0, batchesSent: 0, batchesDropped: 0 };

    var state = {
      stage: null, stageStartMs: pageStartMs, stageActiveMs: 0, phase: null, stepId: null,
      planVisible: true, trial: null, cell: null, rendered: false,
      visible: true, focused: true, exposedVisible: true, exposedFocused: true,
    };

    /* ------------------------------------------------------------- clocks */
    var activeMs = 0;
    var lastClockMs = pageStartMs;
    function accumulate() {
      var now = performance.now();
      var delta = now - lastClockMs;
      // Only visible-and-focused time is active dwell; everything else is a proxy.
      if (delta > 0 && state.visible && state.focused) activeMs += delta;
      lastClockMs = now;
    }
    function wallMs() { return performance.now() - pageStartMs; }
    function epochMs() { return Math.round(performance.now() + epochOffsetMs); }
    function idleMs() { return Math.max(0, Math.round(performance.now() - lastInteractionMs)); }
    function noteInteraction() { lastInteractionMs = performance.now(); }

    /* ---------------------------------------------------------- event sink */
    function makeEvent(type, options2) {
      var settings2 = options2 || {};
      seq += 1;
      var event = {
        id: 'client_' + streamId + '-' + seq.toString(36).padStart(7, '0'),
        type: type,
        seq: seq,
        streamId: streamId,
        clientMs: Math.round(wallMs()),
        clientEpochMs: epochMs(),
        data: settings2.data || {},
      };
      if (state.stage) event.stage = state.stage;
      var phase = settings2.phase !== undefined ? settings2.phase : state.phase;
      if (phase) event.phase = phase;
      var stepId = settings2.stepId !== undefined ? settings2.stepId : state.stepId;
      if (stepId) event.stepId = stepId;
      var trial = settings2.trial || state.trial;
      if (trial && typeof trial.activeMs === 'number') event.executionActiveMs = Math.round(trial.activeMs);
      if (trial && typeof trial.wallMs === 'number') event.executionWallMs = Math.round(trial.wallMs);
      return event;
    }

    function lossMarker(kind) {
      return makeEvent('queue_loss', { data: { kind: kind, pending: queue.length, counter: counters.retries + counters.dropped + counters.networkLost } });
    }

    function push(type, options2) {
      if (!sessionId) return null;
      accumulate();
      var event = makeEvent(type, options2);
      if (queue.length >= MAX_QUEUE) { queue.shift(); counters.dropped += 1; counters.batchesDropped += 1; pendingLoss.queue_overflow = (pendingLoss.queue_overflow || 0) + 1; }
      queue.push(event);
      flushLossMarkers();
      markDirty();
      if (queue.length >= MAX_BATCH_EVENTS * 2) flushSoon(0);
      return event;
    }

    /** Loss markers are appended once per burst and never recursively. */
    function flushLossMarkers() {
      for (var kind in pendingLoss) {
        if (!pendingLoss[kind] || queue.length >= MAX_QUEUE) continue;
        queue.push(lossMarker(kind));
        pendingLoss[kind] = 0;
        markDirty();
      }
    }

    function noteLoss(kind) {
      if (kind === 'storage_unavailable') counters.storageLost += 1;
      else counters.networkLost += 1;
      pendingLoss[kind] = (pendingLoss[kind] || 0) + 1;
      flushLossMarkers();
    }

    /* ------------------------------------------------------------ storage */
    function purgeOtherSessions() {
      try {
        var keys = [];
        for (var index = 0; index < localStorage.length; index += 1) {
          var key = localStorage.key(index);
          if (key && key.indexOf(STORAGE_PREFIX) === 0 && key !== storageKey) keys.push(key);
        }
        keys.forEach(function (key) { localStorage.removeItem(key); });
      } catch (error) { storageOk = false; }
    }
    function load() {
      try {
        var raw = localStorage.getItem(storageKey);
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!parsed || parsed.sessionId !== sessionId || !Array.isArray(parsed.queue)) return;
        queue = parsed.queue.filter(function (event) {
          return event && typeof event.id === 'string' && typeof event.type === 'string' && typeof event.streamId === 'string' && Number.isInteger(event.seq);
        }).slice(-MAX_QUEUE);
        if (parsed.counters) for (var key in counters) if (typeof parsed.counters[key] === 'number') counters[key] = parsed.counters[key];
        if (parsed.ackHighWater && typeof parsed.ackHighWater === 'object') ackHighWater = parsed.ackHighWater;
        if (parsed.storageOk === false) storageOk = false;
        // A restored queue keeps its original stream ids, ids and page clocks; the new
        // page only adds new events with its own stream.
        restored = queue.length > 0;
        // A new page owns a new stream and starts its sequence at one.
        // Restored events retain their original stream and sequence.
      } catch (error) { storageOk = false; noteLoss('storage_unavailable'); }
    }
    function markDirty() {
      saveDirty = true;
      if (saveTimer) return;
      saveTimer = setTimeout(function () { saveTimer = null; save(); }, SAVE_THROTTLE);
    }
    function save() {
      if (!storageKey || !storageOk || !saveDirty) return;
      saveDirty = false;
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          sessionId: sessionId, currentStream: streamId, queue: queue, counters: counters,
          ackHighWater: ackHighWater, storageOk: storageOk, savedAt: Date.now(),
        }));
      } catch (error) { storageOk = false; noteLoss('storage_unavailable'); }
    }

    /* -------------------------------------------------------------- flush */
    function scheduleRetry() {
      if (retryTimer) return;
      retryTimer = setTimeout(function () { retryTimer = null; drain(); }, backoffMs);
      backoffMs = Math.min(MAX_BACKOFF, Math.round(backoffMs * 1.8));
    }
    function flushSoon(delay) {
      if (debounceTimer) return;
      debounceTimer = setTimeout(function () { debounceTimer = null; drain(); }, delay === undefined ? FLUSH_DEBOUNCE : delay);
    }

    /** Next batch: consecutive events of one stream, <=50 events and <=24 KiB. */
    function nextBatch() {
      if (!queue.length) return null;
      var batch = [];
      var bytes = 0;
      for (var index = 0; index < queue.length && batch.length < MAX_BATCH_EVENTS; index += 1) {
        var event = queue[index];
        if (batch.length && event.streamId !== batch[0].streamId) break;
        var size = new TextEncoder().encode(JSON.stringify(event)).length + 1;
        if (batch.length && bytes + size > MAX_BATCH_BYTES) break;
        batch.push(event);
        bytes += size;
      }
      return batch;
    }

    function flushOnce(options2) {
      var useKeepalive = Boolean(options2 && options2.keepalive);
      if (!sessionId || flushing || !queue.length) return Promise.resolve(0);
      var batch = nextBatch();
      if (!batch) return Promise.resolve(0);
      flushing = true;
      var succeeded = false;
      counters.batchesSent += 1;
      return fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: useKeepalive,
        signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json', 'X-Study-Request': '1' },
        body: JSON.stringify({ sessionId: sessionId, streamId: batch[0].streamId, events: batch }),
      }).then(function (response) {
        if (!response.ok) throw new Error('http_' + response.status);
        return response.json();
      }).then(function (result) {
        if (!result || result.ok !== true) throw new Error('batch_not_accepted');
        var stored = Object.create(null);
        (result.accepted || result.acked || []).forEach(function (id) { stored[id] = true; });
        (result.duplicates || []).forEach(function (id) { stored[id] = true; });
        // Rejected ids are terminal: leaving them would resend them forever.
        var terminal = Object.create(null);
        (result.rejected || []).forEach(function (entry) { if (entry && entry.id) terminal[entry.id] = true; });
        batch.forEach(function (event) {
          if (stored[event.id] && event.streamId) ackHighWater[event.streamId] = Math.max(ackHighWater[event.streamId] || 0, event.seq);
        });
        queue = queue.filter(function (event) { return !stored[event.id] && !terminal[event.id]; });
        if (result.counters && Number.isFinite(result.counters.stored)) counters.accepted = result.counters.stored;
        else counters.accepted += (result.accepted || result.acked || []).length;
        counters.rejected += (result.rejected || []).length;
        counters.dropped += Number(result.dropped || 0);
        succeeded = true;
        attempts = 0;
        backoffMs = 1000;
        saveDirty = true;
        save();
      }).catch(function () {
        counters.retries += 1;
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) { attempts = 0; noteLoss('retry_exhausted'); }
        markDirty();
        scheduleRetry();
      }).then(function () { flushing = false; return succeeded; }, function () { flushing = false; return false; });
    }

    /** Sends batches one at a time until the queue drains or the loop budget ends. */
    function drain(budget) {
      var remaining = budget === undefined ? 8 : budget;
      if (remaining <= 0 || flushing || !queue.length || !sessionId) return Promise.resolve(0);
      return flushOnce().then(function (ok) { return ok && queue.length ? drain(remaining - 1) : 0; });
    }

    /** Bounded best effort flush before submitting. Never rejects. */
    function flushFinal(timeoutMs) {
      var limit = timeoutMs || 4000;
      save();
      return Promise.race([
        drain(12).catch(function () { return undefined; }),
        new Promise(function (resolve) { setTimeout(resolve, limit); })
      ]).then(function () { save(); return info(); }, function () { return info(); });
    }

    /* --------------------------------------------------------- public API */
    function attach(details) {
      if (sessionId) return;
      sessionId = details.sessionId;
      storageKey = STORAGE_PREFIX + sessionId;
      state.cell = details.cell || null;
      state.planVisible = details.planVisible !== false;
      // Start from the real document state so a blurred or hidden page is not assumed visible.
      state.visible = document.visibilityState !== 'hidden';
      state.focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      state.exposedVisible = state.visible;
      state.exposedFocused = state.focused;
      purgeOtherSessions();
      load();
      push('page_load', {
        data: { width: root.innerWidth || 0, height: root.innerHeight || 0, restored: restored, visible: state.visible, focused: state.focused },
      });
      startListeners();
      if (intervalTimer) clearInterval(intervalTimer);
      intervalTimer = setInterval(function () { drain(); }, 5000);
      heartbeatTimer = setInterval(function () { heartbeat(); }, HEARTBEAT_INTERVAL);
      flushSoon(FLUSH_DEBOUNCE);
    }

    function info() {
      var acks = {};
      for (var stream in ackHighWater) acks[stream] = ackHighWater[stream];
      return {
        version: VERSION, queued: queue.length, accepted: counters.accepted, rejected: counters.rejected,
        dropped: counters.dropped, retries: counters.retries, storageOk: storageOk, restored: restored,
        networkLost: counters.networkLost, batchesSent: counters.batchesSent, streams: acks, seq: seq,
      };
    }

    function setStage(name) {
      if (!sessionId || name === state.stage) return;
      var now = performance.now();
      accumulate();
      if (state.stage) push('stage_exit', { data: { wallMs: Math.round(now - state.stageStartMs), activeVisibleMs: Math.round(activeMs - state.stageActiveMs) } });
      state.stage = name;
      state.stageStartMs = now;
      state.stageActiveMs = activeMs;
      // The execution phase/step only describes the execution screen; leaving it clears
      // them so later events are not attributed to a stale step.
      if (name !== 'execution') { state.phase = null; state.stepId = null; }
      push('stage_enter', { data: {} });
      flushSoon(FLUSH_DEBOUNCE);
    }

    /** Current action exposure; only fires on a real change, never on the render tick. */
    /* ------------------------------------------------------- language choice */
    // A user preference, recorded as an observed covariate. It is never a factor, it
    // carries the usual page clock and stage, and it never touches a trial clock.
    var initialLanguageLogged = false;
    function languageInitial(language) {
      if (!sessionId || initialLanguageLogged) return;
      if (language !== 'en' && language !== 'zh') return;
      initialLanguageLogged = true;
      push('language_initial', { data: { language: language } });
      flushSoon(FLUSH_DEBOUNCE);
    }
    function languageChange(from, to) {
      if (!sessionId) return;
      if ((from !== 'en' && from !== 'zh') || (to !== 'en' && to !== 'zh')) return;
      push('language_change', { data: { from: from, to: to } });
      flushSoon(FLUSH_DEBOUNCE);
    }

    function setExecution(phase, stepId) {
      if (!sessionId) return;
      var changed = phase !== state.phase || stepId !== state.stepId;
      state.phase = phase === undefined ? state.phase : phase;
      state.stepId = stepId === undefined ? state.stepId : stepId;
      if (!changed) return;
      push('phase_render', { data: { reason: state.rendered ? 'state_change' : 'initial' }, phase: state.phase, stepId: state.stepId });
      state.rendered = true;
      push('step_exposure', { data: { change: 'phase', visible: state.visible, focused: state.focused }, phase: state.phase, stepId: state.stepId });
      flushSoon(FLUSH_DEBOUNCE);
    }

    /** The plan the participant can actually see. Only the high-visibility cell calls this. */
    function planShown(plan, revision, position) {
      push('plan_exposure', { data: { plan: plan, revision: revision || 'initial', position: position || 1 } });
    }

    function refreshExposure() {
      if (!sessionId) return;
      var visibilityChanged = state.visible !== state.exposedVisible;
      var focusChanged = state.focused !== state.exposedFocused;
      state.exposedVisible = state.visible;
      state.exposedFocused = state.focused;
      if ((!visibilityChanged && !focusChanged) || !state.phase) return;
      push('step_exposure', { data: { change: visibilityChanged ? 'visibility' : 'focus', visible: state.visible, focused: state.focused }, phase: state.phase, stepId: state.stepId });
    }

    /** Coarse heartbeat: bounds the last observed dwell for an abandoned session. */
    function heartbeat() {
      if (!sessionId || !state.stage) return;
      accumulate();
      push('heartbeat', {
        data: { visible: state.visible, focused: state.focused, idleMs: idleMs(), stepId: state.stepId || '' },
        phase: state.phase, stepId: state.stepId,
      });
    }

    var openEditors = Object.create(null);
    function editorOpen(kind) { openEditors[kind] = performance.now(); push('editor_open', { data: { kind: kind } }); }
    function editorClose(kind, saved) {
      var started = openEditors[kind];
      delete openEditors[kind];
      push('editor_close', { data: { kind: kind, dwellMs: started === undefined ? 0 : Math.max(0, Math.round(performance.now() - started)), saved: Boolean(saved) } });
    }
    function decision(kind) { push('decision_pause', { data: { kind: kind } }); }

    /* ------------------------------------------------- scripted agent mirror */
    var MIRROR = {
      configured: function () { return ['agent_configured', { pace: 1 }]; },
      initial_plan: function (data) {
        var preparation = data.preparation || {};
        var mode = preparation.mode === 'constrained_co_planning' ? 'constrained_co_planning' : 'review_only';
        return ['agent_initial_plan', { plan: data.plan, mode: mode, assisted: preparation.assisted === true }];
      },
      // Private script state, recorded for every cell: the analysis can compare what the
      // script did with what the participant was allowed to see (plan_exposure).
      plan_event: function (data) { return ['agent_plan_event', { before: data.before, after: data.after, messageId: 'resource_update' }]; },
      state_enter: function (data) { return ['agent_state_enter', { current: data.current || '', plan: data.plan }]; },
      seeded_payload: function (data) { return ['agent_seeded_payload', { payload: data.payload }]; },
      first_publication: function (data) { return ['agent_publication', { payload: data.payload }]; },
      pause: function (data) { return ['agent_pause', { kind: data.kind || 'pause' }]; },
      pause_limit: function () { return ['agent_pause', { kind: 'pause_limit' }]; },
      resume: function () { return ['agent_resume', {}]; },
      resume_ui: function () { return ['decision_pause', { kind: 'resume' }]; },
      override: function (data) { return ['agent_override', { before: data.before, after: data.after, plan: data.plan }]; },
      safe_template_redirect: function () { return ['agent_redirect', {}]; },
      stop: function () { return ['agent_stop', { reason: 'stopped' }]; },
      redirect: function () { return ['agent_pause', { kind: 'redirect' }]; },
      override_open: function () { return ['agent_pause', { kind: 'override_open' }]; },
      redirect_open: function () { return ['agent_pause', { kind: 'redirect_open' }]; },
      trial_end: function (data) {
        var completed = data.metrics ? (data.metrics.completed === 1 || data.metrics.completed === true) : false;
        return ['agent_trial_end', { reason: data.reason, completed: completed }];
      },
      training_pause: function () { return ['practice_step', { step: 'pause', correct: true }]; },
      training_edit: function (data) { return ['practice_step', { step: 'save', correct: data.correct === true }]; },
      training_complete: function () { return ['practice_complete', {}]; },
      planning_attempt: function (data) { return ['planning_interaction', { action: 'submit', outcome: planningOutcome(data), part: 1 }]; },
      planning_assistance: function () { return ['planning_interaction', { action: 'assist', outcome: 'review', part: 2 }]; },
      survey_part_complete: function (data) { return ['survey_page', { part: Number(data.part) || 1, complete: false }]; },
      survey_complete: function () { return ['survey_page', { part: 4, complete: true }]; },
      interview_complete: function () { return ['interview_complete', { questions: document.querySelectorAll('#interview textarea').length }]; },
      narrative_complete: function (data) { return ['narrative_complete', { exposureMs: Math.max(0, Math.round(Number(data.exposureMs) || 0)) }]; },
      information_view: function (data) { return ['panel_view', { area: data.area }]; },
      editor_open: function () { return null; },
      editor_cancel: function () { return null; },
      direction_open: function () { return null; },
      direction_cancel: function () { return null; },
      ui_version: function () { return null; },
      live_models_prepared: function () { return null; },
    };

    function planningOutcome(data) {
      var values = data && data.values ? data.values : {};
      if (!state.cell || state.cell.slice(-1) !== 'C') return 'review';
      return values.order0 === 'form' && values.order1 === 'email' && values.order2 === 'publish' ? 'matched' : 'mismatched';
    }

    /** Mirror the deterministic trial engine without changing it. */
    function attachTrial(trial) {
      if (!trial || attachedTrials.has(trial)) return;
      attachedTrials.add(trial);
      state.trial = trial;
      // The engine records 'configured' inside its constructor, before we can wrap it.
      push('agent_configured', { data: { pace: typeof trial.pace === 'number' ? trial.pace : 1 }, trial: trial });
      var original = trial.record;
      Object.defineProperty(trial, 'record', {
        configurable: true, enumerable: false, writable: true,
        value: function (type, data) {
          var outcome = original.call(this, type, data || {});
          try {
            var mapper = MIRROR[type];
            if (mapper) {
              var mapped = mapper(data || {}, this);
              if (mapped) {
                var stepId = null;
                try { stepId = typeof this.currentId === 'function' ? this.currentId() : null; } catch (error) { stepId = null; }
                push(mapped[0], { data: mapped[1], trial: this, phase: state.stage==='execution'?this.phase:null, stepId: state.stage==='execution'?(stepId||''):null });
              }
            }
          } catch (error) { /* telemetry must never change trial behaviour */ }
          return outcome;
        }
      });
    }

    /* ----------------------------------------------------------- listeners */
    var started = false;
    var lastScrollAt = Object.create(null);
    var lastScrollTop = Object.create(null);
    var resizeTimer = null;

    function startListeners() {
      if (started) return;
      started = true;

      document.addEventListener('visibilitychange', function () {
        accumulate();                       // bank the elapsed time before changing state
        state.visible = document.visibilityState !== 'hidden';
        push('visibility_change', { data: { state: state.visible ? 'visible' : 'hidden' } });
        refreshExposure();
      });
      root.addEventListener('focus', function () {
        accumulate();
        state.focused = true;
        push('focus_change', { data: { direction: 'focusin', target: 'window', control: 'other' } });
        refreshExposure();
      });
      root.addEventListener('blur', function () {
        accumulate();
        state.focused = false;
        push('focus_change', { data: { direction: 'focusout', target: 'window', control: 'other' } });
        refreshExposure();
      });
      root.addEventListener('resize', function () {
        if (resizeTimer) return;
        resizeTimer = setTimeout(function () {
          resizeTimer = null;
          push('viewport_resize', { data: { width: root.innerWidth || 0, height: root.innerHeight || 0 } });
        }, RESIZE_THROTTLE);
      });
      document.addEventListener('click', function (event) {
        var element = event.target && event.target.closest ? event.target.closest('[data-tl]') : null;
        if (!element) return;
        noteInteraction();
        var now = performance.now();
        push('control_click', {
          data: {
            target: logicalId(element), control: controlType(element),
            sinceLastClickMs: lastClickMs === null ? 0 : Math.max(0, Math.round(now - lastClickMs)),
          },
        });
        lastClickMs = now;
      }, true);
      document.addEventListener('pointerdown', noteInteraction, { capture: true, passive: true });
      document.addEventListener('focusin', onFieldFocus);
      document.addEventListener('focusout', onFieldFocus);
      document.addEventListener('change', onFieldChange);
      document.addEventListener('scroll', onPanelScroll, { passive: true, capture: true });
      root.addEventListener('pagehide', function () {
        accumulate();
        push('page_hide', { data: { reason: 'pagehide' } });
        save();
        // Keepalive delivery is best effort and is never reported as guaranteed.
        flushOnce({ keepalive: true });
      });
    }

    function isSurveyField(element) {
      return Boolean(element && element.name && element.closest && element.closest('#survey,#interview'));
    }
    function onFieldFocus(event) {
      var element = event.target;
      var action = event.type === 'focusin' ? 'focus' : 'blur';
      noteInteraction();
      if (isSurveyField(element)) {
        var key = streamId + '|' + element.name;
        var first = firstFocusAt[key];
        if (action === 'focus' && first === undefined) firstFocusAt[key] = performance.now();
        // Discrete focus/change/blur are recorded every time; only timings, never content.
        push('survey_field', {
          data: {
            field: element.name, action: action, control: controlType(element),
            sinceFirstFocusMs: Math.max(0, Math.round(performance.now() - (first === undefined ? performance.now() : first))),
          },
        });
        return;
      }
      push('focus_change', { data: { direction: action === 'focus' ? 'focusin' : 'focusout', target: logicalId(element), control: controlType(element) } });
    }
    function onFieldChange(event) {
      var element = event.target;
      if (!isSurveyField(element)) return;
      noteInteraction();
      var key = (event.streamId || streamId) + '|' + element.name;
      var first = firstFocusAt[key];
      if (first === undefined) firstFocusAt[key] = performance.now();
      push('survey_field', {
        data: {
          field: element.name, action: 'change', control: controlType(element),
          sinceFirstFocusMs: Math.max(0, Math.round(performance.now() - first)),
        },
      });
    }

    function onPanelScroll(event) {
      var node = event.target;
      var area = null;
      if (node && node.id && SCROLL_AREAS[node.id]) area = SCROLL_AREAS[node.id];
      else if (node && node.closest) {
        var panel = node.closest('.panel');
        if (panel && panel.id && SCROLL_AREAS[panel.id]) area = SCROLL_AREAS[panel.id];
      }
      if (!area) return;
      var now = performance.now();
      var automated = now < (autoScroll[area] || 0);
      if (!automated && lastScrollAt[area] !== undefined && now - lastScrollAt[area] < SCROLL_THROTTLE) return;
      var top = node.scrollTop || 0;
      var delta = lastScrollTop[area] === undefined ? 0 : Math.round(top - lastScrollTop[area]);
      lastScrollAt[area] = now;
      lastScrollTop[area] = top;
      noteInteraction();
      push('panel_scroll', { data: { area: area, scrollTop: Math.round(top), delta: delta, automated: automated } });
    }

    return {
      version: VERSION,
      streamId: streamId,
      attach: attach,
      attachTrial: attachTrial,
      setStage: setStage,
      setExecution: setExecution,
      setPlanVisibility: function (visible) { state.planVisible = Boolean(visible); },
      languageInitial: languageInitial,
      languageChange: languageChange,
      setTrial: function (trial) { state.trial = trial; },
      planShown: planShown,
      heartbeat: heartbeat,
      editorOpen: editorOpen,
      editorClose: editorClose,
      decision: decision,
      markAutoScroll: function (area) { autoScroll[area] = performance.now() + AUTO_SCROLL_WINDOW; },
      planning: function (action, outcome, part) { push('planning_interaction', { data: { action: action, outcome: outcome, part: part } }); },
      practice: function (step, correct) { push('practice_step', { data: { step: step, correct: Boolean(correct) } }); },
      transition: function () { flushSoon(0); },
      summary: function () {
        var snapshot = info();
        push('telemetry_summary', {
          data: {
            version: VERSION, queued: snapshot.queued, accepted: snapshot.accepted, rejected: snapshot.rejected,
            dropped: snapshot.dropped, storageOk: snapshot.storageOk, retries: snapshot.retries,
          },
        });
      },
      flush: drain,
      flushFinal: flushFinal,
      info: info,
      _activeVisibleMs: function () { accumulate(); return activeMs; },
    };
  }

  root.HLLTelemetry = { VERSION: VERSION, create: createTelemetry };
})(typeof window !== 'undefined' ? window : globalThis);
