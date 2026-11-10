# SignalRGB Tapo plugin

A [SignalRGB](https://signalrgb.com) plugin that sends the canvas colour to TP-Link Tapo smart lights and plugs. The plugin does not talk to the devices directly: it uses a local [tapo-rest](https://github.com/ClementNerma/tapo-rest) server as an HTTP bridge.

This repository is a fork of [sedbytes/signalrgb-tapo](https://github.com/sedbytes/signalrgb-tapo) by SyedAhkam. The fork adds tapo-rest API-key authentication, colour smoothing and the fixes listed under [Status](#status).

> **Branch `fix/review-3.1.0`: not tested on hardware.**
> Version 3.1.0 on this branch has been checked only with host tests: the plugin running in Node with mocked SignalRGB objects and a fake tapo-rest server. It has not been run in SignalRGB or with a Tapo device.
> - Use it at your own risk. Expect possible errors in device discovery, colour output and the On Exit or Sleep behaviour.
> - Branch `master` holds version 3.0.0, which uses a different LED layout and does not have these changes.
> - The device image is loaded from `master`, so SignalRGB shows a placeholder image until this branch is merged.
> - This notice will be removed when the branch has been tested on hardware and merged.

## Tested configuration

| Item | Version |
|---|---|
| Plugin | 3.1.0 |
| OS | Windows 11 |
| SignalRGB | 2.5.86 |
| Device | Tapo L900 light strip |
| tapo-rest | API-key version (checked against 0.5.1 source); tested version to be recorded |

Hardware test of 3.1.0: pending. See [Status](#status).

## Supported devices

Device types are the ones tapo-rest lists in its configuration.

| Type | Device | Commands used | Canvas sample points |
|---|---|---|---|
| L900, L920, L930 | Light strip | set-hue-saturation, set-brightness, off | 20 (one row, averaged to one colour) |
| L530, L535, L630 | Colour bulb | set-hue-saturation, set-brightness, off | 1 |
| L510, L520, L610 | Dimmable bulb | set-brightness, off | 1 |
| P100, P105, P110, P110M, P115 | Plug | on, off | 1 |
| P300, P304, P304M, P316 | Power strip | not added: tapo-rest has no on/off route for them | – |

Device types not in this table are added as on/off devices.

## Repository layout

```
Tapo.js                     plugin: discovery service and device render loop
Tapo.qml                    service panel (connection, rendering, device list)
images/tapo-signalrgb.png   device image and service icon (1024x1024)
LICENSE                     MIT
```

## Set up tapo-rest

1. Install tapo-rest as described in its [README](https://github.com/ClementNerma/tapo-rest): a prebuilt binary from its releases page, the Docker image, or `cargo install --git https://github.com/ClementNerma/tapo-rest`.

2. Create an API key. tapo-rest requires at least 32 characters, letters and digits only. In PowerShell this prints 64 random hexadecimal characters:

   ```powershell
   $b = New-Object byte[] 32
   [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   -join ($b | ForEach-Object { $_.ToString('x2') })
   ```

   - Line 1 creates an array of 32 bytes.
   - Line 2 fills it from the Windows cryptographic random number generator.
   - Line 3 writes each byte as two hexadecimal digits and joins them into one string.

3. Create a configuration file, for example `C:\tapo-rest\config.json`. Use names without spaces for the devices; the plugin also handles other names.

   ```json
   {
       "tapo_credentials": {
           "email": "<Tapo account e-mail>",
           "password": "<Tapo account password>"
       },
       "devices": [
           { "name": "desk-strip", "device_type": "L900", "ip_addr": "192.168.1.50" }
       ],
       "server": {
           "password": "<any unguessable text>",
           "api_keys": [
               { "name": "SignalRGB", "key": "<API key from step 2>" }
           ]
       }
   }
   ```

4. Start the server on port 8000:

   ```powershell
   tapo-rest.exe C:\tapo-rest\config.json --port 8000
   ```

   tapo-rest connects to every device in the file, then serves the API on all network interfaces at port 8000.

5. Check the device list:

   ```powershell
   curl.exe -H "Authorization: Bearer <API key>" http://127.0.0.1:8000/devices
   ```

   `curl.exe` is used because `curl` in Windows PowerShell 5.1 is an alias for `Invoke-WebRequest`. The answer is a JSON list with one entry per device, for example `[{"name":"desk-strip","device_type":"L900","ip_addr":"192.168.1.50"}]`.

## Install the plugin

1. In SignalRGB, open **Settings > Add-ons** and add this repository's URL: `https://github.com/DukeShank/signalrgb-tapo` (branch `master`). To test the untested 3.1.0 version, select branch `fix/review-3.1.0` instead.
2. Restart SignalRGB if prompted.
3. Open the Tapo service on the **Third Party Services** page.
4. Enter the tapo-rest host, port and API key and press **Apply**. The status line changes to **Connected: 1 device added** and the device appears in the list.
5. Place the device on the **Layouts** page. A light strip is a row of 20 sample points; bulbs and plugs are one point.

**Updating from 3.0.0.** 3.1.0 uses a fixed LED layout instead of a component channel, so the device must be placed on the Layouts page again. The saved host, port, API key, Frame Skip and Min Delta are kept.

## How it works

1. **Discovery.** The service sends `GET /devices` with the API key and adds each supported device. If tapo-rest cannot be reached, or does not answer within 5 s, it tries again every 10 s, so tapo-rest can start after SignalRGB. A rejected key (HTTP 403) is not retried: correct the key and press **Apply**.
2. **Colour.** Every Frame Skip frames, the device averages its sample points (or uses Forced Color), converts the colour to hue, saturation and brightness, applies Brightness (%) and smooths the change.
3. **Commands.** Only the part that changed is sent:
   - colour lights: `set-hue-saturation` when hue or saturation changed by at least Min Delta, then `set-brightness` when brightness changed by at least Min Delta. Both commands also turn the light on, so no separate `on` request is sent;
   - dimmable bulbs: `set-brightness`;
   - plugs: `on` or `off` only when the state changes.

   Brightness 0 sends `off`, and the next non-zero brightness turns the device on again. Changes between on and off are always sent, whatever Min Delta is.
4. **Limits.** tapo-rest accepts saturation 1–100, so white and grey are sent as saturation 1. One request runs at a time per device. A request without an answer is abandoned after 5 s. After a failed request the device waits 2 s before the next one.
5. **Logging.** Each error is logged once with the HTTP status and the tapo-rest message, and recovery is logged once. Nothing is logged per update.

Each command is one HTTP request to tapo-rest and one request from tapo-rest to the device, so a device follows the canvas a few times per second, not at the canvas frame rate.

## Settings

### Service panel

| Field | Default | Description |
|---|---|---|
| Host | `127.0.0.1` | tapo-rest address. `http://` and a trailing `/` are removed. |
| Port | `8000` | tapo-rest port |
| API key | *(empty)* | A key from `server.api_keys` in the tapo-rest configuration. Spaces before and after are removed. |
| Frame Skip | `6` | Render() calls between updates (1–30). SignalRGB calls Render() about every 30 ms, so `6` is at most about 5 updates per second. |
| Min Delta | `3` | Smallest change that is sent (0–100): hue in degrees, saturation and brightness in percent. `0` sends every update. |

**Apply** in the connection card saves the settings, removes the devices and loads the device list again. **Apply** in the rendering card saves Frame Skip and Min Delta and passes them to the devices. The status line shows the connection state.

### Device page

| Setting | Default | Description |
|---|---|---|
| Lighting Mode | Canvas | `Canvas`: average of the sample points. `Forced`: Forced Color. |
| Forced Color | `#0099ff` | Colour used in Forced mode |
| Brightness (%) | 100 | Scales the brightness (1–100) |
| On Exit or Sleep | Warm white | See below |

### On Exit or Sleep

| Value | On exit or when streaming is turned off | On sleep |
|---|---|---|
| Warm white | Colour lights: 3000 K at their last brightness. Dimmable bulbs and plugs: off. | Off |
| Turn off | Off | Off |
| Leave as is | Nothing is sent | Nothing is sent |

**Warm white** is the behaviour of earlier versions, which always reset colour lights to 3000 K on exit.

## Status

### Version 3.1.0

Changes from 3.0.0:
- White and grey no longer fail: tapo-rest rejects saturation 0 with HTTP 500, which left the light on its previous colour.
- A light dimmed to 1–2 % now turns off when the canvas turns black. Before, the change was smaller than Min Delta and `off` was never sent.
- Fewer requests: 1–2 per update instead of 3 (`on`, `set-hue-saturation`, `set-brightness`); plugs switch only when their state changes.
- Errors: the request chain stops after any failed request; errors are logged once instead of about 10 log lines per second; a request without an answer is abandoned after 5 s; device names are URL-encoded.
- Discovery retries every 10 s until tapo-rest answers; power strips without on/off routes are not added; the service panel shows a status line.
- Fixed LED layout (one point, or 20 points for strips) instead of a component channel. The channel returned no colours until a component was added to it.
- Settings: invalid saved values fall back to the defaults; settings are read from SignalRGB's globals instead of module-level copies; the `PASSWORD` field is now `API KEY`; the three render-settings diagnostic log lines are replaced by one line at load.
- New: On Exit or Sleep setting, `DeviceType()` export, Forced Color hue range 0–360, device image in this repository, LICENSE file, `.gitattributes`.

Verified on the host: the plugin in Node with mocked SignalRGB objects and a fake tapo-rest that applies tapo-rest 0.5.1's routes, authentication and value ranges (30 tests).

Not yet verified on hardware: everything above with the L900. Results will be added here.

### Earlier versions

The original author tested 3.0.0 with an L900, with an earlier tapo-rest that used `POST /login`. Other models are implemented from the tapo-rest API and have not been tested.

## Troubleshooting

### Status: Not configured
Enter the API key and press **Apply**.

### Status: tapo-rest not reachable at … (retrying every 10 s)
tapo-rest is not running, or the host or port is wrong. Start tapo-rest and check it with the `curl.exe` command under [Set up tapo-rest](#set-up-tapo-rest). The device list loads within 10 s after tapo-rest starts.

### Status: API key rejected by tapo-rest (HTTP 403)
The key is not in `server.api_keys`. Copy the key from the configuration, press **Apply**, and restart tapo-rest if you changed its configuration.

### Status: Connected: no devices in the tapo-rest configuration
Add the devices to the `devices` list of the tapo-rest configuration, restart tapo-rest and press **Apply**.

### A device is logged as "Not added"
Power strips (P300, P304, P304M, P316) have no on/off route in tapo-rest and are not added.

### The light does not follow the canvas
- Check that the device is placed on the **Layouts** page and that the effect covers it.
- Look for `[Tapo] <device>: … failed: …` in the SignalRGB log. `HTTP 500` with a tapo error means tapo-rest could not reach the device: check its IP address in the tapo-rest configuration. `HTTP 404: Provided device name was not found` means the name differs from the configuration: press **Apply** to load the list again.
- The light was switched off in the Tapo app while the colour stays the same: the plugin sends the next command only when the colour changes.

### Updates are slow
Lower Frame Skip, or set Min Delta to 0 or 1. The limit is the time tapo-rest needs per device request.

### Strips show one colour
Per-segment colour is not supported: tapo-rest has no per-segment colour route. The L900 shows one colour by design.

## Development

No build step. `Tapo.js` and `Tapo.qml` are loaded by SignalRGB as they are.

- QML changes: SignalRGB reloads the panel when the file changes.
- JS changes: disable and enable the add-on, or restart SignalRGB.

To add a device type, edit `tapoDeviceCaps()` in `Tapo.js`:

| Field | Meaning |
|---|---|
| `color` | The type has `set-hue-saturation` |
| `dim` | The type has `set-brightness` |
| `supported` | `false`: the type is not added |
| `kind` | Text for the log; `"light strip"` gets 20 sample points |

## Disclaimer

This is a personal project, not a maintained product.

- No support, updates or compatibility guarantees for future SignalRGB, tapo-rest or Tapo firmware versions. Issues and pull requests may go unanswered.
- Use at your own risk. You are responsible for testing any changes you make.
- Tapo and TP-Link are trademarks of TP-Link. This project is not affiliated with or endorsed by TP-Link, SignalRGB or tapo-rest. The device image is an original drawing.
- tapo-rest listens on all network interfaces and uses plain HTTP. Anyone on the network who has the API key can control the devices. Block the tapo-rest port for other computers in the firewall if only SignalRGB on the same PC uses it, and do not forward it to the internet.
- The API key is stored in SignalRGB's plugin settings as plain text. Do not post it, your Tapo account details or device IP addresses in issues or screenshots.

## Licence and attribution

MIT. See `LICENSE`. The original plugin by SyedAhkam ([sedbytes/signalrgb-tapo](https://github.com/sedbytes/signalrgb-tapo)) states the MIT licence in its README but has no licence file; this fork adds the file with copyright lines for the original author and for the changes in this fork.

[tapo-rest](https://github.com/ClementNerma/tapo-rest) (Apache-2.0) and the [tapo](https://github.com/mihai-dinculescu/tapo) library it uses are separate projects. They are not included in this repository.
