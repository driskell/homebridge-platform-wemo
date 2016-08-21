# homebridge-platform-wemo
[![NPM Version](https://img.shields.io/npm/v/homebridge-platform-wemo.svg)](https://www.npmjs.com/package/homebridge-platform-wemo)
[![Code Climate](https://codeclimate.com/github/rudders/homebridge-platform-wemo/badges/gpa.svg)](https://codeclimate.com/github/rudders/homebridge-platform-wemo)

Belkin WeMo Platform plugin for the awesome  [Homebridge](https://github.com/nfarina/homebridge) project.

## Currently supports
- Wemo Switch
- Wemo Light Swicth 
- Wemo Insight Switch (on/off/outlineinuse only)
- Wemo Bulb (via Wemo Link - on/off/brightness)
- Wemo Motion
- Wemo NetCam (Sensor)

# Installation

1. Install homebridge using: `npm install -g homebridge`
2. Install this plugin using: `npm install -g homebridge-platform-wemo`
3. Update your configuration file. See the sample below.

# Updating

Recently refactored to increase speed of operation and update on/off/brightness status more reliably.

1. npm update -g homebridge-platform-wemo

# Configuration

Configuration sample:

`expected_accessories` is **optional**, defaults to unlimited and is the total count of Wemo bulbs, switches, etc that we will try to find. It is **HIGHLY RECOMMENDED** that you set this value - refer to homekit_safe parameter for reasoning. It has two purposes - we can shortcuts the `timeout` value when we know we can stop looking and more importantly tells us that if we can;t find this number of accessories on a restart that we should kill homebridge so that HomeKit doesn't get inadvertently updated.

`timeout` is **optional**, defaults to 10 and if specified, in seconds, defines how long we will wait to try and find the specified number of `expected_accessories`

`no_motion_timer` is optional, defaults to 60 and applies to WeMo Motion Only. It is a timer in seconds for how long after motion is not detected that the state is changed.

`homekit_safe` is option, defaults to 1 (true) if you have specified a number of `expected_accessories` or '0' (false) if you have not set an expectation as to the number of accessories. This parameter, when set to true, will cause homebridge to crash and hence not update HomeKit if it doesn't find the nominated number of accessories. See section below.

`port` is optional, defaults to 0 (random available port). This parameter sets the local port to bind to
when performing discovery of the Wemo devices. It is useful if you are running a firewall.


 ```javascript
"platforms": [
        {
          "platform": "BelkinWeMo",
          "name": "WeMo Platform",
          "expected_accessories" : "0",
          "timeout" : "25",
          "no_motion_timer": "60",
          "homekit_safe" : "1"
        }   
    ]

```

The module will try and find all your WeMo Devices and make them available to HomeBridge / HomeKit / Siri. It will use the name you have set up with the Belkin app as the name used for Homekit and hence Siri so ensure your naming is distinct so poor Siri has some chance of getting you commands right. To change a name simply use the Wemo App on your smartphone and restart homebridge to pick up the changes.

The discovery process can be a little hit or miss with the Wemo platform so if all your devices are not discovered try restarting homebridge a few times and make sure all Lights (Bulbs) are on!

# homekit_safe

There is an unfortunate side effect of Homebridge and HomeKit - in the situation where an accessory that has previously been found by homebridge and hence added to HomeKit is not found on a subsequent re-run of Homebridge. The side effect is the deletion of that accessory definition from HomeKit. Which has the knock-on effect that all the rooms/zones/scenes it was previously assigned to get updated with the device gone. This plugin will takes a brute force approach to the situation where it can't find the specified number of `expected_accessories` and crash homebridge.

# ToDo

Update to increase the speed of status checking by persisting the WemoClient objects properly - work is in progress and may remove the necessity for the brute force crashing of homebridge if the expected number of devices isn't found.

# Credits

Credit goes to
- Timon Reinhard for his awesome [Wemo Client](https://github.com/timonreinhard/wemo-client) module and advise 
- Andy Lindeman for the [homebridge-smartthings](https://github.com/alindeman/homebridge-smartthings) that this is work is based on.
- [David Parry](https://github.com/devbobo) for his contributions.

# License

Published under the MIT License.
