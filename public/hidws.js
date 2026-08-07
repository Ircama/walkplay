/* =============================================================================
 * hidws.js — Remote WebHID provider + HID log panel for WalkPlay PEQ
 *
 * Adds an OPTIONAL "Remote" connection mode that talks to a `hidws` WebSocket
 * backend (https://github.com/Ircama/hidws) instead of (or in addition to)
 * WebHID, mirroring the remote transport of kt02h20-control / Audiocular-Aura /
 * fiiocontrol.
 *
 * When Remote mode is active, `navigator.hid` is transparently proxied so the
 * (prebuilt) WalkPlay app keeps working unchanged: requestDevice(), getDevices(),
 * open(), sendReport(), sendFeatureReport() and inputreport events are all
 * forwarded to the hidws backend over WebSocket. Local (USB / WebHID) mode
 * falls back to the browser's real WebHID API.
 *
 * UI injected into the dashboard top bar (between the "Connect" button and the
 * round user avatar) — with a floating fallback on other pages:
 *   - "hidws" button: toggles the remote-connection panel
 *       · Mode toggle: Local (WebHID)  |  Remote (hidws)
 *       · In Remote mode: backend URL, "List devices", device selector, status
 *       · "Connect via hidws": performs the whole remote connection (list -> open)
 *         and hands the device to the app (the app's own Connect flow then picks
 *         it up through the navigator.hid proxy).
 *   - "Log" button: opens a modal with the HID interaction log (TX/RX reports)
 *     of both local (WebHID) and remote (hidws) device sessions.
 *
 * Wire protocol (JSON over WebSocket, identical to hidws):
 *   C→S  {"cmd":"list"}
 *   C→S  {"cmd":"open","vendorId":N,"productId":N}
 *   C→S  {"cmd":"send_report","reportId":N,"data":[...]}
 *   C→S  {"cmd":"send_feature_report","reportId":N,"data":[...]}
 *   C→S  {"cmd":"close"}
 *   S→C  {"type":"device_list","devices":[...]}
 *   S→C  {"type":"opened","vendorId":N,"productId":N,"productName":"...",...}
 *   S→C  {"type":"input_report","reportId":N,"data":[...]}
 *   S→C  {"type":"error","message":"..."}
 *   S→C  {"type":"closed"}
 *
 * NOTES
 * - hidws forwards the raw hid_read buffer in input_report. For numbered input
 *   reports the first byte is the report ID; WebHID strips it. Set
 *   STRIP_INPUT_REPORT_ID below if the frontend expects WebHID-style buffers.
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__walkplayHidwsLoaded) return;
  window.__walkplayHidwsLoaded = true;

  /* ------------------------------------------------------------------ *
   * Configuration
   * ------------------------------------------------------------------ */
  var CONN_MODE_KEY = 'walkplay_conn_mode';        // 'local' | 'remote'
  var REMOTE_URL_KEY = 'walkplay_remote_url';
  var DEFAULT_REMOTE_URL = 'ws://localhost:9001';
  var STRIP_INPUT_REPORT_ID = true;                // match WebHID inputreport data
  var OPEN_TIMEOUT_MS = 5000;
  var MAX_LOG_ENTRIES = 2000;

  var REAL_HID = null;
  try { REAL_HID = navigator.hid; } catch (e) { REAL_HID = null; }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return new Uint8Array(data);
    return new Uint8Array(0);
  }

  function remoteSendJson(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  function hex(arr) {
    var a = Array.from(arr || []);
    return a.map(function (b) { return (b & 0xff).toString(16).padStart(2, '0'); }).join(' ');
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  /* ------------------------------------------------------------------ *
   * HID interaction log (local + remote)
   * ------------------------------------------------------------------ */
  var hidLog = [];
  function logHid(entry) {
    hidLog.push(entry);
    if (hidLog.length > MAX_LOG_ENTRIES) hidLog.splice(0, hidLog.length - MAX_LOG_ENTRIES);
    if (ui && ui.logBody) renderLog();
  }
  function logDeviceData(dev, dir, type, reportId, data) {
    var b = toBytes(data);
    logHid({ ts: Date.now(), dir: dir, type: type, reportId: reportId, data: hex(b), size: b.length, name: (dev && dev.productName) || 'device' });
  }
  function logDeviceEvent(dev, dir, type, reportId, dataView) {
    var b = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
    logHid({ ts: Date.now(), dir: dir, type: type, reportId: reportId, data: hex(b), size: b.length, name: (dev && dev.productName) || 'device' });
  }

  // Wrap a REAL WebHID device so sendReport / sendFeatureReport / inputreport
  // events are captured in the log while the app keeps using it unchanged.
  function wrapLocalDevice(dev) {
    if (!dev || dev.__wpLogged) return dev;
    var wrapped = new Proxy(dev, {
      get: function (target, prop) {
        var v = target[prop];
        if (prop === 'sendReport') {
          return function (reportId, data) {
            logDeviceData(target, 'TX', 'sendReport', reportId, data);
            return v.call(target, reportId, data);
          };
        }
        if (prop === 'sendFeatureReport') {
          return function (reportId, data) {
            logDeviceData(target, 'TX', 'sendFeatureReport', reportId, data);
            return v.call(target, reportId, data);
          };
        }
        if (prop === 'receiveFeatureReport') {
          return function () {
            return v.call(target).then(function (dataView) {
              if (dataView) logDeviceEvent(target, 'RX', 'receiveFeatureReport', 0, dataView);
              return dataView;
            });
          };
        }
        if (prop === 'addEventListener') {
          return function (type, handler, options) {
            if (type === 'inputreport' && typeof handler === 'function') {
              var wrappedHandler = function (ev) {
                logDeviceEvent(target, 'RX', 'inputreport', ev.reportId, ev.data);
                return handler(ev);
              };
              wrappedHandler.__wpOriginal = handler;
              return v.call(target, type, wrappedHandler, options);
            }
            return v.call(target, type, handler, options);
          };
        }
        if (prop === 'removeEventListener') {
          return function (type, handler) {
            if (type === 'inputreport' && handler && handler.__wpOriginal) {
              return v.call(target, type, handler.__wpOriginal);
            }
            return v.call(target, type, handler);
          };
        }
        if (typeof v === 'function') return v.bind(target);
        return v;
      },
      set: function (target, prop, value) {
        if (prop === 'oninputreport' && typeof value === 'function') {
          var wrapped = function (ev) {
            logDeviceEvent(target, 'RX', 'inputreport', ev.reportId, ev.data);
            return value(ev);
          };
          wrapped.__wpOriginal = value;
          target.oninputreport = wrapped;
          return true;
        }
        target[prop] = value;
        return true;
      },
    });
    wrapped.__wpLogged = true;
    return wrapped;
  }

  /* ------------------------------------------------------------------ *
   * RemoteHIDDevice — mimics the WebHID HIDDevice interface over the
   * hidws WebSocket, so the WalkPlay app treats it like a local device.
   * ------------------------------------------------------------------ */
  function RemoteHIDDevice(vendorId, productId, productName, ws) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.productName = productName || 'Remote device';
    this.collections = [];
    this.opened = true;
    this._ws = ws;
    this._handlers = new Map();       // 'inputreport' -> Set<{handler, once}>
    this.oninputreport = null;        // HIDDevice.oninputreport
  }

  RemoteHIDDevice.prototype.open = function () { this.opened = true; return Promise.resolve(); };

  RemoteHIDDevice.prototype.close = function () {
    this.opened = false;
    logHid({ ts: Date.now(), dir: '-', type: 'close', reportId: 0, data: '', size: 0, name: this.productName });
    remoteSendJson(this._ws, { cmd: 'close' });
    try { this._ws.close(); } catch (e) {}
    this._handlers.clear();
    this.oninputreport = null;
    return Promise.resolve();
  };

  RemoteHIDDevice.prototype.sendReport = function (reportId, data) {
    logDeviceData(this, 'TX', 'sendReport', reportId, data);
    remoteSendJson(this._ws, { cmd: 'send_report', reportId: reportId || 0, data: Array.from(toBytes(data)) });
    return Promise.resolve();
  };

  RemoteHIDDevice.prototype.sendFeatureReport = function (reportId, data) {
    logDeviceData(this, 'TX', 'sendFeatureReport', reportId, data);
    remoteSendJson(this._ws, { cmd: 'send_feature_report', reportId: reportId || 0, data: Array.from(toBytes(data)) });
    return Promise.resolve();
  };

  RemoteHIDDevice.prototype.receiveFeatureReport = function () {
    return Promise.resolve(new DataView(new ArrayBuffer(0)));
  };

  RemoteHIDDevice.prototype.addEventListener = function (type, handler, options) {
    if (type !== 'inputreport' || typeof handler !== 'function') return;
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add({ handler: handler, once: !!(options && options.once) });
  };

  RemoteHIDDevice.prototype.removeEventListener = function (type, handler) {
    if (type !== 'inputreport') return;
    var set = this._handlers.get(type);
    if (!set) return;
    set.forEach(function (h) { if (h.handler === handler) set.delete(h); });
  };

  RemoteHIDDevice.prototype._dispatchInputReport = function (reportId, rawData) {
    var bytes = toBytes(rawData);

    // hidws forwards the raw hid_read buffer; for numbered input reports the
    // first byte is the report-ID byte, which WebHID strips from inputreport.
    if (STRIP_INPUT_REPORT_ID && reportId > 0 && bytes.length > 0 && bytes[0] === reportId) {
      bytes = bytes.subarray(1);
    }

    var buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    var event = { reportId: reportId, data: new DataView(buffer) };
    logHid({ ts: Date.now(), dir: 'RX', type: 'inputreport', reportId: reportId, data: hex(bytes), size: bytes.length, name: this.productName });

    var set = this._handlers.get('inputreport');
    if (set) {
      set.forEach(function (h) {
        if (h.once) this.removeEventListener('inputreport', h.handler);
        try { h.handler(event); } catch (err) { console.error('[hidws] inputreport handler error:', err); }
      }, this);
    }
    if (typeof this.oninputreport === 'function') {
      try { this.oninputreport(event); } catch (err) { console.error('[hidws] oninputreport error:', err); }
    }
  };

  /* ------------------------------------------------------------------ *
   * Transport: list / open on the hidws backend
   * ------------------------------------------------------------------ */
  // Turn low-level WebSocket errors into actionable hints. The big one:
  // GitHub Pages is HTTPS, so the browser blocks an insecure `ws://` LAN URL
  // (mixed content) before any connection is attempted.
  function friendlyWsError(err, url) {
    var name = err && err.name;
    var msg = err && err.message ? String(err.message) : '';
    var insecure = name === 'SecurityError' || /insecure WebSocket/i.test(msg) || /mixed content/i.test(msg);
    if (insecure) {
      return 'Blocked by the browser (mixed content): this page is HTTPS but the backend URL "' + url + '" is not secure. ' +
        'Fix: use ws://localhost:9001 (backend on this PC) OR expose the backend over wss://, ' +
        'OR open this app from http://localhost (or an http:// server on the LAN) instead of the https:// GitHub Pages site.';
    }
    return msg || (name || 'WebSocket error');
  }

  function listRemoteDevices(url) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { reject(new Error(friendlyWsError(e, url))); return; }
      var timeout = setTimeout(function () { try { ws.close(); } catch (e) {} reject(new Error('Connection timeout')); }, OPEN_TIMEOUT_MS);

      ws.onopen = function () { clearTimeout(timeout); remoteSendJson(ws, { cmd: 'list' }); };
      ws.onmessage = function (ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'device_list') { try { ws.close(); } catch (e) {} resolve(msg.devices || []); }
          else if (msg.type === 'error') { try { ws.close(); } catch (e) {} reject(new Error(msg.message || 'Backend error')); }
        } catch (err) { try { ws.close(); } catch (e) {} reject(new Error('Invalid backend response')); }
      };
      ws.onerror = function () { clearTimeout(timeout); reject(new Error('WebSocket connection failed')); };
      ws.onclose = function () { clearTimeout(timeout); };
    });
  }

  function openRemoteDevice(url, vendorId, productId, onClosed) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { reject(new Error(friendlyWsError(e, url))); return; }
      var timeout = setTimeout(function () { try { ws.close(); } catch (e) {} reject(new Error('Connection timeout')); }, OPEN_TIMEOUT_MS);

      ws.onopen = function () {
        clearTimeout(timeout);
        remoteSendJson(ws, { cmd: 'open', vendorId: vendorId, productId: productId });
      };
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }
        if (msg.type === 'opened') {
          var dev = new RemoteHIDDevice(
            msg.vendorId !== undefined ? msg.vendorId : vendorId,
            msg.productId !== undefined ? msg.productId : productId,
            msg.productName || 'Remote device', ws);
          logHid({ ts: Date.now(), dir: '-', type: 'open', reportId: 0, data: '', size: 0, name: dev.productName });
          ws.onmessage = function (ev2) {
            var m;
            try { m = JSON.parse(ev2.data); } catch (err) { return; }
            if (m.type === 'input_report') dev._dispatchInputReport(m.reportId !== undefined ? m.reportId : 0, m.data || []);
            else if (m.type === 'closed') { dev.opened = false; try { ws.close(); } catch (e) {} onClosed && onClosed(); }
          };
          ws.onclose = function () { dev.opened = false; onClosed && onClosed(); };
          resolve(dev);
        } else if (msg.type === 'error') {
          try { ws.close(); } catch (e) {}
          reject(new Error(msg.message || 'Failed to open device'));
        }
      };
      ws.onerror = function () { clearTimeout(timeout); reject(new Error('WebSocket connection failed')); };
      ws.onclose = function () { clearTimeout(timeout); };
    });
  }

  /* ------------------------------------------------------------------ *
   * State + navigator.hid proxy
   * ------------------------------------------------------------------ */
  var state = {
    mode: (function () { try { return localStorage.getItem(CONN_MODE_KEY) === 'remote' ? 'remote' : 'local'; } catch (e) { return 'local'; } })(),
    url: (function () { try { return localStorage.getItem(REMOTE_URL_KEY) || DEFAULT_REMOTE_URL; } catch (e) { return DEFAULT_REMOTE_URL; } })(),
    remoteDevice: null,
    deviceList: [],
    selectedVid: null,
    selectedPid: null,
    disconnectHandlers: [],
  };

  function setMode(mode) {
    state.mode = mode === 'remote' ? 'remote' : 'local';
    try { localStorage.setItem(CONN_MODE_KEY, state.mode); } catch (e) {}
    syncModeUI();
  }

  function onRemoteClosed() {
    state.remoteDevice = null;
    var ev = { device: state.remoteDevice };
    state.disconnectHandlers.forEach(function (h) {
      try { h(ev); } catch (e) { console.error('[hidws] disconnect handler error:', e); }
    });
    state.disconnectHandlers = [];
    syncModeUI();
  }

  var hidProxy = {
    requestDevice: function (options) {
      if (state.mode !== 'remote') {
        if (!REAL_HID) return Promise.reject(new Error('WebHID is not supported by this browser (local mode). Use a Chromium browser or switch to Remote mode.'));
        return REAL_HID.requestDevice(options || {}).then(function (devices) {
          return devices.map(wrapLocalDevice);
        });
      }

      // ---- Remote mode ----
      if (state.remoteDevice) return Promise.resolve([state.remoteDevice]);

      var url = state.url;
      return listRemoteDevices(url).then(function (devices) {
        if (!devices.length) { setStatus('No remote devices found', 'error'); return []; }
        var list = devices;
        if (options && options.filters && options.filters.length) {
          list = devices.filter(function (d) {
            return options.filters.some(function (f) {
              return (f.vendorId === undefined || f.vendorId === d.vendorId) &&
                     (f.productId === undefined || f.productId === d.productId);
            });
          });
        }
        if (!list.length) { setStatus('No matching remote device', 'error'); return []; }

        // Prefer the device selected in the panel, else the first match.
        var target = list[0];
        if (state.selectedVid != null) {
          for (var i = 0; i < list.length; i++) {
            if (list[i].vendorId === state.selectedVid && list[i].productId === state.selectedPid) { target = list[i]; break; }
          }
        }
        setStatus('Opening ' + target.productName + '\u2026', 'working');
        return openRemoteDevice(url, target.vendorId, target.productId, onRemoteClosed).then(function (dev) {
          state.remoteDevice = dev;
          setStatus('Connected: ' + dev.productName, 'ok');
          syncModeUI();
          return [dev];
        });
      });
    },

    getDevices: function () {
      if (state.mode === 'remote') return Promise.resolve(state.remoteDevice ? [state.remoteDevice] : []);
      if (!REAL_HID) return Promise.resolve([]);
      return REAL_HID.getDevices().then(function (devices) {
        return devices.map(wrapLocalDevice);
      });
    },

    addEventListener: function (type, handler, options) {
      if (type !== 'disconnect' || typeof handler !== 'function') return;
      state.disconnectHandlers.push(handler);
    },

    removeEventListener: function (type, handler) {
      if (type !== 'disconnect') return;
      state.disconnectHandlers = state.disconnectHandlers.filter(function (h) { return h !== handler; });
    },

    ondisconnect: null,
  };

  // Install the proxy so the app sees our remote-capable navigator.hid.
  function installProxy() {
    try {
      Object.defineProperty(navigator, 'hid', {
        configurable: true,
        get: function () { return hidProxy; },
      });
      return true;
    } catch (e) {
      try {
        Object.defineProperty(Navigator.prototype, 'hid', {
          configurable: true,
          get: function () { return hidProxy; },
        });
        return true;
      } catch (e2) {
        console.error('[hidws] Could not override navigator.hid:', e2);
        return false;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * UI: top-bar buttons, connection panel, log modal
   * ------------------------------------------------------------------ */
  var ui = null;                 // injected elements
  var panelOpen = false;
  var logOpen = false;

  function setStatus(text, kind) {
    if (!ui) return;
    ui.statusEl.textContent = text;
    ui.statusEl.className = 'wp-hidws-status wp-hidws-' + (kind || 'idle');
  }

  function makeElement(tag, attrs, text) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function buildPanel() {
    // --- Panel container (dropdown) ---
    var panel = makeElement('div', { id: 'wp-hidws-panel' }, '');
    panel.style.display = 'none';

    var header = makeElement('div', { class: 'wp-hidws-header' }, '');
    var title = makeElement('span', {}, 'hidws Remote Connection');
    var closeBtn = makeElement('button', { type: 'button', class: 'wp-hidws-close', title: 'Close' }, '\u2715');
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    var modeRow = makeElement('div', { class: 'wp-hidws-mode' }, '');
    var modeLabel = makeElement('span', { class: 'wp-hidws-mode-label' }, 'Mode:');
    var localLabel = makeElement('label', { class: 'wp-hidws-radio' }, '');
    var localRadio = makeElement('input', { type: 'radio', name: 'wp-hidws-mode', value: 'local' }, '');
    localLabel.appendChild(localRadio);
    localLabel.appendChild(document.createTextNode(' Local (WebHID)'));
    var remoteLabel = makeElement('label', { class: 'wp-hidws-radio' }, '');
    var remoteRadio = makeElement('input', { type: 'radio', name: 'wp-hidws-mode', value: 'remote' }, '');
    remoteLabel.appendChild(remoteRadio);
    remoteLabel.appendChild(document.createTextNode(' Remote (hidws)'));
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(localLabel);
    modeRow.appendChild(remoteLabel);
    panel.appendChild(modeRow);

    var cfg = makeElement('div', { class: 'wp-hidws-config' }, '');

    var urlRow = makeElement('div', { class: 'wp-hidws-row' }, '');
    var urlInput = makeElement('input', { type: 'text', class: 'wp-hidws-url', spellcheck: 'false', placeholder: 'ws://host:9001' }, '');
    urlInput.value = state.url;
    var listBtn = makeElement('button', { type: 'button', class: 'wp-hidws-btn wp-hidws-list' }, 'List devices');
    urlRow.appendChild(urlInput);
    urlRow.appendChild(listBtn);

    var selRow = makeElement('div', { class: 'wp-hidws-row' }, '');
    var sel = makeElement('select', { class: 'wp-hidws-select' }, '');
    selRow.appendChild(sel);

    var statusEl = makeElement('div', { class: 'wp-hidws-status wp-hidws-idle' }, '');

    var connectBtn = makeElement('button', { type: 'button', class: 'wp-hidws-btn wp-hidws-connect' }, 'Connect via hidws');
    var disconnectBtn = makeElement('button', { type: 'button', class: 'wp-hidws-btn wp-hidws-disconnect', style: 'display:none' }, 'Disconnect');

    cfg.appendChild(urlRow);
    cfg.appendChild(selRow);
    cfg.appendChild(statusEl);
    cfg.appendChild(connectBtn);
    cfg.appendChild(disconnectBtn);
    panel.appendChild(cfg);

    document.body.appendChild(panel);

    ui = ui || {};
    Object.assign(ui, {
      panel: panel,
      closeBtn: closeBtn,
      localRadio: localRadio,
      remoteRadio: remoteRadio,
      cfg: cfg,
      urlInput: urlInput,
      listBtn: listBtn,
      sel: sel,
      statusEl: statusEl,
      connectBtn: connectBtn,
      disconnectBtn: disconnectBtn,
    });

    // --- Events ---
    closeBtn.addEventListener('click', function () { setPanelOpen(false); });
    localRadio.addEventListener('change', function () { if (localRadio.checked) setMode('local'); });
    remoteRadio.addEventListener('change', function () { if (remoteRadio.checked) setMode('remote'); });

    urlInput.addEventListener('change', function () {
      var v = (urlInput.value || '').trim() || DEFAULT_REMOTE_URL;
      state.url = v; urlInput.value = v;
      try { localStorage.setItem(REMOTE_URL_KEY, v); } catch (e) {}
    });

    listBtn.addEventListener('click', async function () {
      var url = (urlInput.value || '').trim() || DEFAULT_REMOTE_URL;
      state.url = url;
      try { localStorage.setItem(REMOTE_URL_KEY, url); } catch (e) {}
      setStatus('Listing devices\u2026', 'working');
      listBtn.disabled = true;
      try {
        var devices = await listRemoteDevices(url);
        state.deviceList = devices;
        sel.innerHTML = '';
        if (!devices.length) {
          sel.appendChild(makeElement('option', {}, 'No devices found'));
          state.selectedVid = state.selectedPid = null;
          setStatus('No devices found on the backend.', 'error');
        } else {
          devices.forEach(function (d) {
            sel.appendChild(makeElement('option', { value: d.vendorId + ':' + d.productId },
              (d.productName || 'HID device') + ' (' + (d.vendorId ? '0x' + d.vendorId.toString(16) : '?') + ':' + (d.productId ? '0x' + d.productId.toString(16) : '?') + ')'));
          });
          state.selectedVid = devices[0].vendorId;
          state.selectedPid = devices[0].productId;
          setStatus(devices.length + ' device(s) found \u2014 pick one and press Connect via hidws.', 'ok');
        }
      } catch (err) {
        setStatus('List failed: ' + err.message, 'error');
      } finally {
        listBtn.disabled = false;
      }
    });

    sel.addEventListener('change', function () {
      var parts = (sel.value || '').split(':');
      state.selectedVid = parts[0] !== undefined && parts[0] !== '' ? Number(parts[0]) : null;
      state.selectedPid = parts[1] !== undefined && parts[1] !== '' ? Number(parts[1]) : null;
    });

    // Connect via hidws: full remote connection, then hand the device to the app.
    connectBtn.addEventListener('click', async function () {
      var url = (urlInput.value || '').trim() || DEFAULT_REMOTE_URL;
      state.url = url;
      try { localStorage.setItem(REMOTE_URL_KEY, url); } catch (e) {}
      setMode('remote');
      connectBtn.disabled = true;
      setStatus('Connecting via hidws\u2026', 'working');
      try {
        var vid = state.selectedVid;
        var pid = state.selectedPid;
        var devices = state.deviceList;
        if (!devices.length) {
          devices = await listRemoteDevices(url);
          state.deviceList = devices;
        }
        if (!devices.length) { setStatus('No devices found on the backend.', 'error'); return; }
        if (vid == null) {
          // Prefer a WalkPlay device (vendor 0x0666 / product 0x0888) if present.
          var wp = devices.filter(function (d) { return d.vendorId === 1638 && d.productId === 2184; })[0];
          vid = wp ? wp.vendorId : devices[0].vendorId;
          pid = wp ? wp.productId : devices[0].productId;
        }
        var dev = await openRemoteDevice(url, vid, pid, onRemoteClosed);
        state.remoteDevice = dev;
        setStatus('Connected: ' + dev.productName, 'ok');
        syncModeUI();
        // Let the app pick the device up: clicking the app's own Connect button
        // triggers navigator.hid.requestDevice()/getDevices(), which the proxy
        // satisfies with the remote device.
        var appBtn = findAppConnectButton();
        if (appBtn) {
          try { appBtn.click(); } catch (e) { console.error('[hidws] app connect click error:', e); }
        }
      } catch (err) {
        setStatus('Connect failed: ' + err.message, 'error');
      } finally {
        connectBtn.disabled = false;
      }
    });

    disconnectBtn.addEventListener('click', function () {
      if (state.remoteDevice) {
        try { state.remoteDevice.close(); } catch (e) {}
        state.remoteDevice = null;
        onRemoteClosed();
        setStatus('Disconnected.', 'idle');
      }
      syncModeUI();
    });

    syncModeUI();
  }

  function buildLogModal() {
    var overlay = makeElement('div', { id: 'wp-hidws-log-overlay' }, '');
    overlay.style.display = 'none';

    var modal = makeElement('div', { class: 'wp-hidws-log-modal' }, '');

    var header = makeElement('div', { class: 'wp-hidws-log-header' }, '');
    var title = makeElement('span', {}, 'HID Interaction Log');
    var count = makeElement('span', { class: 'wp-hidws-log-count' }, '');
    var btnRow = makeElement('div', { class: 'wp-hidws-log-btns' }, '');
    var clearBtn = makeElement('button', { type: 'button', class: 'wp-hidws-btn wp-hidws-log-clear' }, 'Clear');
    var copyBtn = makeElement('button', { type: 'button', class: 'wp-hidws-btn wp-hidws-log-copy' }, 'Copy');
    var closeBtn = makeElement('button', { type: 'button', class: 'wp-hidws-btn wp-hidws-log-close' }, 'Close');
    btnRow.appendChild(clearBtn);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(btnRow);
    modal.appendChild(header);

    var body = makeElement('div', { class: 'wp-hidws-log-body' }, '');
    modal.appendChild(body);

    var footer = makeElement('div', { class: 'wp-hidws-log-footer' }, '');
    footer.appendChild(makeElement('span', {}, 'Captures TX/RX HID reports for both local (WebHID) and remote (hidws) sessions.'));
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    ui = ui || {};
    Object.assign(ui, { logOverlay: overlay, logBody: body, logCount: count, logFooter: footer });

    clearBtn.addEventListener('click', function () {
      hidLog = [];
      renderLog();
    });
    copyBtn.addEventListener('click', function () {
      var text = hidLog.map(function (e) {
        return fmtTime(e.ts) + '  ' + e.dir + '  ' + e.type + '  rpt=' + e.reportId + '  len=' + e.size + '  ' + e.data + '  [' + e.name + ']';
      }).join('\n');
      try { navigator.clipboard.writeText(text); setLogFooter('Copied ' + hidLog.length + ' entries.'); } catch (err) { setLogFooter('Copy failed: ' + err.message); }
    });
    closeBtn.addEventListener('click', function () { setLogOpen(false); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) setLogOpen(false); });
  }

  function renderLog() {
    if (!ui || !ui.logBody) return;
    var body = ui.logBody;
    body.innerHTML = '';
    if (!hidLog.length) {
      body.appendChild(makeElement('div', { class: 'wp-hidws-log-empty' }, 'No HID interactions recorded yet.'));
    } else {
      var table = makeElement('table', { class: 'wp-hidws-log-table' }, '');
      var thead = makeElement('thead', {}, '');
      var hr = makeElement('tr', {}, '');
      ['Time', 'Dir', 'Type', 'Report', 'Len', 'Data (hex)', 'Device'].forEach(function (h) {
        hr.appendChild(makeElement('th', {}, h));
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = makeElement('tbody', {}, '');
      var shown = hidLog.slice(-500);
      for (var i = 0; i < shown.length; i++) {
        var e = shown[i];
        var tr = makeElement('tr', {}, '');
        tr.appendChild(makeElement('td', {}, fmtTime(e.ts)));
        tr.appendChild(makeElement('td', { class: 'wp-hidws-log-dir-' + (e.dir === 'RX' ? 'rx' : (e.dir === 'TX' ? 'tx' : 'info')) }, e.dir));
        tr.appendChild(makeElement('td', {}, e.type));
        tr.appendChild(makeElement('td', {}, String(e.reportId)));
        tr.appendChild(makeElement('td', {}, String(e.size)));
        tr.appendChild(makeElement('td', { class: 'wp-hidws-log-data' }, e.data));
        tr.appendChild(makeElement('td', {}, e.name));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      body.appendChild(table);
    }
    if (ui.logCount) ui.logCount.textContent = hidLog.length + ' entries';
  }

  function setLogFooter(text) {
    if (ui && ui.logFooter) ui.logFooter.textContent = text;
  }

  function setPanelOpen(open) {
    panelOpen = !!open;
    if (ui && ui.panel) ui.panel.style.display = panelOpen ? 'block' : 'none';
    if (ui && ui.panelBtn) ui.panelBtn.classList.toggle('wp-hidws-active', panelOpen);
  }

  function setLogOpen(open) {
    logOpen = !!open;
    if (ui && ui.logOverlay) ui.logOverlay.style.display = logOpen ? 'flex' : 'none';
    if (logOpen) renderLog();
    if (ui && ui.logBtn) ui.logBtn.classList.toggle('wp-hidws-active', logOpen);
  }

  // Find the app's "Connect" button (dashboard top bar / upgrade page).
  function findAppConnectButton() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var txt = (buttons[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (txt === 'Connect' || txt === '连接' || txt === '连接设备' || txt === 'Connect device') return buttons[i];
    }
    return null;
  }

  // Find the dashboard top-right bar container.
  function findTopRight() {
    var topRight = document.querySelector('.head .top-right');
    if (topRight) return topRight;
    // Fallback: any element containing the connect button and avatar
    var connect = document.querySelector('.connect-btn');
    if (connect && connect.parentElement) return connect.parentElement;
    return null;
  }

  // Inject the hidws + Log buttons into the top bar (between connect-btn and avatar-img).
  function ensureTopBarButtons() {
    var topRight = findTopRight();
    var panelBtn = document.getElementById('wp-hidws-top-fab');
    var logBtn = document.getElementById('wp-hidws-log-fab');
    var fab = document.getElementById('wp-hidws-fab');

    if (!topRight) {
      // No dashboard header: show the floating fallback button(s).
      if (fab && fab.style.display !== 'flex') fab.style.display = 'flex';
      return;
    }

    // Hide the floating fallback when the header is present.
    if (fab) fab.style.display = 'none';

    if (!panelBtn) {
      panelBtn = makeElement('button', { type: 'button', id: 'wp-hidws-top-fab', title: 'hidws remote connection' }, 'hidws');
      panelBtn.addEventListener('click', function () { setPanelOpen(!panelOpen); });
    }
    if (!logBtn) {
      logBtn = makeElement('button', { type: 'button', id: 'wp-hidws-log-fab', title: 'HID interaction log' }, 'Log');
      logBtn.addEventListener('click', function () { setLogOpen(!logOpen); });
    }

    var connectBtn = topRight.querySelector('.connect-btn');
    var avatar = topRight.querySelector('.avatar-img');

    // Insert panelBtn + logBtn between connect-btn and avatar-img.
    if (avatar) {
      if (panelBtn.parentElement !== topRight || panelBtn.nextElementSibling !== logBtn) {
        topRight.insertBefore(panelBtn, avatar);
        topRight.insertBefore(logBtn, avatar);
      }
    } else if (connectBtn) {
      if (panelBtn.parentElement !== topRight || panelBtn.nextElementSibling !== logBtn) {
        topRight.insertBefore(panelBtn, connectBtn.nextSibling);
        topRight.insertBefore(logBtn, connectBtn.nextSibling);
      }
    } else {
      topRight.appendChild(panelBtn);
      topRight.appendChild(logBtn);
    }

    ui = ui || {};
    Object.assign(ui, { topRight: topRight, panelBtn: panelBtn, logBtn: logBtn });

    // The app's round User button no longer opens the (portal-account) person
    // center — make it show a short local notice instead of doing nothing.
    ensureUserNotice();
  }

  var userNoticeTimer = null;
  function ensureUserNotice() {
    var avatar = document.querySelector('.head .avatar-img');
    if (!avatar || avatar.__wpNotice) return;
    avatar.__wpNotice = true;
    avatar.style.cursor = 'pointer';
    avatar.addEventListener('click', function () {
      var notice = document.getElementById('wp-hidws-user-notice');
      if (!notice) {
        notice = makeElement('div', { id: 'wp-hidws-user-notice' }, 'Local mode \u2014 no account needed. (hidws / Log controls above)');
        document.body.appendChild(notice);
        ui = ui || {};
        ui.userNotice = notice;
      }
      notice.style.opacity = '1';
      notice.style.transform = 'translateY(0)';
      clearTimeout(userNoticeTimer);
      userNoticeTimer = setTimeout(function () {
        notice.style.opacity = '0';
        notice.style.transform = 'translateY(-6px)';
      }, 2500);
    });
  }

  // Floating fallback button (non-dashboard pages).
  function ensureFloatingFallback() {
    var fab = document.getElementById('wp-hidws-fab');
    if (fab) return;
    fab = makeElement('button', { type: 'button', id: 'wp-hidws-fab', title: 'hidws remote connection' }, 'hidws');
    fab.addEventListener('click', function () { setPanelOpen(!panelOpen); });
    document.body.appendChild(fab);
    ui = ui || {};
    ui.fab = fab;
  }

  /* Styling for the injected elements (dark theme, matches the WalkPlay app) */
  var style = document.createElement('style');
  style.textContent = [
    // --- top bar buttons ---
    '#wp-hidws-top-fab, #wp-hidws-log-fab { display:inline-flex !important; align-items:center !important; justify-content:center !important; height:32px !important; min-width:44px !important; padding:0 10px !important; margin:0 0 0 8px !important; font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif !important; color:#fff !important; background:#2a2a2a !important; border:1px solid #3a3a3a !important; border-radius:16px !important; cursor:pointer !important; user-select:none !important; white-space:nowrap !important; }',
    '#wp-hidws-top-fab:hover, #wp-hidws-log-fab:hover { filter:brightness(1.15) !important; }',
    '#wp-hidws-top-fab.wp-hidws-active, #wp-hidws-log-fab.wp-hidws-active { background:#1668dc !important; border-color:#1668dc !important; }',
    '.head .top-right { align-items:center !important; }',
    // --- floating fallback ---
    '#wp-hidws-fab { position:fixed !important; right:18px !important; bottom:18px !important; z-index:2147483000 !important; display:inline-flex !important; align-items:center !important; padding:9px 15px !important; font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif !important; color:#fff !important; background:#1668dc !important; border:none !important; border-radius:20px !important; cursor:pointer !important; box-shadow:0 4px 14px rgba(0,0,0,.35) !important; user-select:none !important; }',
    '#wp-hidws-fab:hover { filter:brightness(1.1) !important; }',
    // --- connection panel ---
    '#wp-hidws-panel { position:fixed !important; right:18px !important; top:70px !important; z-index:2147483001 !important; width:300px !important; max-width:calc(100vw - 24px) !important; background:#1f1f1f !important; color:#e5eaf3 !important; border:1px solid #3a3a3a !important; border-radius:10px !important; box-shadow:0 10px 30px rgba(0,0,0,.5) !important; padding:12px !important; font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif !important; }',
    '.wp-hidws-header { display:flex !important; align-items:center !important; justify-content:space-between !important; margin-bottom:10px !important; }',
    '.wp-hidws-header > span { font-weight:600 !important; font-size:13px !important; }',
    '.wp-hidws-close { background:none !important; border:none !important; color:#909399 !important; font-size:14px !important; cursor:pointer !important; padding:2px 4px !important; }',
    '.wp-hidws-mode { display:flex !important; gap:10px !important; align-items:center !important; margin-bottom:10px !important; flex-wrap:wrap !important; }',
    '.wp-hidws-mode-label { color:#909399 !important; }',
    '.wp-hidws-radio { display:inline-flex !important; align-items:center !important; gap:4px !important; cursor:pointer !important; }',
    '.wp-hidws-config { display:none; flex-direction:column !important; gap:8px !important; }',
    '.wp-hidws-config.wp-hidws-open { display:flex; }',
    '.wp-hidws-row { display:flex !important; gap:6px !important; align-items:center !important; }',
    '.wp-hidws-url { flex:1 !important; min-width:0 !important; height:30px !important; border:1px solid #3a3a3a !important; border-radius:6px !important; background:#141414 !important; color:#e5eaf3 !important; padding:0 8px !important; font-size:12px !important; }',
    '.wp-hidws-select { flex:1 !important; min-width:0 !important; height:30px !important; border:1px solid #3a3a3a !important; border-radius:6px !important; background:#141414 !important; color:#e5eaf3 !important; padding:0 6px !important; font-size:12px !important; }',
    '.wp-hidws-btn { height:30px !important; padding:0 12px !important; border-radius:6px !important; border:none !important; font:600 12px/1 system-ui,sans-serif !important; cursor:pointer !important; }',
    '.wp-hidws-list { background:#2b2b2b !important; color:#e5eaf3 !important; border:1px solid #3a3a3a !important; }',
    '.wp-hidws-connect { background:#1668dc !important; color:#fff !important; width:100% !important; height:34px !important; }',
    '.wp-hidws-connect:hover { filter:brightness(1.1) !important; }',
    '.wp-hidws-connect:disabled { opacity:.6 !important; cursor:not-allowed !important; }',
    '.wp-hidws-disconnect { background:#b3273a !important; color:#fff !important; width:100% !important; height:34px !important; }',
    '.wp-hidws-status { font-size:12px !important; min-height:14px !important; word-break:break-word !important; color:#909399 !important; }',
    '.wp-hidws-status.wp-hidws-working { color:#e6a23c !important; }',
    '.wp-hidws-status.wp-hidws-ok { color:#67c23a !important; }',
    '.wp-hidws-status.wp-hidws-error { color:#f56c6c !important; }',
    // --- log modal ---
    '#wp-hidws-log-overlay { position:fixed !important; inset:0 !important; z-index:2147483002 !important; background:rgba(0,0,0,.6) !important; display:flex !important; align-items:center !important; justify-content:center !important; padding:24px !important; }',
    '.wp-hidws-log-modal { background:#1f1f1f !important; color:#e5eaf3 !important; border:1px solid #3a3a3a !important; border-radius:10px !important; box-shadow:0 10px 30px rgba(0,0,0,.5) !important; width:min(1100px, 100%) !important; max-height:90vh !important; display:flex !important; flex-direction:column !important; font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif !important; }',
    '.wp-hidws-log-header { display:flex !important; align-items:center !important; gap:12px !important; padding:12px 14px !important; border-bottom:1px solid #3a3a3a !important; }',
    '.wp-hidws-log-header > span:first-child { font-weight:600 !important; }',
    '.wp-hidws-log-count { color:#909399 !important; font-size:12px !important; }',
    '.wp-hidws-log-btns { margin-left:auto !important; display:flex !important; gap:8px !important; }',
    '.wp-hidws-log-clear { background:#2b2b2b !important; color:#e5eaf3 !important; border:1px solid #3a3a3a !important; }',
    '.wp-hidws-log-copy { background:#2b2b2b !important; color:#e5eaf3 !important; border:1px solid #3a3a3a !important; }',
    '.wp-hidws-log-close { background:#b3273a !important; color:#fff !important; }',
    '.wp-hidws-log-body { flex:1 !important; overflow:auto !important; padding:10px 14px !important; min-height:200px !important; }',
    '.wp-hidws-log-empty { color:#909399 !important; text-align:center !important; padding:40px 0 !important; }',
    '.wp-hidws-log-table { width:100% !important; border-collapse:collapse !important; font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace !important; }',
    '.wp-hidws-log-table th, .wp-hidws-log-table td { text-align:left !important; padding:4px 8px !important; border-bottom:1px solid #2a2a2a !important; white-space:nowrap !important; }',
    '.wp-hidws-log-table th { color:#909399 !important; font-weight:600 !important; position:sticky !important; top:0 !important; background:#1f1f1f !important; }',
    '.wp-hidws-log-table td.wp-hidws-log-data { word-break:break-all !important; white-space:normal !important; }',
    '.wp-hidws-log-dir-TX { color:#67c23a !important; font-weight:600 !important; }',
    '.wp-hidws-log-dir-RX { color:#e6a23c !important; font-weight:600 !important; }',
    '.wp-hidws-log-dir-info { color:#909399 !important; }',
    '.wp-hidws-log-footer { padding:8px 14px !important; border-top:1px solid #3a3a3a !important; color:#909399 !important; font-size:12px !important; min-height:14px !important; }',
    // --- user (avatar) local notice toast ---
    '#wp-hidws-user-notice { position:fixed !important; top:64px !important; right:20px !important; z-index:2147483003 !important; background:#1f1f1f !important; color:#e5eaf3 !important; border:1px solid #3a3a3a !important; border-radius:8px !important; padding:10px 14px !important; font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif !important; box-shadow:0 6px 20px rgba(0,0,0,.45) !important; opacity:0 !important; transform:translateY(-6px) !important; transition:opacity .25s ease, transform .25s ease !important; pointer-events:none !important; }',
  ].join('\n');
  document.head.appendChild(style);

  // Install proxy BEFORE the app bundle runs.
  installProxy();

  // Build UI once the body exists, then watch for the dashboard header.
  var started = false;
  function startUI() {
    if (started) return;
    if (!document.body) { setTimeout(startUI, 50); return; }
    started = true;
    buildPanel();
    buildLogModal();
    ensureFloatingFallback();
    ensureTopBarButtons();

    var lastTopRight = null;
    setInterval(function () {
      var topRight = findTopRight();
      if (topRight !== lastTopRight) {
        lastTopRight = topRight;
        ensureTopBarButtons();
        if (topRight) { if (ui && ui.fab) ui.fab.style.display = 'none'; }
        else if (ui && ui.fab) ui.fab.style.display = 'flex';
      }
    }, 800);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startUI);
  } else {
    startUI();
  }

  function syncModeUI() {
    if (!ui) return;
    var remote = state.mode === 'remote';
    if (ui.localRadio) ui.localRadio.checked = !remote;
    if (ui.remoteRadio) ui.remoteRadio.checked = remote;
    if (ui.cfg) ui.cfg.classList.toggle('wp-hidws-open', remote);
    if (ui.urlInput) ui.urlInput.value = state.url;
    var connected = !!state.remoteDevice;
    if (ui.connectBtn) ui.connectBtn.style.display = connected ? 'none' : 'block';
    if (ui.disconnectBtn) ui.disconnectBtn.style.display = connected ? 'block' : 'none';
    if (connected && ui.sel) {
      ui.sel.innerHTML = '';
      ui.sel.appendChild(makeElement('option', {}, state.remoteDevice.productName || 'Connected device'));
      setStatus('Connected: ' + (state.remoteDevice.productName || 'Remote device'), 'ok');
    } else if (remote && ui.statusEl) {
      setStatus('Remote mode \u2014 pick a device and press Connect via hidws.', 'idle');
    }
  }

  // Expose a small debug handle.
  window.__walkplayHidws = { state: state, hidProxy: hidProxy, listRemoteDevices: listRemoteDevices, openRemoteDevice: openRemoteDevice, syncModeUI: syncModeUI, getLog: function () { return hidLog.slice(); }, clearLog: function () { hidLog = []; renderLog(); } };
})();
