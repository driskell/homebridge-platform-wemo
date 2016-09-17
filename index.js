// Wemo Platform Plugin for HomeBridge (https://github.com/nfarina/homebridge)
//
// Remember to add platform to config.json. Example:
// "platforms": [
//      {
//          "platform": "BelkinWeMo",
//          "no_motion_timer": 60 // optional: [WeMo Motion only] a timer (in seconds) which is started no motion is detected, defaults to 60
//      }
// ],

var PlatformAccessory, Characteristic, Consumption, Service, UUIDGen, wemo;
var inherits = require('util').inherits;
var Wemo = require('wemo-client');
var debug = require('debug')('homebridge-platform-wemo');

module.exports = function (homebridge) {
    PlatformAccessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    Consumption = function() {
        Characteristic.call(this, 'Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
            format: Characteristic.Formats.FLOAT,
            unit: 'W',
            perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    };

    inherits(Consumption, Characteristic);

    Consumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

    homebridge.registerPlatform('homebridge-platform-wemo', 'BelkinWeMo', WemoPlatform, true);
};

function WemoPlatform(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    this.port = config.port || 0;
    this.config.no_motion_timer = this.config.no_motion_timer || 60;

    this.unregisterCachedAccessories = [];

    // Indexes
    // {deviceId: accessory}
    this.accessories = new Map();

    // Initialise wemo-client
    wemo = new Wemo({
        port: this.port,
        discover_opts: {
            unicastBindPort: this.port
        }
    });

    this.api.on('didFinishLaunching', this._didFinishLaunching.bind(this));
}

// Homebridge has finished launching and restoring cached accessories, start
// discovery processes
WemoPlatform.prototype._didFinishLaunching = function () {
    this.log('Searching for WeMo devices');

    var performDiscovery = function () {
        wemo.discover(this._processDiscovery.bind(this));
    }.bind(this);
    performDiscovery();
    setInterval(performDiscovery, 10000);

    // Remove unwanted cached accessories
    if (this.unregisterCachedAccessories.length !== 0) {
      this.api.unregisterPlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', this.unregisterCachedAccessories);
      this.unregisterCachedAccessories = [];
    }

    // TODO: Handle devices that are REMOVED from the network and cleanup structures
};

// Configure a cached accessory
WemoPlatform.prototype.configureAccessory = function (platformAccessory) {
  new WemoAccessory(
      this,
      this._createLogger(platformAccessory.context.name),
      platformAccessory.context.name,
      platformAccessory.context.deviceId,
      platformAccessory.context.deviceType,
      undefined,
      platformAccessory
  );
};

// Create a logger for an accessory
WemoPlatform.prototype._createLogger = function (prefix) {
  var log = this.log;
  return function () {
    var args = Array.from(arguments);
    args[0] = '[' + prefix + '] ' + args[0];
    log.apply(null, args);
  };
};

// Process a discovery event
WemoPlatform.prototype._processDiscovery = function (device) {
    this.log('Found: %s, type: %s, UDN: %s', device.friendlyName, device.deviceType.split(":")[3], device.UDN);

    if (device.deviceType === Wemo.DEVICE_TYPE.Bridge) {
        // a wemolink bridge - find bulbs
        var client = this.client(device, this.log);
        client.getEndDevices(function (err, endDeviceList) {
            if (err) {
                this.log('Failed to retrieve EndDevices');
                return;
            }

            // this calls us back with an array of enddevices (bulbs)
            this.log('Device has %s EndDevices', endDeviceList.length);
            endDeviceList.forEach(function (endDevice) {
                this.log('Found EndDevice: %s, id: %s', endDevice.friendlyName, endDevice.deviceId);

                var deviceId = device.UDN + ':' + endDevice.deviceId,
                    accessory = this._lookupAndVerifyDeviceType(deviceId, device.deviceType);
                if (accessory) {
                    accessory.attachDeviceData(endDevice);
                } else {
                    new WemoAccessory(
                      this,
                      this._createLogger(endDevice.friendlyName),
                      endDevice.friendlyName,
                      deviceId,
                      device.deviceType,
                      endDevice
                    );
                }
            }.bind(this));
        });
        return;
    }

    if (device.deviceType !== Wemo.DEVICE_TYPE.Maker) {
        var accessory = this._lookupAndVerifyDeviceType(device.UDN, device.deviceType);
        if (accessory) {
            accessory.attachDeviceData(device);
        } else {
            new WemoAccessory(
              this,
              this._createLogger(device.friendlyName),
              device.friendlyName,
              device.UDN,
              device.deviceType,
              device
            );
        }
    }
};

// Lookup an existing accessory and verify the device type still matches
WemoPlatform.prototype._lookupAndVerifyDeviceType = function (deviceId, deviceType) {
    var accessory = this.accessories.get(deviceId);
    if (!accessory) {
        return false;
    }

    if (accessory.deviceType != deviceType) {
        // Unregister the old and create a new
        this.accessories.delete(deviceId);
        this.platform.api.unregisterPlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [accessory]);
        return false;
    }

    return accessory;
};

//
// Transition utilities
//

// Get a transition status from the transition table
function _utilGetTransition(characteristic) {
  if (!this.transitions) {
    this.transitions = new Map();
  }

  var transition = this.transitions.get(characteristic.UUID);
  if (!transition) {
    transition = {};
    this.transitions.set(characteristic.UUID, transition);
  }

  return transition;
}

// Handle an internal update, checking for active transitions
function _utilUpdateInternal(characteristic, value, quiet) {
  var transition = _utilGetTransition.call(this, characteristic),
      characteristicObj = this.service.getCharacteristic(characteristic);

  // Are we transitioning?
  if (!transition.isRunning) {
    // Compare with the existing value so we avoid unnecessary changes and logging
    // This is valid as HAP-NodeJS documents cacheable value as accessible directly
    // We don't call getValue as it triggers our listeners
    if (characteristicObj.value == value) {
      return;
    }

    // Log only if we're not a 'noisy' event (like power usage that happens every second)
    if (!quiet) {
      this.log('Updating %s characteristic to %s', characteristicObj.displayName, value);
    }

    // Set the value with internal context so our listeners ignores it but so we
    // still trigger change events to propogate to remote listeners (accessing
    // the cached value propertly directly doesn't do this)
    characteristicObj.setValue(value, null, '_internal');
    return;
  }

  this.log('Deferring %s characteristic update to %s as it is currently transitioning', characteristicObj.displayName, value);
  transition.deferred = value;
}

// Begin transition of a characteristic
// Prevents internal updates from taking effect until a second after the
// transition completes, to prevent flicking of states while status converges
function _utilBeginTransition(characteristic, callback) {
  var transition = _utilGetTransition.call(this, characteristic);

  transition.isRunning = true;

  // If we have a deferred timeout running already, clear it
  if (transition.deferredTimeout !== undefined) {
    clearTimeout(transition.deferredTimeout);
    transition.deferredTimeout = undefined;
  }

  return function (err) {
    // Set a timer to update to any deferred value after a small timeout that
    // will hopefully be long enough for events to converge on the desired state
    transition.deferredTimeout = setTimeout(function () {
      transition.isRunning = false;
      if (transition.deferred === undefined) {
        return;
      }

      this._updateInternal(characteristic, transition.deferred);
      transition.deferred = undefined;
    }.bind(this), 2000);

    callback(err);
  }.bind(this);
}

//
// Wemo Accessory
//

function WemoAccessory(platform, log, name, deviceId, deviceType, deviceData, platformAccessory) {
    this.platform = platform;
    this.log = log;
    this.name = name;
    this.deviceId = deviceId;
    this.deviceType = deviceType;
    this.deviceData = deviceData;

    if (platformAccessory) {
        this.log('Restoring cached platform accessory with name %s', name);
        this.platformAccessory = platformAccessory;
    } else {
        this.log('Creating new platform accessory with name %s', name);
        this.platformAccessory = new PlatformAccessory(name, UUIDGen.generate(deviceId));
        this.platformAccessory.context.name = name;
        this.platformAccessory.context.deviceId = deviceId;
        this.platformAccessory.context.deviceType = deviceType;
    }

    this._configureServices();

    if (deviceData) {
        // New device now reachable - set data
        this._setDeviceData(deviceData);
    } else {
        // No device yet, just set initial info stuff and leave unreachable
        this._updateInfoCharacteristics();
    }

    // Index
    this.platform.accessories.set(deviceId, this);

    if (!platformAccessory) {
        this.platform.api.registerPlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [this.platformAccessory]);
    }
}

// Transition utilities
WemoAccessory.prototype._updateInternal = _utilUpdateInternal;
WemoAccessory.prototype._beginTransition = _utilBeginTransition;

// Called to configure the internal device data and update info characteristics
WemoAccessory.prototype._setDeviceData = function (deviceData) {
  this.deviceData = deviceData;
  if (this.deviceData === undefined) {
    this.log('Device is no longer reachable');
    this.client = undefined;
    // TODO: Cleanup old client
    this.platformAccessory.updateReachability(false);
  } else {
    this.log('Device is now reachable');
    this.client = wemo.client(deviceData, this.log);
    this._configureListeners();
    this.platformAccessory.updateReachability(true);
  }

  this._updateInfoCharacteristics();
};

// Called when the device becomes reachable
WemoAccessory.prototype.attachDeviceData = function (deviceData) {
  this._setDeviceData(deviceData);

  // Update the platform accessory with latest context persisted
  this.platform.api.updatePlatformAccessories([this.platformAccessory]);
};

// Update device information characteristics
WemoAccessory.prototype._updateInfoCharacteristics = function () {
    if (!this.deviceData || this.deviceType === Wemo.DEVICE_TYPE.Bridge) {
        // We actually got given an endDevice which doesn't have any information
        this.infoService
            .setCharacteristic(Characteristic.Manufacturer, 'WeMo')
            .setCharacteristic(Characteristic.Model, 'Unknown')
            .setCharacteristic(Characteristic.SerialNumber, 'Unknown');
        return;
    }

    this.infoService
        .setCharacteristic(Characteristic.Manufacturer, 'WeMo')
        .setCharacteristic(Characteristic.Model, this.deviceData.modelName)
        .setCharacteristic(Characteristic.SerialNumber, this.deviceData.serialNumber)
        .setCharacteristic(Characteristic.FirmwareRevision, this.deviceData.firmwareVersion)
        .setCharacteristic(Characteristic.HardwareRevision, this.deviceData.modelNumber);
};

// Adds a new service if we're a new accessory or fetches existing if we're cached
WemoAccessory.prototype._addOrGetService = function (serviceClass) {
    var service = this.platformAccessory.getService(serviceClass);
    if (service) {
      return service;
    }

    return this.platformAccessory.addService(serviceClass);
};

// Adds a new characteristic if we're a new accessory of fetches existing if we're cached
WemoAccessory.prototype._addOrGetCharacteristic = function (characteristicClass) {
    var characteristic = this.service.getCharacteristic(characteristicClass);
    if (characteristic) {
      return characteristic;
    }

    return this.service.addCharacteristic(characteristicClass);
};

// Configure available services for this accessory
WemoAccessory.prototype._configureServices = function () {
    this.infoService = this.platformAccessory.getService(Service.AccessoryInformation);

    if (this.deviceType === Wemo.DEVICE_TYPE.Bridge) {
        this.service = this._addOrGetService(Service.Lightbulb);

        this.service
            .getCharacteristic(Characteristic.On)
            .on('set', this.setOnStatus.bind(this))
            .on('get', this.getOnStatus.bind(this));
        this.service
            .getCharacteristic(Characteristic.Brightness)
            .on('set', this.setBrightness.bind(this))
            .on('get', this.getBrightness.bind(this));

        return;
    }

    if (this.deviceType === Wemo.DEVICE_TYPE.Insight ||
            this.deviceType === Wemo.DEVICE_TYPE.Switch ||
            this.deviceType === Wemo.DEVICE_TYPE.LightSwitch) {
        this.service = this._addOrGetService(Service.Switch);

        this.service
            .getCharacteristic(Characteristic.On)
            .on('set', this.setOn.bind(this))
            .on('get', this.getOn.bind(this));

        if (this.deviceType === Wemo.DEVICE_TYPE.Insight) {
            this._addOrGetCharacteristic(Characteristic.OutletInUse)
                .on('get', this.getInUse.bind(this));
            this._addOrGetCharacteristic(Consumption)
                .on('get', this.getPowerUsage.bind(this));

            this.insightInUse = false;
            this.insightPowerUsage = 0;
        }

        return;
    }

    if (this.deviceType === Wemo.DEVICE_TYPE.Motion ||
            this.deviceType === 'urn:Belkin:device:NetCamSensor:1') {
        this.service = this._addOrGetService(Service.MotionSensor);

        this.service
            .getCharacteristic(Characteristic.MotionDetected)
            .on('get', this.getOn.bind(this));

        return;
    }

    this.log('Device type is not implemented: %s', this.deviceType);
};

// Configure wemo-client event listeners to update our internal state when things
// change
WemoAccessory.prototype._configureListeners = function () {
    if (this.deviceType === Wemo.DEVICE_TYPE.Bridge) {
        this.client.on('statusChange', this._handleStatusChange.bind(this));
        return;
    }

    if (this.deviceType === Wemo.DEVICE_TYPE.Insight ||
            this.deviceType === Wemo.DEVICE_TYPE.Switch ||
            this.deviceType === Wemo.DEVICE_TYPE.LightSwitch) {
        this.client.on('binaryState', function (state) {
            this.log('State is now %s', state);
            this._updateInternal(Characteristic.On, state > 0);

            if (this.deviceType === Wemo.DEVICE_TYPE.Insight && state <= 0) {
                this._updateInternal(Characteristic.OutletInUse, false);
                this._updateInternal(Consumption, 0, true);
            }
        }.bind(this));

        if (this.deviceType === Wemo.DEVICE_TYPE.Insight) {
            this.client.on('insightParams', function (state, power) {
                this.insightInUse = state == 1;
                this.insightPowerUsage = Math.round(power / 100) / 10;
                this._updateInternal(Characteristic.OutletInUse, this.insightInUse);
                this._updateInternal(Consumption, this.insightPowerUsage, true);
            }.bind(this));
        }
        return;
    }

    if (this.deviceType === Wemo.DEVICE_TYPE.Motion) {
      this.client.on('binaryState', function (state) {
          this._motionStateChange(state > 0);
      }.bind(this));
    }
};

// Handle status change for Wemo light bulbs
WemoAccessory.prototype._handleStatusChange = function (deviceId, capabilityId, value) {
    // We create separate accessory for each bulb, but they are in fact a group
    // and when each bulb accessory registers for events it gets events for all bulbs
    // Compare deviceId to check we are the correct accessory to handle this event
    if (deviceId != this.deviceId) {
        return;
    }

    switch(capabilityId) {
        case '10008': // this is a brightness change
            var newBrightness = Math.round(value.split(':').shift() / 255 * 100 );
            this.log('Brightness is now %s', newBrightness);
            this._updateInternal(Characteristic.Brightness, newbrightness);
            break;
        case '10006': // on/off/etc
            // reflect change of onState from potentially and external change (from Wemo App for instance)
            var newState = this._capabilities['10006'].substr(0,1) === '1' ? true : false;
            this.log('State is now %s', newState);
            this._updateInternal(Characteristic.On, newState);
            break;
        default:
            this.log('Capability ID %s is not implemented', capabilityId);
            break;
    }
};

// Handle switching on/off
WemoAccessory.prototype.setOn = function (value, callback, context) {
    if (context == '_internal') {
        // An internal update from Wemo - don't do any action
        callback(null);
        return;
    }

    // Flag a transition happening that will allow a delay before allowing
    // internal updates to propogate, giving them time to catch up and prevent
    // flickering switch states
    callback = this._beginTransition(Characteristic.On, callback);

    this.log('Setting state to %s', value);

    this.client.setBinaryState(value ? 1 : 0, function (err) {
        if (err) {
            this.log('Failed to set state to %s: %s', value > 0 ? 'on' : 'off', err);
            callback(err);
            return;
        }

        this.log('Successfully set state to %s', value);
        callback(null);
    }.bind(this));
};

// Get current on status
WemoAccessory.prototype.getOn = function (callback) {
    this.client.getBinaryState(function (err, state) {
        if (err) {
            this.log('Failed to get current state for %s: %s', this.name, err);
            callback(err);
            return;
        }

        this.log('Current state: %s', state);
        callback(null, state > 0);
    }.bind(this));
};

// Get in use from cached insightParams (there is no on-demand GET)
WemoAccessory.prototype.getInUse = function (callback) {
    callback(null, this.insightInUse);
};

// Get power usage from cached insightParams (there is no on-demand GET)
WemoAccessory.prototype.getPowerUsage = function (callback) {
    callback(null, this.insightPowerUsage);
};

// Set light on status
WemoAccessory.prototype.setOnStatus = function (value, callback) {
    // Flag a transition to prevent flickering statuses
    callback = this._beginTransition(Characteristic.On, callback);

    this.log('Setting light state to: %s', value);

    this.client.setDeviceStatus(this.deviceId, 10006, value ? 1 : 0, function (err) {
        if (err) {
          this.log('Failed to set light state to %s: %s', value, err);
          callback(err);
          return;
        }

        this.log('Successfully set light state to %s', value);
        callback(null);
    }.bind(this));
};

// Get status from light bridge and allow multiple listeners
WemoAccessory.prototype._getStatus = function (callback) {
    // Request already in progress?
    if (this.isRequestingStatus) {
        // Add on extra callbacks
        this.log('Light status request in progress - queueing additional callback');
        this.requestStatusCallbacks.push(callback);
        return;
    }

    this.log('Light status request starting');
    this.isRequestingStatus = true;
    this.requestStatusCallbacks  = [callback];
    this.client.getDeviceStatus(this.deviceId, function (err, capabilities) {
        this.isRequestingStatus = false;

        if (err) {
            this.log('Light status request failed: %s', err);
            this.requestStatusCallbacks.forEach(function (queuedCallback) {
                queuedCallback(err);
            }.bind(this));
            return;
        }

        this.log('Light status request successful');
        this.requestStatusCallbacks.forEach(function (queuedCallback) {
            queuedCallback(null, capabilities);
        }.bind(this));
    }.bind(this));
};

// Get light on status
WemoAccessory.prototype.getOnStatus = function (callback) {
    this._getStatus(function (err, capabilities) {
        if (err) {
            callback(err);
            return;
        }

        var state = capabilities['10006'].substr(0,1) === '1' ? true : false;
        this.log('Current light status: %s', state);
        callback(null, state);
    });
};

WemoAccessory.prototype.setBrightness = function (value, callback) {
    callback = this._beginTransition(Characteristic.Brightness, callback);

    this.log('Setting light brightness to: %s%%', value);

    this.client.setDeviceStatus(this.deviceId, 10008, value * 255 / 100, function (err) {
        if (err) {
            this.log('Failed to set light brightness to %s%%: %s', value, err);
            callback(err);
            return;
        }

        this.log('Successfully set light brightness to %s%%', value);
        callback(null);
    }.bind(this));
};

// Get light brightness
WemoAccessory.prototype.getBrightness = function (callback) {
    this._getStatus(function (err, capabilities) {
        if (err) {
            callback(err);
            return;
        }

        var brightness = Math.round(capabilities['10008'].split(':').shift() / 255 * 100);
        this.log('Current light brightness: %s', brightness);
        callback(null, brightness);
    });
};

// Handle motion timer
WemoAccessory.prototype._motionStateChange = function (state) {
    if (state) {
        this.log('Motion detected - setting motion characteristic to: true');

        // Motion detected - if within the motion timer period since last motion
        // clear the timer so we remain active until motion stops
        if (this.motionTimer) {
            this.log('Exiting end-of-motion timer stopped');
            clearTimeout(this.motionTimer);
            this.motionTimer = undefined;
        }

        this._updateInternal(Characteristic.MotionDetected, true);
        return;
    }

    // Motion stopped - start a timer before turning off the switch state
    this.log('Motion stopped - starting end-of-motion timer (%d secs)', this.platform.config.no_motion_timer);
    if (this.motionTimer) {
        clearTimeout(this.motionTimer);
    }

    this.motionTimer = setTimeout(function () {
        self.log('End-of-motion timer completed; setting motion characteristic to: false');
        this._updateInternal(Characteristic.MotionDetected, false);
        this.motionTimer = undefined;
    }.bind(this), this.platform.config.no_motion_timer * 1000);
};
