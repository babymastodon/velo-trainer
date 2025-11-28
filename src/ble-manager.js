// --------------------------- BLE singleton ---------------------------

export const BleManager = (() => {
  // Local constants (self-contained – these shadow the globals safely)
  const FTMS_SERVICE_UUID = 0x1826;
  const HEART_RATE_SERVICE_UUID = 0x180d;
  const BATTERY_SERVICE_UUID = 0x180f;

  const INDOOR_BIKE_DATA_CHAR = 0x2ad2;
  const FTMS_CONTROL_POINT_CHAR = 0x2ad9;
  const HR_MEASUREMENT_CHAR = 0x2a37;
  const BATTERY_LEVEL_CHAR = 0x2a19;

  const FTMS_OPCODES = {
    requestControl: 0x00,
    reset: 0x01,
    setTargetSpeed: 0x02,
    setTargetInclination: 0x03,
    setTargetResistanceLevel: 0x04,
    setTargetPower: 0x05,
    setTargetHeartRate: 0x06,
    startOrResume: 0x07,
    stopOrPause: 0x08,
  };

  const TRAINER_SEND_MIN_INTERVAL_SEC = 10;
  const STORAGE_LAST_BIKE_DEVICE_ID = "lastBikeDeviceId";
  const STORAGE_LAST_HR_DEVICE_ID = "lastHrDeviceId";

  const MIN_RECONNECT_DELAY_MS = 1000;  // 1s
  const MAX_RECONNECT_DELAY_MS = 10000; // cap at 10s

  // Simple event system
  const listeners = {
    log: new Set(),
    bikeStatus: new Set(),
    hrStatus: new Set(),
    bikeSample: new Set(),
    hrSample: new Set(),
    hrBattery: new Set(),
  };

  function emit(type, payload) {
    const set = listeners[type];
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error("[BleManager] listener error for", type, err);
      }
    }
  }

  function log(msg) {
    // Forward to workout logger if available
    emit("log", msg);
  }

  // ---------------------------------------------------------------------------
  // Internal device state
  // ---------------------------------------------------------------------------

  const bikeState = {
    device: null,
    server: null,
    ftmsService: null,
    indoorBikeDataChar: null,
    controlPointChar: null,
    _disconnectHandler: null,
  };

  const hrState = {
    device: null,
    server: null,
    hrService: null,
    measurementChar: null,
    batteryService: null,
    _disconnectHandler: null,
  };

  // Desired / preferred devices (the IDs we *want* to be connected to)
  let bikeDesiredDeviceId = null;
  let hrDesiredDeviceId = null;

  // Known device objects by ID (from getDevices or requestDevice)
  const bikeKnownDevices = new Map(); // id -> BluetoothDevice
  const hrKnownDevices = new Map();   // id -> BluetoothDevice

  // Auto-reconnect timers & delays
  let bikeAutoReconnectTimerId = null;
  let hrAutoReconnectTimerId = null;

  let bikeAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;
  let hrAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;

  // Connection flags (internal)
  let bikeConnected = false;
  let hrConnected = false;

  // Suppress auto-reconnect once (for manual disconnects)
  let bikeSuppressAutoReconnectOnce = false;
  let hrSuppressAutoReconnectOnce = false;

  // Global auto-reconnect enable flag
  let autoReconnectEnabled = true;

  function updateBikeStatus(state) {
    bikeConnected = state === "connected";
    emit("bikeStatus", state);
  }

  function updateHrStatus(state) {
    hrConnected = state === "connected";
    emit("hrStatus", state);
  }

  // Last samples & battery
  let lastBikeSample = {
    power: null,
    cadence: null,
    speedKph: null,
    hrFromBike: null,
  };

  let hrBatteryPercent = null;

  // Trainer throttling
  let lastTrainerMode = null; // "erg" | "resistance" | null
  let lastErgTargetSent = null;
  let lastResistanceSent = null;
  let lastErgSendTs = 0;
  let lastResistanceSendTs = 0;

  function nowSec() {
    return performance.now() / 1000;
  }

  // ---------------------------------------------------------------------------
  // Storage helpers for device IDs
  // ---------------------------------------------------------------------------

  function loadSavedBleDeviceIds() {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) {
          resolve({bikeId: null, hrId: null});
          return;
        }
      } catch {
        resolve({bikeId: null, hrId: null});
        return;
      }

      chrome.storage.local.get(
        {
          [STORAGE_LAST_BIKE_DEVICE_ID]: null,
          [STORAGE_LAST_HR_DEVICE_ID]: null,
        },
        (data) => {
          resolve({
            bikeId: data[STORAGE_LAST_BIKE_DEVICE_ID],
            hrId: data[STORAGE_LAST_HR_DEVICE_ID],
          });
        }
      );
    });
  }

  function saveBikeDeviceId(id) {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set({[STORAGE_LAST_BIKE_DEVICE_ID]: id});
    } catch {}
  }

  function saveHrDeviceId(id) {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set({[STORAGE_LAST_HR_DEVICE_ID]: id});
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Auto-reconnect scheduling (per-device, exponential backoff)
  // ---------------------------------------------------------------------------

  function cancelBikeAutoReconnect() {
    if (bikeAutoReconnectTimerId != null) {
      clearTimeout(bikeAutoReconnectTimerId);
      bikeAutoReconnectTimerId = null;
      log("Bike auto-reconnect cancelled.");
    }
  }

  function cancelHrAutoReconnect() {
    if (hrAutoReconnectTimerId != null) {
      clearTimeout(hrAutoReconnectTimerId);
      hrAutoReconnectTimerId = null;
      log("HR auto-reconnect cancelled.");
    }
  }

  function scheduleBikeAutoReconnect(resetDelay = false) {
    if (!autoReconnectEnabled) return;
    if (!bikeDesiredDeviceId) return;

    const device = bikeKnownDevices.get(bikeDesiredDeviceId);
    if (!device) {
      log(
        "Bike auto-reconnect skipped: desired device not known in bikeKnownDevices."
      );
      return;
    }

    if (bikeConnected) return;

    if (resetDelay || !bikeAutoReconnectDelayMs) {
      bikeAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;
    }

    cancelBikeAutoReconnect();

    bikeAutoReconnectTimerId = setTimeout(async () => {
      bikeAutoReconnectTimerId = null;

      if (!autoReconnectEnabled) return;
      if (!bikeDesiredDeviceId) return;

      const currentDesiredId = bikeDesiredDeviceId;
      const dev = bikeKnownDevices.get(currentDesiredId);
      if (!dev) {
        log(
          "Auto-reconnect (bike): desired device missing from map; aborting attempt."
        );
        return;
      }

      log("Auto-reconnect: attempting bike reconnect…");

      try {
        await connectToBike(dev, {isAuto: true});
        log("Auto-reconnect (bike) attempt finished.");
        // Success path: we don't schedule further here.
      } catch (err) {
        log("Auto-reconnect (bike) failed: " + err);
        // Increase delay (up to 10s) and reschedule
        bikeAutoReconnectDelayMs = Math.min(
          MAX_RECONNECT_DELAY_MS,
          bikeAutoReconnectDelayMs * 2
        );
        scheduleBikeAutoReconnect(false);
      }
    }, bikeAutoReconnectDelayMs);
  }

  function scheduleHrAutoReconnect(resetDelay = false) {
    if (!autoReconnectEnabled) return;
    if (!hrDesiredDeviceId) return;

    const device = hrKnownDevices.get(hrDesiredDeviceId);
    if (!device) {
      log(
        "HR auto-reconnect skipped: desired device not known in hrKnownDevices."
      );
      return;
    }

    if (hrConnected) return;

    if (resetDelay || !hrAutoReconnectDelayMs) {
      hrAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;
    }

    cancelHrAutoReconnect();

    hrAutoReconnectTimerId = setTimeout(async () => {
      hrAutoReconnectTimerId = null;

      if (!autoReconnectEnabled) return;
      if (!hrDesiredDeviceId) return;

      const currentDesiredId = hrDesiredDeviceId;
      const dev = hrKnownDevices.get(currentDesiredId);
      if (!dev) {
        log(
          "Auto-reconnect (HR): desired device missing from map; aborting attempt."
        );
        return;
      }

      log("Auto-reconnect: attempting HRM reconnect…");

      try {
        await connectToHr(dev, {isAuto: true});
        log("Auto-reconnect (HR) attempt finished.");
      } catch (err) {
        log("Auto-reconnect (HR) failed: " + err);
        // Increase delay (up to 10s) and reschedule
        hrAutoReconnectDelayMs = Math.min(
          MAX_RECONNECT_DELAY_MS,
          hrAutoReconnectDelayMs * 2
        );
        scheduleHrAutoReconnect(false);
      }
    }, hrAutoReconnectDelayMs);
  }

  // ---------------------------------------------------------------------------
  // Parsing helpers
  // ---------------------------------------------------------------------------

  function parseIndoorBikeData(dataView) {
    if (!dataView || dataView.byteLength < 4) return;

    let index = 0;
    const flags = dataView.getUint16(index, true);
    index += 2;

    // Speed (km/h)
    if ((flags & 0x0001) === 0 && dataView.byteLength >= index + 2) {
      const raw = dataView.getUint16(index, true);
      index += 2;
      lastBikeSample.speedKph = raw / 100.0;
    }

    if (flags & (1 << 1)) index += 2;

    // Cadence
    if (flags & (1 << 2)) {
      if (dataView.byteLength >= index + 2) {
        const rawCad = dataView.getUint16(index, true);
        index += 2;
        lastBikeSample.cadence = rawCad / 2.0;
      }
    }

    if (flags & (1 << 3)) index += 2;
    if (flags & (1 << 4)) index += 3;
    if (flags & (1 << 5)) index += 1;

    // Power
    if (flags & (1 << 6)) {
      if (dataView.byteLength >= index + 2) {
        const power = dataView.getInt16(index, true);
        index += 2;
        lastBikeSample.power = power;
      }
    }

    if (flags & (1 << 7)) index += 2;
    if (flags & (1 << 8)) index += 5;

    // HR from bike (optional)
    if (flags & (1 << 9)) {
      if (dataView.byteLength >= index + 1) {
        const hr = dataView.getUint8(index);
        index += 1;
        lastBikeSample.hrFromBike = hr;
      }
    }

    log(
      `FTMS <- IndoorBikeData: flags=0x${flags
        .toString(16)
        .padStart(4, "0")}, power=${lastBikeSample.power ?? "n/a"}W, cad=${lastBikeSample.cadence != null
          ? lastBikeSample.cadence.toFixed(1)
          : "n/a"
      }rpm`
    );

    emit("bikeSample", {...lastBikeSample});
  }

  function parseHrMeasurement(dataView) {
    if (!dataView || dataView.byteLength < 2) return;

    let offset = 0;
    const flags = dataView.getUint8(offset);
    offset += 1;
    const is16bit = (flags & 0x1) !== 0;

    let hr;
    if (is16bit && dataView.byteLength >= offset + 2) {
      hr = dataView.getUint16(offset, true);
    } else if (!is16bit) {
      hr = dataView.getUint8(offset);
    }

    log(`HRM <- HeartRateMeasurement: hr=${hr}bpm`);
    emit("hrSample", hr);
  }

  // ---------------------------------------------------------------------------
  // FTMS control point / trainer state
  // ---------------------------------------------------------------------------

  // Generic writer that doesn't depend on global bikeState (used during connect)
  async function writeFtmsControlPoint(cpChar, opCode, sint16Param /* or null */) {
    let buffer;
    if (sint16Param == null) {
      buffer = new Uint8Array([opCode]).buffer;
    } else {
      buffer = new ArrayBuffer(3);
      const view = new DataView(buffer);
      view.setUint8(0, opCode);
      view.setInt16(1, sint16Param, true);
    }

    const fn = cpChar.writeValueWithResponse || cpChar.writeValue;
    await fn.call(cpChar, buffer);
  }

  // Uses committed bikeState.controlPointChar (for normal trainer operations)
  async function sendFtmsControlPoint(opCode, sint16Param /* or null */) {
    const cpChar = bikeState.controlPointChar;
    if (!cpChar) {
      log("FTMS CP write attempted, but control point characteristic not ready.");
      throw new Error("FTMS Control Point characteristic not ready");
    }

    let buffer;
    if (sint16Param == null) {
      buffer = new Uint8Array([opCode]).buffer;
    } else {
      buffer = new ArrayBuffer(3);
      const view = new DataView(buffer);
      view.setUint8(0, opCode);
      view.setInt16(1, sint16Param, true);
    }

    log(
      `FTMS CP -> opCode=0x${opCode.toString(16)}, param=${sint16Param ?? "none"
      }`
    );

    const fn = cpChar.writeValueWithResponse || cpChar.writeValue;
    await fn.call(cpChar, buffer);
  }

  async function sendErgSetpointRaw(targetWatts) {
    if (!bikeState.controlPointChar) return;
    const val = Math.max(0, Math.min(2000, targetWatts | 0));
    try {
      await sendFtmsControlPoint(FTMS_OPCODES.setTargetPower, val);
      log(`ERG target → ${val} W`);
    } catch (err) {
      log("Failed to set ERG target: " + err);
    }
  }

  async function sendResistanceLevelRaw(level) {
    if (!bikeState.controlPointChar) return;
    const clamped = Math.max(0, Math.min(100, level | 0));
    const tenth = clamped * 10;
    try {
      await sendFtmsControlPoint(FTMS_OPCODES.setTargetResistanceLevel, tenth);
      log(`Resistance level → ${clamped}`);
    } catch (err) {
      log("Failed to set resistance: " + err);
    }
  }

  async function setTrainerStateInternal(state, {force = false} = {}) {
    if (!bikeConnected || !bikeState.controlPointChar) return;

    const tNow = nowSec();

    if (state.kind === "erg") {
      const target = Math.round(state.value);
      const needsSend =
        force ||
        lastTrainerMode !== "erg" ||
        lastErgTargetSent !== target ||
        tNow - lastErgSendTs >= TRAINER_SEND_MIN_INTERVAL_SEC;

      if (needsSend) {
        log(
          `TrainerState: ERG, target=${target}, force=${force}, lastTarget=${lastErgTargetSent}, lastMode=${lastTrainerMode}`
        );
        await sendErgSetpointRaw(target);
        lastTrainerMode = "erg";
        lastErgTargetSent = target;
        lastErgSendTs = tNow;
      }
    } else if (state.kind === "resistance") {
      const target = Math.round(state.value);
      const needsSend =
        force ||
        lastTrainerMode !== "resistance" ||
        lastResistanceSent !== target ||
        tNow - lastResistanceSendTs >= TRAINER_SEND_MIN_INTERVAL_SEC;

      if (needsSend) {
        log(
          `TrainerState: RESISTANCE, level=${target}, force=${force}, lastLevel=${lastResistanceSent}, lastMode=${lastTrainerMode}`
        );
        await sendResistanceLevelRaw(target);
        lastTrainerMode = "resistance";
        lastResistanceSent = target;
        lastResistanceSendTs = tNow;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Connection flows
  // ---------------------------------------------------------------------------

  async function requestBikeDevice() {
    const options = {
      filters: [{services: [FTMS_SERVICE_UUID]}],
      optionalServices: [FTMS_SERVICE_UUID],
    };
    log(
      "navigator.bluetooth.requestDevice for bike with options: " +
      JSON.stringify(options)
    );
    const device = await navigator.bluetooth.requestDevice(options);
    log("requestDevice returned bike: " + (device.name || "unnamed"));
    return device;
  }

  async function requestHrDevice() {
    const options = {
      filters: [{services: [HEART_RATE_SERVICE_UUID]}],
      optionalServices: [HEART_RATE_SERVICE_UUID, BATTERY_SERVICE_UUID],
    };
    log(
      "navigator.bluetooth.requestDevice for HRM with options: " +
      JSON.stringify(options)
    );
    const device = await navigator.bluetooth.requestDevice(options);
    log("requestDevice returned HRM: " + (device.name || "unnamed"));
    return device;
  }

  // Bike connect:
  // - All errors are fatal (including FTMS control point characteristic)
  // - Only updates bikeState & saves ID after successful connect *and* if this device is still desired
  // - Multiple connect calls for the same device are allowed to run in parallel
  async function connectToBike(device, {isAuto = false} = {}) {
    if (!device) throw new Error("connectToBike called without a device");

    const deviceId = device.id;
    bikeKnownDevices.set(deviceId, device);

    const desiredAtStart = bikeDesiredDeviceId;

    // For auto attempts, if desired ID already changed, skip entirely.
    if (isAuto && desiredAtStart && desiredAtStart !== deviceId) {
      log(
        `connectToBike(auto): desired device changed (was ${desiredAtStart}, now ${bikeDesiredDeviceId}); skipping.`
      );
      return;
    }

    if (deviceId === bikeDesiredDeviceId) {
      updateBikeStatus("connecting");
    }

    let server = null;
    let ftmsService = null;
    let indoorBikeDataChar = null;
    let controlPointChar = null;

    try {
      log(`Connecting to GATT server for bike (id=${deviceId})…`);
      server = await device.gatt.connect();
      log("Connected to GATT server (bike).");

      ftmsService = await server.getPrimaryService(FTMS_SERVICE_UUID);
      log("FTMS service found.");

      indoorBikeDataChar = await ftmsService.getCharacteristic(
        INDOOR_BIKE_DATA_CHAR
      );
      log("Indoor Bike Data characteristic found.");

      // FTMS Control Point is REQUIRED now; errors are fatal
      controlPointChar = await ftmsService.getCharacteristic(
        FTMS_CONTROL_POINT_CHAR
      );
      log("FTMS Control Point characteristic found.");

      // Subscribe to control point indications
      controlPointChar.addEventListener("characteristicvaluechanged", (ev) => {
        const dv = ev.target.value;
        if (!dv || dv.byteLength < 3) return;
        const op = dv.getUint8(0);
        const reqOp = dv.getUint8(1);
        const resCode = dv.getUint8(2);
        log(
          `FTMS CP <- Indication: op=0x${op
            .toString(16)
            .padStart(2, "0")}, req=0x${reqOp
              .toString(16)
              .padStart(2, "0")}, result=0x${resCode
                .toString(16)
                .padStart(2, "0")}`
        );
      });

      await controlPointChar.startNotifications();
      log("Subscribed to FTMS Control Point indications.");

      // Subscribe to Indoor Bike Data
      indoorBikeDataChar.addEventListener("characteristicvaluechanged", (ev) => {
        const dv = ev.target.value;
        parseIndoorBikeData(dv);
      });
      await indoorBikeDataChar.startNotifications();
      log("Subscribed to FTMS Indoor Bike Data (0x2AD2).");

      // Request control + start/resume are now fatal if they fail.
      await writeFtmsControlPoint(
        controlPointChar,
        FTMS_OPCODES.requestControl,
        null
      );
      await writeFtmsControlPoint(
        controlPointChar,
        FTMS_OPCODES.startOrResume,
        null
      );
      log("FTMS requestControl + startOrResume sent.");

      // Only commit to state & save ID if this device is still desired
      if (deviceId !== bikeDesiredDeviceId) {
        log(
          `Bike connect succeeded for stale device ${deviceId}, desired is now ${bikeDesiredDeviceId}. Tearing down.`
        );
        try {
          server.disconnect();
        } catch {}
        return;
      }

      // Save ID only after confirming it's still the desired ID
      saveBikeDeviceId(deviceId);

      // Clean up previous connection's handler
      if (bikeState.device && bikeState._disconnectHandler) {
        try {
          bikeState.device.removeEventListener(
            "gattserverdisconnected",
            bikeState._disconnectHandler
          );
        } catch {}
      }

      const disconnectHandler = () => {
        log("BLE disconnected (bike).");
        bikeConnected = false;
        updateBikeStatus("error");

        lastBikeSample = {
          power: null,
          cadence: null,
          speedKph: null,
          hrFromBike: null,
        };
        emit("bikeSample", {...lastBikeSample});

        // Upon disconnect, resume regular auto-reconnect with reset backoff
        bikeAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;

        if (!bikeSuppressAutoReconnectOnce) {
          scheduleBikeAutoReconnect(true);
        } else {
          bikeSuppressAutoReconnectOnce = false;
          log("Bike auto-reconnect suppressed once after manual disconnect.");
        }
      };

      device.addEventListener("gattserverdisconnected", disconnectHandler);

      // Commit to shared bikeState
      bikeState.device = device;
      bikeState.server = server;
      bikeState.ftmsService = ftmsService;
      bikeState.indoorBikeDataChar = indoorBikeDataChar;
      bikeState.controlPointChar = controlPointChar;
      bikeState._disconnectHandler = disconnectHandler;

      bikeConnected = true;
      updateBikeStatus("connected");
      log("Bike connected & committed to bikeState.");
    } catch (err) {
      log("Bike connect error (fatal): " + err);
      if (deviceId === bikeDesiredDeviceId) {
        bikeConnected = false;
        updateBikeStatus("error");
      }
      if (server && server.connected) {
        try {
          server.disconnect();
        } catch {}
      }
      throw err;
    }
  }

  // HR connect:
  // - All errors in the core HR flow are fatal (battery read remains optional)
  // - Only updates hrState & saves ID after successful connect *and* if this device is still desired
  // - Multiple connect calls for the same device are allowed to run in parallel
  async function connectToHr(device, {isAuto = false} = {}) {
    if (!device) throw new Error("connectToHr called without a device");

    const deviceId = device.id;
    hrKnownDevices.set(deviceId, device);

    const desiredAtStart = hrDesiredDeviceId;

    if (isAuto && desiredAtStart && desiredAtStart !== deviceId) {
      log(
        `connectToHr(auto): desired device changed (was ${desiredAtStart}, now ${hrDesiredDeviceId}); skipping.`
      );
      return;
    }

    if (deviceId === hrDesiredDeviceId) {
      updateHrStatus("connecting");
    }

    let server = null;
    let hrService = null;
    let batteryService = null;
    let measurementChar = null;

    try {
      log(`Connecting to GATT server for HR (id=${deviceId})…`);
      server = await device.gatt.connect();
      log("Connected to GATT server (hr).");

      hrService = await server.getPrimaryService(HEART_RATE_SERVICE_UUID);
      log("Heart Rate service found.");

      // Battery service still optional
      batteryService = await server
        .getPrimaryService(BATTERY_SERVICE_UUID)
        .catch(() => null);

      measurementChar = await hrService.getCharacteristic(HR_MEASUREMENT_CHAR);
      log("HR Measurement characteristic found.");

      await measurementChar.startNotifications();
      measurementChar.addEventListener("characteristicvaluechanged", (ev) =>
        parseHrMeasurement(ev.target.value)
      );
      log("Subscribed to HRM Measurement (0x2A37).");

      // Optional battery read; errors are non-fatal
      if (batteryService) {
        try {
          const batteryLevelChar =
            await batteryService.getCharacteristic(BATTERY_LEVEL_CHAR);
          const val = await batteryLevelChar.readValue();
          const pct = val.getUint8(0);
          log(`HR battery: ${pct}%`);
          hrBatteryPercent = pct;
          emit("hrBattery", pct);
        } catch (err) {
          log("Battery read failed (non-fatal): " + err);
        }
      }

      // Only commit & save ID if still desired device
      if (deviceId !== hrDesiredDeviceId) {
        log(
          `HR connect succeeded for stale device ${deviceId}, desired is now ${hrDesiredDeviceId}. Tearing down.`
        );
        try {
          server.disconnect();
        } catch {}
        return;
      }

      // Save ID only after confirming it's still the desired ID
      saveHrDeviceId(deviceId);

      // Clean up previous connection's handler
      if (hrState.device && hrState._disconnectHandler) {
        try {
          hrState.device.removeEventListener(
            "gattserverdisconnected",
            hrState._disconnectHandler
          );
        } catch {}
      }

      const disconnectHandler = () => {
        log("BLE disconnected (hr).");
        hrConnected = false;
        updateHrStatus("error");
        hrBatteryPercent = null;
        emit("hrBattery", hrBatteryPercent);
        emit("hrSample", null);

        // Upon disconnect, resume regular auto-reconnect with reset backoff
        hrAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;

        if (!hrSuppressAutoReconnectOnce) {
          scheduleHrAutoReconnect(true);
        } else {
          hrSuppressAutoReconnectOnce = false;
          log("HR auto-reconnect suppressed once after manual disconnect.");
        }
      };

      device.addEventListener("gattserverdisconnected", disconnectHandler);

      // Commit to shared hrState
      hrState.device = device;
      hrState.server = server;
      hrState.hrService = hrService;
      hrState.measurementChar = measurementChar;
      hrState.batteryService = batteryService;
      hrState._disconnectHandler = disconnectHandler;

      hrConnected = true;
      updateHrStatus("connected");
      log("HR connected & committed to hrState.");
    } catch (err) {
      log("HR connect error (fatal): " + err);
      if (deviceId === hrDesiredDeviceId) {
        hrConnected = false;
        updateHrStatus("error");
      }
      if (server && server.connected) {
        try {
          server.disconnect();
        } catch {}
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Auto reconnect via navigator.bluetooth.getDevices()
  // ---------------------------------------------------------------------------

  async function maybeReconnectSavedDevicesOnLoad() {
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) {
      log("Web Bluetooth getDevices() not supported, skipping auto-reconnect.");
      return;
    }

    const {bikeId, hrId} = await loadSavedBleDeviceIds();
    if (!bikeId && !hrId) {
      log("No saved BLE device IDs, skipping auto-reconnect.");
      return;
    }

    let devices;
    try {
      devices = await navigator.bluetooth.getDevices();
    } catch (err) {
      log("getDevices() failed: " + err);
      return;
    }

    log(`getDevices() returned ${devices.length} devices.`);

    const bikeDevice = bikeId ? devices.find((d) => d.id === bikeId) : null;
    const hrDevice = hrId ? devices.find((d) => d.id === hrId) : null;

    if (bikeDevice) {
      log("Found previously paired bike, starting auto-reconnect…");
      bikeKnownDevices.set(bikeDevice.id, bikeDevice);
      bikeDesiredDeviceId = bikeDevice.id;
      bikeAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;
      scheduleBikeAutoReconnect(true);
    } else if (bikeId) {
      log("Saved bike ID not available in getDevices() (permission revoked?).");
    }

    if (hrDevice) {
      log("Found previously paired HRM, starting auto-reconnect…");
      hrKnownDevices.set(hrDevice.id, hrDevice);
      hrDesiredDeviceId = hrDevice.id;
      hrAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;
      scheduleHrAutoReconnect(true);
    } else if (hrId) {
      log("Saved HRM ID not available in getDevices() (permission revoked?).");
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    init({autoReconnect = true} = {}) {
      autoReconnectEnabled = !!autoReconnect;

      if (autoReconnectEnabled) {
        maybeReconnectSavedDevicesOnLoad().catch((err) =>
          log("Auto-reconnect error: " + err)
        );
      } else {
        cancelBikeAutoReconnect();
        cancelHrAutoReconnect();
      }
    },

    async connectBikeViaPicker() {
      if (!navigator.bluetooth) {
        throw new Error("Bluetooth not available in this browser.");
      }

      // If user manually triggers connect, cancel any pending auto-connects
      cancelBikeAutoReconnect();

      const wasConnected = bikeConnected;
      let device;

      try {
        device = await requestBikeDevice();
      } catch (err) {
        log("Bike picker cancelled or failed: " + err);
        if (wasConnected && bikeState.server && bikeState.server.connected) {
          bikeSuppressAutoReconnectOnce = true;
          try {
            bikeState.server.disconnect();
          } catch {}
        }
        throw err;
      }

      const deviceId = device.id;

      // The user's selection becomes the new desired bike ID
      bikeDesiredDeviceId = deviceId;
      bikeKnownDevices.set(deviceId, device);

      // Reset backoff for this new target
      bikeAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;

      try {
        await connectToBike(device, {isAuto: false});
      } catch (err) {
        // Even if user connect fails, auto-reconnect should keep trying this ID
        scheduleBikeAutoReconnect(true);
        throw err;
      }
    },

    async connectHrViaPicker() {
      if (!navigator.bluetooth) {
        throw new Error("Bluetooth not available in this browser.");
      }

      cancelHrAutoReconnect();

      const wasConnected = hrConnected;
      let device;

      try {
        device = await requestHrDevice();
      } catch (err) {
        log("HR picker cancelled or failed: " + err);
        if (wasConnected && hrState.server && hrState.server.connected) {
          hrSuppressAutoReconnectOnce = true;
          try {
            hrState.server.disconnect();
          } catch {}
        }
        throw err;
      }

      const deviceId = device.id;

      hrDesiredDeviceId = deviceId;
      hrKnownDevices.set(deviceId, device);

      hrAutoReconnectDelayMs = MIN_RECONNECT_DELAY_MS;

      try {
        await connectToHr(device, {isAuto: false});
      } catch (err) {
        // Even if user connect fails, auto-reconnect should keep trying this ID
        scheduleHrAutoReconnect(true);
        throw err;
      }
    },

    async setTrainerState(state, opts) {
      // state: { kind: "erg" | "resistance", value: number }
      await setTrainerStateInternal(state, opts);
    },

    getLastBikeSample() {
      return {...lastBikeSample};
    },

    getHrBatteryPercent() {
      return hrBatteryPercent;
    },

    on(type, fn) {
      if (!listeners[type]) throw new Error("Unknown event type: " + type);
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },

    off(type, fn) {
      if (listeners[type]) listeners[type].delete(fn);
    },
  };
})();
