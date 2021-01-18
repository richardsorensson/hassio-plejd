const dbus = require('dbus-next');
const crypto = require('crypto');
const xor = require('buffer-xor');
const EventEmitter = require('events');

const logInfo = true;     // Normal operations
const logDebug = false;   // Chatty
const logVerbose = false; // Very chatty

const consoleLogger = (level) => (...msg) =>
  console.log(new Date().toISOString().replace('T', ' ').substring(0, 19) + 'Z', level, 'plejd-ble', ...msg);

const getLogger = (level, shouldLog) => (shouldLog ? consoleLogger(level) : () => {});

const errLogger = getLogger('ERR', true);
const infLogger = getLogger('INF', logInfo);
const dbgLogger = getLogger('DBG', logDebug);
const vrbLogger = getLogger('vrb', logVerbose);


// UUIDs
const PLEJD_SERVICE = '31ba0001-6085-4726-be45-040c957391b5';
const DATA_UUID = '31ba0004-6085-4726-be45-040c957391b5';
const LAST_DATA_UUID = '31ba0005-6085-4726-be45-040c957391b5';
const AUTH_UUID = '31ba0009-6085-4726-be45-040c957391b5';
const PING_UUID = '31ba000a-6085-4726-be45-040c957391b5';

const BLE_CMD_DIM_CHANGE = '00c8';
const BLE_CMD_DIM2_CHANGE = '0098';
const BLE_CMD_STATE_CHANGE = '0097';
const BLE_CMD_SCENE_TRIG = '0021';

const BLUEZ_SERVICE_NAME = 'org.bluez';
const DBUS_OM_INTERFACE = 'org.freedesktop.DBus.ObjectManager';
const DBUS_PROP_INTERFACE = 'org.freedesktop.DBus.Properties';

const BLUEZ_ADAPTER_ID = 'org.bluez.Adapter1';
const BLUEZ_DEVICE_ID = 'org.bluez.Device1';
const GATT_SERVICE_ID = 'org.bluez.GattService1';
const GATT_CHRC_ID = 'org.bluez.GattCharacteristic1';

const MAX_TRANSITION_STEPS_PER_SECOND = 5; // Could be made a setting
const MAX_RETRY_COUNT = 5; // Could be made a setting

class PlejdService extends EventEmitter {
  constructor(cryptoKey, devices, sceneManager, connectionTimeout, writeQueueWaitTime, keepAlive = false) {
    super();

    infLogger('Starting Plejd BLE, resetting all device states.');

    this.cryptoKey = Buffer.from(cryptoKey.replace(/-/g, ''), 'hex');

    this.sceneManager = sceneManager;
    this.connectedDevice = null;
    this.plejdService = null;
    this.bleDevices = [];
    this.bleDeviceTransitionTimers = {};
    this.plejdDevices = {};
    this.devices = devices;
    this.connectEventHooked = false;
    this.connectionTimeout = connectionTimeout;
    this.writeQueueWaitTime = writeQueueWaitTime;
    this.writeQueue = [];
    this.writeQueueRef = null;
    this.initInProgress = null;

    // Holds a reference to all characteristics
    this.characteristics = {
      data: null,
      lastData: null,
      lastDataProperties: null,
      auth: null,
      ping: null
    };

    this.bus = dbus.systemBus();
    this.adapter = null;

    dbgLogger('wiring events and waiting for BLE interface to power up.');
    this.wireEvents();
  }

  async init() {
    if (this.objectManager) {
      this.objectManager.removeAllListeners();
    }

    this.bleDevices = [];
    this.connectedDevice = null;

    this.characteristics = {
      data: null,
      lastData: null,
      lastDataProperties: null,
      auth: null,
      ping: null
    };

    clearInterval(this.pingRef);
    clearTimeout(this.writeQueueRef);
    infLogger('init()');

    const bluez = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, '/');
    this.objectManager = await bluez.getInterface(DBUS_OM_INTERFACE);

    // We need to find the ble interface which implements the Adapter1 interface
    const managedObjects = await this.objectManager.GetManagedObjects();
    let result = await this._getInterface(managedObjects, BLUEZ_ADAPTER_ID);

    if (result) {
      this.adapter = result[1];
    }

    if (!this.adapter) {
      errLogger('unable to find a bluetooth adapter that is compatible.');
      return;
    }

    for (let path of Object.keys(managedObjects)) {
      const interfaces = Object.keys(managedObjects[path]);

      if (interfaces.indexOf(BLUEZ_DEVICE_ID) > -1) {
        const proxyObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, path);
        const device = await proxyObject.getInterface(BLUEZ_DEVICE_ID);

        const connected = managedObjects[path][BLUEZ_DEVICE_ID].Connected.value;

        if (connected) {
          infLogger('disconnecting ' + path);
          await device.Disconnect();
        }

        await this.adapter.RemoveDevice(path);
      }
    }

    this.objectManager.on('InterfacesAdded', this.onInterfacesAdded.bind(this));

    this.adapter.SetDiscoveryFilter({
      'UUIDs': new dbus.Variant('as', [PLEJD_SERVICE]),
      'Transport': new dbus.Variant('s', 'le')
    });

    try {
      await this.adapter.StartDiscovery();
    } catch (err) {
      errLogger('failed to start discovery. Make sure no other add-on is currently scanning.');
      return;
    }
    return new Promise(resolve => 
      setTimeout(() => resolve(
        this._internalInit().catch((err) => { errLogger('InternalInit exception! Will rethrow.', err); throw err; })
        ), this.connectionTimeout * 1000
      )
    );
  }

  async _internalInit() {
    dbgLogger(`Got ${this.bleDevices.length} device(s).`);

    for (const plejd of this.bleDevices) {
      dbgLogger(`Inspecting ${plejd['path']}`);

      try {
        const proxyObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, plejd['path']);
        const device = await proxyObject.getInterface(BLUEZ_DEVICE_ID);
        const properties = await proxyObject.getInterface(DBUS_PROP_INTERFACE);

        plejd['rssi'] = (await properties.Get(BLUEZ_DEVICE_ID, 'RSSI')).value;
        plejd['instance'] = device;

        const segments = plejd['path'].split('/');
        let fixedPlejdPath = segments[segments.length - 1].replace('dev_', '');
        fixedPlejdPath = fixedPlejdPath.replace(/_/g, '');
        plejd['device'] = this.devices.find(x => x.serialNumber === fixedPlejdPath);

        dbgLogger(`Discovered ${plejd['path']} with rssi ${plejd['rssi']}`);
      } catch (err) {
        errLogger(`Failed inspecting ${plejd['path']}. `, err);
      }
    }

    const sortedDevices = this.bleDevices.sort((a, b) => b['rssi'] - a['rssi']);
    let connectedDevice = null;

    for (const plejd of sortedDevices) {
      try {
        if (plejd['instance']) {
          infLogger(`Connecting to ${plejd['path']}`);
          await plejd['instance'].Connect();
          connectedDevice = plejd;
          break
        }
      } catch (err) {
        errLogger('Warning: unable to connect, will retry. ', err);
      }
    }

    setTimeout(async () => {
      await this.onDeviceConnected(connectedDevice);
      await this.adapter.StopDiscovery();
    }, this.connectionTimeout * 1000);
  }

  async _getInterface(managedObjects, iface) {
    const managedPaths = Object.keys(managedObjects);

    for (let path of managedPaths) {
      const pathInterfaces = Object.keys(managedObjects[path]);
      if (pathInterfaces.indexOf(iface) > -1) {
        dbgLogger(`Found BLE interface '${iface}' at ${path}`);
        try {
          const adapterObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, path);
          return [path, adapterObject.getInterface(iface), adapterObject];
        } catch (err) {
          errLogger(`Failed to get interface '${iface}'. `, err);
        }
      }
    }

    return null;
  }

  async onInterfacesAdded(path, interfaces) {
    // const [adapter, dev, service, characteristic] = path.split('/').slice(3);
    const interfaceKeys = Object.keys(interfaces);

    if (interfaceKeys.indexOf(BLUEZ_DEVICE_ID) > -1) {
      if (interfaces[BLUEZ_DEVICE_ID]['UUIDs'].value.indexOf(PLEJD_SERVICE) > -1) {
        dbgLogger(`Found Plejd service on ${path}`);
        this.bleDevices.push({
          'path': path
        });
      } else {
        errLogger('Uh oh, no Plejd device!');
      }
    }
  }

  updateSettings(settings) {
    dbgLogger('Got new settings: ', settings);
    if (settings.debug) {
      debug = true;
    } else {
      debug = false;
    }
  }

  turnOn(deviceId, command) {
    const deviceName = (logVerbose || logDebug) ? this._getDeviceName(deviceId) : '';
    infLogger(`Plejd got turn on command for ${deviceName} (${deviceId}), brightness ${command.brightness}${command.transition ? `, transition: ${command.transition}` : ''}`);
    this._transitionTo(deviceId, command.brightness, command.transition, deviceName);
  }

  turnOff(deviceId, command) {
    const deviceName = (logVerbose || logDebug) ? this._getDeviceName(deviceId) : '';
    infLogger(`Plejd got turn off command for ${deviceName} (${deviceId}), brightness ${command.brightness}${command.transition ? `, transition: ${command.transition}` : ''}`);
    this._transitionTo(deviceId, 0, command.transition, deviceName);
  }


  _clearDeviceTransitionTimer(deviceId) {
    if (this.bleDeviceTransitionTimers[deviceId]) {
      clearInterval(this.bleDeviceTransitionTimers[deviceId]);
    }
  }

  _transitionTo(deviceId, targetBrightness, transition, deviceName) {
    const initialBrightness = this.plejdDevices[deviceId] ? this.plejdDevices[deviceId].state && this.plejdDevices[deviceId].dim : null;
    this._clearDeviceTransitionTimer(deviceId);

    const isDimmable = this.devices.find(d => d.id === deviceId).dimmable;

    if (transition > 1 && isDimmable && (initialBrightness || initialBrightness === 0) && (targetBrightness || targetBrightness === 0) && targetBrightness !== initialBrightness) {
      // Transition time set, known initial and target brightness
      // Calculate transition interval time based on delta brightness and max steps per second
      // During transition, measure actual transition interval time and adjust stepping continously
      // If transition <= 1 second, Plejd will do a better job than we can in transitioning so transitioning will be skipped

      const deltaBrightness = targetBrightness - initialBrightness;
      const transitionSteps = Math.min(Math.abs(deltaBrightness), MAX_TRANSITION_STEPS_PER_SECOND * transition);
      const transitionInterval = transition * 1000 / transitionSteps;

      dbgLogger(`transitioning from ${initialBrightness} to ${targetBrightness} ${transition ? 'in ' + transition + ' seconds' : ''}.`);
      vrbLogger(`delta brightness ${deltaBrightness}, steps ${transitionSteps}, interval ${transitionInterval} ms`);

      const dtStart = new Date();

      let nSteps = 0;

      this.bleDeviceTransitionTimers[deviceId] = setInterval(() => {
        let tElapsedMs = new Date().getTime() - dtStart.getTime();
        let tElapsed = tElapsedMs / 1000;

        if (tElapsed > transition || tElapsed < 0) {
          tElapsed = transition;
        }

        let newBrightness = parseInt(initialBrightness + deltaBrightness * tElapsed / transition);

        if (tElapsed === transition) {
          nSteps++;
          this._clearDeviceTransitionTimer(deviceId);
          newBrightness = targetBrightness;
          dbgLogger(`Queueing finalize ${deviceName} (${deviceId}) transition from ${initialBrightness} to ${targetBrightness} in ${tElapsedMs}ms. Done steps ${nSteps}. Average interval ${tElapsedMs / (nSteps || 1)} ms.`);
          this._setBrightness(deviceId, newBrightness, true, deviceName);
        } else {
          nSteps++;
          vrbLogger(`Queueing dim transition for ${deviceName} (${deviceId}) to ${newBrightness}. Total queue length ${this.writeQueue.length}`);
          this._setBrightness(deviceId, newBrightness, false, deviceName);
        }

      }, transitionInterval);
    }
    else {
      if (transition && isDimmable) {
        dbgLogger(`Could not transition light change. Either initial value is unknown or change is too small. Requested from ${initialBrightness} to ${targetBrightness}`)
      }
      this._setBrightness(deviceId, targetBrightness, true, deviceName);
    }
  }

  _setBrightness(deviceId, brightness, shouldRetry, deviceName) {
    let payload = null;
    let log = '';

    if (!brightness && brightness !== 0) {
      dbgLogger(`Queueing turn on ${deviceName} (${deviceId}). No brightness specified, setting DIM to previous.`);
      payload = Buffer.from((deviceId).toString(16).padStart(2, '0') + '0110009701', 'hex');
      log = 'ON';
    }
    else {
      if (brightness <= 0) {
        dbgLogger(`Queueing turn off ${deviceId}`);
        payload = Buffer.from((deviceId).toString(16).padStart(2, '0') + '0110009700', 'hex');
        log = 'OFF';
     }
      else {
        if (brightness > 255) {
          brightness = 255;
        }

        dbgLogger(`Queueing ${deviceId} set brightness to ${brightness}`);
        const brightnessVal = (brightness << 8) | brightness;
        payload = Buffer.from((deviceId).toString(16).padStart(2, '0') + '0110009801' + (brightnessVal).toString(16).padStart(4, '0'), 'hex');
        log = `DIM ${brightness}`;
      }
    }
    this.writeQueue.unshift({deviceId, log, shouldRetry, payload});
  }

  triggerScene(sceneIndex) {
    const sceneName = this._getDeviceName(sceneIndex);
    infLogger(`Triggering scene ${sceneName} (${sceneIndex}). Scene name might be misleading if there is a device with the same numeric id.`);
    this.sceneManager.executeScene(sceneIndex, this);
  }

  async authenticate() {
    infLogger('authenticate()');

    try {
      dbgLogger('Sending challenge to device');
      await this.characteristics.auth.WriteValue([0], {});
      dbgLogger('Reading response from device');
      const challenge = await this.characteristics.auth.ReadValue({});
      const response = this._createChallengeResponse(this.cryptoKey, Buffer.from(challenge));
      dbgLogger('Responding to authenticate');
      await this.characteristics.auth.WriteValue([...response], {});
    } catch (err) {
      errLogger('Failed to authenticate: ', err);
    }

    // auth done, start ping
    this.startPing();
    this.startWriteQueue();

    // After we've authenticated, we need to hook up the event listener
    // for changes to lastData.
    this.characteristics.lastDataProperties.on('PropertiesChanged', this.onLastDataUpdated.bind(this));
    this.characteristics.lastData.StartNotify();
  }

  async throttledInit(delay) {
    if(this.initInProgress){
      dbgLogger('ThrottledInit already in progress. Skipping this call and returning existing promise.')
      return this.initInProgress;
    }
   this.initInProgress = new Promise((resolve) => setTimeout(async () => {
     const result = await this.init().catch((err) => { errLogger('TrottledInit exception calling init(). Will re-throw.', err); throw err; });
     this.initInProgress = null;
     resolve(result)
   }, delay))
   return this.initInProgress;
  }

  async write(data) {
    if (!data || !this.plejdService || !this.characteristics.data) {
      dbgLogger('data, plejdService or characteristics not available. Cannot write()');
      return;
    }

    try {
      vrbLogger(`Sending ${data.length} byte(s) of data to Plejd`, data);
      const encryptedData = this._encryptDecrypt(this.cryptoKey, this.plejdService.addr, data);
      await this.characteristics.data.WriteValue([...encryptedData], {});
      return true;
    } catch (err) {
      if (err.message === 'In Progress') {
        dbgLogger('Write failed due to \'In progress\' ', err);
      } else {
        dbgLogger('Write failed ', err);
      }
      await this.throttledInit(this.connectionTimeout * 1000);
      return false;
    }
  }

  startPing() {
    infLogger('startPing()');
    clearInterval(this.pingRef);

    this.pingRef = setInterval(async () => {
      vrbLogger('ping');
      await this.ping();
    }, 3000);
  }

  onPingSuccess(nr) {
    vrbLogger('pong: ' + nr);
  }

  async onPingFailed(error) {
    dbgLogger('onPingFailed(' + error + ')');
    infLogger('ping failed, reconnecting.');

    clearInterval(this.pingRef);
    await this.init();
  }

  async ping() {
    vrbLogger('ping()');

    var ping = crypto.randomBytes(1);
    let pong = null;

    try {
      await this.characteristics.ping.WriteValue([...ping], {});
      pong = await this.characteristics.ping.ReadValue({});
    } catch (err) {
      errLogger('writing to plejd: ', err);
      this.emit('pingFailed', 'write error');
      return;
    }

    if (((ping[0] + 1) & 0xff) !== pong[0]) {
      errLogger('plejd ping failed');
      this.emit('pingFailed', 'plejd ping failed ' + ping[0] + ' - ' + pong[0]);
      return;
    }

    this.emit('pingSuccess', pong[0]);
  }

  startWriteQueue() {
    infLogger('startWriteQueue()');
    clearTimeout(this.writeQueueRef);

    this.writeQueueRef = setTimeout(() => this.runWriteQueue(), this.writeQueueWaitTime);
  }

  async runWriteQueue() {
    try {
      while (this.writeQueue.length > 0) {
        const queueItem = this.writeQueue.pop();
        const deviceName = this._getDeviceName(queueItem.deviceId);
        dbgLogger(`Write queue: Processing ${deviceName} (${queueItem.deviceId}). Command ${queueItem.log}. Total queue length: ${this.writeQueue.length}`);

        if (this.writeQueue.some((item) => item.deviceId === queueItem.deviceId)) {
          vrbLogger(`Skipping ${deviceName} (${queueItem.deviceId}) ${queueItem.log} due to more recent command in queue.`);
          continue; // Skip commands if new ones exist for the same deviceId, but still process all messages in order
        }

        const success = await this.write(queueItem.payload);
        if (!success && queueItem.shouldRetry) {
          queueItem.retryCount = (queueItem.retryCount || 0) + 1;
          dbgLogger('Will retry command, count failed so far', queueItem.retryCount);
          if (queueItem.retryCount <= MAX_RETRY_COUNT) {
            this.writeQueue.push(queueItem); // Add back to top of queue to be processed next;
          }
          else {
            errLogger(`Write queue: Exceeed max retry count (${MAX_RETRY_COUNT}) for ${deviceName} (${queueItem.deviceId}). Command ${queueItem.log} failed.`);
            break;
          }
          if (queueItem.retryCount > 1) {
            break; // First retry directly, consecutive after writeQueueWaitTime ms
          }
        }
      }
    } catch (e) {
      errLogger('Error in writeQueue loop, values probably not written to Plejd', e);
    }

    this.writeQueueRef = setTimeout(() => this.runWriteQueue(), this.writeQueueWaitTime);
  }

  async _processPlejdService(path, characteristics) {
    const proxyObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, path);
    const service = await proxyObject.getInterface(GATT_SERVICE_ID);
    const properties = await proxyObject.getInterface(DBUS_PROP_INTERFACE);

    const uuid = (await properties.Get(GATT_SERVICE_ID, 'UUID')).value;
    if (uuid !== PLEJD_SERVICE) {
      errLogger('not a Plejd device.');
      return null;
    }

    const dev = (await properties.Get(GATT_SERVICE_ID, 'Device')).value;
    const regex = /dev_([0-9A-F_]+)$/;
    const dirtyAddr = regex.exec(dev);
    const addr = this._reverseBuffer(
      Buffer.from(
        String(dirtyAddr[1])
        .replace(/\-/g, '')
        .replace(/\_/g, '')
        .replace(/\:/g, ''), 'hex'
      )
    );

    for (const chPath of characteristics) {
      const chProxyObject = await this.bus.getProxyObject(BLUEZ_SERVICE_NAME, chPath);
      const ch = await chProxyObject.getInterface(GATT_CHRC_ID);
      const prop = await chProxyObject.getInterface(DBUS_PROP_INTERFACE);

      const chUuid = (await prop.Get(GATT_CHRC_ID, 'UUID')).value;

      if (chUuid === DATA_UUID) {
        dbgLogger('found DATA characteristic.');
        this.characteristics.data = ch;
      } else if (chUuid === LAST_DATA_UUID) {
        dbgLogger('found LAST_DATA characteristic.');
        this.characteristics.lastData = ch;
        this.characteristics.lastDataProperties = prop;
      } else if (chUuid === AUTH_UUID) {
        dbgLogger('found AUTH characteristic.');
        this.characteristics.auth = ch;
      } else if (chUuid === PING_UUID) {
        dbgLogger('found PING characteristic.');
        this.characteristics.ping = ch;
      }
    }

    return {
      addr: addr
    };
  }

  async onDeviceConnected(device) {
    infLogger('onDeviceConnected()');
    dbgLogger('Device: ', device);
    if (!device) {
      errLogger('Device is null. Should we break/return when this happens?');
    }

    const objects = await this.objectManager.GetManagedObjects();
    const paths = Object.keys(objects);
    let characteristics = [];

    for (const path of paths) {
      const interfaces = Object.keys(objects[path]);
      if (interfaces.indexOf(GATT_CHRC_ID) > -1) {
        characteristics.push(path);
      }
    }

    for (const path of paths) {
      const interfaces = Object.keys(objects[path]);
      if (interfaces.indexOf(GATT_SERVICE_ID) > -1) {
        let chPaths = [];
        for (const c of characteristics) {
          if (c.startsWith(path + '/')) {
            chPaths.push(c);
          }
        }

        infLogger('trying ' + chPaths.length + ' characteristics');

        this.plejdService = await this._processPlejdService(path, chPaths);
        if (this.plejdService) {
          break;
        }
      }
    }

    if (!this.plejdService) {
      infLogger('warning: wasn\'t able to connect to Plejd, will retry.');
      this.emit('connectFailed');
      return;
    }

    if (!this.characteristics.auth) {
      errLogger('unable to enumerate characteristics.');
      this.emit('connectFailed');
      return;
    }

    this.connectedDevice = device['device'];
    await this.authenticate();
  }

  async onLastDataUpdated(iface, properties, invalidated) {
    if (iface !== GATT_CHRC_ID) {
      return;
    }

    const changedKeys = Object.keys(properties);
    if (changedKeys.length === 0) {
      return;
    }

    const value = await properties['Value'];
    if (!value) {
      return;
    }

    const data = value.value;
    const decoded = this._encryptDecrypt(this.cryptoKey, this.plejdService.addr, data);

    const deviceId = parseInt(decoded[0], 10);
    // What is bytes 2-3?
    const cmd = decoded.toString('hex', 3, 5);
    const state = parseInt(decoded.toString('hex', 5, 6), 10); // Overflows for command 0x001b, scene command
    const data2 = parseInt(decoded.toString('hex', 6, 8), 16) >> 8;

    if (decoded.length < 5) {
      dbgLogger('Too short raw event ignored: ', decoded.toString('hex'));
      // ignore the notification since too small
      return;
    }

    const deviceName = (logVerbose || logDebug) ? this._getDeviceName(deviceId) : '';
    vrbLogger('Raw event received: ', decoded.toString('hex'));
    vrbLogger(`Device ${deviceId}, cmd ${cmd.toString('hex')}, state ${state}, dim/data2 ${data2}`);

    if (cmd === BLE_CMD_DIM_CHANGE || cmd === BLE_CMD_DIM2_CHANGE) {
      const dim = data2;

      dbgLogger(`${deviceName} (${deviceId}) got state+dim update. S: ${state}, D: ${dim}`);

      this.emit('stateChanged', deviceId, {
        state: state,
        brightness: dim
      });

      this.plejdDevices[deviceId] = {
        state: state,
        dim: dim
      };
      vrbLogger('All states: ', this.plejdDevices);
    } else if (cmd === BLE_CMD_STATE_CHANGE) {
      dbgLogger(`${deviceName} (${deviceId}) got state update. S: ${state}`);
      this.emit('stateChanged', deviceId, {
        state: state
      });
      this.plejdDevices[deviceId] = {
        state: state,
        dim: 0
      };
      vrbLogger('All states: ', this.plejdDevices);
    } else if (cmd === BLE_CMD_SCENE_TRIG) {
      const sceneId = parseInt(decoded.toString('hex', 5, 6), 16);
      const sceneName = this._getDeviceName(sceneId);

      dbgLogger(`${sceneName} (${sceneId}) scene triggered (device id ${deviceId}). Name can be misleading if there is a device with the same numeric id.`);

      this.emit('sceneTriggered', deviceId, sceneId);
    }
    else if (cmd === '001b') {
      // vrbLogger('Command 001b seems to be some kind of often repeating ping/mesh data');
    }
    else {
      vrbLogger(`Command ${cmd.toString('hex')} unknown. Device ${deviceName} (${deviceId})`);
    }
  }

  wireEvents() {
    infLogger('wireEvents()');
    const self = this;

    this.on('pingFailed', this.onPingFailed.bind(self));
    this.on('pingSuccess', this.onPingSuccess.bind(self));
  }

  _createChallengeResponse(key, challenge) {
    const intermediate = crypto.createHash('sha256').update(xor(key, challenge)).digest();
    const part1 = intermediate.subarray(0, 16);
    const part2 = intermediate.subarray(16);

    const resp = xor(part1, part2);

    return resp;
  }

  _encryptDecrypt(key, addr, data) {
    var buf = Buffer.concat([addr, addr, addr.subarray(0, 4)]);

    var cipher = crypto.createCipheriv('aes-128-ecb', key, '');
    cipher.setAutoPadding(false);

    var ct = cipher.update(buf).toString('hex');
    ct += cipher.final().toString('hex');
    ct = Buffer.from(ct, 'hex');

    var output = '';
    for (var i = 0, length = data.length; i < length; i++) {
      output += String.fromCharCode(data[i] ^ ct[i % 16]);
    }

    return Buffer.from(output, 'ascii');
  }

  _getDeviceName(deviceId) {
    return (this.devices.find(d => d.id === deviceId) || {}).name;
  }

  _reverseBuffer(src) {
    var buffer = Buffer.allocUnsafe(src.length)

    for (var i = 0, j = src.length - 1; i <= j; ++i, --j) {
      buffer[i] = src[j]
      buffer[j] = src[i]
    }

    return buffer
  }
}

module.exports = PlejdService;
